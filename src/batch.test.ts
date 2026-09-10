import { describe, expect, it } from 'vitest';
import { decodeFunctionData, encodeFunctionResult, zeroAddress, type Address } from 'viem';
import { v4QuoterAbi, v4StateViewAbi } from './abis.js';
import { decodeV4PoolState, quoteV4WithBatch, readV4PoolStatesWithBatch, readV4TicksWithBatch, v4DepthWordPositions, v4PoolStateCalls, type V4BatchTransport } from './batch.js';

const address: Address = '0x0000000000000000000000000000000000000010';
const id = `0x${'11'.repeat(32)}` as const;
const key = { currency0: zeroAddress, currency1: address, fee: 10000, tickSpacing: 200, hooks: zeroAddress };

describe('multicall host integration', () => {
  it('keeps quote order, direction, zero and malformed/reverted results distinct', async () => {
    const transport: V4BatchTransport = async calls => calls.map((call, i) => {
      const decoded = decodeFunctionData({ abi: v4QuoterAbi, data: call.callData });
      expect(decoded.args?.[0]).toMatchObject({ zeroForOne: false, hookData: '0x1234', exactAmount: BigInt(i) });
      if (i === 1) return { success: false, returnData: '0x' };
      if (i === 2) return { success: true, returnData: '0x1234' };
      return { success: true, returnData: encodeFunctionResult({ abi: v4QuoterAbi, functionName: 'quoteExactInputSingle', result: [0n, 99n] }) };
    });
    const result = await quoteV4WithBatch(transport, address, key, [0n, 1n, 2n].map(amountIn => ({ currencyIn: address, amountIn, hookData: '0x1234' })));
    expect(result[0]).toEqual({ status: 'success', amountOut: 0n, gasEstimate: 99n });
    expect(result.slice(1).every(item => item.status === 'failure')).toBe(true);
  });
  it('bounds multicalls and rejects response count drift', async () => {
    const sizes: number[] = [];
    const transport: V4BatchTransport = async calls => {
      sizes.push(calls.length);
      return calls.map(() => ({ success: false, returnData: '0x' }));
    };
    await quoteV4WithBatch(transport, address, key, Array.from({ length: 513 }, () => ({ currencyIn: address, amountIn: 1n, hookData: '0x' })));
    expect(sizes).toEqual([256, 256, 1]);
    await expect(quoteV4WithBatch(async () => [], address, key, [{ currencyIn: address, amountIn: 1n, hookData: '0x' }])).rejects.toMatchObject({ code: 'RPC_ERROR' });
  });
  it('combines standard pool state calls without changing slot ordering or zero-state probing', async () => {
    const transport: V4BatchTransport = async calls => calls.map(call => {
      const decoded = decodeFunctionData({ abi: v4StateViewAbi, data: call.callData });
      return { success: true, returnData: decoded.functionName === 'getSlot0'
        ? encodeFunctionResult({ abi: v4StateViewAbi, functionName: 'getSlot0', result: [0n, 0, 1000, 10000] })
        : encodeFunctionResult({ abi: v4StateViewAbi, functionName: 'getLiquidity', result: 0n }) };
    });
    expect((await readV4PoolStatesWithBatch(transport, address, [id]))[0]).toEqual({ sqrtPriceX96: 0n, tick: 0, protocolFee: 1000, lpFee: 10000, liquidity: 0n });
    expect(v4PoolStateCalls(address, id).every(call => !call.allowFailure)).toBe(true);
    expect(() => decodeV4PoolState([{ success: false, returnData: '0x' }])).toThrow();
  });
  it('retains full-range boundary ticks and marks incomplete bitmap reads partial', async () => {
    const words = v4DepthWordPositions(800, 200, 2);
    expect(words).toContain(-18); expect(words).toContain(17);
    const result = await readV4TicksWithBatch(async calls => calls.map(call => {
      const decoded = decodeFunctionData({ abi: v4StateViewAbi, data: call.callData });
      if (decoded.functionName === 'getTickBitmap') return { success: decoded.args[1] !== -18, returnData: encodeFunctionResult({ abi: v4StateViewAbi, functionName: 'getTickBitmap', result: 0n }) };
      throw new Error('No initialized ticks should be queried');
    }), address, id, 200, words);
    expect(result).toMatchObject({ ticks: [], failedWords: [-18], partial: true });
  });
});
