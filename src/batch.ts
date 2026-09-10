import { decodeFunctionResult, encodeFunctionData, type Address, type Hex } from 'viem';
import { v4QuoterAbi, v4StateViewAbi } from './abis.js';
import { invalid, UniswapSdkError } from './errors.js';
import { checkedAddress, validatePoolKey, type V4PoolKey } from './pool.js';
import { ticksInWord } from './depth.js';

/** Host-owned batch transport. Host owns chain/wiring checks, block pinning and sender. */
export interface V4BatchCall { target: Address; allowFailure: boolean; callData: Hex }
export interface V4BatchResult { success: boolean; returnData: Hex }
export type V4BatchTransport = (calls: V4BatchCall[]) => Promise<readonly V4BatchResult[]>;
export interface V4PoolState { sqrtPriceX96: bigint; tick: number; protocolFee: number; lpFee: number; liquidity: bigint }
export type V4BatchQuote = { status: 'success'; amountOut: bigint; gasEstimate: bigint } | { status: 'failure'; error: UniswapSdkError };

function checkedPoolId(poolId: Hex): Hex {
  if (!/^0x[0-9a-fA-F]{64}$/.test(poolId)) invalid('poolId must be bytes32');
  return poolId;
}

async function batch(transport: V4BatchTransport, calls: V4BatchCall[]) {
  if (calls.length === 0) return [];
  const results = await transport(calls);
  if (results.length !== calls.length) throw new UniswapSdkError('RPC_ERROR', 'Batch response count does not match the request');
  return results;
}

/** Slot0 then liquidity; callers may combine these with other venues in one RPC. */
export function v4PoolStateCalls(stateView: Address, poolId: Hex): [V4BatchCall, V4BatchCall] {
  const target = checkedAddress(stateView);
  const args = [checkedPoolId(poolId)] as const;
  return [
    { target, allowFailure: false, callData: encodeFunctionData({ abi: v4StateViewAbi, functionName: 'getSlot0', args }) },
    { target, allowFailure: false, callData: encodeFunctionData({ abi: v4StateViewAbi, functionName: 'getLiquidity', args }) },
  ];
}

/** Zero state is valid for the bot's uninitialized-pool probes. */
export function decodeV4PoolState(results: readonly V4BatchResult[]): V4PoolState {
  if (results.length !== 2 || results.some(result => !result.success)) throw new UniswapSdkError('RPC_ERROR', 'Both pool state observations are required');
  try {
    const slot = decodeFunctionResult({ abi: v4StateViewAbi, functionName: 'getSlot0', data: results[0].returnData });
    const liquidity = decodeFunctionResult({ abi: v4StateViewAbi, functionName: 'getLiquidity', data: results[1].returnData });
    return { sqrtPriceX96: slot[0], tick: slot[1], protocolFee: slot[2], lpFee: slot[3], liquidity };
  } catch (cause) { throw new UniswapSdkError('RPC_ERROR', 'Pool state response cannot be decoded', { cause }); }
}

export async function readV4PoolStatesWithBatch(transport: V4BatchTransport, stateView: Address, poolIds: readonly Hex[]): Promise<V4PoolState[]> {
  const states: V4PoolState[] = [];
  for (let offset = 0; offset < poolIds.length; offset += 256) {
    const ids = poolIds.slice(offset, offset + 256);
    const results = await batch(transport, ids.flatMap(id => v4PoolStateCalls(stateView, id)));
    states.push(...ids.map((_, i) => decodeV4PoolState(results.slice(i * 2, i * 2 + 2))));
  }
  return states;
}

/** Explicit multicall opt-in: hooks see the host's multicall/Quoter context. */
export async function quoteV4WithBatch(
  transport: V4BatchTransport,
  quoter: Address,
  inputKey: V4PoolKey,
  inputs: readonly { currencyIn: Address; amountIn: bigint; hookData: Hex }[],
): Promise<V4BatchQuote[]> {
  const key = validatePoolKey(inputKey);
  const target = checkedAddress(quoter);
  const calls = inputs.map(input => {
    const currencyIn = checkedAddress(input.currencyIn);
    if (currencyIn !== key.currency0 && currencyIn !== key.currency1) invalid('Input currency does not belong to this pool');
    // Zero input was historically accepted by the bot's sizing probes.
    if (typeof input.amountIn !== 'bigint' || input.amountIn < 0n || input.amountIn >= 1n << 128n) invalid('amountIn must be uint128');
    if (typeof input.hookData !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(input.hookData)) invalid('hookData must be explicit even-length hex bytes');
    return { target, allowFailure: true, callData: encodeFunctionData({ abi: v4QuoterAbi, functionName: 'quoteExactInputSingle', args: [{ poolKey: key, zeroForOne: currencyIn === key.currency0, exactAmount: input.amountIn, hookData: input.hookData }] }) };
  });
  const quotes: V4BatchQuote[] = [];
  for (let offset = 0; offset < calls.length; offset += 256) {
    const results = await batch(transport, calls.slice(offset, offset + 256));
    quotes.push(...results.map((result): V4BatchQuote => {
      if (!result.success) return { status: 'failure', error: new UniswapSdkError('QUOTE_FAILED', 'Quoter simulation reverted') };
      try {
        const [amountOut, gasEstimate] = decodeFunctionResult({ abi: v4QuoterAbi, functionName: 'quoteExactInputSingle', data: result.returnData });
        return { status: 'success', amountOut, gasEstimate };
      } catch (cause) { return { status: 'failure', error: new UniswapSdkError('QUOTE_FAILED', 'Quoter response cannot be decoded', { cause }) }; }
    }));
  }
  return quotes;
}

export const V4_MIN_TICK = -887272;
export const V4_MAX_TICK = 887272;
export function usableV4TickRange(tickSpacing: number) {
  if (!Number.isInteger(tickSpacing) || tickSpacing < 1 || tickSpacing > 32767) invalid('tickSpacing must be between 1 and 32767');
  return { min: Math.ceil(V4_MIN_TICK / tickSpacing) * tickSpacing, max: Math.floor(V4_MAX_TICK / tickSpacing) * tickSpacing };
}
export function v4WordPosition(tick: number, tickSpacing: number) {
  usableV4TickRange(tickSpacing);
  if (!Number.isInteger(tick)) invalid('tick must be an integer');
  return Math.floor(Math.floor(tick / tickSpacing) / 256);
}
/** Spot window plus the two extremes, retaining full-range LP boundary ticks. */
export function v4DepthWordPositions(currentTick: number, tickSpacing: number, radius: number) {
  if (!Number.isSafeInteger(radius) || radius < 0) invalid('radius must be a nonnegative safe integer');
  const { min, max } = usableV4TickRange(tickSpacing);
  const lo = v4WordPosition(min, tickSpacing);
  const hi = v4WordPosition(max, tickSpacing);
  const centre = v4WordPosition(currentTick, tickSpacing);
  const words = new Set([lo, hi]);
  const start = Math.max(lo, centre - radius);
  const end = Math.min(hi, centre + radius);
  if (end - start + 1 > 257) invalid('Tick scan window must contain at most 257 bitmap words');
  for (let word = start; word <= end; word++) words.add(word);
  return [...words].sort((a, b) => a - b);
}

export async function readV4TicksWithBatch(transport: V4BatchTransport, stateView: Address, poolId: Hex, tickSpacing: number, words: readonly number[]) {
  const target = checkedAddress(stateView);
  checkedPoolId(poolId);
  const { min, max } = usableV4TickRange(tickSpacing);
  const lo = v4WordPosition(min, tickSpacing);
  const hi = v4WordPosition(max, tickSpacing);
  const unique = [...new Set(words)].sort((a, b) => a - b);
  if (unique.length > 259 || unique.some(word => !Number.isInteger(word) || word < lo || word > hi)) invalid('Tick scan must contain at most 259 usable bitmap words');
  const bitmaps = await batch(transport, unique.map(word => ({ target, allowFailure: true, callData: encodeFunctionData({ abi: v4StateViewAbi, functionName: 'getTickBitmap', args: [poolId, word] }) })));
  const failedWords: number[] = [];
  const failedTicks: number[] = [];
  const coordinates: number[] = [];
  bitmaps.forEach((result, i) => {
    try {
      if (!result.success) throw new Error('Missing bitmap');
      coordinates.push(...ticksInWord(unique[i], decodeFunctionResult({ abi: v4StateViewAbi, functionName: 'getTickBitmap', data: result.returnData }), tickSpacing));
    } catch { failedWords.push(unique[i]); }
  });
  const ticks: { tick: number; liquidityGross: bigint; liquidityNet: bigint }[] = [];
  for (let offset = 0; offset < coordinates.length; offset += 256) {
    const chunk = coordinates.slice(offset, offset + 256);
    const results = await batch(transport, chunk.map(tick => ({ target, allowFailure: true, callData: encodeFunctionData({ abi: v4StateViewAbi, functionName: 'getTickLiquidity', args: [poolId, tick] }) })));
    results.forEach((result, i) => {
      try {
        if (!result.success) throw new Error('Missing tick');
        const [liquidityGross, liquidityNet] = decodeFunctionResult({ abi: v4StateViewAbi, functionName: 'getTickLiquidity', data: result.returnData });
        ticks.push({ tick: chunk[i], liquidityGross, liquidityNet });
      } catch { failedTicks.push(chunk[i]); }
    });
  }
  return { ticks, failedWords, failedTicks, partial: unique.length < hi - lo + 1 || failedWords.length > 0 || failedTicks.length > 0 };
}
