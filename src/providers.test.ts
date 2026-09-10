import { describe, expect, it } from 'vitest';
import { getV4PoolId } from './pool.js';
import { buildV4PoolSubscriptions, verifyV4ProviderPool, type V4ProviderDescriptor, type V4ProviderPool } from './providers.js';
import { encodeEventTopics, parseAbi, type Hex } from 'viem';
const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as const;
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;
const provider: V4ProviderDescriptor = {
  schemaVersion: 1, substrate: 'uniswap-v4', providerId: 'test', deploymentId: 'test-v1',
  chainId: 4663, poolManager: addr(1), hooks: [addr(2)], startBlock: 10n,
  discovery: { address: addr(2), eventSignature: 'Registered(bytes32)', poolIdParameter: 'poolId', expectedRuntimeCodeHash: hash(1) },
  poolEvents: ['Swap', 'ModifyLiquidity'],
};
function pool(n = 4, blockNumber = 12n): V4ProviderPool {
  const key = { currency0: addr(0), currency1: addr(n), fee: 3000, tickSpacing: 60, hooks: addr(2) };
  return { providerId: 'test', deploymentId: 'test-v1', chainId: 4663, poolManager: addr(1), key,
    poolId: getV4PoolId(key), membership: { sourceAddress: addr(2), eventSignature: 'Registered(bytes32)', blockNumber,
      blockHash: hash(2), transactionHash: hash(3), logIndex: 1 } };
}
const options = { fromBlock: 10n, toBlock: 30n, transport: { indexedTopicFiltering: true }, maxPoolIdsPerRequest: 2 };
describe('selective provider subscriptions', () => {
  it('never widens an empty selection into a PoolManager subscription', () => {
    expect(buildV4PoolSubscriptions(provider, [], options)).toEqual([]);
    expect(() => buildV4PoolSubscriptions(provider, [pool()], { ...options, transport: { indexedTopicFiltering: false } })).toThrow(/upstream/);
  });
  it('filters upstream, deduplicates, bounds batches, and starts at the whole discovery block', () => {
    const pools = [pool(4), pool(5), pool(6), pool(7, 20n), pool(4)];
    const plans = buildV4PoolSubscriptions(provider, pools, options);
    expect(plans).toHaveLength(6);
    expect(plans.every(plan => plan.topics[1].length <= 2 && plan.topics[1].length > 0)).toBe(true);
    expect(new Set(plans.flatMap(plan => plan.topics[1]))).toEqual(new Set(pools.map(p => p.poolId)));
    expect(plans.map(plan => plan.fromBlock)).toEqual([12n, 12n, 12n, 12n, 20n, 20n]);
    expect(buildV4PoolSubscriptions(provider, [...pools].reverse(), options)).toEqual(plans);
    expect(buildV4PoolSubscriptions(provider, [pool(4, 31n)], options)).toEqual([]);
  });
  it('rejects cross-provider, cross-chain, forged-key, and foreign-registration identities', () => {
    for (const mutate of [
      (p: V4ProviderPool) => { p.providerId = 'other'; },
      (p: V4ProviderPool) => { p.deploymentId = 'other'; },
      (p: V4ProviderPool) => { p.chainId = 1; },
      (p: V4ProviderPool) => { p.poolManager = addr(9); },
      (p: V4ProviderPool) => { p.key.hooks = addr(9); },
      (p: V4ProviderPool) => { p.poolId = hash(9); },
      (p: V4ProviderPool) => { p.membership.sourceAddress = addr(9); },
      (p: V4ProviderPool) => { p.membership.blockNumber = 9n; },
      (p: V4ProviderPool) => { p.membership.blockHash = hash(0); },
    ]) {
      const value = pool(); mutate(value);
      expect(() => verifyV4ProviderPool(provider, value)).toThrow();
    }
  });
  it('uses the canonical indexed topic for each standard pool event', () => {
    const abi = parseAbi([
      'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)',
      'event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)',
      'event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)',
      'event Donate(bytes32 indexed id, address indexed sender, uint256 amount0, uint256 amount1)',
    ]);
    const events = ['Initialize', 'Swap', 'ModifyLiquidity', 'Donate'] as const;
    const plans = buildV4PoolSubscriptions({ ...provider, poolEvents: events }, [pool()], options);
    expect(plans.map(plan => plan.topics[0])).toEqual(events.map(eventName => encodeEventTopics({ abi, eventName })[0]));
  });
  it('rejects contradictory membership checkpoints instead of hiding a reorg', () => {
    const alternative = pool(); alternative.membership.blockHash = hash(8);
    expect(() => buildV4PoolSubscriptions(provider, [pool(), alternative], options)).toThrow(/Conflicting/);
  });
});
