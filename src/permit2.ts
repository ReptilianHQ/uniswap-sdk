import type { Address } from 'viem';
import { zeroAddress } from 'viem';
import { AllowanceTransfer, permit2Address } from './official-sdk.cjs';
import { checkedAddress } from './pool.js';
import { invalid, UniswapSdkError } from './errors.js';

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
