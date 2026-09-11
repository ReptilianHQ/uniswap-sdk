import { describe, expect, it } from 'vitest';
import { encodeFunctionData, type Address } from 'viem';
import { v3PositionManagerAbi } from './v3-abis.js';
import { UniswapSdkError } from './errors.js';
import {
  buildV3ApprovalTransaction,
  buildV3CollectTransaction,
  buildV3CompoundTransaction,
  buildV3DecreaseAndCollectTransaction,
  buildV3IncreaseLiquidityTransaction,
  buildV3MintPositionTransaction,
  reviewV3ApprovalCalldata,
  reviewV3CloseCalldata,
  reviewV3CompoundCalldata,
  reviewV3IncreaseLiquidityCalldata,
  reviewV3LiquidityRemovalCalldata,
  reviewV3MintPositionCalldata,
} from './v3-transactions.js';

const manager = '0x1111111111111111111111111111111111111111' as Address;
const token = '0x2222222222222222222222222222222222222222' as Address;
const recipient = '0x3333333333333333333333333333333333333333' as Address;

describe('Uniswap v3 transaction boundary', () => {
  it('builds approval material that is independently reviewable', () => {
    const material = buildV3ApprovalTransaction(token, manager, 50n);
    expect(material.to).toBe(token);
    expect(reviewV3ApprovalCalldata(material.data, manager)).toBe(50n);
    expect(() => reviewV3ApprovalCalldata(material.data, recipient)).toThrowError(/position manager/);
  });

  it('builds and reviews position management calldata', () => {
    const increase = { tokenId: 42n, amount0Desired: 10n, amount1Desired: 20n, amount0Min: 9n, amount1Min: 18n, deadline: 1000n };
    const increaseMaterial = buildV3IncreaseLiquidityTransaction({ manager, params: increase });
    expect(reviewV3IncreaseLiquidityCalldata(increaseMaterial.data, 42n)).toEqual(increase);

    const decreaseMaterial = buildV3DecreaseAndCollectTransaction({
      manager,
      recipient,
      tokenId: 42n,
      decrease: { tokenId: 42n, liquidity: 99n, amount0Min: 1n, amount1Min: 2n, deadline: 1000n },
    });
    expect(reviewV3LiquidityRemovalCalldata(decreaseMaterial.data, recipient, 42n)).toBe(99n);

    const closeMaterial = buildV3DecreaseAndCollectTransaction({ manager, recipient, tokenId: 42n, burn: true });
    expect(reviewV3CloseCalldata(closeMaterial.data, recipient, 42n)).toEqual({ liquidityRemoved: 0n, burned: true });
  });

  it('requires compound call ordering and matching position identity', () => {
    const material = buildV3CompoundTransaction({
      manager,
      recipient,
      params: { tokenId: 42n, amount0Desired: 10n, amount1Desired: 20n, amount0Min: 9n, amount1Min: 18n, deadline: 1000n },
    });
    expect(() => reviewV3CompoundCalldata(material.data, recipient, 42n)).not.toThrow();
    expect(() => reviewV3CompoundCalldata(material.data, recipient, 43n)).toThrowError(/position/);
  });

  it('rejects extra, duplicate, and reordered mint calls', () => {
    const params = {
      token0: token,
      token1: manager,
      fee: 3000,
      tickLower: -120,
      tickUpper: 120,
      amount0Desired: 10n,
      amount1Desired: 20n,
      amount0Min: 9n,
      amount1Min: 18n,
      recipient,
      deadline: 1000n,
    };
    const built = buildV3MintPositionTransaction({ manager, params, initialize: { sqrtPriceX96: 2n ** 96n } });
    const collect = buildV3CollectTransaction({ manager, tokenId: 42n, recipient }).data;
    const outer = (calls: readonly `0x${string}`[]) => encodeFunctionData({ abi: v3PositionManagerAbi, functionName: 'multicall', args: [calls] });
    for (const calls of [[...built.calls, collect], [built.calls[1], built.calls[1]], [built.calls[1], built.calls[0]]]) {
      expect(() => reviewV3MintPositionCalldata(outer(calls), { token0: token, token1: manager, recipient })).toThrowError(/Mint/);
    }
  });

  it('rejects invalid transaction ranges through the typed error contract', () => {
    const invalidBuilds = [
      () => buildV3ApprovalTransaction(token, manager, 0n),
      () => buildV3ApprovalTransaction(token, manager, 2n ** 256n),
      () => buildV3ApprovalTransaction('not-an-address' as Address, manager, 1n),
      () => buildV3CollectTransaction({ manager, tokenId: 0n, recipient }),
      () => buildV3IncreaseLiquidityTransaction({ manager, params: {
        tokenId: 1n, amount0Desired: 1n, amount1Desired: 0n, amount0Min: 2n, amount1Min: 0n, deadline: 1n,
      } }),
      () => buildV3IncreaseLiquidityTransaction({ manager, params: {
        tokenId: 1n, amount0Desired: 1n, amount1Desired: 0n, amount0Min: 0n, amount1Min: 0n, deadline: 0n,
      } }),
      () => buildV3MintPositionTransaction({ manager, params: {
        token0: token, token1: manager, fee: 3000, tickLower: 1, tickUpper: 1,
        amount0Desired: 1n, amount1Desired: 0n, amount0Min: 0n, amount1Min: 0n, recipient, deadline: 1n,
      } }),
    ];
    for (const build of invalidBuilds) {
      expect(build).toThrowError(UniswapSdkError);
      try { build(); } catch (error) { expect(error).toMatchObject({ code: 'INVALID_ARGUMENT' }); }
    }
  });
});
