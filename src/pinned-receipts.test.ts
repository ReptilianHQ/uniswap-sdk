import { readFileSync } from 'node:fs';
import { getAddress, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { robinhoodUniswapV3Mainnet } from './deployments.js';
import { V3_ABI_REVISION } from './v3-abis.js';
import { findV3MintedPositionTokenId, summarizeV3PositionReceipt, type V3ReceiptLog } from './v3-receipts.js';

type ReceiptFixture = {
  schemaVersion: number;
  deploymentId: string;
  chainId: number;
  abiRevision: string;
  recordedHead: number;
  minimumFinalityDepth: number;
  transactionHash: Hex;
  blockHash: Hex;
  blockNumber: number;
  manager: Address;
  recipient: Address;
  tokenId?: string;
  closedTokenId?: string;
  mintedTokenId?: string;
  logs: V3ReceiptLog[];
  expected: Record<string, unknown>;
};

function fixture(name: string): ReceiptFixture {
  return JSON.parse(readFileSync(new URL(`../fixtures/receipts/${name}.json`, import.meta.url), 'utf8')) as ReceiptFixture;
}

function assertProvenance(value: ReceiptFixture): void {
  expect(value.schemaVersion).toBe(1);
  expect(value.deploymentId).toBe(robinhoodUniswapV3Mainnet.id);
  expect(value.chainId).toBe(robinhoodUniswapV3Mainnet.chainId);
  expect(value.abiRevision).toBe(V3_ABI_REVISION);
  expect(getAddress(value.manager)).toBe(robinhoodUniswapV3Mainnet.contracts.nonfungiblePositionManager);
  expect(value.recordedHead - value.blockNumber).toBeGreaterThanOrEqual(value.minimumFinalityDepth);
  expect(value.transactionHash).toMatch(/^0x[0-9a-f]{64}$/);
  expect(value.blockHash).toMatch(/^0x[0-9a-f]{64}$/);
}

describe('pinned finalized Robinhood mainnet receipts', () => {
  it('reconstructs mint and liquidity-add evidence from the reviewed manager', () => {
    const value = fixture('robinhood-mainnet-v3-mint');
    assertProvenance(value);
    const tokenId = BigInt(value.tokenId!);
    expect(findV3MintedPositionTokenId({ logs: value.logs, manager: value.manager, recipient: value.recipient })).toBe(tokenId);
    expect(summarizeV3PositionReceipt({ logs: value.logs, manager: value.manager, recipient: value.recipient, tokenId })).toEqual({
      liquidityAdded: 9_080_828_397_494_115_660n,
      amount0Added: 98_202_793_803_044_062_283n,
      amount1Added: 7_821_750_973_834_156n,
      liquidityRemoved: 0n,
      amount0Collected: 0n,
      amount1Collected: 0n,
      burned: false,
    });
  });

  it('reconstructs decrease, collection, burn, and replacement-mint evidence', () => {
    const value = fixture('robinhood-mainnet-v3-lifecycle');
    assertProvenance(value);
    const closedTokenId = BigInt(value.closedTokenId!);
    const mintedTokenId = BigInt(value.mintedTokenId!);
    expect(findV3MintedPositionTokenId({ logs: value.logs, manager: value.manager, recipient: value.recipient })).toBe(mintedTokenId);
    expect(summarizeV3PositionReceipt({ logs: value.logs, manager: value.manager, recipient: value.recipient, tokenId: closedTokenId })).toEqual({
      liquidityAdded: 0n,
      amount0Added: 0n,
      amount1Added: 0n,
      liquidityRemoved: 9_433_219_015_305_506_097n,
      amount0Collected: 165_918_405_172_525n,
      amount1Collected: 250_080_047_057_793_478_599n,
      burned: true,
    });
    expect(summarizeV3PositionReceipt({ logs: value.logs, manager: value.manager, recipient: value.recipient, tokenId: mintedTokenId })).toMatchObject({
      liquidityAdded: 9_475_922_674_326_428_363n,
      amount0Added: 2_063_438_017_480_703n,
      amount1Added: 145_801_849_036_816_553_390n,
    });
  });
});
