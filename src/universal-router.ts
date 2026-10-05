import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  isHex,
  parseAbiParameters,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem';
import { universalRouterAbi } from './abis.js';
import { invalid, UniswapSdkError } from './errors.js';
import { checkedAddress } from './pool.js';
import { validatePermitSingle, type PermitSingle } from './permit2.js';

/**
 * Universal Router 2.x command types, from `contracts/libraries/Commands.sol` at the
 * universal-router package commit Arc's reviewed router was built from
 * (`999d561c3ad58fb5cab91b602911f3c75591a9c7`). Placeholder slots are deliberately absent:
 * the router reverts on them, so a decoder that met one would be reading something else.
 */
export const UNIVERSAL_ROUTER_COMMAND = Object.freeze({
  V3_SWAP_EXACT_IN: 0x00,
  V3_SWAP_EXACT_OUT: 0x01,
  PERMIT2_TRANSFER_FROM: 0x02,
  PERMIT2_PERMIT_BATCH: 0x03,
  SWEEP: 0x04,
  TRANSFER: 0x05,
  PAY_PORTION: 0x06,
  PAY_PORTION_FULL_PRECISION: 0x07,
  V2_SWAP_EXACT_IN: 0x08,
  V2_SWAP_EXACT_OUT: 0x09,
  PERMIT2_PERMIT: 0x0a,
  WRAP_ETH: 0x0b,
  UNWRAP_WETH: 0x0c,
  PERMIT2_TRANSFER_FROM_BATCH: 0x0d,
  BALANCE_CHECK_ERC20: 0x0e,
  V4_SWAP: 0x10,
  V3_POSITION_MANAGER_PERMIT: 0x11,
  V3_POSITION_MANAGER_CALL: 0x12,
  V4_INITIALIZE_POOL: 0x13,
  V4_POSITION_MANAGER_CALL: 0x14,
  EXECUTE_SUB_PLAN: 0x21,
  ACROSS_V4_DEPOSIT_V3: 0x40,
} as const);

export type UniversalRouterCommandName = keyof typeof UNIVERSAL_ROUTER_COMMAND;
export type UniversalRouterCommandType = (typeof UNIVERSAL_ROUTER_COMMAND)[UniversalRouterCommandName];

/** High bit of a command byte: the router continues past a failure of that command. */
export const UNIVERSAL_ROUTER_FLAG_ALLOW_REVERT = 0x80;
const COMMAND_TYPE_MASK = 0x7f;

/**
 * The command types accepted when a caller passes no `permittedCommands`: Permit2 permits,
 * v2/v3/v4 swaps, native wrapping, and the payment and balance-check commands a swap ends
 * with. Everything else must be opted into. That includes `EXECUTE_SUB_PLAN`, Permit2 transfers
 * and batch permits, position-manager calls, pool initialization, `TRANSFER`, and
 * `ACROSS_V4_DEPOSIT_V3`. This default is a structural floor, not a review: hosts reviewing
 * calldata they did not build should pass the exact command list their plan uses.
 */
export const UNIVERSAL_ROUTER_DEFAULT_COMMANDS: readonly number[] = Object.freeze([
  UNIVERSAL_ROUTER_COMMAND.PERMIT2_PERMIT,
  UNIVERSAL_ROUTER_COMMAND.V2_SWAP_EXACT_IN,
  UNIVERSAL_ROUTER_COMMAND.V2_SWAP_EXACT_OUT,
  UNIVERSAL_ROUTER_COMMAND.V3_SWAP_EXACT_IN,
  UNIVERSAL_ROUTER_COMMAND.V3_SWAP_EXACT_OUT,
  UNIVERSAL_ROUTER_COMMAND.V4_SWAP,
  UNIVERSAL_ROUTER_COMMAND.WRAP_ETH,
  UNIVERSAL_ROUTER_COMMAND.UNWRAP_WETH,
  UNIVERSAL_ROUTER_COMMAND.SWEEP,
  UNIVERSAL_ROUTER_COMMAND.PAY_PORTION,
  UNIVERSAL_ROUTER_COMMAND.BALANCE_CHECK_ERC20,
]);

/** Deepest `EXECUTE_SUB_PLAN` nesting the codec decodes; deeper plans are rejected. */
export const UNIVERSAL_ROUTER_MAX_SUB_PLAN_DEPTH = 2;

export type UniversalRouterCommandInput = {
  /** The command type, without the allow-revert flag. */
  command: number;
  /** ABI-encoded command input, exactly as the router's dispatcher decodes it. */
  input: Hex;
  /** Sets the allow-revert flag. Rejected unless the codec options permit it. */
  allowRevert?: boolean;
};

export type UniversalRouterCommand = {
  command: number;
  allowRevert: boolean;
  input: Hex;
  /** Present for `EXECUTE_SUB_PLAN`: the inner plan, decoded and checked under the same options. */
  subPlan?: UniversalRouterCommand[];
};

export type UniversalRouterExecute = { commands: UniversalRouterCommand[]; deadline: bigint };

export type UniversalRouterCodecOptions = {
  /**
   * Command types accepted. Defaults to `UNIVERSAL_ROUTER_DEFAULT_COMMANDS`; pass the exact
   * list a plan uses to review it, or list any other type to admit it explicitly. Permitting
   * `EXECUTE_SUB_PLAN` makes the codec decode each sub-plan under these same options.
   */
  permittedCommands?: readonly number[];
  /**
   * The allow-revert flag is rejected by default: a tolerated failure lets later commands run
   * against state the plan did not anticipate. `true` accepts it on any command; a list
   * accepts it only on those command types. `[PERMIT2_PERMIT]` is the usual opt-in: it keeps
   * a swap alive when someone has already submitted the same signature to Permit2 directly.
   * The swap then runs on whatever allowance the owner already has, even when the permit failed
   * for another reason, so bound that standing allowance too (`readPermit2Allowance`) or
   * simulate the exact call.
   */
  allowRevert?: boolean | readonly number[];
};

const permit2PermitParams = parseAbiParameters(
  '(address token, uint160 amount, uint48 expiration, uint48 nonce) details, address spender, uint256 sigDeadline, bytes signature',
);
const subPlanParams = parseAbiParameters('bytes commands, bytes[] inputs');

function mismatch(message: string): never {
  throw new UniswapSdkError('CALLDATA_MISMATCH', message);
}

function commandType(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= COMMAND_TYPE_MASK;
}

type ResolvedOptions = { permitted: ReadonlySet<number>; allowRevert: (command: number) => boolean };

function resolveOptions(options: UniversalRouterCodecOptions): ResolvedOptions {
  const permittedList = options.permittedCommands ?? UNIVERSAL_ROUTER_DEFAULT_COMMANDS;
  if (!Array.isArray(permittedList) || !permittedList.every(commandType)) {
    invalid('permittedCommands entries must be command types from 0x00 to 0x7f');
  }
  const { allowRevert } = options;
  if (allowRevert !== undefined && typeof allowRevert !== 'boolean' && !(Array.isArray(allowRevert) && allowRevert.every(commandType))) {
    invalid('allowRevert must be a boolean or a list of command types from 0x00 to 0x7f');
  }
  const revertable = new Set(Array.isArray(allowRevert) ? allowRevert : []);
  return {
    permitted: new Set(permittedList),
    allowRevert: command => allowRevert === true || revertable.has(command),
  };
}

function hexByte(value: number): string {
  return `0x${value.toString(16).padStart(2, '0')}`;
}

/** Checks one command list, recursing into sub-plans. Throws CALLDATA_MISMATCH. */
function reviewCommands(commandBytes: Hex, inputs: readonly Hex[], options: ResolvedOptions, depth: number, path: string): UniversalRouterCommand[] {
  const bytes = commandBytes.slice(2);
  if (bytes.length / 2 !== inputs.length) mismatch(`${path} command count does not match its input count`);
  if (!inputs.length) mismatch(`${path} has no commands`);
  const commands: UniversalRouterCommand[] = [];
  for (let index = 0; index < inputs.length; index++) {
    const byte = parseInt(bytes.slice(index * 2, index * 2 + 2), 16);
    const command = byte & COMMAND_TYPE_MASK;
    const allowRevert = (byte & UNIVERSAL_ROUTER_FLAG_ALLOW_REVERT) !== 0;
    const where = `${path} command ${index}`;
    if (!options.permitted.has(command)) mismatch(`${where} is unpermitted type ${hexByte(command)}`);
    if (allowRevert && !options.allowRevert(command)) mismatch(`${where} sets allow-revert, which was not permitted`);
    const input = inputs[index]!;
    if (command !== UNIVERSAL_ROUTER_COMMAND.EXECUTE_SUB_PLAN) {
      commands.push({ command, allowRevert, input });
      continue;
    }
    // The router runs a sub-plan as a nested execute; review it as strictly as the outer plan.
    if (depth >= UNIVERSAL_ROUTER_MAX_SUB_PLAN_DEPTH) mismatch(`${where} nests sub-plans deeper than ${UNIVERSAL_ROUTER_MAX_SUB_PLAN_DEPTH}`);
    let inner: readonly [Hex, readonly Hex[]];
    try {
      inner = decodeAbiParameters(subPlanParams, input);
    } catch (cause) {
      throw new UniswapSdkError('CALLDATA_MISMATCH', `${where} is not abi.encode(bytes commands, bytes[] inputs)`, { cause });
    }
    if (encodeAbiParameters(subPlanParams, inner).toLowerCase() !== input.toLowerCase()) mismatch(`${where} sub-plan is not canonically encoded`);
    commands.push({ command, allowRevert, input, subPlan: reviewCommands(inner[0], inner[1], options, depth + 1, `${where} sub-plan`) });
  }
  return commands;
}

function packCommands(commands: readonly UniversalRouterCommandInput[], label: string): { commandBytes: Hex; inputs: Hex[] } {
  if (!Array.isArray(commands) || !commands.length) invalid(`${label} must include at least one command`);
  let commandBytes = '0x';
  const inputs: Hex[] = [];
  for (const [index, entry] of commands.entries()) {
    if (!commandType(entry.command)) invalid(`${label}[${index}].command must be a command type from 0x00 to 0x7f`);
    if (!isHex(entry.input, { strict: true }) || entry.input.length % 2 !== 0) invalid(`${label}[${index}].input must be whole-byte hex`);
    const byte = entry.command | (entry.allowRevert ? UNIVERSAL_ROUTER_FLAG_ALLOW_REVERT : 0);
    commandBytes += byte.toString(16).padStart(2, '0');
    inputs.push(entry.input);
  }
  return { commandBytes: commandBytes as Hex, inputs };
}

/** Builder-side check: the same rules the decoder enforces, reported as INVALID_ARGUMENT. */
function checkBuiltCommands(commandBytes: Hex, inputs: readonly Hex[], options: UniversalRouterCodecOptions, depth: number, label: string): void {
  const resolved = resolveOptions(options);
  try {
    reviewCommands(commandBytes, inputs, resolved, depth, label);
  } catch (error) {
    if (error instanceof UniswapSdkError && error.code === 'CALLDATA_MISMATCH') {
      throw new UniswapSdkError('INVALID_ARGUMENT', error.message, { cause: error.cause });
    }
    throw error;
  }
}

/**
 * Encodes `execute(bytes commands, bytes[] inputs, uint256 deadline)`. Only the deadline
 * overload is produced: a router call without a deadline can be held and mined at any later
 * price. Inputs are passed through as encoded; use the per-command encoders to build them.
 * The plan must satisfy the same options the decoder would apply, sub-plans included.
 */
export function encodeUniversalRouterExecute(
  plan: { commands: readonly UniversalRouterCommandInput[]; deadline: bigint },
  options: UniversalRouterCodecOptions = {},
): Hex {
  if (typeof plan.deadline !== 'bigint' || plan.deadline < 0n || plan.deadline >= 1n << 256n) invalid('deadline must fit in uint256');
  const { commandBytes, inputs } = packCommands(plan.commands, 'commands');
  checkBuiltCommands(commandBytes, inputs, options, 0, 'Universal Router plan');
  return encodeFunctionData({ abi: universalRouterAbi, functionName: 'execute', args: [commandBytes, inputs, plan.deadline] });
}

/**
 * Encodes an `EXECUTE_SUB_PLAN` (0x21) input, `abi.encode(bytes commands, bytes[] inputs)`,
 * checked under `options` exactly as the decoder checks sub-plans.
 */
export function encodeUniversalRouterSubPlan(commands: readonly UniversalRouterCommandInput[], options: UniversalRouterCodecOptions = {}): Hex {
  const packed = packCommands(commands, 'commands');
  // A sub-plan is always at least one level deep once it sits inside an execute.
  checkBuiltCommands(packed.commandBytes, packed.inputs, options, 1, 'Universal Router sub-plan');
  return encodeAbiParameters(subPlanParams, [packed.commandBytes, packed.inputs]);
}

/**
 * Decodes `execute(bytes,bytes[],uint256)` calldata into its commands and deadline. Rejects
 * any other selector (including the deadline-free `execute(bytes,bytes[])`), a command/input
 * count mismatch, unpermitted command types, allow-revert flags unless permitted, and
 * calldata that does not re-encode to the same bytes. A permitted `EXECUTE_SUB_PLAN` is
 * decoded and checked recursively under the same options.
 *
 * This is a structural check of which commands run, not a review of what they do. Review
 * each input (for example `reviewPermit2PermitInput`), and pass the exact
 * `permittedCommands` a plan uses when the calldata came from someone else.
 */
export function decodeUniversalRouterExecute(data: Hex, options: UniversalRouterCodecOptions = {}): UniversalRouterExecute {
  const resolved = resolveOptions(options);
  let commandBytes: Hex;
  let inputs: readonly Hex[];
  let deadline: bigint;
  try {
    const decoded = decodeFunctionData({ abi: universalRouterAbi, data });
    if (decoded.functionName !== 'execute') mismatch('Calldata is not a Universal Router execute(bytes,bytes[],uint256) call');
    [commandBytes, inputs, deadline] = decoded.args;
  } catch (cause) {
    if (cause instanceof UniswapSdkError) throw cause;
    throw new UniswapSdkError('CALLDATA_MISMATCH', 'Calldata is not a decodable Universal Router execute(bytes,bytes[],uint256) call', { cause });
  }
  const commands = reviewCommands(commandBytes, inputs, resolved, 0, 'Universal Router plan');
  const canonical = encodeFunctionData({ abi: universalRouterAbi, functionName: 'execute', args: [commandBytes, inputs, deadline] });
  if (canonical.toLowerCase() !== data.toLowerCase()) mismatch('Universal Router calldata is not canonically encoded');
  return { commands, deadline };
}

/**
 * Encodes a `PERMIT2_PERMIT` (0x0a) input: `abi.encode(PermitSingle, bytes signature)`, the
 * layout the router hands to `Permit2.permit(msgSender(), permitSingle, signature)`. The
 * router supplies the owner, so the signer must be the account that sends the transaction.
 * The permit overwrites any existing allowance for this token and router; see
 * `readPermit2Allowance` for nonce races and the allow-revert mitigation.
 */
export function encodePermit2PermitInput(permitSingle: PermitSingle, signature: Hex): Hex {
  const permit = validatePermitSingle(permitSingle);
  if (!isHex(signature, { strict: true }) || signature.length <= 2) invalid('signature must be nonempty hex');
  return encodeAbiParameters(permit2PermitParams, [
    // viem types uint48 as number; validatePermitSingle bounded both below 2^48, which is exact.
    { ...permit.details, expiration: Number(permit.details.expiration), nonce: Number(permit.details.nonce) },
    permit.spender,
    permit.sigDeadline,
    signature,
  ]);
}

export type Permit2PermitInput = { permitSingle: PermitSingle; signature: Hex };

/** Decodes a `PERMIT2_PERMIT` input, rejecting anything that does not re-encode identically. */
export function decodePermit2PermitInput(input: Hex): Permit2PermitInput {
  let decoded: Permit2PermitInput;
  try {
    const [details, spender, sigDeadline, signature] = decodeAbiParameters(permit2PermitParams, input);
    decoded = {
      permitSingle: {
        details: {
          token: checkedAddress(details.token),
          amount: details.amount,
          expiration: BigInt(details.expiration),
          nonce: BigInt(details.nonce),
        },
        spender: checkedAddress(spender),
        sigDeadline,
      },
      signature,
    };
  } catch (cause) {
    throw new UniswapSdkError('CALLDATA_MISMATCH', 'PERMIT2_PERMIT input is not abi.encode(PermitSingle, bytes)', { cause });
  }
  if (decoded.signature.length <= 2) mismatch('PERMIT2_PERMIT input carries an empty signature');
  if (encodePermit2PermitInput(decoded.permitSingle, decoded.signature).toLowerCase() !== input.toLowerCase()) {
    mismatch('PERMIT2_PERMIT input is not canonically encoded');
  }
  return decoded;
}

/**
 * The owner-independent bounds a host requires of a `PERMIT2_PERMIT` it did not build itself.
 * Every bound that limits what the signature authorizes is required and checked at runtime;
 * the host states the allowance size and lifetime it accepts rather than inheriting whatever
 * was signed.
 *
 * `Permit2.permit` overwrites the owner's allowance for this token and spender; it does not
 * add to it. For operator wallets prefer an exact amount and an expiration near the execute
 * deadline. A standing unlimited router allowance lets any later router calldata the owner
 * sends pull that token without a fresh signature.
 */
export type ExpectedPermit2Permit = {
  token: Address;
  /** The router the transaction calls; the permit must grant exactly this spender. */
  spender: Address;
  /** Least allowance the plan needs (uint160); a smaller permit would leave the swap unfunded. */
  minAmount: bigint;
  /** Largest allowance accepted (uint160). Prefer the exact swap amount; `2^160 - 1` accepts unlimited. */
  maxAmount: bigint;
  /** Latest signature deadline accepted (uint256), typically the execute deadline. */
  maxSigDeadline: bigint;
  /** Latest allowance expiration accepted (uint48): how long the router may keep pulling this token. */
  maxExpiration: bigint;
  /**
   * Earliest allowance expiration accepted (uint48), e.g. the execute deadline so the
   * allowance outlives the call. Expiration 0 always satisfies it: Permit2 expires such an
   * allowance at the permit's own block, which still covers a swap in the same transaction.
   */
  minExpiration?: bigint;
  /** The owner's current Permit2 nonce (uint48, `readPermit2Allowance`), when already observed. */
  nonce?: bigint;
};

function expectedUint(value: unknown, bits: bigint, label: string): bigint {
  if (typeof value !== 'bigint' || value < 0n || value >= 1n << bits) invalid(`expected.${label} must be a uint${bits} bigint`);
  return value;
}

function expectedAddress(value: unknown, label: string): Address {
  if (typeof value !== 'string') invalid(`expected.${label} must be an address`);
  const address = checkedAddress(value as Address);
  if (address === zeroAddress) invalid(`expected.${label} cannot be the zero address`);
  return address;
}

function validateExpectedPermit(expected: ExpectedPermit2Permit): Required<Omit<ExpectedPermit2Permit, 'minExpiration' | 'nonce'>> & Pick<ExpectedPermit2Permit, 'minExpiration' | 'nonce'> {
  if (expected === null || typeof expected !== 'object') invalid('expected must be an object of permit bounds');
  const bounds = {
    token: expectedAddress(expected.token, 'token'),
    spender: expectedAddress(expected.spender, 'spender'),
    minAmount: expectedUint(expected.minAmount, 160n, 'minAmount'),
    maxAmount: expectedUint(expected.maxAmount, 160n, 'maxAmount'),
    maxSigDeadline: expectedUint(expected.maxSigDeadline, 256n, 'maxSigDeadline'),
    maxExpiration: expectedUint(expected.maxExpiration, 48n, 'maxExpiration'),
    minExpiration: expected.minExpiration === undefined ? undefined : expectedUint(expected.minExpiration, 48n, 'minExpiration'),
    nonce: expected.nonce === undefined ? undefined : expectedUint(expected.nonce, 48n, 'nonce'),
  };
  if (bounds.minAmount > bounds.maxAmount) invalid('expected.minAmount must not exceed expected.maxAmount');
  if (bounds.minExpiration !== undefined && bounds.minExpiration > bounds.maxExpiration) {
    invalid('expected.minExpiration must not exceed expected.maxExpiration');
  }
  return bounds;
}

/**
 * Reviews a `PERMIT2_PERMIT` input against host bounds, the way the v4 position reviewers
 * check a folded `permitBatch`. Malformed or missing bounds throw `INVALID_ARGUMENT` before
 * anything is decoded. It does not check the signer: pass the returned `permitSingle` to
 * `verifyPermitSingleSignature` with the transaction's sender and the router deployment's chain.
 */
export function reviewPermit2PermitInput(input: Hex, expected: ExpectedPermit2Permit): Permit2PermitInput {
  const bounds = validateExpectedPermit(expected);
  const decoded = decodePermit2PermitInput(input);
  const { details, spender, sigDeadline } = decoded.permitSingle;
  if (details.token !== bounds.token) mismatch('PERMIT2_PERMIT covers a different token than expected');
  if (spender !== bounds.spender) mismatch('PERMIT2_PERMIT grants a different spender than expected');
  if (details.amount < bounds.minAmount) mismatch('PERMIT2_PERMIT grants less than the expected minimum amount');
  if (details.amount > bounds.maxAmount) mismatch('PERMIT2_PERMIT grants more than the expected maximum amount');
  if (sigDeadline > bounds.maxSigDeadline) mismatch('PERMIT2_PERMIT signature deadline is later than accepted');
  if (details.expiration > bounds.maxExpiration) mismatch('PERMIT2_PERMIT allowance expires later than accepted');
  if (bounds.minExpiration !== undefined && details.expiration !== 0n && details.expiration < bounds.minExpiration) {
    mismatch('PERMIT2_PERMIT allowance expires earlier than required');
  }
  if (bounds.nonce !== undefined && details.nonce !== bounds.nonce) mismatch('PERMIT2_PERMIT nonce is not the expected Permit2 nonce');
  return decoded;
}
