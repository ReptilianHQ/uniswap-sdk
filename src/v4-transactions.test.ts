import { describe, expect, it } from 'vitest';
import { Ether, Token } from '@uniswap/sdk-core';
import { decodeFunctionData, zeroAddress, type Address } from 'viem';
import { v4PositionManagerAbi } from './abis.js';
import { buildV4MintPositionTransaction, type V4PoolState } from './v4-transactions.js';
import { isUniswapSdkError } from './errors.js';

const positionManager: Address = '0x0000000000000000000000000000000000000900';
const hooks: Address = '0x0000000000000000000000000000000000002044';
const recipient: Address = '0x0000000000000000000000000000000000000030';
const token = new Token(1, '0x0000000000000000000000000000000000000010', 18);
const other = new Token(1, '0x0000000000000000000000000000000000000020', 18);

const pool: V4PoolState = {
  currency0: token,
  currency1: other,
  fee: 3000,
  tickSpacing: 60,
  hooks,
  sqrtPriceX96: 1n << 96n,
  liquidity: 0n,
  tickCurrent: 0,
};

const baseParams = {
  positionManager,
  pool,
  tickLower: -60,
  tickUpper: 60,
  liquidity: 1_000_000n,
  recipient,
  slippageToleranceBps: 50,
  deadlineSeconds: 9_999_999_999n,
};

describe('v4 mint transaction', () => {
  it('encodes a plain mint as modifyLiquidities with the given deadline and zero value', () => {
    const material = buildV4MintPositionTransaction(baseParams);
    expect(material.to.toLowerCase()).toBe(positionManager.toLowerCase());
    expect(material.value).toBe(0n);
    const decoded = decodeFunctionData({ abi: v4PositionManagerAbi, data: material.data });
    expect(decoded.functionName).toBe('modifyLiquidities');
    expect(decoded.args[1]).toBe(baseParams.deadlineSeconds);
    expect((decoded.args[0] as string).length).toBeGreaterThan(2);
  });

  it('wraps pool initialization and mint in a multicall when createPool is set', () => {
    const material = buildV4MintPositionTransaction({ ...baseParams, createPool: true });
    const decoded = decodeFunctionData({ abi: v4PositionManagerAbi, data: material.data });
    expect(decoded.functionName).toBe('multicall');
    const calls = (decoded.args[0] as readonly `0x${string}`[]).map(call => decodeFunctionData({ abi: v4PositionManagerAbi, data: call }));
    expect(calls).toHaveLength(2);
    expect(calls[0]!.functionName).toBe('initializePool');
    expect(calls[0]!.args[0]).toMatchObject({ fee: pool.fee, tickSpacing: pool.tickSpacing });
    expect(calls[0]!.args[1]).toBe(pool.sqrtPriceX96);
    expect(calls[1]!.functionName).toBe('modifyLiquidities');
  });

  it('sends native value for a native-currency0 pool instead of requiring a prior wrap', () => {
    const nativePool: V4PoolState = { ...pool, currency0: Ether.onChain(1), hooks: zeroAddress };
    const material = buildV4MintPositionTransaction({ ...baseParams, pool: nativePool });
    expect(material.value).toBeGreaterThan(0n);
  });

  it('rejects non-positive liquidity, inverted ticks, out-of-range slippage, and createPool without a starting price', () => {
    for (const bad of [
      { liquidity: 0n },
      { tickLower: 60, tickUpper: -60 },
      { tickLower: 0, tickUpper: 0 },
      { slippageToleranceBps: -1 },
      { slippageToleranceBps: 10_001 },
    ]) {
      expect(() => buildV4MintPositionTransaction({ ...baseParams, ...bad })).toThrow();
    }
    expect(() => buildV4MintPositionTransaction({ ...baseParams, createPool: true, pool: { ...pool, sqrtPriceX96: 0n } })).toThrow();
  });

  it('normalizes a rejected input into a UniswapSdkError', () => {
    try {
      buildV4MintPositionTransaction({ ...baseParams, positionManager: 'not-an-address' as Address });
      expect.unreachable('an invalid position manager address must be rejected');
    } catch (error) {
      expect(isUniswapSdkError(error)).toBe(true);
    }
  });
});
