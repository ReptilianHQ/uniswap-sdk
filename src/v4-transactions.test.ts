import { describe, expect, it } from 'vitest';
import { Ether, Token } from '@uniswap/sdk-core';
import { decodeFunctionData, encodeAbiParameters, encodeFunctionData, parseAbiParameters, zeroAddress, type Address, type Hex } from 'viem';
import { v4PositionManagerAbi } from './abis.js';
import { buildV4MintPositionTransaction, reviewV4MintPositionCalldata, type V4PoolState } from './v4-transactions.js';
import { isUniswapSdkError } from './errors.js';

/** Hand-encodes a `modifyLiquidities` call for a crafted action sequence, bypassing
 * buildV4MintPositionTransaction entirely — used to test that the reviewer rejects
 * shapes the real builder would never produce, not just corrupted real output. */
function encodeRawActions(actions: readonly { id: number; params: Hex }[], deadline: bigint): Hex {
  const actionsBytes = ('0x' + actions.map(a => a.id.toString(16).padStart(2, '0')).join('')) as Hex;
  const unlockData = encodeAbiParameters(parseAbiParameters('bytes actions, bytes[] params'), [actionsBytes, actions.map(a => a.params)]);
  return encodeFunctionData({ abi: v4PositionManagerAbi, functionName: 'modifyLiquidities', args: [unlockData, deadline] });
}
const mintPositionParamTypes = parseAbiParameters(
  '(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, int24 tickLower, int24 tickUpper, uint256 liquidity, uint128 amount0Max, uint128 amount1Max, address owner, bytes hookData',
);
const settlePairParamTypes = parseAbiParameters('address currency0, address currency1');
const sweepParamTypes = parseAbiParameters('address currency, address to');

const positionManager: Address = '0x0000000000000000000000000000000000000900';
const hooks: Address = '0x0000000000000000000000000000000000002044';
const recipient: Address = '0x0000000000000000000000000000000000000030';
const token = new Token(1, '0x0000000000000000000000000000000000000010', 18);
const other = new Token(1, '0x0000000000000000000000000000000000000020', 18);

const pool: V4PoolState = {
  currency0: token,
  currency1: other,
  fee: 3000,
  tickSpacing: 60,
  hooks,
  sqrtPriceX96: 1n << 96n,
  liquidity: 0n,
  tickCurrent: 0,
};

const baseParams = {
  positionManager,
  pool,
  tickLower: -60,
  tickUpper: 60,
  liquidity: 1_000_000n,
  recipient,
  slippageToleranceBps: 50,
  deadlineSeconds: 9_999_999_999n,
};

describe('v4 mint transaction', () => {
  it('encodes a plain mint as modifyLiquidities with the given deadline and zero value', () => {
    const material = buildV4MintPositionTransaction(baseParams);
    expect(material.to.toLowerCase()).toBe(positionManager.toLowerCase());
    expect(material.value).toBe(0n);
    const decoded = decodeFunctionData({ abi: v4PositionManagerAbi, data: material.data });
    expect(decoded.functionName).toBe('modifyLiquidities');
    expect(decoded.args[1]).toBe(baseParams.deadlineSeconds);
    expect((decoded.args[0] as string).length).toBeGreaterThan(2);
  });

  it('wraps pool initialization and mint in a multicall when createPool is set', () => {
    const material = buildV4MintPositionTransaction({ ...baseParams, createPool: true });
    const decoded = decodeFunctionData({ abi: v4PositionManagerAbi, data: material.data });
    expect(decoded.functionName).toBe('multicall');
    const calls = (decoded.args[0] as readonly `0x${string}`[]).map(call => decodeFunctionData({ abi: v4PositionManagerAbi, data: call }));
    expect(calls).toHaveLength(2);
    expect(calls[0]!.functionName).toBe('initializePool');
    expect(calls[0]!.args[0]).toMatchObject({ fee: pool.fee, tickSpacing: pool.tickSpacing });
    expect(calls[0]!.args[1]).toBe(pool.sqrtPriceX96);
    expect(calls[1]!.functionName).toBe('modifyLiquidities');
  });

  it('sends native value for a native-currency0 pool instead of requiring a prior wrap', () => {
    const nativePool: V4PoolState = { ...pool, currency0: Ether.onChain(1), hooks: zeroAddress };
    const material = buildV4MintPositionTransaction({ ...baseParams, pool: nativePool });
    expect(material.value).toBeGreaterThan(0n);
  });

  function expectSdkError(input: Parameters<typeof buildV4MintPositionTransaction>[0]) {
    try {
      buildV4MintPositionTransaction(input);
      expect.unreachable('expected buildV4MintPositionTransaction to reject this input');
    } catch (error) {
      expect(isUniswapSdkError(error)).toBe(true);
      expect((error as { code?: string }).code).toBe('INVALID_ARGUMENT');
    }
  }

  it('rejects non-positive liquidity, inverted ticks, out-of-range slippage, and createPool without a starting price as UniswapSdkError', () => {
    for (const bad of [
      { liquidity: 0n },
      { tickLower: 60, tickUpper: -60 },
      { tickLower: 0, tickUpper: 0 },
      { slippageToleranceBps: -1 },
      { slippageToleranceBps: 10_001 },
    ]) {
      expectSdkError({ ...baseParams, ...bad });
    }
    expectSdkError({ ...baseParams, createPool: true, pool: { ...pool, sqrtPriceX96: 0n } });
  });

  it('normalizes an invalid position manager address into a UniswapSdkError', () => {
    expectSdkError({ ...baseParams, positionManager: 'not-an-address' as Address });
  });

  it('normalizes an official-SDK invariant failure (tick not a multiple of tickSpacing) into a UniswapSdkError', () => {
    // tickSpacing is 60; -61 is not a multiple of it. The official SDK's Position/Pool
    // constructors throw a bare tiny-invariant Error for this, not a UniswapSdkError —
    // this asserts the wrapper still normalizes it rather than leaking the raw invariant.
    expectSdkError({ ...baseParams, tickLower: -61 });
  });
});

describe('v4 mint calldata review', () => {
  const expected = {
    currency0: token.address as Address, currency1: other.address as Address,
    fee: pool.fee, tickSpacing: pool.tickSpacing, hooks, recipient,
  };

  it('round-trips a plain mint back to its own parameters', () => {
    const material = buildV4MintPositionTransaction(baseParams);
    const decoded = reviewV4MintPositionCalldata(material.data, expected);
    expect(decoded.poolKey.currency0.toLowerCase()).toBe(token.address.toLowerCase());
    expect(decoded.poolKey.currency1.toLowerCase()).toBe(other.address.toLowerCase());
    expect(decoded.poolKey.fee).toBe(pool.fee);
    expect(decoded.poolKey.tickSpacing).toBe(pool.tickSpacing);
    expect(decoded.tickLower).toBe(baseParams.tickLower);
    expect(decoded.tickUpper).toBe(baseParams.tickUpper);
    expect(decoded.liquidity).toBe(baseParams.liquidity);
    expect(decoded.owner.toLowerCase()).toBe(recipient.toLowerCase());
    expect(decoded.hookData).toBe('0x');
    expect(decoded.deadline).toBe(baseParams.deadlineSeconds);
  });

  it('round-trips a createPool mint through its multicall wrapper', () => {
    const material = buildV4MintPositionTransaction({ ...baseParams, createPool: true });
    const decoded = reviewV4MintPositionCalldata(material.data, expected);
    expect(decoded.tickLower).toBe(baseParams.tickLower);
    expect(decoded.owner.toLowerCase()).toBe(recipient.toLowerCase());
    expect(decoded.deadline).toBe(baseParams.deadlineSeconds);
  });

  it('round-trips a native-currency0 mint (MINT_POSITION, SETTLE_PAIR, SWEEP)', () => {
    const nativePool: V4PoolState = { ...pool, currency0: Ether.onChain(1), hooks: zeroAddress };
    const material = buildV4MintPositionTransaction({ ...baseParams, pool: nativePool });
    const decoded = reviewV4MintPositionCalldata(material.data, { ...expected, currency0: zeroAddress, hooks: zeroAddress });
    expect(decoded.owner.toLowerCase()).toBe(recipient.toLowerCase());
  });

  it('rejects a mint that targets a different token pair, pool configuration, or recipient', () => {
    const material = buildV4MintPositionTransaction(baseParams);
    expect(() => reviewV4MintPositionCalldata(material.data, { ...expected, currency1: recipient })).toThrow(/different pool/);
    expect(() => reviewV4MintPositionCalldata(material.data, { ...expected, hooks: recipient })).toThrow(/different pool/);
    expect(() => reviewV4MintPositionCalldata(material.data, { ...expected, fee: 500 })).toThrow(/different pool/);
    expect(() => reviewV4MintPositionCalldata(material.data, { ...expected, recipient: token.address as Address })).toThrow(/different recipient/);
  });

  it('rejects a createPool mint whose initialization targets a different pool than the mint', () => {
    const mintParams = encodeAbiParameters(mintPositionParamTypes, [
      { currency0: token.address as Address, currency1: other.address as Address, fee: pool.fee, tickSpacing: pool.tickSpacing, hooks },
      baseParams.tickLower, baseParams.tickUpper, baseParams.liquidity, (1n << 128n) - 1n, (1n << 128n) - 1n, recipient, '0x',
    ]);
    const settleParams = encodeAbiParameters(settlePairParamTypes, [token.address as Address, other.address as Address]);
    const mint = encodeRawActions([{ id: 2, params: mintParams }, { id: 13, params: settleParams }], baseParams.deadlineSeconds);
    const wrongInitialization = encodeFunctionData({
      abi: v4PositionManagerAbi, functionName: 'initializePool',
      // Same pair, but a different tickSpacing than the mint's poolKey — a different pool.
      args: [{ currency0: token.address as Address, currency1: other.address as Address, fee: pool.fee, tickSpacing: pool.tickSpacing + 60, hooks }, pool.sqrtPriceX96],
    });
    const multicall = encodeFunctionData({ abi: v4PositionManagerAbi, functionName: 'multicall', args: [[wrongInitialization, mint]] });
    expect(() => reviewV4MintPositionCalldata(multicall, expected)).toThrow(/different pool than the position mint/);
  });

  it('rejects a SWEEP that refunds to an address other than PositionManager\'s MSG_SENDER sentinel', () => {
    const nativePoolKey = { currency0: zeroAddress, currency1: other.address as Address, fee: pool.fee, tickSpacing: pool.tickSpacing, hooks: zeroAddress };
    const mintParams = encodeAbiParameters(mintPositionParamTypes, [
      nativePoolKey, baseParams.tickLower, baseParams.tickUpper, baseParams.liquidity, (1n << 128n) - 1n, (1n << 128n) - 1n, recipient, '0x',
    ]);
    const settleParams = encodeAbiParameters(settlePairParamTypes, [zeroAddress, other.address as Address]);
    // A real SWEEP always pays PositionManager's own MSG_SENDER sentinel (…0001); this one
    // redirects the native-currency refund to an arbitrary address instead.
    const sweepParams = encodeAbiParameters(sweepParamTypes, [zeroAddress, recipient]);
    const forged = encodeRawActions(
      [{ id: 2, params: mintParams }, { id: 13, params: settleParams }, { id: 20, params: sweepParams }],
      baseParams.deadlineSeconds,
    );
    expect(() => reviewV4MintPositionCalldata(forged, { ...expected, currency0: zeroAddress, hooks: zeroAddress }))
      .toThrow(/unexpected recipient/);
  });

  it('rejects calldata that is not one of its own mint builds', () => {
    expect(() => reviewV4MintPositionCalldata('0x12345678', expected)).toThrow();
    // A real ERC20 `approve` selector — 4 bytes, no position-manager function matches it.
    expect(() => reviewV4MintPositionCalldata('0x095ea7b3', expected)).toThrow();
  });
});
