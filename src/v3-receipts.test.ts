import { encodeEventTopics, zeroAddress, type Address } from 'viem';
import { describe, expect, it } from 'vitest';
import { v3PositionManagerEventAbi } from './v3-abis.js';
import { findV3MintedPositionTokenId } from './v3-receipts.js';

const manager = '0x1111111111111111111111111111111111111111' as Address;
const recipient = '0x3333333333333333333333333333333333333333' as Address;

describe('Uniswap v3 receipt evidence', () => {
  it('finds a mint only from the reviewed manager and recipient', () => {
    const topics = encodeEventTopics({ abi: v3PositionManagerEventAbi, eventName: 'Transfer', args: { from: zeroAddress, to: recipient, tokenId: 42n } });
    expect(findV3MintedPositionTokenId({ logs: [{ address: manager, data: '0x', topics }], manager, recipient })).toBe(42n);
    expect(() => findV3MintedPositionTokenId({ logs: [{ address: recipient, data: '0x', topics }], manager, recipient })).toThrowError(/position NFT/);
  });
});
