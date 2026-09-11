import { describe, expect, it } from 'vitest';
import * as hegel from '@hegeldev/hegel';
import * as gs from '@hegeldev/hegel/generators';
import { getAddress, pad, toHex, type Address } from 'viem';
import { UniswapSdkError } from './errors.js';
import {
  buildV3ApprovalTransaction,
  buildV3AtomicPoolInitializationTransaction,
  buildV3CollectTransaction,
  buildV3CompoundTransaction,
  buildV3DecreaseAndCollectTransaction,
  buildV3IncreaseLiquidityTransaction,
  reviewV3ApprovalCalldata,
  reviewV3AtomicPoolInitializationCalldata,
  reviewV3CloseCalldata,
  reviewV3CompoundCalldata,
  reviewV3CollectCalldata,
  reviewV3IncreaseLiquidityCalldata,
  reviewV3LiquidityRemovalCalldata,
  buildV3MintPositionTransaction,
  reviewV3MintPositionCalldata,
} from './transactions.js';

const SETTINGS = { testCases: 500, derandomize: true, database: hegel.Database.disabled } as const;
const MAX_ADDRESS = 2n ** 160n - 1n;

function address(tc: hegel.TestCase): Address {
  return getAddress(pad(toHex(tc.draw(gs.bigIntegers({ minValue: 1n, maxValue: MAX_ADDRESS }))), { size: 20 }));
}

function otherAddress(tc: hegel.TestCase, taken: Address): Address {
  const candidate = address(tc);
  return candidate.toLowerCase() === taken.toLowerCase()
    ? getAddress(pad(toHex(BigInt(candidate) === MAX_ADDRESS ? 1n : BigInt(candidate) + 1n), { size: 20 }))
    : candidate;
}

function positive(tc: hegel.TestCase): bigint {
  return tc.draw(gs.bigIntegers({ minValue: 1n, maxValue: 10n ** 30n }));
}

function codeOf(action: () => unknown): string {
  try { action(); return 'no error'; }
  catch (error) {
    if (!(error instanceof UniswapSdkError)) throw error;
    return error.code;
  }
}

describe('Uniswap v3 transaction properties', () => {
  it('preserves approval spender and amount and rejects another spender', () => {
    hegel.test((tc) => {
      const token = address(tc);
      const manager = otherAddress(tc, token);
      const amount = positive(tc);
      const material = buildV3ApprovalTransaction(token, manager, amount);
      expect(material.to).toBe(token);
      expect(reviewV3ApprovalCalldata(material.data, manager)).toBe(amount);
      expect(codeOf(() => reviewV3ApprovalCalldata(material.data, otherAddress(tc, manager)))).toBe('CALLDATA_MISMATCH');
    }, SETTINGS);
  });

  it('preserves atomic pool initialization targets and terms', () => {
    hegel.test((tc) => {
      const multicall = address(tc);
      const factory = otherAddress(tc, multicall);
      const manager = otherAddress(tc, factory);
      const token0 = otherAddress(tc, manager);
      const token1 = otherAddress(tc, token0);
      const fee = tc.draw(gs.integers({ minValue: 1, maxValue: 2 ** 24 - 1 }));
      const sqrtPriceX96 = tc.draw(gs.bigIntegers({ minValue: 1n, maxValue: 2n ** 160n - 1n }));
      const material = buildV3AtomicPoolInitializationTransaction({ multicall, factory, manager, token0, token1, fee, sqrtPriceX96 });
      expect(codeOf(() => reviewV3AtomicPoolInitializationCalldata(material.data, { factory, manager, token0, token1, fee, sqrtPriceX96 }))).toBe('no error');
      expect(codeOf(() => reviewV3AtomicPoolInitializationCalldata(material.data, { factory: otherAddress(tc, factory), manager, token0, token1 }))).toBe('CALLDATA_MISMATCH');
    }, SETTINGS);
  });

  it('preserves mint pair and NFT recipient', () => {
    hegel.test((tc) => {
      const manager = address(tc);
      const token0 = otherAddress(tc, manager);
      const token1 = otherAddress(tc, token0);
      const recipient = otherAddress(tc, token1);
      const amount0Desired = positive(tc);
      const amount1Desired = positive(tc);
      const params = {
        token0,
        token1,
        fee: tc.draw(gs.integers({ minValue: 1, maxValue: 2 ** 24 - 1 })),
        tickLower: tc.draw(gs.integers({ minValue: -887272, maxValue: 0 })),
        tickUpper: tc.draw(gs.integers({ minValue: 1, maxValue: 887272 })),
        amount0Desired,
        amount1Desired,
        amount0Min: tc.draw(gs.bigIntegers({ minValue: 0n, maxValue: amount0Desired })),
        amount1Min: tc.draw(gs.bigIntegers({ minValue: 0n, maxValue: amount1Desired })),
        recipient,
        deadline: positive(tc),
      };
      const material = buildV3MintPositionTransaction({ manager, params });
      expect(reviewV3MintPositionCalldata(material.data, { token0, token1, recipient })).toEqual(params);
      expect(codeOf(() => reviewV3MintPositionCalldata(material.data, { token0, token1, recipient: otherAddress(tc, recipient) }))).toBe('CALLDATA_MISMATCH');
    }, SETTINGS);
  });

  it('preserves collect position and recipient', () => {
    hegel.test((tc) => {
      const manager = address(tc);
      const recipient = otherAddress(tc, manager);
      const tokenId = positive(tc);
      const material = buildV3CollectTransaction({ manager, tokenId, recipient });
      expect(codeOf(() => reviewV3CollectCalldata(material.data, recipient, tokenId))).toBe('no error');
      expect(codeOf(() => reviewV3CollectCalldata(material.data, otherAddress(tc, recipient), tokenId))).toBe('CALLDATA_MISMATCH');
    }, SETTINGS);
  });

  it('preserves increase position identity and amounts', () => {
    hegel.test((tc) => {
      const manager = address(tc);
      const tokenId = positive(tc);
      const amount0Desired = positive(tc);
      const amount1Desired = positive(tc);
      const params = {
        tokenId,
        amount0Desired,
        amount1Desired,
        amount0Min: tc.draw(gs.bigIntegers({ minValue: 0n, maxValue: amount0Desired })),
        amount1Min: tc.draw(gs.bigIntegers({ minValue: 0n, maxValue: amount1Desired })),
        deadline: positive(tc),
      };
      const material = buildV3IncreaseLiquidityTransaction({ manager, params });
      expect(reviewV3IncreaseLiquidityCalldata(material.data, tokenId)).toEqual(params);
      expect(codeOf(() => reviewV3IncreaseLiquidityCalldata(material.data, tokenId + 1n))).toBe('CALLDATA_MISMATCH');
    }, SETTINGS);
  });

  it('preserves decrease, collection, and burn ordering', () => {
    hegel.test((tc) => {
      const manager = address(tc);
      const recipient = otherAddress(tc, manager);
      const tokenId = positive(tc);
      const liquidity = positive(tc);
      const removal = buildV3DecreaseAndCollectTransaction({
        manager,
        recipient,
        tokenId,
        decrease: { tokenId, liquidity, amount0Min: positive(tc), amount1Min: positive(tc), deadline: positive(tc) },
      });
      const close = buildV3DecreaseAndCollectTransaction({
        manager,
        recipient,
        tokenId,
        decrease: { tokenId, liquidity, amount0Min: positive(tc), amount1Min: positive(tc), deadline: positive(tc) },
        burn: true,
      });
      expect(reviewV3LiquidityRemovalCalldata(removal.data, recipient, tokenId)).toBe(liquidity);
      expect(reviewV3CloseCalldata(close.data, recipient, tokenId)).toEqual({ liquidityRemoved: liquidity, burned: true });
      expect(codeOf(() => reviewV3CloseCalldata(close.data, otherAddress(tc, recipient), tokenId))).toBe('CALLDATA_MISMATCH');
    }, SETTINGS);
  });

  it('preserves compound recipient and position identity', () => {
    hegel.test((tc) => {
      const manager = address(tc);
      const recipient = otherAddress(tc, manager);
      const tokenId = positive(tc);
      const amount0Desired = positive(tc);
      const amount1Desired = positive(tc);
      const material = buildV3CompoundTransaction({ manager, recipient, params: {
        tokenId,
        amount0Desired,
        amount1Desired,
        amount0Min: tc.draw(gs.bigIntegers({ minValue: 0n, maxValue: amount0Desired })),
        amount1Min: tc.draw(gs.bigIntegers({ minValue: 0n, maxValue: amount1Desired })),
        deadline: positive(tc),
      } });
      expect(codeOf(() => reviewV3CompoundCalldata(material.data, recipient, tokenId))).toBe('no error');
      expect(codeOf(() => reviewV3CompoundCalldata(material.data, recipient, tokenId + 1n))).toBe('CALLDATA_MISMATCH');
    }, SETTINGS);
  });
});
