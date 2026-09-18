import { describe, expect, it } from 'vitest';
import { zeroAddress, type Address } from 'viem';
import { decodeV4HookPermissions, unmodelledV4HookPermissions } from './hooks.js';

// Real, deployed Argus v4 tax hook (argus-sdk/fixtures/arc-receipts.json, argus-sdk/provenance/mainnet.json).
// Its low 14 bits mask to 0x2044, cross-checked against argus-sdk's own runtime assertion
// `(BigInt(hook) & 0x3fffn) === 0x2044n` (argus-sdk/src/transactions.ts:639) and against
// argus-sdk/audit/capabilities.json, which lists exactly afterSwap and beforeInitialize as
// the hook's mutating v4 callbacks.
const argusHook: Address = '0x8cfc010441a541382bf822500add757c62b8e044';

describe('v4 hook permission decoding', () => {
  it('decodes the live Argus hook as beforeInitialize + afterSwap + afterSwapReturnsDelta only', () => {
    expect(decodeV4HookPermissions(argusHook)).toEqual({
      beforeInitialize: true,
      afterInitialize: false,
      beforeAddLiquidity: false,
      afterAddLiquidity: false,
      beforeRemoveLiquidity: false,
      afterRemoveLiquidity: false,
      beforeSwap: false,
      afterSwap: true,
      beforeDonate: false,
      afterDonate: false,
      beforeSwapReturnsDelta: false,
      afterSwapReturnsDelta: true,
      afterAddLiquidityReturnsDelta: false,
      afterRemoveLiquidityReturnsDelta: false,
    });
  });

  it('reports no permissions for an address with none of the low 14 bits set', () => {
    expect(Object.values(decodeV4HookPermissions(zeroAddress))).toEqual(new Array(14).fill(false));
  });

  it('reports every permission for an address with all 14 low bits set', () => {
    const allFlags: Address = '0x0000000000000000000000000000000000003fff';
    expect(Object.values(decodeV4HookPermissions(allFlags))).toEqual(new Array(14).fill(true));
  });

  it('rejects an invalid address', () => {
    expect(() => decodeV4HookPermissions('not-an-address' as Address)).toThrow();
  });
});

describe('unmodelled v4 hook permissions', () => {
  it('is empty when every flag the hook sets is in the modelled set', () => {
    expect(unmodelledV4HookPermissions(argusHook, ['beforeInitialize', 'afterSwap', 'afterSwapReturnsDelta'])).toEqual([]);
  });

  it('is empty for a hook with no permissions regardless of the modelled set', () => {
    expect(unmodelledV4HookPermissions(zeroAddress, [])).toEqual([]);
  });

  it('names each set flag missing from a narrower modelled set', () => {
    expect(unmodelledV4HookPermissions(argusHook, ['beforeInitialize'])).toEqual(['afterSwap', 'afterSwapReturnsDelta']);
    expect(unmodelledV4HookPermissions(argusHook, [])).toEqual(['beforeInitialize', 'afterSwap', 'afterSwapReturnsDelta']);
  });
});
