import { Percent, type Currency } from '@uniswap/sdk-core';
import type { Address, Hex } from 'viem';
import { Pool, Position, V4PositionManager } from './official-sdk.cjs';
import { checkedAddress } from './pool.js';
import { invalid, UniswapSdkError } from './errors.js';

export type V4TransactionMaterial = { to: Address; data: Hex; value: bigint };

/** Pool state as read from PoolManager/StateView (e.g. via `readV4Pool`), not yet a mint target. */
export type V4PoolState = {
  currency0: Currency;
  currency1: Currency;
  fee: number;
  tickSpacing: number;
  hooks: Address;
  sqrtPriceX96: bigint;
  liquidity: bigint;
  tickCurrent: number;
};

export type V4MintPositionParams = {
  positionManager: Address;
  pool: V4PoolState;
  tickLower: number;
  tickUpper: number;
  /** Liquidity units to mint, not a token amount. */
  liquidity: bigint;
  recipient: Address;
  /** Integer basis points, 0-10000. */
  slippageToleranceBps: number;
  deadlineSeconds: bigint;
  /** Passed to the hook's callbacks verbatim; this SDK does not construct it. */
  hookData?: Hex;
  /** Atomically initializes the pool before minting. Requires `pool.sqrtPriceX96` to be the intended starting price. */
  createPool?: boolean;
};

function slippagePercent(bps: number): Percent {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
    invalid('slippageToleranceBps must be an integer between 0 and 10000');
  }
  return new Percent(bps, 10_000);
}

/**
 * Builds unsigned calldata for `PositionManager.modifyLiquidities` minting a new v4 position.
 * Delegates encoding to `@uniswap/v4-sdk`'s `V4PositionManager`/`V4PositionPlanner` (the same
 * Actions/multicall encoding Uniswap's own SDK uses) rather than hand-rolling it, since v4's
 * calldata is a sequence of packed actions, not a single ABI-encoded function call like v3's.
 *
 * No Permit2 support yet — callers must have already approved the position manager via a plain
 * ERC20 approval, or the built transaction will revert on-chain. Hook-permission gating (refusing
 * a pool whose hook implements more than the caller has modelled) is also the caller's
 * responsibility; this function only encodes what it is given.
 */
export function buildV4MintPositionTransaction(input: V4MintPositionParams): V4TransactionMaterial {
  if (input.liquidity <= 0n) invalid('Mint liquidity must be positive');
  if (!Number.isInteger(input.tickLower) || !Number.isInteger(input.tickUpper) || input.tickLower >= input.tickUpper) {
    invalid('tickLower must be an integer less than tickUpper');
  }
  if (input.createPool && input.pool.sqrtPriceX96 <= 0n) invalid('createPool requires a positive initial sqrtPriceX96');
  const positionManager = checkedAddress(input.positionManager);
  const recipient = checkedAddress(input.recipient);
  const slippageTolerance = slippagePercent(input.slippageToleranceBps);

  try {
    const pool = new Pool(
      input.pool.currency0,
      input.pool.currency1,
      input.pool.fee,
      input.pool.tickSpacing,
      checkedAddress(input.pool.hooks),
      input.pool.sqrtPriceX96.toString(),
      input.pool.liquidity.toString(),
      input.pool.tickCurrent,
    );
    const position = new Position({
      pool,
      liquidity: input.liquidity.toString(),
      tickLower: input.tickLower,
      tickUpper: input.tickUpper,
    });
    const params = V4PositionManager.addCallParameters(position, {
      recipient,
      createPool: input.createPool ?? false,
      ...(input.createPool ? { sqrtPriceX96: input.pool.sqrtPriceX96.toString() } : {}),
      useNative: pool.currency0.isNative ? pool.currency0 : undefined,
      slippageTolerance,
      hookData: input.hookData,
      deadline: input.deadlineSeconds.toString(),
    });
    return { to: positionManager, data: params.calldata as Hex, value: BigInt(params.value) };
  } catch (cause) {
    if (cause instanceof UniswapSdkError) throw cause;
    throw new UniswapSdkError('INVALID_ARGUMENT', 'Official Uniswap SDK rejected the mint parameters', { cause });
  }
}
