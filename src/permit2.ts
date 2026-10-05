import type { Address, Hex, PublicClient } from 'viem';
import {
  BaseError,
  encodeFunctionData,
  ExecutionRevertedError,
  hashTypedData,
  hexToBigInt,
  hexToNumber,
  isHex,
  numberToHex,
  recoverAddress,
  serializeSignature,
  sliceHex,
  zeroAddress,
} from 'viem';
import { AllowanceTransfer, permit2Address } from './official-sdk.cjs';
import { checkedAddress } from './pool.js';
import { invalid, rpc, UniswapSdkError } from './errors.js';
import { erc1271Abi, permit2Abi } from './abis.js';

export type V4PermitBatchDetailInput = {
  token: Address;
  amount: bigint;
  expiration: bigint;
  nonce: bigint;
};

export type V4PermitBatchTypedData = {
  domain: { name: 'Permit2'; chainId: number; verifyingContract: Address };
  types: {
    PermitBatch: readonly { name: string; type: string }[];
    PermitDetails: readonly { name: string; type: string }[];
  };
  primaryType: 'PermitBatch';
  message: {
    details: readonly { token: Address; amount: bigint; expiration: bigint; nonce: bigint }[];
    spender: Address;
    sigDeadline: bigint;
  };
};

function nonNegative(value: bigint, label: string): void {
  if (value < 0n) invalid(`${label} must not be negative`);
}

function nonZeroAddress(value: Address, label: string): Address {
  const checked = checkedAddress(value);
  if (checked === zeroAddress) invalid(`${label} cannot be the zero address`);
  return checked;
}

/**
 * Builds the EIP-712 typed data for a caller's wallet to sign, authorizing PositionManager
 * to pull the tokens a v4 mint needs via Permit2's `AllowanceTransfer.permitBatch`, instead
 * of a prior plain ERC20 `approve`. This SDK never holds a signer — the caller signs this
 * with their own wallet (`eth_signTypedData_v4`) and passes the resulting signature on to
 * whatever assembles the mint's `batchPermit` option; encoding that consumption side is a
 * separate, later piece.
 *
 * Delegates the domain and EIP-712 type definitions to `@uniswap/permit2-sdk`'s
 * `AllowanceTransfer.getPermitData` rather than hand-authoring them: Permit2's typed-data
 * schema lives only in its deployed contract, and no vendored Uniswap SDK re-derives it —
 * getting it wrong produces a signature that fails silently on-chain, not a caught error.
 *
 * `spender` is trusted as given — this function does not know what contract the caller
 * intends to grant to. Callers must pass PositionManager's own address, not a value taken
 * from unreviewed input; a wrong `spender` here authorizes an arbitrary contract to pull
 * the caller's tokens, and this SDK has no way to detect that from the typed data alone.
 */
export function buildV4MintPermitBatchTypedData(input: {
  chainId: number;
  spender: Address;
  details: readonly V4PermitBatchDetailInput[];
  sigDeadline: bigint;
  /** Overrides the canonical per-chain Permit2 deployment; only for a non-standard deployment. */
  permit2Address?: Address;
}): V4PermitBatchTypedData {
  if (!Number.isSafeInteger(input.chainId) || input.chainId <= 0) invalid('chainId must be a positive safe integer');
  if (!input.details.length) invalid('Permit batch must include at least one token detail');
  nonNegative(input.sigDeadline, 'sigDeadline');
  const spender = nonZeroAddress(input.spender, 'spender');
  const resolvedPermit2Address = nonZeroAddress(input.permit2Address ?? (permit2Address(input.chainId) as Address), 'permit2Address');

  try {
    const details = input.details.map(detail => {
      nonNegative(detail.amount, 'amount');
      nonNegative(detail.expiration, 'expiration');
      nonNegative(detail.nonce, 'nonce');
      return {
        token: checkedAddress(detail.token),
        amount: detail.amount.toString(),
        expiration: detail.expiration.toString(),
        nonce: detail.nonce.toString(),
      };
    });
    const { domain, types, values } = AllowanceTransfer.getPermitData(
      { details, spender, sigDeadline: input.sigDeadline.toString() },
      resolvedPermit2Address,
      input.chainId,
    );
    const batch = values as { details: { token: string; amount: string; expiration: string; nonce: string }[]; spender: string; sigDeadline: string };
    if (domain.name !== 'Permit2') invalid(`Official Permit2 SDK returned an unexpected domain name: ${String(domain.name)}`);
    return {
      domain: { name: 'Permit2', chainId: domain.chainId as number, verifyingContract: checkedAddress(domain.verifyingContract as Address) },
      // Deep-copied: `types` is the dependency's own module-level object: mutating the
      // returned value would otherwise corrupt every future call in this process.
      types: structuredClone(types) as unknown as V4PermitBatchTypedData['types'],
      primaryType: 'PermitBatch',
      message: {
        details: batch.details.map(detail => ({
          token: checkedAddress(detail.token as Address),
          amount: BigInt(detail.amount),
          expiration: BigInt(detail.expiration),
          nonce: BigInt(detail.nonce),
        })),
        spender: checkedAddress(batch.spender as Address),
        sigDeadline: BigInt(batch.sigDeadline),
      },
    };
  } catch (cause) {
    if (cause instanceof UniswapSdkError) throw cause;
    throw new UniswapSdkError('INVALID_ARGUMENT', 'Official Permit2 SDK rejected the permit batch parameters', { cause });
  }
}

/** Permit2 `IAllowanceTransfer.PermitDetails`: uint160 amount, uint48 expiration and nonce. */
export type PermitSingleDetails = { token: Address; amount: bigint; expiration: bigint; nonce: bigint };

/** Permit2 `IAllowanceTransfer.PermitSingle`, the struct `permit(owner, permitSingle, signature)` consumes. */
export type PermitSingle = { details: PermitSingleDetails; spender: Address; sigDeadline: bigint };

export type PermitSingleTypedData = {
  domain: { name: 'Permit2'; chainId: number; verifyingContract: Address };
  types: {
    PermitSingle: readonly { name: string; type: string }[];
    PermitDetails: readonly { name: string; type: string }[];
  };
  primaryType: 'PermitSingle';
  message: PermitSingle;
};


function uint(value: bigint, bits: 48n | 160n | 256n, label: string): bigint {
  if (typeof value !== 'bigint') invalid(`${label} must be a bigint`);
  if (value < 0n || value >= 1n << bits) invalid(`${label} must fit in uint${bits}`);
  return value;
}

/**
 * Checks every field of a PermitSingle against the width Permit2 declares for it and returns
 * a checksummed copy. Token and spender must be nonzero: Permit2 never covers the native
 * currency, and a zero spender authorizes nothing anyone can use.
 */
export function validatePermitSingle(permit: PermitSingle): PermitSingle {
  return {
    details: {
      token: nonZeroAddress(permit.details.token, 'token'),
      amount: uint(permit.details.amount, 160n, 'amount'),
      expiration: uint(permit.details.expiration, 48n, 'expiration'),
      nonce: uint(permit.details.nonce, 48n, 'nonce'),
    },
    spender: nonZeroAddress(permit.spender, 'spender'),
    sigDeadline: uint(permit.sigDeadline, 256n, 'sigDeadline'),
  };
}

/**
 * Builds the EIP-712 typed data for one token's Permit2 allowance (`PermitSingle`), which a
 * caller's wallet signs (`eth_signTypedData_v4`) so a spender such as the Universal Router can
 * consume it in the same transaction (`PERMIT2_PERMIT`) instead of a separate on-chain
 * `Permit2.approve`. The result is viem-compatible as is: pass it straight to
 * `signTypedData`, `hashTypedData`, or `verifyTypedData`.
 *
 * Like `buildV4MintPermitBatchTypedData`, the domain and type definitions come from
 * `@uniswap/permit2-sdk`'s `AllowanceTransfer.getPermitData`, never hand-authored.
 *
 * `spender` is trusted as given. Pass the reviewed router or manager address the signed
 * transaction will call, never a value from unreviewed input. `nonce` must be the owner's
 * current Permit2 nonce for this token and spender (`readPermit2Allowance`), or Permit2 rejects
 * the signature. `expiration` 0 means Permit2 expires the allowance at the permit's own block.
 */
export function buildPermitSingleTypedData(input: {
  chainId: number;
  token: Address;
  amount: bigint;
  expiration: bigint;
  nonce: bigint;
  spender: Address;
  sigDeadline: bigint;
  /** Overrides the canonical per-chain Permit2 deployment; only for a non-standard deployment. */
  permit2Address?: Address;
}): PermitSingleTypedData {
  if (!Number.isSafeInteger(input.chainId) || input.chainId <= 0) invalid('chainId must be a positive safe integer');
  const permit = validatePermitSingle({
    details: { token: input.token, amount: input.amount, expiration: input.expiration, nonce: input.nonce },
    spender: input.spender,
    sigDeadline: input.sigDeadline,
  });
  const resolvedPermit2Address = nonZeroAddress(input.permit2Address ?? (permit2Address(input.chainId) as Address), 'permit2Address');

  try {
    const { domain, types, values } = AllowanceTransfer.getPermitData(
      {
        details: {
          token: permit.details.token,
          amount: permit.details.amount.toString(),
          expiration: permit.details.expiration.toString(),
          nonce: permit.details.nonce.toString(),
        },
        spender: permit.spender,
        sigDeadline: permit.sigDeadline.toString(),
      },
      resolvedPermit2Address,
      input.chainId,
    );
    if (domain.name !== 'Permit2') invalid(`Official Permit2 SDK returned an unexpected domain name: ${String(domain.name)}`);
    if (!('PermitSingle' in types)) invalid('Official Permit2 SDK did not return PermitSingle typed data');
    const single = values as { details: { token: string; amount: string; expiration: string; nonce: string }; spender: string; sigDeadline: string };
    return {
      domain: { name: 'Permit2', chainId: domain.chainId as number, verifyingContract: checkedAddress(domain.verifyingContract as Address) },
      // Deep-copied for the same reason as the PermitBatch builder: `types` is module-level state.
      types: structuredClone(types) as unknown as PermitSingleTypedData['types'],
      primaryType: 'PermitSingle',
      message: {
        details: {
          token: checkedAddress(single.details.token as Address),
          amount: BigInt(single.details.amount),
          expiration: BigInt(single.details.expiration),
          nonce: BigInt(single.details.nonce),
        },
        spender: checkedAddress(single.spender as Address),
        sigDeadline: BigInt(single.sigDeadline),
      },
    };
  } catch (cause) {
    if (cause instanceof UniswapSdkError) throw cause;
    throw new UniswapSdkError('INVALID_ARGUMENT', 'Official Permit2 SDK rejected the permit parameters', { cause });
  }
}

export type Permit2SignatureClient = Pick<PublicClient, 'getChainId' | 'getCode' | 'call'>;

export type VerifyPermitSingleSignatureInput = {
  /** The account Permit2 will treat as signer: for `PERMIT2_PERMIT`, the transaction sender. */
  owner: Address;
  /** The chain the permit must be valid on; the client must be connected to it. */
  chainId: number;
  /** The Permit2 the permit must be valid for. Defaults to the canonical per-chain deployment. */
  permit2Address?: Address;
  signature: Hex;
  /** Block for the owner-code read and any ERC-1271 call. Defaults to latest. */
  blockNumber?: bigint;
} & (
  /** A permit decoded from calldata, e.g. `reviewPermit2PermitInput(...).permitSingle`. */
  | { permitSingle: PermitSingle; typedData?: never }
  /** Typed data from `buildPermitSingleTypedData`; its domain must equal `chainId` and Permit2. */
  | { typedData: PermitSingleTypedData; permitSingle?: never }
);

const ERC1271_MAGIC_VALUE = '0x1626ba7e';
// ERC-6492 wraps a counterfactual wallet's signature and ends it with this magic suffix.
const ERC6492_MAGIC_SUFFIX = '6492649264926492649264926492649264926492649264926492649264926492';
const HALF_WORD_MASK = (1n << 255n) - 1n;

/**
 * Whether Permit2 would accept `signature` as `owner`'s PermitSingle on `chainId`, following
 * Permit2's `SignatureVerification`:
 *
 * - an owner without code (an EOA) must produce a 65-byte signature with `v` of 27 or 28, or a
 *   64-byte EIP-2098 compact signature, that ecrecovers to the owner. This is checked locally
 *   once the owner's code has been read. `v` of 0 or 1 is rejected because Permit2 does not
 *   normalize it;
 * - an owner with code, including an EIP-7702-delegated EOA, must return the ERC-1271 magic
 *   value from its own `isValidSignature`, as one zero-padded 32-byte word;
 * - ERC-6492-wrapped signatures are rejected without any RPC. Permit2 never unwraps them, so a
 *   counterfactual wallet's permit reverts on chain. This is stricter than Permit2 only for a
 *   deployed wallet whose own `isValidSignature` happens to accept the wrapped bytes.
 *
 * The EIP-712 domain is always built from `chainId` and the expected Permit2, never taken from
 * the caller, and supplied `typedData` whose domain differs is refused. The client must be on
 * `chainId`. Owner code is read at `blockNumber`, while Permit2 checks it again at execution.
 * Returns `false` for a signature Permit2 would reject. Throws `INVALID_ARGUMENT` for malformed
 * input, `CHAIN_MISMATCH` for a client on another chain, and `RPC_ERROR` when the chain cannot
 * answer. This proves acceptance only, not that the nonce is current, the deadline is ahead,
 * or the spender is the one the host intends.
 */
export async function verifyPermitSingleSignature(
  client: Permit2SignatureClient,
  input: VerifyPermitSingleSignatureInput,
): Promise<boolean> {
  const owner = nonZeroAddress(input.owner, 'owner');
  if (!Number.isSafeInteger(input.chainId) || input.chainId <= 0) invalid('chainId must be a positive safe integer');
  const permit2 = nonZeroAddress(input.permit2Address ?? (permit2Address(input.chainId) as Address), 'permit2Address');
  const { signature } = input;
  if (!isHex(signature, { strict: true }) || signature.length <= 2 || signature.length % 2 !== 0) invalid('signature must be nonempty whole-byte hex');
  if (input.blockNumber !== undefined && (typeof input.blockNumber !== 'bigint' || input.blockNumber < 0n)) {
    invalid('blockNumber must be a nonnegative bigint');
  }
  if ((input.permitSingle === undefined) === (input.typedData === undefined)) invalid('Pass exactly one of permitSingle or typedData');
  let message: PermitSingle;
  if (input.typedData !== undefined) {
    const { domain, primaryType } = input.typedData;
    if (primaryType !== 'PermitSingle') invalid('typedData must be a Permit2 PermitSingle');
    if (domain?.name !== 'Permit2') invalid('typedData domain must be Permit2');
    if (domain.chainId !== input.chainId) invalid('typedData domain is for a different chain than expected');
    if (checkedAddress(domain.verifyingContract) !== permit2) invalid('typedData domain names a different Permit2 than expected');
    message = input.typedData.message;
  } else {
    message = input.permitSingle;
  }
  const typedData = buildPermitSingleTypedData({
    chainId: input.chainId,
    permit2Address: permit2,
    token: message.details.token,
    amount: message.details.amount,
    expiration: message.details.expiration,
    nonce: message.details.nonce,
    spender: message.spender,
    sigDeadline: message.sigDeadline,
  });
  const hash = hashTypedData(typedData);
  if (signature.toLowerCase().endsWith(ERC6492_MAGIC_SUFFIX)) return false;

  const code = await rpc(async () => {
    const chainId = await client.getChainId();
    if (chainId !== input.chainId) {
      throw new UniswapSdkError('CHAIN_MISMATCH', 'RPC chain does not match the permit chain', {
        path: 'chainId', expected: String(input.chainId), actual: String(chainId),
      });
    }
    return client.getCode({ address: owner, blockNumber: input.blockNumber });
  });
  if (code && code !== '0x') return erc1271Accepts(client, owner, hash, signature, input.blockNumber);
  return ecrecoverAccepts(owner, hash, signature);
}

/** Permit2's EOA branch: 64- or 65-byte signatures only, `v` as given, ecrecover semantics. */
async function ecrecoverAccepts(owner: Address, hash: Hex, signature: Hex): Promise<boolean> {
  const length = (signature.length - 2) / 2;
  let r: Hex;
  let s: bigint;
  let v: number;
  if (length === 65) {
    r = sliceHex(signature, 0, 32);
    s = hexToBigInt(sliceHex(signature, 32, 64));
    v = hexToNumber(sliceHex(signature, 64, 65));
  } else if (length === 64) {
    r = sliceHex(signature, 0, 32);
    const vs = hexToBigInt(sliceHex(signature, 32, 64));
    s = vs & HALF_WORD_MASK;
    v = Number(vs >> 255n) + 27;
  } else {
    return false; // InvalidSignatureLength; this also covers ERC-6492-wrapped signatures.
  }
  if (v !== 27 && v !== 28) return false; // The ecrecover precompile returns address(0).
  try {
    const signer = await recoverAddress({
      hash,
      signature: serializeSignature({ r, s: numberToHex(s, { size: 32 }), yParity: v === 28 ? 1 : 0 }),
    });
    return signer === owner;
  } catch {
    return false; // Out-of-range r or s, or no curve point: ecrecover returns address(0).
  }
}

// What Permit2's ABI decoder v2 (solc 0.8.17) accepts for `bytes4`: the selector, then zeroes.
const ERC1271_MAGIC_WORD = `${ERC1271_MAGIC_VALUE}${'00'.repeat(28)}`;

/**
 * Permit2's contract branch: the owner's own ERC-1271 `isValidSignature`, nothing else. The raw
 * return is read with `call` and must be exactly one 32-byte word holding the magic value with
 * zero padding. Permit2's decoder reverts on dirty padding, and a typed decode would hide that.
 * A longer return is also refused, which is stricter than Permit2 and so safe.
 */
async function erc1271Accepts(client: Permit2SignatureClient, owner: Address, hash: Hex, signature: Hex, blockNumber?: bigint): Promise<boolean> {
  let data: Hex | undefined;
  try {
    ({ data } = await client.call({
      to: owner,
      data: encodeFunctionData({ abi: erc1271Abi, functionName: 'isValidSignature', args: [hash, signature] }),
      blockNumber,
    }));
  } catch (cause) {
    // A revert makes Permit2 revert too: not accepted. Anything else is the transport's failure.
    if (cause instanceof BaseError && cause.walk(error => error instanceof ExecutionRevertedError)) return false;
    throw new UniswapSdkError('RPC_ERROR', 'ERC-1271 signature check failed', { cause });
  }
  return data !== undefined && data.toLowerCase() === ERC1271_MAGIC_WORD;
}

export type Permit2AllowanceReadClient = Pick<PublicClient, 'getChainId' | 'getBlockNumber' | 'readContract'>;

export interface Permit2Allowance {
  chainId: number;
  permit2: Address;
  owner: Address;
  token: Address;
  spender: Address;
  /** Remaining allowance; `2^160 - 1` is unlimited and Permit2 does not decrement it. */
  amount: bigint;
  /** Unix seconds after which the allowance is unusable. */
  expiration: bigint;
  /** The nonce the owner's next PermitSingle for this token and spender must carry. */
  nonce: bigint;
  blockNumber: bigint;
}

/**
 * Reads `Permit2.allowance(owner, token, spender)` at one block. Returns the observation block
 * so a following `buildPermitSingleTypedData` can retain which state its nonce came from.
 * `chainId`, when given, must match the RPC; Permit2 defaults to the canonical per-chain address.
 *
 * The nonce is only a snapshot of the latest (or given) block:
 * - two permits signed concurrently for the same owner, token, and spender read the same
 *   nonce, and the second one to land reverts. Serialize signing per (owner, token, spender);
 * - a submitted permit's signature is public. Anyone can send it to `Permit2.permit` first,
 *   consuming the nonce so the router's `PERMIT2_PERMIT` reverts and takes the swap with it.
 *   Encoding that command with allow-revert (`allowRevert: [PERMIT2_PERMIT]`) keeps the swap
 *   running on the allowance the front-runner installed. It also lets the swap run on any
 *   standing allowance when the permit fails for another reason, so bound that allowance with
 *   this read or simulate the exact call;
 * - `lockdown` and `invalidateNonces` also move or revoke state between read and use.
 */
export async function readPermit2Allowance(
  client: Permit2AllowanceReadClient,
  input: { owner: Address; token: Address; spender: Address; chainId?: number; permit2Address?: Address; blockNumber?: bigint },
): Promise<Permit2Allowance> {
  const owner = nonZeroAddress(input.owner, 'owner');
  const token = nonZeroAddress(input.token, 'token');
  const spender = nonZeroAddress(input.spender, 'spender');
  if (input.blockNumber !== undefined && (typeof input.blockNumber !== 'bigint' || input.blockNumber < 0n)) {
    invalid('blockNumber must be a nonnegative bigint');
  }
  const override = input.permit2Address === undefined ? undefined : nonZeroAddress(input.permit2Address, 'permit2Address');
  return rpc(async () => {
    const chainId = await client.getChainId();
    if (input.chainId !== undefined && chainId !== input.chainId) {
      throw new UniswapSdkError('CHAIN_MISMATCH', 'RPC chain does not match the requested chain', {
        path: 'chainId', expected: String(input.chainId), actual: String(chainId),
      });
    }
    const permit2 = override ?? checkedAddress(permit2Address(chainId) as Address);
    const blockNumber = input.blockNumber ?? await client.getBlockNumber();
    const [amount, expiration, nonce] = await client.readContract({
      address: permit2, abi: permit2Abi, functionName: 'allowance', args: [owner, token, spender], blockNumber,
    });
    return { chainId, permit2, owner, token, spender, amount, expiration: BigInt(expiration), nonce: BigInt(nonce), blockNumber };
  });
}
