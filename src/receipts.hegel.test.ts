import { describe, expect, it } from 'vitest';
import * as hegel from '@hegeldev/hegel';
import * as gs from '@hegeldev/hegel/generators';
import { encodeAbiParameters, encodeEventTopics, getAddress, pad, toHex, zeroAddress, type Address } from 'viem';
import { v3PositionManagerEventAbi } from './v3-abis.js';
import { findV3MintedPositionTokenId, summarizeV3PositionReceipt } from './receipts.js';
import { UniswapSdkError } from './errors.js';

const SETTINGS = { testCases: 500, derandomize: true, database: hegel.Database.disabled } as const;
const MAX_ADDRESS = 2n ** 160n - 1n;

function address(tc: hegel.TestCase): Address {
  return getAddress(pad(toHex(tc.draw(gs.bigIntegers({ minValue: 1n, maxValue: MAX_ADDRESS }))), { size: 20 }));
}

function otherAddress(value: Address): Address {
  return getAddress(pad(toHex(BigInt(value) === MAX_ADDRESS ? 1n : BigInt(value) + 1n), { size: 20 }));
}

function codeOf(action: () => unknown): string {
  try { action(); return 'no error'; }
  catch (error) {
    if (!(error instanceof UniswapSdkError)) throw error;
    return error.code;
  }
}

describe('Uniswap v3 receipt properties', () => {
  it('accepts only mint transfer evidence from the reviewed manager to the reviewed recipient', () => {
    hegel.test((tc) => {
      const manager = address(tc);
      const recipient = address(tc);
      const tokenId = tc.draw(gs.bigIntegers({ minValue: 1n, maxValue: 2n ** 256n - 1n }));
      const topics = encodeEventTopics({ abi: v3PositionManagerEventAbi, eventName: 'Transfer', args: { from: zeroAddress, to: recipient, tokenId } });
      const log = { address: manager, data: '0x' as const, topics };
      expect(findV3MintedPositionTokenId({ logs: [log], manager, recipient })).toBe(tokenId);
      expect(codeOf(() => findV3MintedPositionTokenId({ logs: [{ ...log, address: otherAddress(manager) }], manager, recipient }))).toBe('EVENT_NOT_FOUND');
      expect(codeOf(() => findV3MintedPositionTokenId({ logs: [log], manager, recipient: otherAddress(recipient) }))).toBe('EVENT_NOT_FOUND');
    }, SETTINGS);
  });

  it('reduces only same-manager, same-position, same-recipient management evidence', () => {
    hegel.test((tc) => {
      const manager = address(tc);
      const recipient = address(tc);
      const tokenId = tc.draw(gs.bigIntegers({ minValue: 1n, maxValue: 2n ** 256n - 1n }));
      const liquidity = tc.draw(gs.bigIntegers({ minValue: 1n, maxValue: 2n ** 128n - 1n }));
      const amount0 = tc.draw(gs.bigIntegers({ minValue: 0n, maxValue: 10n ** 30n }));
      const amount1 = tc.draw(gs.bigIntegers({ minValue: 0n, maxValue: 10n ** 30n }));
      const increase = {
        address: manager,
        topics: encodeEventTopics({ abi: v3PositionManagerEventAbi, eventName: 'IncreaseLiquidity', args: { tokenId } }),
        data: encodeAbiParameters([{ type: 'uint128' }, { type: 'uint256' }, { type: 'uint256' }], [liquidity, amount0, amount1]),
      };
      const collect = {
        address: manager,
        topics: encodeEventTopics({ abi: v3PositionManagerEventAbi, eventName: 'Collect', args: { tokenId } }),
        data: encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }], [recipient, amount0, amount1]),
      };
      expect(summarizeV3PositionReceipt({ logs: [
        { ...increase, address: otherAddress(manager) },
        { ...collect, data: encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }], [otherAddress(recipient), amount0, amount1]) },
        increase,
        collect,
      ], manager, recipient, tokenId })).toMatchObject({
        liquidityAdded: liquidity,
        amount0Added: amount0,
        amount1Added: amount1,
        amount0Collected: amount0,
        amount1Collected: amount1,
      });
    }, SETTINGS);
  });
});
