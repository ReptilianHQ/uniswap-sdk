import { decodeEventLog, type Address, type Hex } from 'viem';
import { v4PoolManagerAbi } from './abis.js';
import { invalid } from './errors.js';
import { checkedAddress, poolReference, type V4Deployment } from './pool.js';

/** Normalize an Initialize log supplied by an indexer or bounded RPC scan. */
export function decodeV4PoolInitialization(deployment: V4Deployment, log: {
  address: Address; data: Hex; topics: [Hex, ...Hex[]]; blockNumber: bigint; transactionHash: Hex; logIndex: number; removed?: boolean;
}) {
  if (log.removed) invalid('Removed logs cannot establish pool discovery');
  if (checkedAddress(log.address) !== checkedAddress(deployment.poolManager)) invalid('Initialize log came from a different PoolManager');
  const decoded = decodeEventLog({ abi: v4PoolManagerAbi, data: log.data, topics: log.topics, strict: true });
  if (decoded.eventName !== 'Initialize') invalid('Expected an Initialize event');
  const reference = poolReference(deployment, decoded.args);
  if (reference.poolId.toLowerCase() !== decoded.args.id.toLowerCase()) invalid('Initialize PoolKey does not match its pool ID');
  return { ...reference, sqrtPriceX96: decoded.args.sqrtPriceX96, tick: decoded.args.tick,
    blockNumber: log.blockNumber, transactionHash: log.transactionHash, logIndex: log.logIndex };
}
