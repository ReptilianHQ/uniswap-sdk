import type { Currency } from '@uniswap/sdk-core';
import { decodeAbiParameters, decodeFunctionData, parseAbiParameters, zeroAddress, type Address, type Hex } from 'viem';
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
/** PositionManager's `msgSender()` sentinel; the only address `SWEEP` may refund to. */
const MSG_SENDER: Address = '0x0000000000000000000000000000000000000001';

const unlockDataParams = parseAbiParameters('bytes actions, bytes[] params');
const poolKeyStruct = '(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)';
const mintPositionParams = parseAbiParameters(
  `${poolKeyStruct} poolKey, int24 tickLower, int24 tickUpper, uint256 liquidity, uint128 amount0Max, uint128 amount1Max, address owner, bytes hookData`,
);
const settlePairParams = parseAbiParameters('address currency0, address currency1');
const sweepParams = parseAbiParameters('address currency, address to');

export type V4PoolKeyMaterial = { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };
export type V4MintActionParams = {
  poolKey: V4PoolKeyMaterial;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  amount0Max: bigint;
  amount1Max: bigint;
  owner: Address;
  hookData: Hex;
  deadline: bigint;
  /** Present only if this mint atomically initializes the pool; the price it initializes at. */
  createdAtSqrtPriceX96?: bigint;
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

function samePoolKey(a: V4PoolKeyMaterial, b: V4PoolKeyMaterial): boolean {
  return same(a.currency0, b.currency0) && same(a.currency1, b.currency1)
    && a.fee === b.fee && a.tickSpacing === b.tickSpacing && same(a.hooks, b.hooks);
}

/**
 * Decodes and verifies calldata built by `buildV4MintPositionTransaction`: a
 * `modifyLiquidities` call — optionally wrapped in a `multicall` alongside pool
 * initialization — encoding exactly a MINT_POSITION action, a SETTLE_PAIR, and,
 * for a native-currency0 mint, a trailing SWEEP. This is the only action shape
 * that function produces; any other sequence is calldata this decoder does not
 * recognise as its own and refuses, rather than guessing at its meaning.
 *
 * `expected` must name the full pool (including `hooks`), not just the token
 * pair — a mint into the same pair through a different, unreviewed hook is a
 * different pool with different economics, not a cosmetic difference.
 * `currency0`/`currency1` must already be in canonical (sorted) order, and a
 * native-currency pool's `currency0` must be the zero address, matching how
 * `V4PoolKey`/`Pool` represent it elsewhere in this SDK — this function does
 * not reorder or reinterpret them. Pass `sqrtPriceX96` when the mint might
 * atomically create the pool; omitting it fails closed rather than silently
 * accepting whatever starting price the calldata sets.
 */
export function reviewV4MintPositionCalldata(data: Hex, expected: V4PoolKeyMaterial & {
  recipient: Address;
  /** Required if this mint might atomically create the pool; the only price that mint may set. */
  sqrtPriceX96?: bigint;
}): V4MintActionParams {
  try {
    const decoded = decodeFunctionData({ abi: v4PositionManagerAbi, data });
    let unlockData: Hex;
    let deadline: bigint;
    let initialization: { key: V4PoolKeyMaterial; sqrtPriceX96: bigint } | undefined;
    if (decoded.functionName === 'multicall') {
      const calls = decoded.args[0].map(call => decodeFunctionData({ abi: v4PositionManagerAbi, data: call }));
      if (calls.length !== 2 || calls[0]!.functionName !== 'initializePool' || calls[1]!.functionName !== 'modifyLiquidities') {
        mismatch('Mint calldata multicall must contain only pool initialization followed by one mint');
      }
      initialization = { key: calls[0]!.args[0] as V4PoolKeyMaterial, sqrtPriceX96: calls[0]!.args[1] as bigint };
      [unlockData, deadline] = calls[1]!.args as [Hex, bigint];
    } else if (decoded.functionName === 'modifyLiquidities') {
      [unlockData, deadline] = decoded.args;
    } else {
      return mismatch('Mint calldata is not a position-manager modifyLiquidities call');
    }

    const [actionsBytes, actionParams] = decodeAbiParameters(unlockDataParams, unlockData) as [Hex, readonly Hex[]];
    const actionIds = decodeActionIds(actionsBytes);
    if (actionIds.length !== actionParams.length) mismatch('Mint calldata has a different number of actions and action parameters');
    if (actionIds.length < 2 || actionIds.length > 3) mismatch('Mint calldata does not have the action count a plain mint produces');

    if (actionIds[0] !== MINT_POSITION_ACTION) mismatch('Mint calldata must begin with a MINT_POSITION action');
    const [poolKey, tickLower, tickUpper, liquidity, amount0Max, amount1Max, owner, hookData] = decodeAbiParameters(
      mintPositionParams,
      actionParams[0]!,
    ) as [V4PoolKeyMaterial, number, number, bigint, bigint, bigint, Address, Hex];
    if (liquidity <= 0n) mismatch('Mint calldata mints non-positive liquidity');

    if (initialization && !samePoolKey(initialization.key, poolKey)) {
      mismatch('Mint pool initialization targets a different pool than the position mint');
    }

    if (actionIds[1] !== SETTLE_PAIR_ACTION) mismatch('MINT_POSITION must be followed by a SETTLE_PAIR');
    const [settleCurrency0, settleCurrency1] = decodeAbiParameters(settlePairParams, actionParams[1]!) as [Address, Address];
    if (!same(settleCurrency0, poolKey.currency0) || !same(settleCurrency1, poolKey.currency1)) {
      mismatch('SETTLE_PAIR settles a different pair than the minted position');
    }

    if (actionIds.length === 3) {
      if (actionIds[2] !== SWEEP_ACTION) mismatch('Mint calldata has an unreviewed action after SETTLE_PAIR');
      const [sweepCurrency, sweepTo] = decodeAbiParameters(sweepParams, actionParams[2]!) as [Address, Address];
      if (!same(sweepCurrency, zeroAddress) && !same(sweepCurrency, poolKey.currency0)) {
        mismatch('SWEEP refunds an unexpected currency');
      }
      if (!same(sweepTo, MSG_SENDER)) mismatch('SWEEP sends the refund to an unexpected recipient');
    }

    if (!samePoolKey(poolKey, expected)) mismatch('Mint calldata targets a different pool than expected');
    if (!same(owner, expected.recipient)) mismatch('Mint calldata sends the position NFT to a different recipient');

    if (initialization) {
      if (expected.sqrtPriceX96 === undefined) {
        mismatch('Mint calldata initializes the pool but no expected starting price was supplied to verify it');
      }
      if (initialization.sqrtPriceX96 !== expected.sqrtPriceX96) {
        mismatch('Mint calldata initializes the pool at a different starting price than expected');
      }
    }

    return {
      poolKey, tickLower, tickUpper, liquidity, amount0Max, amount1Max, owner, hookData, deadline,
      ...(initialization ? { createdAtSqrtPriceX96: initialization.sqrtPriceX96 } : {}),
    };
  } catch (error) {
    if (error instanceof UniswapSdkError) throw error;
    throw new UniswapSdkError('CALLDATA_MISMATCH', 'Mint calldata contains undecodable position-manager calls', { cause: error });
  }
}
