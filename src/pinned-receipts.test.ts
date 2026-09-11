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
  status: 'success';
  manager: Address;
  recipient: Address;
  tokenId?: string;
  closedTokenId?: string;
  mintedTokenId?: string;
  logs: V3ReceiptLog[];
  expected: {
    mintedTokenId?: string;
    liquidityAdded?: string;
    amount0Added?: string;
    amount1Added?: string;
    closed?: {
      liquidityRemoved: string; amount0Collected: string; amount1Collected: string; burned: boolean;
    };
    minted?: {
      liquidityAdded: string; amount0Added: string; amount1Added: string;
    };
  };
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
  expect(value.status).toBe('success');
}

describe('pinned finalized Robinhood mainnet receipts', () => {
  it('reconstructs mint and liquidity-add evidence from the reviewed manager', () => {
    const value = fixture('robinhood-mainnet-v3-mint');
    assertProvenance(value);
    const tokenId = BigInt(value.tokenId!);
    expect(findV3MintedPositionTokenId({ logs: value.logs, manager: value.manager, recipient: value.recipient })).toBe(BigInt(value.expected.mintedTokenId!));
    expect(summarizeV3PositionReceipt({ logs: value.logs, manager: value.manager, recipient: value.recipient, tokenId })).toEqual({
      liquidityAdded: BigInt(value.expected.liquidityAdded!),
      amount0Added: BigInt(value.expected.amount0Added!),
      amount1Added: BigInt(value.expected.amount1Added!),
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
    const closed = value.expected.closed!;
    const minted = value.expected.minted!;
    expect(findV3MintedPositionTokenId({ logs: value.logs, manager: value.manager, recipient: value.recipient })).toBe(mintedTokenId);
    expect(summarizeV3PositionReceipt({ logs: value.logs, manager: value.manager, recipient: value.recipient, tokenId: closedTokenId })).toEqual({
      liquidityAdded: 0n,
      amount0Added: 0n,
      amount1Added: 0n,
      liquidityRemoved: BigInt(closed.liquidityRemoved),
      amount0Collected: BigInt(closed.amount0Collected),
      amount1Collected: BigInt(closed.amount1Collected),
      burned: closed.burned,
    });
    expect(summarizeV3PositionReceipt({ logs: value.logs, manager: value.manager, recipient: value.recipient, tokenId: mintedTokenId })).toMatchObject({
      liquidityAdded: BigInt(minted.liquidityAdded),
      amount0Added: BigInt(minted.amount0Added),
      amount1Added: BigInt(minted.amount1Added),
    });
  });
});
