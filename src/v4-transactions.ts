import type { Currency } from '@uniswap/sdk-core';
import { decodeAbiParameters, decodeFunctionData, parseAbiParameters, zeroAddress, type Address, type Hex } from 'viem';
import { Percent, Pool, Position, V4PositionManager } from './official-sdk.cjs';
import { checkedAddress } from './pool.js';
import { invalid, UniswapSdkError } from './errors.js';
import { v4PositionManagerAbi } from './abis.js';
import { unmodelledV4HookPermissions, type V4HookPermissions } from './hooks.js';

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
  /** A Permit2 batch approval signed by the caller's own wallet; see `buildV4MintPermitBatchTypedData`. */
  batchPermit?: V4BatchPermit;
  /**
   * Permission flags the caller has reviewed for `pool.hooks` (see `decodeV4HookPermissions`).
   * Required whenever `pool.hooks` is not the zero address: a hook implementing a callback the
   * caller has not modelled can move price, take a cut, or otherwise change what this mint
   * actually does, so minting into one is refused rather than assumed benign.
   */
  modelledHookPermissions?: readonly (keyof V4HookPermissions)[];
};

export type V4RemovePositionParams = {
  positionManager: Address;
  pool: V4PoolState;
  tokenId: bigint;
  tickLower: number;
  tickUpper: number;
  /** Current on-chain position liquidity at the reviewed observation block. */
  liquidity: bigint;
  /** Exact liquidity units to remove. */
  liquidityToRemove: bigint;
  /** Burns the position NFT after removing all liquidity. */
  burnToken?: boolean;
  /** Integer basis points, 0-10000. */
  slippageToleranceBps: number;
  deadlineSeconds: bigint;
  /** Passed to the hook's callbacks verbatim; this SDK does not construct it. */
  hookData?: Hex;
  /** Permission flags reviewed for a nonzero pool hook. */
  modelledHookPermissions?: readonly (keyof V4HookPermissions)[];
};

export type V4IncreasePositionParams = {
  positionManager: Address;
  pool: V4PoolState;
  tokenId: bigint;
  tickLower: number;
  tickUpper: number;
  /** Exact liquidity units to add to the existing position. */
  liquidityToAdd: bigint;
  slippageToleranceBps: number;
  deadlineSeconds: bigint;
  hookData?: Hex;
  batchPermit?: V4BatchPermit;
  modelledHookPermissions?: readonly (keyof V4HookPermissions)[];
};

function slippagePercent(bps: number): Percent {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
    invalid('slippageToleranceBps must be an integer between 0 and 10000');
  }
  return new Percent(bps, 10_000);
}

function same(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export type V4BatchPermitDetail = { token: Address; amount: bigint; expiration: bigint; nonce: bigint };
export type V4BatchPermit = {
  owner: Address;
  permitBatch: { details: readonly V4BatchPermitDetail[]; spender: Address; sigDeadline: bigint };
  signature: Hex;
};

/**
 * Builds unsigned calldata for `PositionManager.modifyLiquidities` minting a new v4 position.
 * Delegates encoding to `@uniswap/v4-sdk`'s `V4PositionManager`/`V4PositionPlanner` (the same
 * Actions/multicall encoding Uniswap's own SDK uses) rather than hand-rolling it, since v4's
 * calldata is a sequence of packed actions, not a single ABI-encoded function call like v3's.
 *
 * Pass `batchPermit` (built via `buildV4MintPermitBatchTypedData` and signed by the caller's own
 * wallet) to fold a Permit2 approval into this same transaction instead of requiring a prior,
 * separate ERC20 `approve`. Without it, callers must already hold a plain ERC20 approval or the
 * built transaction will revert on-chain.
 *
 * If `pool.hooks` is not the zero address, `modelledHookPermissions` is required and this
 * function refuses to mint if the hook implements any permission flag outside it (see
 * `decodeV4HookPermissions`/`unmodelledV4HookPermissions`) — a hook can move price, take a cut,
 * or otherwise change what this mint actually does, so an unreviewed one is refused rather than
 * assumed benign.
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
  const hooks = checkedAddress(input.pool.hooks);

  if (!same(hooks, zeroAddress)) {
    if (!input.modelledHookPermissions) {
      invalid('pool.hooks is set but no modelledHookPermissions were supplied to verify it');
    }
    const unmodelled = unmodelledV4HookPermissions(hooks, input.modelledHookPermissions);
    if (unmodelled.length) invalid(`Pool hook implements unmodelled permissions: ${unmodelled.join(', ')}`);
  }

  if (input.batchPermit) {
    if (!same(input.batchPermit.permitBatch.spender, positionManager)) {
      invalid('batchPermit.permitBatch.spender must be the position manager this transaction submits to');
    }
    if (!input.batchPermit.permitBatch.details.length) invalid('batchPermit.permitBatch.details must include at least one token');
    const poolTokens = [input.pool.currency0, input.pool.currency1]
      .filter(currency => !currency.isNative)
      .map(currency => checkedAddress(currency.wrapped.address as Address));
    const seen = new Set<string>();
    for (const detail of input.batchPermit.permitBatch.details) {
      const token = checkedAddress(detail.token);
      if (!poolTokens.some(poolToken => same(poolToken, token))) {
        invalid('batchPermit.permitBatch.details references a token that is not part of this mint\'s pool');
      }
      if (seen.has(token.toLowerCase())) invalid('batchPermit.permitBatch.details lists the same token more than once');
      seen.add(token.toLowerCase());
    }
  }

  try {
    const pool = new Pool(
      input.pool.currency0,
      input.pool.currency1,
      input.pool.fee,
      input.pool.tickSpacing,
      hooks,
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
      ...(input.batchPermit ? {
        batchPermit: {
          owner: checkedAddress(input.batchPermit.owner),
          permitBatch: {
            details: input.batchPermit.permitBatch.details.map(detail => ({
              token: checkedAddress(detail.token),
              amount: detail.amount.toString(),
              expiration: detail.expiration.toString(),
              nonce: detail.nonce.toString(),
            })),
            spender: checkedAddress(input.batchPermit.permitBatch.spender),
            sigDeadline: input.batchPermit.permitBatch.sigDeadline.toString(),
          },
          signature: input.batchPermit.signature,
        },
      } : {}),
    });
    return { to: positionManager, data: params.calldata as Hex, value: BigInt(params.value) };
  } catch (cause) {
    if (cause instanceof UniswapSdkError) throw cause;
    throw new UniswapSdkError('INVALID_ARGUMENT', 'Official Uniswap SDK rejected the mint parameters', { cause });
  }
}

/**
 * Builds unsigned calldata that removes exact liquidity units from one V4 position and
 * returns both currencies to PositionManager's `msgSender()`. Full exits may atomically
 * burn the NFT. The caller must independently bind the token ID to the supplied PoolKey,
 * ticks, liquidity and owner at the same observation block; V4 removal calldata contains
 * a token ID rather than the complete PoolKey.
 */
export function buildV4RemovePositionTransaction(input: V4RemovePositionParams): V4TransactionMaterial {
  if (input.tokenId < 0n) invalid('Position token ID must be non-negative');
  if (input.liquidity <= 0n) invalid('Current position liquidity must be positive');
  if (input.liquidityToRemove <= 0n || input.liquidityToRemove > input.liquidity) {
    invalid('Liquidity to remove must be positive and no greater than current position liquidity');
  }
  if (!Number.isInteger(input.tickLower) || !Number.isInteger(input.tickUpper) || input.tickLower >= input.tickUpper) {
    invalid('tickLower must be an integer less than tickUpper');
  }
  if (input.burnToken && input.liquidityToRemove !== input.liquidity) {
    invalid('burnToken requires removing all current position liquidity');
  }
  const positionManager = checkedAddress(input.positionManager);
  const hooks = checkedAddress(input.pool.hooks);
  if (!same(hooks, zeroAddress)) {
    if (!input.modelledHookPermissions) {
      invalid('pool.hooks is set but no modelledHookPermissions were supplied to verify it');
    }
    const unmodelled = unmodelledV4HookPermissions(hooks, input.modelledHookPermissions);
    if (unmodelled.length) invalid(`Pool hook implements unmodelled permissions: ${unmodelled.join(', ')}`);
  }

  try {
    const pool = new Pool(
      input.pool.currency0,
      input.pool.currency1,
      input.pool.fee,
      input.pool.tickSpacing,
      hooks,
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
    const params = V4PositionManager.removeCallParameters(position, {
      tokenId: input.tokenId.toString(),
      liquidityPercentage: new Percent(input.liquidityToRemove.toString(), input.liquidity.toString()),
      burnToken: input.burnToken ?? false,
      slippageTolerance: slippagePercent(input.slippageToleranceBps),
      hookData: input.hookData,
      deadline: input.deadlineSeconds.toString(),
    });
    return { to: positionManager, data: params.calldata as Hex, value: BigInt(params.value) };
  } catch (cause) {
    if (cause instanceof UniswapSdkError) throw cause;
    throw new UniswapSdkError('INVALID_ARGUMENT', 'Official Uniswap SDK rejected the removal parameters', { cause });
  }
}

/** Builds unsigned calldata that increases one existing V4 position. */
export function buildV4IncreasePositionTransaction(input: V4IncreasePositionParams): V4TransactionMaterial {
  if (input.tokenId < 0n) invalid('Position token ID must be non-negative');
  if (input.liquidityToAdd <= 0n) invalid('Liquidity to add must be positive');
  if (!Number.isInteger(input.tickLower) || !Number.isInteger(input.tickUpper) || input.tickLower >= input.tickUpper) {
    invalid('tickLower must be an integer less than tickUpper');
  }
  const positionManager = checkedAddress(input.positionManager);
  const hooks = checkedAddress(input.pool.hooks);
  if (!same(hooks, zeroAddress)) {
    if (!input.modelledHookPermissions) invalid('pool.hooks is set but no modelledHookPermissions were supplied to verify it');
    const unmodelled = unmodelledV4HookPermissions(hooks, input.modelledHookPermissions);
    if (unmodelled.length) invalid(`Pool hook implements unmodelled permissions: ${unmodelled.join(', ')}`);
  }
  if (input.batchPermit) validateBatchPermit(input.batchPermit, positionManager, input.pool);

  try {
    const pool = new Pool(
      input.pool.currency0,
      input.pool.currency1,
      input.pool.fee,
      input.pool.tickSpacing,
      hooks,
      input.pool.sqrtPriceX96.toString(),
      input.pool.liquidity.toString(),
      input.pool.tickCurrent,
    );
    const position = new Position({
      pool,
      liquidity: input.liquidityToAdd.toString(),
      tickLower: input.tickLower,
      tickUpper: input.tickUpper,
    });
    const params = V4PositionManager.addCallParameters(position, {
      tokenId: input.tokenId.toString(),
      useNative: pool.currency0.isNative ? pool.currency0 : undefined,
      slippageTolerance: slippagePercent(input.slippageToleranceBps),
      hookData: input.hookData,
      deadline: input.deadlineSeconds.toString(),
      ...(input.batchPermit ? { batchPermit: serializableBatchPermit(input.batchPermit) } : {}),
    });
    return { to: positionManager, data: params.calldata as Hex, value: BigInt(params.value) };
  } catch (cause) {
    if (cause instanceof UniswapSdkError) throw cause;
    throw new UniswapSdkError('INVALID_ARGUMENT', 'Official Uniswap SDK rejected the increase parameters', { cause });
  }
}

function validateBatchPermit(batchPermit: V4BatchPermit, positionManager: Address, pool: V4PoolState): void {
  if (!same(batchPermit.permitBatch.spender, positionManager)) {
    invalid('batchPermit.permitBatch.spender must be the position manager this transaction submits to');
  }
  if (!batchPermit.permitBatch.details.length) invalid('batchPermit.permitBatch.details must include at least one token');
  const poolTokens = [pool.currency0, pool.currency1]
    .filter(currency => !currency.isNative)
    .map(currency => checkedAddress(currency.wrapped.address as Address));
  const seen = new Set<string>();
  for (const detail of batchPermit.permitBatch.details) {
    const token = checkedAddress(detail.token);
    if (!poolTokens.some(poolToken => same(poolToken, token))) {
      invalid('batchPermit.permitBatch.details references a token that is not part of this position pool');
    }
    if (seen.has(token.toLowerCase())) invalid('batchPermit.permitBatch.details lists the same token more than once');
    seen.add(token.toLowerCase());
  }
}

function serializableBatchPermit(batchPermit: V4BatchPermit) {
  return {
    owner: checkedAddress(batchPermit.owner),
    permitBatch: {
      details: batchPermit.permitBatch.details.map(detail => ({
        token: checkedAddress(detail.token),
        amount: detail.amount.toString(),
        expiration: detail.expiration.toString(),
        nonce: detail.nonce.toString(),
      })),
      spender: checkedAddress(batchPermit.permitBatch.spender),
      sigDeadline: batchPermit.permitBatch.sigDeadline.toString(),
    },
    signature: batchPermit.signature,
  };
}

const MINT_POSITION_ACTION = 2;
const INCREASE_LIQUIDITY_ACTION = 0;
const DECREASE_LIQUIDITY_ACTION = 1;
const BURN_POSITION_ACTION = 3;
const SETTLE_PAIR_ACTION = 13;
const TAKE_PAIR_ACTION = 17;
const CLOSE_CURRENCY_ACTION = 18;
const SWEEP_ACTION = 20;
/** PositionManager's `msgSender()` sentinel; the only address `SWEEP` may refund to. */
const MSG_SENDER: Address = '0x0000000000000000000000000000000000000001';

const unlockDataParams = parseAbiParameters('bytes actions, bytes[] params');
const poolKeyStruct = '(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)';
const mintPositionParams = parseAbiParameters(
  `${poolKeyStruct} poolKey, int24 tickLower, int24 tickUpper, uint256 liquidity, uint128 amount0Max, uint128 amount1Max, address owner, bytes hookData`,
);
const increaseLiquidityParams = parseAbiParameters(
  'uint256 tokenId, uint256 liquidity, uint128 amount0Max, uint128 amount1Max, bytes hookData',
);
const settlePairParams = parseAbiParameters('address currency0, address currency1');
const sweepParams = parseAbiParameters('address currency, address to');
const decreaseLiquidityParams = parseAbiParameters(
  'uint256 tokenId, uint256 liquidity, uint128 amount0Min, uint128 amount1Min, bytes hookData',
);
const burnPositionParams = parseAbiParameters(
  'uint256 tokenId, uint128 amount0Min, uint128 amount1Min, bytes hookData',
);
const takePairParams = parseAbiParameters('address currency0, address currency1, address recipient');
const closeCurrencyParams = parseAbiParameters('address currency');

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
  /** Present only if this mint folds in a Permit2 batch approval; the address that signed it. */
  batchPermitOwner?: Address;
};

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
 * A 1:1 pairing, not "every actual detail matches some expected detail" — that weaker check
 * would let `[A, A]` pass against `expected = [A, B]` (both actual entries match A; lengths
 * happen to agree), silently ignoring that B was never actually authorized and A appears twice.
 */
function sameBatchPermitDetails(actual: readonly V4BatchPermitDetail[], expected: readonly V4BatchPermitDetail[]): boolean {
  if (actual.length !== expected.length) return false;
  const remaining = expected.slice();
  for (const detail of actual) {
    const index = remaining.findIndex(candidate => same(candidate.token, detail.token)
      && candidate.amount === detail.amount && candidate.expiration === detail.expiration && candidate.nonce === detail.nonce);
    if (index === -1) return false;
    remaining.splice(index, 1);
  }
  return true;
}

export type V4ExpectedMint = V4PoolKeyMaterial & {
  recipient: Address;
  /**
   * Required if this mint might atomically create the pool; the only price that
   * mint may set. Checked only in that direction: supplying it does not require
   * the calldata to actually create the pool — a plain mint into an
   * already-initialized pool is unaffected either way, distinguishable from a
   * pool-creating mint by `createdAtSqrtPriceX96` being absent from the result.
   */
  sqrtPriceX96?: bigint;
  /**
   * Required if this mint folds in a Permit2 batch approval; the only owner/spender/
   * sigDeadline/token-detail set that approval may authorize. Checked only in that
   * direction, the same as `sqrtPriceX96` — omitting it fails closed if the calldata
   * does include a permit, rather than trusting whatever it authorizes.
   */
  batchPermit?: { owner: Address; spender: Address; sigDeadline: bigint; details: readonly V4BatchPermitDetail[] };
  /**
   * Required if `hooks` is not the zero address; the permission flags the caller has reviewed
   * for it. Minting into a hook that implements any other permission flag is refused — the
   * same gate `buildV4MintPositionTransaction` applies when building this calldata in the
   * first place, re-checked here independently of what the builder was told.
   */
  modelledHookPermissions?: readonly (keyof V4HookPermissions)[];
};

export type V4ExpectedRemoval = V4PoolKeyMaterial & {
  tokenId: bigint;
  /** Exact liquidity units reviewed for removal. Required for partial exits. */
  liquidityToRemove: bigint;
  burnToken: boolean;
  modelledHookPermissions?: readonly (keyof V4HookPermissions)[];
};

export type V4ExpectedIncrease = V4PoolKeyMaterial & {
  tokenId: bigint;
  batchPermit?: { owner: Address; spender: Address; sigDeadline: bigint; details: readonly V4BatchPermitDetail[] };
  modelledHookPermissions?: readonly (keyof V4HookPermissions)[];
};

export type V4IncreaseActionParams = {
  tokenId: bigint;
  liquidityAdded: bigint;
  amount0Max: bigint;
  amount1Max: bigint;
  hookData: Hex;
  currency0: Address;
  currency1: Address;
  deadline: bigint;
  batchPermitOwner?: Address;
};

/** Reviews the exact increase/settlement shape emitted by the corresponding builder. */
export function reviewV4IncreasePositionCalldata(data: Hex, expected: V4ExpectedIncrease): V4IncreaseActionParams {
  try {
    const decoded = decodeFunctionData({ abi: v4PositionManagerAbi, data });
    let unlockData: Hex;
    let deadline: bigint;
    let batchPermit: { owner: Address; spender: Address; sigDeadline: bigint; details: readonly V4BatchPermitDetail[] } | undefined;
    if (decoded.functionName === 'multicall') {
      const calls = decoded.args[0].map(call => decodeFunctionData({ abi: v4PositionManagerAbi, data: call }));
      if (calls.length < 1 || calls.length > 2) mismatch('Increase calldata multicall has an unexpected call count');
      const increaseCall = calls.at(-1)!;
      if (increaseCall.functionName !== 'modifyLiquidities') mismatch('Increase calldata multicall must end with modifyLiquidities');
      if (calls.length === 2) {
        const permitCall = calls[0]!;
        if (permitCall.functionName !== 'permitBatch') mismatch('Increase calldata contains an unreviewed call before modifyLiquidities');
        const [owner, permit] = permitCall.args as readonly [Address, { details: readonly { token: Address; amount: bigint; expiration: number; nonce: number }[]; spender: Address; sigDeadline: bigint }, Hex];
        batchPermit = {
          owner,
          spender: permit.spender,
          sigDeadline: permit.sigDeadline,
          details: permit.details.map(detail => ({ token: detail.token, amount: detail.amount, expiration: BigInt(detail.expiration), nonce: BigInt(detail.nonce) })),
        };
      }
      [unlockData, deadline] = increaseCall.args as [Hex, bigint];
    } else if (decoded.functionName === 'modifyLiquidities') {
      [unlockData, deadline] = decoded.args;
    } else {
      return mismatch('Increase calldata is not a position-manager modifyLiquidities call');
    }

    const [actionsBytes, actionParams] = decodeAbiParameters(unlockDataParams, unlockData) as [Hex, readonly Hex[]];
    const actionIds = decodeActionIds(actionsBytes);
    if (actionIds.length < 3 || actionIds.length > 4 || actionIds.length !== actionParams.length) {
      mismatch('Increase calldata has an unexpected action count');
    }
    if (actionIds[0] !== INCREASE_LIQUIDITY_ACTION) mismatch('Increase calldata must begin with INCREASE_LIQUIDITY');
    const [tokenId, liquidityAdded, amount0Max, amount1Max, hookData] = decodeAbiParameters(
      increaseLiquidityParams,
      actionParams[0]!,
    ) as [bigint, bigint, bigint, bigint, Hex];
    if (tokenId !== expected.tokenId) mismatch('Increase calldata targets a different position token ID');
    if (liquidityAdded <= 0n) mismatch('Increase calldata adds non-positive liquidity');
    if (actionIds[1] !== CLOSE_CURRENCY_ACTION || actionIds[2] !== CLOSE_CURRENCY_ACTION) {
      mismatch('INCREASE_LIQUIDITY must be followed by CLOSE_CURRENCY for both pool currencies');
    }
    const [currency0] = decodeAbiParameters(closeCurrencyParams, actionParams[1]!) as [Address];
    const [currency1] = decodeAbiParameters(closeCurrencyParams, actionParams[2]!) as [Address];
    if (!same(currency0, expected.currency0) || !same(currency1, expected.currency1)) {
      mismatch('CLOSE_CURRENCY actions target a different currency pair than expected');
    }
    if (actionIds.length === 4) {
      if (actionIds[3] !== SWEEP_ACTION) mismatch('Increase calldata has an unreviewed action after CLOSE_CURRENCY');
      const [sweepCurrency, sweepTo] = decodeAbiParameters(sweepParams, actionParams[3]!) as [Address, Address];
      if (!same(sweepCurrency, zeroAddress) && !same(sweepCurrency, expected.currency0)) mismatch('SWEEP refunds an unexpected currency');
      if (!same(sweepTo, MSG_SENDER)) mismatch('SWEEP sends the refund to an unexpected recipient');
    }
    if (!same(expected.hooks, zeroAddress)) {
      if (!expected.modelledHookPermissions) mismatch('Increase targets a pool with a hook but no modelled permissions were supplied');
      const unmodelled = unmodelledV4HookPermissions(expected.hooks, expected.modelledHookPermissions);
      if (unmodelled.length) mismatch(`Increase pool hook implements unmodelled permissions: ${unmodelled.join(', ')}`);
    }
    if (batchPermit) {
      if (!expected.batchPermit) mismatch('Increase calldata includes a Permit2 batch approval but no expected approval was supplied');
      const poolTokens = [expected.currency0, expected.currency1];
      const seen = new Set<string>();
      for (const detail of batchPermit.details) {
        if (same(detail.token, zeroAddress) || !poolTokens.some(token => same(token, detail.token))) {
          mismatch('Permit2 batch approval references a token outside the position pool');
        }
        if (seen.has(detail.token.toLowerCase())) mismatch('Permit2 batch approval lists the same token more than once');
        seen.add(detail.token.toLowerCase());
      }
      if (!same(batchPermit.owner, expected.batchPermit.owner)
        || !same(batchPermit.spender, expected.batchPermit.spender)
        || batchPermit.sigDeadline !== expected.batchPermit.sigDeadline
        || !sameBatchPermitDetails(batchPermit.details, expected.batchPermit.details)) {
        mismatch('Increase Permit2 batch approval does not match what was expected');
      }
    }
    return {
      tokenId,
      liquidityAdded,
      amount0Max,
      amount1Max,
      hookData,
      currency0,
      currency1,
      deadline,
      ...(batchPermit ? { batchPermitOwner: batchPermit.owner } : {}),
    };
  } catch (error) {
    if (error instanceof UniswapSdkError) throw error;
    throw new UniswapSdkError('CALLDATA_MISMATCH', 'Increase calldata contains undecodable position-manager calls', { cause: error });
  }
}

export type V4RemoveActionParams = {
  tokenId: bigint;
  liquidityRemoved: bigint;
  amount0Min: bigint;
  amount1Min: bigint;
  hookData: Hex;
  currency0: Address;
  currency1: Address;
  recipient: Address;
  deadline: bigint;
  burned: boolean;
};

/**
 * Reviews the exact removal shape emitted by `buildV4RemovePositionTransaction`:
 * one DECREASE_LIQUIDITY or BURN_POSITION action followed by TAKE_PAIR to
 * PositionManager's `msgSender()` sentinel. Pool identity beyond the currency pair
 * must be independently proven by a same-block token-ID position read.
 */
export function reviewV4RemovePositionCalldata(data: Hex, expected: V4ExpectedRemoval): V4RemoveActionParams {
  try {
    const decoded = decodeFunctionData({ abi: v4PositionManagerAbi, data });
    let unlockData: Hex;
    let deadline: bigint;
    if (decoded.functionName === 'multicall') {
      const calls = decoded.args[0].map(call => decodeFunctionData({ abi: v4PositionManagerAbi, data: call }));
      if (calls.length !== 1 || calls[0]!.functionName !== 'modifyLiquidities') {
        mismatch('Removal calldata multicall must contain exactly one modifyLiquidities call');
      }
      [unlockData, deadline] = calls[0]!.args as [Hex, bigint];
    } else if (decoded.functionName === 'modifyLiquidities') {
      [unlockData, deadline] = decoded.args;
    } else {
      return mismatch('Removal calldata is not a position-manager modifyLiquidities call');
    }

    const [actionsBytes, actionParams] = decodeAbiParameters(unlockDataParams, unlockData) as [Hex, readonly Hex[]];
    const actionIds = decodeActionIds(actionsBytes);
    if (actionIds.length !== 2 || actionParams.length !== 2) {
      mismatch('Removal calldata must contain exactly one liquidity action followed by TAKE_PAIR');
    }

    let tokenId: bigint;
    let liquidityRemoved: bigint;
    let amount0Min: bigint;
    let amount1Min: bigint;
    let hookData: Hex;
    let burned: boolean;
    if (actionIds[0] === DECREASE_LIQUIDITY_ACTION) {
      [tokenId, liquidityRemoved, amount0Min, amount1Min, hookData] = decodeAbiParameters(
        decreaseLiquidityParams,
        actionParams[0]!,
      ) as [bigint, bigint, bigint, bigint, Hex];
      burned = false;
      if (liquidityRemoved <= 0n) mismatch('Removal calldata removes non-positive liquidity');
    } else if (actionIds[0] === BURN_POSITION_ACTION) {
      [tokenId, amount0Min, amount1Min, hookData] = decodeAbiParameters(
        burnPositionParams,
        actionParams[0]!,
      ) as [bigint, bigint, bigint, Hex];
      liquidityRemoved = expected.liquidityToRemove;
      burned = true;
    } else {
      return mismatch('Removal calldata must begin with DECREASE_LIQUIDITY or BURN_POSITION');
    }

    if (actionIds[1] !== TAKE_PAIR_ACTION) mismatch('Removal liquidity action must be followed by TAKE_PAIR');
    const [currency0, currency1, recipient] = decodeAbiParameters(
      takePairParams,
      actionParams[1]!,
    ) as [Address, Address, Address];
    if (!same(currency0, expected.currency0) || !same(currency1, expected.currency1)) {
      mismatch('TAKE_PAIR withdraws a different currency pair than expected');
    }
    if (!same(recipient, MSG_SENDER)) mismatch('TAKE_PAIR sends withdrawn assets to an unexpected recipient');
    if (tokenId !== expected.tokenId) mismatch('Removal calldata targets a different position token ID');
    if (burned !== expected.burnToken) mismatch('Removal calldata burn behavior differs from expected');
    if (liquidityRemoved !== expected.liquidityToRemove) mismatch('Removal calldata removes different liquidity than expected');

    if (!same(expected.hooks, zeroAddress)) {
      if (!expected.modelledHookPermissions) {
        mismatch('Removal targets a pool with a hook but no modelled permissions were supplied to verify it');
      }
      const unmodelled = unmodelledV4HookPermissions(expected.hooks, expected.modelledHookPermissions);
      if (unmodelled.length) mismatch(`Removal pool hook implements unmodelled permissions: ${unmodelled.join(', ')}`);
    }

    return {
      tokenId,
      liquidityRemoved,
      amount0Min,
      amount1Min,
      hookData,
      currency0,
      currency1,
      recipient,
      deadline,
      burned,
    };
  } catch (error) {
    if (error instanceof UniswapSdkError) throw error;
    throw new UniswapSdkError('CALLDATA_MISMATCH', 'Removal calldata contains undecodable position-manager calls', { cause: error });
  }
}

/**
 * Decodes and verifies calldata built by `buildV4MintPositionTransaction`: a
 * `modifyLiquidities` call — optionally wrapped in a `multicall` alongside pool
 * initialization and/or a Permit2 batch approval — encoding exactly a MINT_POSITION
 * action, a SETTLE_PAIR, and, for a native-currency0 mint, a trailing SWEEP. This is
 * the only action shape that function produces; any other sequence is calldata this
 * decoder does not recognise as its own and refuses, rather than guessing at its
 * meaning.
 *
 * `expected` must name the full pool (including `hooks`), not just the token
 * pair — a mint into the same pair through a different, unreviewed hook is a
 * different pool with different economics, not a cosmetic difference.
 * `currency0`/`currency1` must already be in canonical (sorted) order, and a
 * native-currency pool's `currency0` must be the zero address, matching how
 * `V4PoolKey`/`Pool` represent it elsewhere in this SDK — this function does
 * not reorder or reinterpret them. Pass `sqrtPriceX96` when the mint might
 * atomically create the pool; omitting it fails closed rather than silently
 * accepting whatever starting price the calldata sets. Pass `batchPermit` when
 * the mint might fold in a Permit2 approval, for the same reason — a decoded
 * permit's token/owner/spender are also self-checked against the pool regardless
 * of what `expected` claims.
 */
export function reviewV4MintPositionCalldata(data: Hex, expected: V4ExpectedMint): V4MintActionParams {
  try {
    const decoded = decodeFunctionData({ abi: v4PositionManagerAbi, data });
    let unlockData: Hex;
    let deadline: bigint;
    let initialization: { key: V4PoolKeyMaterial; sqrtPriceX96: bigint } | undefined;
    let batchPermit: { owner: Address; spender: Address; sigDeadline: bigint; details: readonly V4BatchPermitDetail[] } | undefined;
    if (decoded.functionName === 'multicall') {
      const calls = decoded.args[0].map(call => decodeFunctionData({ abi: v4PositionManagerAbi, data: call }));
      if (calls.length < 2 || calls.length > 3) mismatch('Mint calldata multicall does not have the call count a plain mint produces');
      const mintCall = calls.at(-1)!;
      if (mintCall.functionName !== 'modifyLiquidities') mismatch('Mint calldata multicall must end with the position mint');
      for (const call of calls.slice(0, -1)) {
        if (call.functionName === 'initializePool') {
          if (initialization) mismatch('Mint calldata multicall contains more than one pool initialization');
          initialization = { key: call.args[0] as V4PoolKeyMaterial, sqrtPriceX96: call.args[1] as bigint };
        } else if (call.functionName === 'permitBatch') {
          if (batchPermit) mismatch('Mint calldata multicall contains more than one permit batch');
          const [owner, permitBatch] = call.args as readonly [Address, { details: readonly { token: Address; amount: bigint; expiration: number; nonce: number }[]; spender: Address; sigDeadline: bigint }, Hex];
          batchPermit = {
            owner,
            spender: permitBatch.spender,
            sigDeadline: permitBatch.sigDeadline,
            details: permitBatch.details.map(detail => ({ token: detail.token, amount: detail.amount, expiration: BigInt(detail.expiration), nonce: BigInt(detail.nonce) })),
          };
        } else {
          mismatch('Mint calldata multicall contains an unreviewed call before the position mint');
        }
      }
      [unlockData, deadline] = mintCall.args as [Hex, bigint];
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

    if (!same(poolKey.hooks, zeroAddress)) {
      if (!expected.modelledHookPermissions) {
        mismatch('Mint calldata targets a pool with a hook but no modelled permissions were supplied to verify it');
      }
      const unmodelled = unmodelledV4HookPermissions(poolKey.hooks, expected.modelledHookPermissions);
      if (unmodelled.length) mismatch(`Mint calldata's pool hook implements unmodelled permissions: ${unmodelled.join(', ')}`);
    }

    if (initialization) {
      if (expected.sqrtPriceX96 === undefined) {
        mismatch('Mint calldata initializes the pool but no expected starting price was supplied to verify it');
      }
      if (initialization.sqrtPriceX96 !== expected.sqrtPriceX96) {
        mismatch('Mint calldata initializes the pool at a different starting price than expected');
      }
    }

    if (batchPermit) {
      // Self-checked against the decoded poolKey regardless of what `expected` claims, so a
      // caller who fails to scrutinize `expected` still can't be tricked into treating a permit
      // for an unrelated or duplicated token as reviewed.
      const poolTokens = [poolKey.currency0, poolKey.currency1];
      const seenTokens = new Set<string>();
      for (const detail of batchPermit.details) {
        if (same(detail.token, zeroAddress)) mismatch('Permit2 batch approval cannot cover the native currency');
        if (!poolTokens.some(poolToken => same(poolToken, detail.token))) {
          mismatch('Permit2 batch approval references a token that is not part of the minted pool');
        }
        const key = detail.token.toLowerCase();
        if (seenTokens.has(key)) mismatch('Permit2 batch approval lists the same token more than once');
        seenTokens.add(key);
      }

      if (!expected.batchPermit) {
        mismatch('Mint calldata includes a Permit2 batch approval but no expected approval was supplied to verify it');
      }
      if (!same(batchPermit.owner, expected.batchPermit.owner)
        || !same(batchPermit.spender, expected.batchPermit.spender)
        || batchPermit.sigDeadline !== expected.batchPermit.sigDeadline
        || !sameBatchPermitDetails(batchPermit.details, expected.batchPermit.details)) {
        mismatch('Mint calldata\'s Permit2 batch approval does not match what was expected');
      }
    }

    return {
      poolKey, tickLower, tickUpper, liquidity, amount0Max, amount1Max, owner, hookData, deadline,
      ...(initialization ? { createdAtSqrtPriceX96: initialization.sqrtPriceX96 } : {}),
      ...(batchPermit ? { batchPermitOwner: batchPermit.owner } : {}),
    };
  } catch (error) {
    if (error instanceof UniswapSdkError) throw error;
    throw new UniswapSdkError('CALLDATA_MISMATCH', 'Mint calldata contains undecodable position-manager calls', { cause: error });
  }
}
