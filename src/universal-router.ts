import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  isHex,
  parseAbiParameters,
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
const KNOWN_COMMANDS: ReadonlySet<number> = new Set(Object.values(UNIVERSAL_ROUTER_COMMAND));

export type UniversalRouterCommandInput = {
  /** The command type, without the allow-revert flag. */
  command: number;
  /** ABI-encoded command input, exactly as the router's dispatcher decodes it. */
  input: Hex;
  /** Sets the allow-revert flag. Rejected unless the codec options permit it. */
  allowRevert?: boolean;
};

export type UniversalRouterCommand = { command: number; allowRevert: boolean; input: Hex };

export type UniversalRouterExecute = { commands: UniversalRouterCommand[]; deadline: bigint };

export type UniversalRouterCodecOptions = {
  /**
   * Command types accepted. Defaults to every command in `UNIVERSAL_ROUTER_COMMAND`; pass a
   * narrower list to review a specific plan, or list an unmodelled type to admit it explicitly.
   */
  permittedCommands?: readonly number[];
  /**
   * Accepts the allow-revert flag. Off by default: a permitted failure lets later commands
   * run against state the plan did not anticipate.
   */
  allowRevert?: boolean;
};

const permit2PermitParams = parseAbiParameters(
  '(address token, uint160 amount, uint48 expiration, uint48 nonce) details, address spender, uint256 sigDeadline, bytes signature',
);

function mismatch(message: string): never {
  throw new UniswapSdkError('CALLDATA_MISMATCH', message);
}

function permittedCommandSet(options: UniversalRouterCodecOptions): ReadonlySet<number> {
  if (options.permittedCommands === undefined) return KNOWN_COMMANDS;
  for (const command of options.permittedCommands) {
    if (!Number.isInteger(command) || command < 0 || command > COMMAND_TYPE_MASK) {
      invalid('permittedCommands entries must be command types from 0x00 to 0x7f');
    }
  }
  return new Set(options.permittedCommands);
}

function hexByte(value: number): string {
  return `0x${value.toString(16).padStart(2, '0')}`;
}

/**
 * Encodes `execute(bytes commands, bytes[] inputs, uint256 deadline)`. Only the deadline
 * overload is produced: a router call without a deadline can be held and mined at any later
 * price. Inputs are passed through as encoded; use the per-command encoders to build them.
 */
export function encodeUniversalRouterExecute(
  plan: { commands: readonly UniversalRouterCommandInput[]; deadline: bigint },
  options: UniversalRouterCodecOptions = {},
): Hex {
  const permitted = permittedCommandSet(options);
  if (!plan.commands.length) invalid('A Universal Router plan must include at least one command');
  if (typeof plan.deadline !== 'bigint' || plan.deadline < 0n || plan.deadline >= 1n << 256n) invalid('deadline must fit in uint256');
  let commandBytes = '0x';
  const inputs: Hex[] = [];
  for (const [index, entry] of plan.commands.entries()) {
    if (!Number.isInteger(entry.command) || entry.command < 0 || entry.command > COMMAND_TYPE_MASK) {
      invalid(`commands[${index}].command must be a command type from 0x00 to 0x7f`);
    }
    if (!permitted.has(entry.command)) invalid(`commands[${index}] uses unpermitted command ${hexByte(entry.command)}`);
    if (entry.allowRevert && !options.allowRevert) invalid(`commands[${index}] sets allow-revert, which was not permitted`);
    if (!isHex(entry.input, { strict: true })) invalid(`commands[${index}].input must be hex`);
    const byte = entry.command | (entry.allowRevert ? UNIVERSAL_ROUTER_FLAG_ALLOW_REVERT : 0);
    commandBytes += byte.toString(16).padStart(2, '0');
    inputs.push(entry.input);
  }
  return encodeFunctionData({
    abi: universalRouterAbi,
    functionName: 'execute',
    args: [commandBytes as Hex, inputs, plan.deadline],
  });
}

/**
 * Decodes `execute(bytes,bytes[],uint256)` calldata into its commands and deadline. Rejects
 * any other selector (including the deadline-free `execute(bytes,bytes[])`), a command/input
 * count mismatch, unpermitted command types, allow-revert flags unless permitted, and
 * calldata that does not re-encode to the same bytes, so nothing can ride along unreviewed.
 */
export function decodeUniversalRouterExecute(data: Hex, options: UniversalRouterCodecOptions = {}): UniversalRouterExecute {
  const permitted = permittedCommandSet(options);
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
  const bytes = commandBytes.slice(2);
  if (bytes.length / 2 !== inputs.length) mismatch('Universal Router command count does not match its input count');
  if (!inputs.length) mismatch('Universal Router calldata has no commands');
  const commands: UniversalRouterCommand[] = [];
  for (let index = 0; index < inputs.length; index++) {
    const byte = parseInt(bytes.slice(index * 2, index * 2 + 2), 16);
    const command = byte & COMMAND_TYPE_MASK;
    const allowRevert = (byte & UNIVERSAL_ROUTER_FLAG_ALLOW_REVERT) !== 0;
    if (!permitted.has(command)) mismatch(`Universal Router command ${index} is unpermitted type ${hexByte(command)}`);
    if (allowRevert && !options.allowRevert) mismatch(`Universal Router command ${index} sets allow-revert, which was not permitted`);
    commands.push({ command, allowRevert, input: inputs[index]! });
  }
  const canonical = encodeFunctionData({ abi: universalRouterAbi, functionName: 'execute', args: [commandBytes, inputs, deadline] });
  if (canonical.toLowerCase() !== data.toLowerCase()) mismatch('Universal Router calldata is not canonically encoded');
  return { commands, deadline };
}

/**
 * Encodes a `PERMIT2_PERMIT` (0x0a) input: `abi.encode(PermitSingle, bytes signature)`, the
 * layout the router hands to `Permit2.permit(msgSender(), permitSingle, signature)`. The
 * router supplies the owner, so the signer must be the account that sends the transaction.
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
 * Every bound that limits what the signature authorizes is required; the host states the
 * allowance size and lifetime it accepts rather than inheriting whatever was signed.
 */
export type ExpectedPermit2Permit = {
  token: Address;
  /** The router the transaction calls; the permit must grant exactly this spender. */
  spender: Address;
  /** Least allowance the plan needs; a smaller permit would leave the swap unfunded. */
  minAmount: bigint;
  /** Largest allowance the host accepts; pass `2^160 - 1` to accept an unlimited approval. */
  maxAmount: bigint;
  /** Latest signature deadline accepted, typically the execute deadline. */
  maxSigDeadline: bigint;
  /** Latest allowance expiration accepted: how long the router may keep pulling this token. */
  maxExpiration: bigint;
  /** Earliest allowance expiration accepted, e.g. the execute deadline so the allowance outlives the call. */
  minExpiration?: bigint;
  /** The owner's current Permit2 nonce (`readPermit2Allowance`), when already observed. */
  nonce?: bigint;
};

/**
 * Reviews a `PERMIT2_PERMIT` input against host bounds, the way the v4 position reviewers
 * check a folded `permitBatch`. It does not check the signer: pair it with
 * `verifyPermitSingleSignature` for the transaction's sender.
 */
export function reviewPermit2PermitInput(input: Hex, expected: ExpectedPermit2Permit): Permit2PermitInput {
  const decoded = decodePermit2PermitInput(input);
  const { details, spender, sigDeadline } = decoded.permitSingle;
  if (expected.minAmount > expected.maxAmount) invalid('expected.minAmount must not exceed expected.maxAmount');
  if (details.token !== checkedAddress(expected.token)) mismatch('PERMIT2_PERMIT covers a different token than expected');
  if (spender !== checkedAddress(expected.spender)) mismatch('PERMIT2_PERMIT grants a different spender than expected');
  if (details.amount < expected.minAmount) mismatch('PERMIT2_PERMIT grants less than the expected minimum amount');
  if (details.amount > expected.maxAmount) mismatch('PERMIT2_PERMIT grants more than the expected maximum amount');
  if (sigDeadline > expected.maxSigDeadline) mismatch('PERMIT2_PERMIT signature deadline is later than accepted');
  if (details.expiration > expected.maxExpiration) mismatch('PERMIT2_PERMIT allowance expires later than accepted');
  if (expected.minExpiration !== undefined && details.expiration < expected.minExpiration) {
    mismatch('PERMIT2_PERMIT allowance expires earlier than required');
  }
  if (expected.nonce !== undefined && details.nonce !== expected.nonce) mismatch('PERMIT2_PERMIT nonce is not the expected Permit2 nonce');
  return decoded;
}
