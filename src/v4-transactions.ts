import type { Currency } from '@uniswap/sdk-core';
import { decodeAbiParameters, decodeFunctionData, parseAbiParameters, type Address, type Hex } from 'viem';
import { Percent, Pool, Position, V4PositionManager } from './official-sdk.cjs';
import { checkedAddress } from './pool.js';
import { invalid, UniswapSdkError } from './errors.js';
import { v4PositionManagerAbi } from './abis.js';

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

const MINT_POSITION_ACTION = 2;
const SETTLE_PAIR_ACTION = 13;
const SWEEP_ACTION = 20;

const unlockDataParams = parseAbiParameters('bytes actions, bytes[] params');
const mintPositionParams = parseAbiParameters(
  '(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, int24 tickLower, int24 tickUpper, uint256 liquidity, uint128 amount0Max, uint128 amount1Max, address owner, bytes hookData',
);
const settlePairParams = parseAbiParameters('address currency0, address currency1');
const sweepParams = parseAbiParameters('address currency, address to');

export type V4MintActionParams = {
  poolKey: { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  amount0Max: bigint;
  amount1Max: bigint;
  owner: Address;
  hookData: Hex;
};

function same(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function mismatch(message: string): never {
  throw new UniswapSdkError('CALLDATA_MISMATCH', message);
}

/** `bytes actions` packs one uint8 opcode per action, two hex characters each. */
function decodeActionIds(actions: Hex): number[] {
  const hex = actions.slice(2);
  if (hex.length % 2 !== 0) mismatch('Mint calldata has a malformed action byte string');
  const ids: number[] = [];
  for (let i = 0; i < hex.length; i += 2) ids.push(parseInt(hex.slice(i, i + 2), 16));
  return ids;
}

/**
 * Decodes and verifies calldata built by `buildV4MintPositionTransaction`: a
 * `modifyLiquidities` call — optionally wrapped in a `multicall` alongside pool
 * initialization — encoding exactly a MINT_POSITION action, a SETTLE_PAIR, and,
 * for a native-currency0 mint, a trailing SWEEP. This is the only action shape
 * that function produces; any other sequence is calldata this decoder does not
 * recognise as its own and refuses, rather than guessing at its meaning.
 */
export function reviewV4MintPositionCalldata(data: Hex, expected: {
  currency0: Address; currency1: Address; recipient: Address;
}): V4MintActionParams {
  try {
    const decoded = decodeFunctionData({ abi: v4PositionManagerAbi, data });
    let unlockData: Hex;
    if (decoded.functionName === 'multicall') {
      const calls = decoded.args[0].map(call => decodeFunctionData({ abi: v4PositionManagerAbi, data: call }));
      if (calls.length !== 2 || calls[0]!.functionName !== 'initializePool' || calls[1]!.functionName !== 'modifyLiquidities') {
        mismatch('Mint calldata multicall must contain only pool initialization followed by one mint');
      }
      unlockData = calls[1]!.args[0] as Hex;
    } else if (decoded.functionName === 'modifyLiquidities') {
      unlockData = decoded.args[0] as Hex;
    } else {
      return mismatch('Mint calldata is not a position-manager modifyLiquidities call');
    }

    const [actionsBytes, actionParams] = decodeAbiParameters(unlockDataParams, unlockData) as [Hex, readonly Hex[]];
    const actionIds = decodeActionIds(actionsBytes);

    if (actionIds[0] !== MINT_POSITION_ACTION) mismatch('Mint calldata must begin with a MINT_POSITION action');
    const [poolKey, tickLower, tickUpper, liquidity, amount0Max, amount1Max, owner, hookData] = decodeAbiParameters(
      mintPositionParams,
      actionParams[0]!,
    ) as [{ currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address }, number, number, bigint, bigint, bigint, Address, Hex];

    if (actionIds.length < 2 || actionIds[1] !== SETTLE_PAIR_ACTION) mismatch('MINT_POSITION must be followed by a SETTLE_PAIR');
    const [settleCurrency0, settleCurrency1] = decodeAbiParameters(settlePairParams, actionParams[1]!) as [Address, Address];
    if (!same(settleCurrency0, poolKey.currency0) || !same(settleCurrency1, poolKey.currency1)) {
      mismatch('SETTLE_PAIR settles a different pair than the minted position');
    }

    if (actionIds.length === 3) {
      if (actionIds[2] !== SWEEP_ACTION) mismatch('Mint calldata has an unreviewed action after SETTLE_PAIR');
      decodeAbiParameters(sweepParams, actionParams[2]!);
    } else if (actionIds.length !== 2) {
      mismatch('Mint calldata has more actions than a plain mint produces');
    }

    const expectedPair = [expected.currency0.toLowerCase(), expected.currency1.toLowerCase()].sort().join(':');
    if ([poolKey.currency0.toLowerCase(), poolKey.currency1.toLowerCase()].sort().join(':') !== expectedPair) {
      mismatch('Mint calldata targets a different token pair');
    }
    if (!same(owner, expected.recipient)) mismatch('Mint calldata sends the position NFT to a different recipient');

    return { poolKey, tickLower, tickUpper, liquidity, amount0Max, amount1Max, owner, hookData };
  } catch (error) {
    if (error instanceof UniswapSdkError) throw error;
    return mismatch('Mint calldata contains undecodable position-manager calls');
  }
}
