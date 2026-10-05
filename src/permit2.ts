import type { Address, Hex, PublicClient } from 'viem';
import { isHex, recoverTypedDataAddress, zeroAddress } from 'viem';
import { AllowanceTransfer, permit2Address } from './official-sdk.cjs';
import { checkedAddress } from './pool.js';
import { invalid, rpc, UniswapSdkError } from './errors.js';
import { permit2Abi } from './abis.js';

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

// ERC-6492 wraps a counterfactual wallet's signature and ends it with this magic suffix.
const ERC6492_MAGIC_SUFFIX = '6492649264926492649264926492649264926492649264926492649264926492';

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

export type Permit2SignatureClient = Pick<PublicClient, 'verifyTypedData'>;

/**
 * Whether `signature` is `owner`'s valid Permit2 signature over `typedData`, judged as Permit2
 * itself would: the typed data is rebuilt from its domain and message through
 * `buildPermitSingleTypedData` first, so a caller-supplied `types` or `primaryType` can never
 * make a signature over some other struct pass.
 *
 * An EOA signature is recovered locally with no RPC. Anything else, including a mismatch, an
 * ERC-1271 contract signature, or an ERC-6492 counterfactual-wallet signature, falls back to
 * the host client's `verifyTypedData`, which performs the on-chain checks. Returns `false` for
 * a well-formed signature by someone else; throws `INVALID_ARGUMENT` for malformed input and
 * `RPC_ERROR` when the fallback cannot be answered. This proves authorship only, not that the
 * nonce is current, the deadline is ahead, or the spender is the one the host intends.
 */
export async function verifyPermitSingleSignature(
  client: Permit2SignatureClient,
  input: { owner: Address; typedData: PermitSingleTypedData; signature: Hex },
): Promise<boolean> {
  const owner = nonZeroAddress(input.owner, 'owner');
  if (!isHex(input.signature, { strict: true }) || input.signature.length <= 2) invalid('signature must be nonempty hex');
  const { domain, primaryType, message } = input.typedData;
  if (primaryType !== 'PermitSingle') invalid('typedData must be a Permit2 PermitSingle');
  if (domain?.name !== 'Permit2') invalid('typedData domain must be Permit2');
  const typedData = buildPermitSingleTypedData({
    chainId: domain.chainId,
    permit2Address: domain.verifyingContract,
    token: message.details.token,
    amount: message.details.amount,
    expiration: message.details.expiration,
    nonce: message.details.nonce,
    spender: message.spender,
    sigDeadline: message.sigDeadline,
  });

  if (!input.signature.toLowerCase().endsWith(ERC6492_MAGIC_SUFFIX)) {
    try {
      const recovered = await recoverTypedDataAddress({ ...typedData, signature: input.signature });
      if (recovered === owner) return true;
    } catch {
      // Not a recoverable ECDSA signature; it may still be a contract wallet's.
    }
  }
  return rpc(() => client.verifyTypedData({ address: owner, ...typedData, signature: input.signature }));
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
