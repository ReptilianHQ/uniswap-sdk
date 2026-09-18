import { Hook } from './official-sdk.cjs';
import type { Address } from 'viem';
import { checkedAddress } from './pool.js';

/**
 * A v4 hook's capability bits, decoded from its address. Field names match
 * Uniswap's `Hooks.sol`. Declared independently of `@uniswap/v4-sdk`'s own
 * `HookPermissions` (keyed by its nominal `HookOptions` enum) so callers can
 * work with plain string keys instead of importing that enum too.
 */
export interface V4HookPermissions {
  beforeInitialize: boolean;
  afterInitialize: boolean;
  beforeAddLiquidity: boolean;
  afterAddLiquidity: boolean;
  beforeRemoveLiquidity: boolean;
  afterRemoveLiquidity: boolean;
  beforeSwap: boolean;
  afterSwap: boolean;
  beforeDonate: boolean;
  afterDonate: boolean;
  beforeSwapReturnsDelta: boolean;
  afterSwapReturnsDelta: boolean;
  afterAddLiquidityReturnsDelta: boolean;
  afterRemoveLiquidityReturnsDelta: boolean;
}

/**
 * A v4 hook address encodes which PoolManager callbacks it implements in its low 14 bits
 * (mined via CREATE2, so PoolManager can check permissions without an external call).
 * Delegates the bit-to-callback mapping to `@uniswap/v4-sdk`'s `Hook` class rather than
 * re-deriving it, so the mapping stays pinned to a versioned upstream dependency instead
 * of drifting from memory.
 */
export function decodeV4HookPermissions(address: Address): V4HookPermissions {
  return Hook.permissions(checkedAddress(address)) as V4HookPermissions;
}

/**
 * The permission flags a hook implements that are not in `modelled`, i.e. the
 * behaviour a caller has not accounted for. Empty means every flag the hook
 * sets is one the caller already knows how to price and verify.
 *
 * This does not judge economic safety (tax rates, whether principal is
 * locked) — only whether the hook's *shape* is fully understood. That
 * judgement, and what "modelled" means for a given protocol, belongs to the
 * caller: a beforeSwap hook is fine to a caller that prices beforeSwap price
 * moves and unsafe to one that does not.
 */
export function unmodelledV4HookPermissions(
  address: Address,
  modelled: Iterable<keyof V4HookPermissions>,
): (keyof V4HookPermissions)[] {
  const allowed = new Set(modelled);
  const permissions = decodeV4HookPermissions(address);
  return (Object.keys(permissions) as (keyof V4HookPermissions)[]).filter(
    flag => permissions[flag] && !allowed.has(flag),
  );
}
