import { describe, expect, it } from 'vitest';
import { Ether, Token } from '@uniswap/sdk-core';
import { Pool } from '@uniswap/v4-sdk';
import { createPublicClient, custom, decodeFunctionData, encodeAbiParameters, encodeFunctionResult, encodeEventTopics, zeroAddress, type Address, type Hex } from 'viem';
import { v4PoolManagerAbi, v4QuoterAbi, v4StateViewAbi } from './abis.js';
import { decodeV4PoolInitialization, getV4PoolId, poolKeyFromCurrencies, poolReference, quoteV4Batch, quoteV4ExactInput, readV4Pool, readV4TickWindow, ticksInWord, verifyV4DeploymentWiring, type V4Deployment, type V4PoolKey } from './v4.js';

const token: Address = '0x0000000000000000000000000000000000000010';
const other: Address = '0x0000000000000000000000000000000000000020';
const account: Address = '0x0000000000000000000000000000000000000030';
const deployment: V4Deployment = { chainId: 4663, poolManager: '0x0000000000000000000000000000000000000100', stateView: '0x0000000000000000000000000000000000000200', quoter: '0x0000000000000000000000000000000000000300' };
const key: V4PoolKey = { currency0: zeroAddress, currency1: token, fee: 3000, tickSpacing: 60, hooks: zeroAddress };
const input = { currencyIn: token, amountIn: 5n, hookData: '0x1234' as Hex, account };

// Real viem encoding/decoding over a deterministic JSON-RPC transport, not mocked generics.
function fixture(options: { chainId?: number; manager?: Address; failAmount?: bigint; uninitialized?: boolean; failWord?: number; failTick?: number } = {}) {
  const calls: { to: Address; data: Hex; from?: Address; block: unknown }[] = [];
  const client = createPublicClient({ transport: custom({ request: async ({ method, params }) => {
    if (method === 'eth_chainId') return `0x${(options.chainId ?? deployment.chainId).toString(16)}`;
    if (method === 'eth_blockNumber') return '0x64';
    if (method !== 'eth_call') throw new Error(`Unexpected method ${method}`);
    const [call, block] = params as [{ to: Address; data: Hex; from?: Address }, unknown];
    calls.push({ ...call, block });
    const decoded = decodeFunctionData({ abi: [...v4StateViewAbi, ...v4QuoterAbi], data: call.data });
    if (decoded.functionName === 'poolManager') return encodeFunctionResult({ abi: v4StateViewAbi, functionName: 'poolManager', result: options.manager ?? deployment.poolManager });
    if (decoded.functionName === 'getSlot0') return encodeFunctionResult({ abi: v4StateViewAbi, functionName: 'getSlot0', result: [options.uninitialized ? 0n : 1n << 96n, 0, 1000, 3000] });
    if (decoded.functionName === 'getLiquidity') return encodeFunctionResult({ abi: v4StateViewAbi, functionName: 'getLiquidity', result: 500n });
    if (decoded.functionName === 'quoteExactInputSingle') {
      if (decoded.args[0].exactAmount === options.failAmount) throw new Error('simulation reverted');
      return encodeFunctionResult({ abi: v4QuoterAbi, functionName: 'quoteExactInputSingle', result: [decoded.args[0].exactAmount === 1n ? 0n : 7n, 25000n] });
    }
    if (decoded.functionName === 'getTickBitmap') {
      if (decoded.args[1] === options.failWord) throw new Error('word unavailable');
      return encodeFunctionResult({ abi: v4StateViewAbi, functionName: 'getTickBitmap', result: decoded.args[1] === 0 ? 3n : 0n });
    }
    if (decoded.functionName === 'getTickLiquidity') {
      if (decoded.args[1] === options.failTick) throw new Error('tick unavailable');
      return encodeFunctionResult({ abi: v4StateViewAbi, functionName: 'getTickLiquidity', result: [500n, decoded.args[1] === 0 ? 500n : -500n] });
    }
    throw new Error('Unexpected call');
  } }, { retryCount: 0 }) });
  return { client, calls };
}

describe('v4 pool identity', () => {
  it('matches the official SDK for native and ERC20 pairs across chains and fee modes', () => {
    for (const chainId of [1, 4663, 777777]) {
      for (const currency0 of [zeroAddress, token]) {
        for (const fee of [0, 500, 3000, 10000, 0x800000]) {
          const a = currency0 === zeroAddress ? Ether.onChain(chainId) : new Token(chainId, currency0, 6);
          const b = new Token(chainId, other, 18);
          const hooks = fee === 0x800000 ? account : zeroAddress;
          const actual = poolKeyFromCurrencies(b, a, fee, 60, hooks);
          expect(actual.currency0.toLowerCase()).toBe(currency0);
          expect(getV4PoolId(actual)).toBe(Pool.getPoolId(a, b, fee, 60, hooks));
          expect(poolReference({ ...deployment, chainId }, actual).chainId).toBe(chainId);
        }
      }
    }
  });
  it('rejects reordered/duplicate currencies, bad spacing, invalid fees and cross-chain currencies', () => {
    for (const bad of [{ currency0: token, currency1: zeroAddress }, { currency1: zeroAddress }, { tickSpacing: -1 }, { tickSpacing: 32768 }, { fee: 1000001 }, { fee: 0x800000 }]) {
      expect(() => getV4PoolId({ ...key, ...bad })).toThrow();
    }
    expect(() => poolKeyFromCurrencies(new Token(1, token, 18), new Token(4663, other, 18), 3000, 60, zeroAddress)).toThrow('same chain');
  });
  it('does not confuse identical pool IDs on different managers or chains', () => {
    const first = poolReference(deployment, key);
    const second = poolReference({ ...deployment, chainId: 777777, poolManager: account }, key);
    expect(first.poolId).toBe(second.poolId);
    expect(first).not.toEqual(second);
  });
});

describe('v4 observations and quotes', () => {
  it('pins reads and manager wiring to one observation block', async () => {
    const { client, calls } = fixture();
    const value = await readV4Pool(client, deployment, key);
    expect(value).toMatchObject({ chainId: 4663, blockNumber: 100n, liquidity: 500n, lpFee: 3000, protocolFee: 1000 });
    expect(calls.every(call => call.block === '0x64')).toBe(true);
    await expect(verifyV4DeploymentWiring(client, deployment)).resolves.toMatchObject({ blockNumber: 100n });
  });
  it('rejects wrong chain, wrong periphery and uninitialized pools', async () => {
    const wrong = fixture({ chainId: 1 });
    await expect(readV4Pool(wrong.client, deployment, key)).rejects.toMatchObject({ code: 'CHAIN_MISMATCH' });
    expect(wrong.calls).toHaveLength(0);
    await expect(readV4Pool(fixture({ manager: account }).client, deployment, key)).rejects.toMatchObject({ code: 'DEPLOYMENT_MISMATCH' });
    await expect(readV4Pool(fixture({ uninitialized: true }).client, deployment, key)).rejects.toMatchObject({ code: 'POOL_NOT_FOUND' });
  });
  it('preserves hook data, account, direction, ERC20 quote currencies, and block', async () => {
    const { client, calls } = fixture();
    const hookedKey = { ...key, currency0: token, currency1: other, hooks: account, fee: 0x800000 };
    const quote = await quoteV4ExactInput(client, deployment, hookedKey, input, { blockNumber: 80n });
    expect(quote).toMatchObject({ currencyIn: token, currencyOut: other, amountOut: 7n, hookData: '0x1234', blockNumber: 80n });
    const call = calls.at(-1)!;
    expect(call.from?.toLowerCase()).toBe(account);
    expect(call.block).toBe('0x50');
    expect(decodeFunctionData({ abi: v4QuoterAbi, data: call.data }).args?.[0]).toMatchObject({ zeroForOne: true, hookData: '0x1234' });
    const reverse = await quoteV4ExactInput(client, deployment, key, input);
    expect(reverse.currencyOut).toBe(zeroAddress);
    expect(decodeFunctionData({ abi: v4QuoterAbi, data: calls.at(-1)!.data }).args?.[0]).toMatchObject({ zeroForOne: false });
  });
  it('keeps failed quotes separate from valid zero output and preserves batch order', async () => {
    const { client } = fixture({ failAmount: 2n });
    const result = await quoteV4Batch(client, deployment, key, [1n, 2n, 3n].map(amountIn => ({ ...input, amountIn })), { concurrency: 2 });
    expect(result[0]).toMatchObject({ status: 'success', quote: { amountOut: 0n, blockNumber: 100n } });
    expect(result[1]).toMatchObject({ status: 'failure', index: 1, error: { code: 'QUOTE_FAILED' } });
    expect(result[2]).toMatchObject({ status: 'success', quote: { amountIn: 3n, blockNumber: 100n } });
  });
  it('rejects invalid quote inputs before eth_call', async () => {
    const { client, calls } = fixture();
    for (const change of [{ amountIn: 0n }, { amountIn: 1n << 128n }, { currencyIn: other }, { hookData: '0x1' as Hex }]) {
      await expect(quoteV4ExactInput(client, deployment, key, { ...input, ...change })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    }
    expect(calls).toHaveLength(0);
  });
});

describe('v4 tick windows', () => {
  it('decodes negative bitmap words without truncation toward zero', () => {
    expect(ticksInWord(-1, 1n | (1n << 255n), 60)).toEqual([-15360, -60]);
  });
  it('reports failed bitmap and tick reads as partial even when the full range was requested', async () => {
    const spaced = { ...key, tickSpacing: 32767 };
    const result = await readV4TickWindow(fixture({ failWord: -1, failTick: 32767 }).client, deployment, spaced, { fromWord: -1, toWord: 0 });
    expect(result).toMatchObject({ partial: true, failedWords: [-1], failedTicks: [32767], ticks: [{ tick: 0, liquidityNet: 500n }] });
    const complete = await readV4TickWindow(fixture().client, deployment, spaced, { fromWord: -1, toWord: 0 });
    expect(complete.partial).toBe(false);
    expect(complete.ticks).toHaveLength(2);
  });
  it('bounds scan size and marks a successful limited window partial', async () => {
    await expect(readV4TickWindow(fixture().client, deployment, key, { fromWord: -10, toWord: 10 })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect((await readV4TickWindow(fixture().client, deployment, key, { fromWord: 0, toWord: 0 })).partial).toBe(true);
  });
});

describe('v4 discovery normalization', () => {
  it('checks manager, pool ID and removed logs', () => {
    const poolId = getV4PoolId(key);
    const topics = encodeEventTopics({ abi: v4PoolManagerAbi, eventName: 'Initialize', args: { id: poolId, currency0: key.currency0, currency1: key.currency1 } });
    const data = encodeAbiParameters([{ type: 'uint24' }, { type: 'int24' }, { type: 'address' }, { type: 'uint160' }, { type: 'int24' }], [key.fee, key.tickSpacing, key.hooks, 1n << 96n, 0]);
    const log = { address: deployment.poolManager, topics: topics as [Hex, ...Hex[]], data, blockNumber: 100n, transactionHash: poolId, logIndex: 1 };
    expect(decodeV4PoolInitialization(deployment, log)).toMatchObject({ poolId, key, blockNumber: 100n });
    expect(() => decodeV4PoolInitialization(deployment, { ...log, removed: true })).toThrow('Removed');
    expect(() => decodeV4PoolInitialization(deployment, { ...log, address: account })).toThrow('different');
    expect(() => decodeV4PoolInitialization(deployment, { ...log, topics: [topics[0] as Hex, `0x${'00'.repeat(32)}`, ...topics.slice(2) as Hex[]] })).toThrow('pool ID');
  });
});
