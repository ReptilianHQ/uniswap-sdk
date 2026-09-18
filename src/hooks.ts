import { Hook } from './official-sdk.cjs';
import type { HookPermissions } from '@uniswap/v4-sdk';
import type { Address } from 'viem';
import { checkedAddress } from './pool.js';

/** A v4 hook's capability bits, decoded from its address. Field names match Uniswap's `Hooks.sol`. */
export type V4HookPermissions = HookPermissions;

/**
 * A v4 hook address encodes which PoolManager callbacks it implements in its low 14 bits
 * (mined via CREATE2, so PoolManager can check permissions without an external call).
 * Delegates the bit-to-callback mapping to `@uniswap/v4-sdk`'s `Hook` class rather than
 * re-deriving it, so the mapping stays pinned to a versioned upstream dependency instead
 * of drifting from memory.
 */
export function decodeV4HookPermissions(address: Address): V4HookPermissions {
  return Hook.permissions(checkedAddress(address));
}
