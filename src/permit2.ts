import type { Address } from 'viem';
import { AllowanceTransfer, PERMIT2_ADDRESS } from './official-sdk.cjs';
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
 */
export function buildV4MintPermitBatchTypedData(input: {
  chainId: number;
  spender: Address;
  details: readonly V4PermitBatchDetailInput[];
  sigDeadline: bigint;
  /** Overrides the canonical Permit2 deployment; only for a non-standard deployment. */
  permit2Address?: Address;
}): V4PermitBatchTypedData {
  if (!Number.isSafeInteger(input.chainId) || input.chainId <= 0) invalid('chainId must be a positive safe integer');
  if (!input.details.length) invalid('Permit batch must include at least one token detail');
  const spender = checkedAddress(input.spender);
  const permit2Address = checkedAddress(input.permit2Address ?? (PERMIT2_ADDRESS as Address));

  try {
    const details = input.details.map(detail => ({
      token: checkedAddress(detail.token),
      amount: detail.amount.toString(),
      expiration: detail.expiration.toString(),
      nonce: detail.nonce.toString(),
    }));
    const { domain, types, values } = AllowanceTransfer.getPermitData(
      { details, spender, sigDeadline: input.sigDeadline.toString() },
      permit2Address,
      input.chainId,
    );
    const batch = values as { details: { token: string; amount: string; expiration: string; nonce: string }[]; spender: string; sigDeadline: string };
    return {
      domain: { name: 'Permit2', chainId: domain.chainId as number, verifyingContract: checkedAddress(domain.verifyingContract as Address) },
      types: types as unknown as V4PermitBatchTypedData['types'],
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
