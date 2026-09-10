import { getAddress, keccak256, toBytes, zeroAddress, type Address, type Hex } from 'viem';
import { checkedAddress, getV4PoolId, type V4PoolReference } from './pool.js';
import { invalid } from './errors.js';

/** Structural contract implemented by protocol SDKs; contains no transport or signer. */
export interface V4ProviderDescriptor {
  schemaVersion: 1;
  providerId: string;
  deploymentId: string;
  substrate: 'uniswap-v4';
  chainId: number;
  poolManager: Address;
  startBlock: bigint;
  hooks: readonly Address[];
  discovery: {
    address: Address;
    eventSignature: string;
    poolIdParameter: string;
    expectedRuntimeCodeHash: Hex;
  };
  poolEvents: readonly V4PoolEvent[];
}
export type V4PoolEvent = 'Initialize' | 'Swap' | 'ModifyLiquidity' | 'Donate';
const signatures: Record<V4PoolEvent, string> = {
  Initialize: 'Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)',
  Swap: 'Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)',
  ModifyLiquidity: 'ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)',
  Donate: 'Donate(bytes32,address,uint256,uint256)',
};

/** Evidence is historical, not execution authorization. Protocol SDKs verify its meaning. */
export interface V4ProviderPool extends V4PoolReference {
  providerId: string;
  deploymentId: string;
  membership: {
    sourceAddress: Address;
    eventSignature: string;
    blockNumber: bigint;
    blockHash: Hex;
    transactionHash: Hex;
    logIndex: number;
  };
}

function hash(value: Hex) {
  if (!/^0x[\da-f]{64}$/i.test(value) || /^0x0{64}$/i.test(value)) invalid('Expected a nonzero bytes32 hash');
}
function block(value: bigint) {
  if (typeof value !== 'bigint' || value < 0n) invalid('Expected a nonnegative block number');
}
export function verifyV4ProviderDescriptor(provider: V4ProviderDescriptor): void {
  if (provider.schemaVersion !== 1 || provider.substrate !== 'uniswap-v4') invalid('Unsupported provider composition version or substrate');
  if (!provider.providerId?.trim() || !provider.deploymentId?.trim()) invalid('Provider and deployment identifiers are required');
  if (!Number.isSafeInteger(provider.chainId) || provider.chainId <= 0) invalid('Invalid provider chain ID');
  if (checkedAddress(provider.poolManager) === zeroAddress || checkedAddress(provider.discovery.address) === zeroAddress) invalid('Provider contracts cannot be zero addresses');
  block(provider.startBlock);
  hash(provider.discovery.expectedRuntimeCodeHash);
  if (!/^[A-Za-z]\w*\([^)]*\)$/.test(provider.discovery.eventSignature) || !provider.discovery.poolIdParameter) invalid('Explicit pool membership discovery is required');
  if (!provider.hooks.length) invalid('Provider must enumerate its reviewed hooks');
  provider.hooks.forEach(checkedAddress);
  if (!provider.poolEvents.length || provider.poolEvents.some(event => !Object.hasOwn(signatures, event))) invalid('Explicit supported pool events are required');
}

/** Structural/identity verification only; the protocol SDK verifies registration provenance. */
export function verifyV4ProviderPool(provider: V4ProviderDescriptor, pool: V4ProviderPool): void {
  verifyV4ProviderDescriptor(provider);
  if (pool.providerId !== provider.providerId || pool.deploymentId !== provider.deploymentId || pool.chainId !== provider.chainId
    || checkedAddress(pool.poolManager) !== checkedAddress(provider.poolManager)) invalid('Pool belongs to a different provider deployment');
  if (!provider.hooks.some(hook => checkedAddress(hook) === checkedAddress(pool.key.hooks))) invalid('Pool uses an unreviewed provider hook');
  if (getV4PoolId(pool.key).toLowerCase() !== pool.poolId.toLowerCase()) invalid('Pool ID differs from its full key');
  if (checkedAddress(pool.membership.sourceAddress) !== checkedAddress(provider.discovery.address)
    || pool.membership.eventSignature !== provider.discovery.eventSignature) invalid('Pool membership uses a different discovery source');
  block(pool.membership.blockNumber);
  if (pool.membership.blockNumber < provider.startBlock) invalid('Pool membership predates deployment');
  hash(pool.membership.blockHash); hash(pool.membership.transactionHash);
  if (!Number.isSafeInteger(pool.membership.logIndex) || pool.membership.logIndex < 0) invalid('Invalid membership log index');
}

/** Bounded eth_getLogs-compatible plans. Empty selections return no requests, never a wildcard.
 * Hosts must apply topics upstream, retain canonical membership evidence, and replay discovery
 * blocks when the selection changes. Each query covers its whole first block, including events
 * emitted before the registration log. Hosts own reorg rollback, cursors and finality.
 */
export function buildV4PoolSubscriptions(provider: V4ProviderDescriptor, pools: readonly V4ProviderPool[], options: {
  fromBlock: bigint; toBlock: bigint; maxPoolIdsPerRequest?: number;
  transport: { indexedTopicFiltering: boolean };
}) {
  verifyV4ProviderDescriptor(provider);
  block(options.fromBlock); block(options.toBlock);
  if (options.toBlock < options.fromBlock) invalid('Invalid subscription block range');
  if (!options.transport.indexedTopicFiltering) invalid('Selective v4 indexing requires upstream indexed-topic filtering');
  const size = options.maxPoolIdsPerRequest ?? 64;
  if (!Number.isSafeInteger(size) || size < 1 || size > 256) invalid('Pool filter batch size must be between 1 and 256');
  if (pools.length > 4096) invalid('At most 4096 selected pools per planning call');
  const selected = new Map<string, V4ProviderPool>();
  for (const pool of pools) {
    verifyV4ProviderPool(provider, pool);
    const id = pool.poolId.toLowerCase();
    const previous = selected.get(id);
    if (previous && (previous.membership.blockHash.toLowerCase() !== pool.membership.blockHash.toLowerCase()
      || previous.membership.blockNumber !== pool.membership.blockNumber
      || previous.membership.transactionHash.toLowerCase() !== pool.membership.transactionHash.toLowerCase()
      || previous.membership.logIndex !== pool.membership.logIndex)) invalid('Conflicting membership evidence; reconcile canonical history before subscribing');
    selected.set(id, pool);
  }
  const groups = new Map<bigint, Hex[]>();
  for (const [id, pool] of [...selected].sort(([a], [b]) => a.localeCompare(b))) {
    const start = pool.membership.blockNumber > options.fromBlock ? pool.membership.blockNumber : options.fromBlock;
    if (start > options.toBlock) continue;
    groups.set(start, [...(groups.get(start) ?? []), id as Hex]);
  }
  const plans: { providerId: string; deploymentId: string; chainId: number; address: Address; fromBlock: bigint; toBlock: bigint; topics: readonly [Hex, readonly Hex[]] }[] = [];
  for (const [fromBlock, ids] of [...groups].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    for (let offset = 0; offset < ids.length; offset += size) {
      for (const event of [...new Set(provider.poolEvents)]) plans.push({
        providerId: provider.providerId, deploymentId: provider.deploymentId,
        chainId: provider.chainId, address: getAddress(provider.poolManager), fromBlock, toBlock: options.toBlock,
        topics: [keccak256(toBytes(signatures[event])), ids.slice(offset, offset + size)],
      });
    }
  }
  return plans;
}
