import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { buildV4MintPermitBatchTypedData } from './permit2.js';
import { isUniswapSdkError } from './errors.js';

const spender: Address = '0x0000000000000000000000000000000000000900';
const tokenA: Address = '0x0000000000000000000000000000000000000010';
const tokenB: Address = '0x0000000000000000000000000000000000000020';
const permit2Address: Address = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

const baseInput = {
  chainId: 1,
  spender,
  details: [
    { token: tokenA, amount: 1_000_000n, expiration: 9_999_999_999n, nonce: 0n },
    { token: tokenB, amount: 2_000_000n, expiration: 9_999_999_999n, nonce: 1n },
  ],
  sigDeadline: 9_999_999_999n,
};

describe('v4 mint Permit2 typed data', () => {
  it('builds the canonical Permit2 domain and PermitBatch/PermitDetails EIP-712 types', () => {
    const typedData = buildV4MintPermitBatchTypedData(baseInput);
    expect(typedData.domain).toEqual({ name: 'Permit2', chainId: 1, verifyingContract: permit2Address });
    expect(typedData.primaryType).toBe('PermitBatch');
    expect(typedData.types.PermitBatch).toEqual([
      { name: 'details', type: 'PermitDetails[]' },
      { name: 'spender', type: 'address' },
      { name: 'sigDeadline', type: 'uint256' },
    ]);
    expect(typedData.types.PermitDetails).toEqual([
      { name: 'token', type: 'address' },
      { name: 'amount', type: 'uint160' },
      { name: 'expiration', type: 'uint48' },
      { name: 'nonce', type: 'uint48' },
    ]);
  });

  it('round-trips the batch details, spender, and sigDeadline as bigints', () => {
    const typedData = buildV4MintPermitBatchTypedData(baseInput);
    expect(typedData.message).toEqual({
      details: [
        { token: tokenA, amount: 1_000_000n, expiration: 9_999_999_999n, nonce: 0n },
        { token: tokenB, amount: 2_000_000n, expiration: 9_999_999_999n, nonce: 1n },
      ],
      spender,
      sigDeadline: 9_999_999_999n,
    });
  });

  it('accepts an explicit permit2Address override for a non-standard deployment', () => {
    const override: Address = '0x0000000000000000000000000000000000000abc';
    const typedData = buildV4MintPermitBatchTypedData({ ...baseInput, permit2Address: override });
    expect(typedData.domain.verifyingContract.toLowerCase()).toBe(override.toLowerCase());
  });

  it('rejects an empty details array, an invalid chainId, and an invalid address as UniswapSdkError', () => {
    for (const bad of [
      { details: [] },
      { chainId: 0 },
      { chainId: -1 },
      { spender: 'not-an-address' as Address },
    ]) {
      try {
        buildV4MintPermitBatchTypedData({ ...baseInput, ...bad });
        expect.unreachable('expected buildV4MintPermitBatchTypedData to reject this input');
      } catch (error) {
        expect(isUniswapSdkError(error)).toBe(true);
      }
    }
  });

  it('normalizes an official-SDK invariant failure (nonce out of range) into a UniswapSdkError', () => {
    // Permit2's own AllowanceTransfer.getPermitData enforces MaxOrderedNonce; this wrapper's
    // own pre-validation doesn't duplicate that range check, so this reaches the official SDK.
    try {
      buildV4MintPermitBatchTypedData({
        ...baseInput,
        details: [{ ...baseInput.details[0]!, nonce: 1n << 60n }],
      });
      expect.unreachable('expected an out-of-range nonce to be rejected');
    } catch (error) {
      expect(isUniswapSdkError(error)).toBe(true);
    }
  });
});
