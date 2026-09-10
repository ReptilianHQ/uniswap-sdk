import { v4StateViewAbi } from './abis.js';
import { invalid, rpc } from './errors.js';
import { poolReference, type V4Deployment, type V4PoolKey } from './pool.js';
import { assertManager, observationBlock, type V4Observation, type V4ReadClient } from './reads.js';

export interface V4Tick { tick: number; liquidityGross: bigint; liquidityNet: bigint }
export interface V4TickWindow extends V4Observation {
  ticks: V4Tick[];
  fromWord: number;
  toWord: number;
  /** True for an incomplete range OR any failed bitmap/tick observation. */
  partial: boolean;
  failedWords: number[];
  failedTicks: number[];
}

export function ticksInWord(wordPosition: number, bitmap: bigint, tickSpacing: number): number[] {
  if (!Number.isInteger(wordPosition) || wordPosition < -32768 || wordPosition > 32767) invalid('wordPosition must be int16');
  if (typeof bitmap !== 'bigint' || bitmap < 0n || bitmap >= 1n << 256n) invalid('bitmap must be uint256');
  if (!Number.isInteger(tickSpacing) || tickSpacing < 1 || tickSpacing > 32767) invalid('tickSpacing must be between 1 and 32767');
  const ticks: number[] = [];
  for (let bit = 0; bit < 256; bit++) {
    if ((bitmap & (1n << BigInt(bit))) !== 0n) {
      const tick = (wordPosition * 256 + bit) * tickSpacing;
      if (tick >= -887272 && tick <= 887272) ticks.push(tick);
    }
  }
  return ticks;
}

/** Raw initialized ticks, not an assertion of complete executable hook-adjusted depth. */
export async function readV4TickWindow(client: V4ReadClient, deployment: V4Deployment, key: V4PoolKey, options: { fromWord: number; toWord: number; blockNumber?: bigint }): Promise<V4TickWindow> {
  const reference = poolReference(deployment, key);
  const minTick = Math.ceil(-887272 / key.tickSpacing) * key.tickSpacing;
  const maxTick = Math.floor(887272 / key.tickSpacing) * key.tickSpacing;
  const minWord = Math.floor(minTick / key.tickSpacing / 256);
  const maxWord = Math.floor(maxTick / key.tickSpacing / 256);
  const { fromWord, toWord } = options;
  if (!Number.isInteger(fromWord) || !Number.isInteger(toWord) || fromWord < minWord || toWord > maxWord || fromWord > toWord || toWord - fromWord >= 16) invalid('Choose an ordered window of at most 16 bitmap words within the usable tick range');
  const blockNumber = await observationBlock(client, deployment, options.blockNumber);
  await assertManager(client, deployment, deployment.stateView, blockNumber);
  const failedWords: number[] = [];
  const failedTicks: number[] = [];
  const ticks: V4Tick[] = [];
  const words = Array.from({ length: toWord - fromWord + 1 }, (_, i) => fromWord + i);
  const wordResults = await Promise.allSettled(words.map(word => client.readContract({
    address: deployment.stateView, abi: v4StateViewAbi, functionName: 'getTickBitmap', args: [reference.poolId, word], blockNumber,
  })));
  const coordinates: number[] = [];
  wordResults.forEach((result, i) => {
    if (result.status === 'rejected') failedWords.push(words[i]);
    else coordinates.push(...ticksInWord(words[i], result.value, key.tickSpacing));
  });
  for (let offset = 0; offset < coordinates.length; offset += 16) {
    const batch = coordinates.slice(offset, offset + 16);
    const results = await Promise.allSettled(batch.map(tick => client.readContract({
      address: deployment.stateView, abi: v4StateViewAbi, functionName: 'getTickLiquidity', args: [reference.poolId, tick], blockNumber,
    })));
    results.forEach((result, i) => {
      if (result.status === 'rejected') failedTicks.push(batch[i]);
      else ticks.push({ tick: batch[i], liquidityGross: result.value[0], liquidityNet: result.value[1] });
    });
  }
  // A transport failure during the scan cannot silently relabel another chain's observations.
  await rpc(() => observationBlock(client, deployment, blockNumber));
  return { ...reference, blockNumber, fromWord, toWord, ticks, failedWords, failedTicks,
    partial: fromWord !== minWord || toWord !== maxWord || failedWords.length > 0 || failedTicks.length > 0 };
}
