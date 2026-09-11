import { decodeEventLog, zeroAddress, type Address, type Hex } from 'viem';
import { UniswapSdkError } from './errors.js';
import { v3PositionManagerEventAbi } from './v3-abis.js';

export type V3ReceiptLog = {
  address: Address | string;
  data: Hex;
  topics: readonly [] | readonly [Hex, ...(Hex | Hex[] | null)[]];
};

function decodableTopics(topics: V3ReceiptLog['topics']): [] | [Hex, ...Hex[]] {
  if (topics.some((topic) => typeof topic !== 'string')) return [];
  return [...topics] as [] | [Hex, ...Hex[]];
}

export interface V3PositionReceiptEvidence {
  liquidityAdded: bigint;
  amount0Added: bigint;
  amount1Added: bigint;
  liquidityRemoved: bigint;
  amount0Collected: bigint;
  amount1Collected: bigint;
  burned: boolean;
}

type PositionManagerEvent =
  | { eventName: 'IncreaseLiquidity'; args: { tokenId: bigint; liquidity: bigint; amount0: bigint; amount1: bigint } }
  | { eventName: 'DecreaseLiquidity'; args: { tokenId: bigint; liquidity: bigint; amount0: bigint; amount1: bigint } }
  | { eventName: 'Collect'; args: { tokenId: bigint; recipient: Address; amount0: bigint; amount1: bigint } }
  | { eventName: 'Transfer'; args: { from: Address; to: Address; tokenId: bigint } };

export function findV3MintedPositionTokenId(input: {
  logs: readonly V3ReceiptLog[]; manager: Address; recipient: Address;
}): bigint {
  for (const log of input.logs) {
    if (log.address.toLowerCase() !== input.manager.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({ abi: v3PositionManagerEventAbi, eventName: 'Transfer', data: log.data, topics: decodableTopics(log.topics) });
      if (decoded.eventName === 'Transfer'
        && decoded.args.from === zeroAddress
        && decoded.args.to.toLowerCase() === input.recipient.toLowerCase()) return decoded.args.tokenId;
    } catch {
      // Unrelated manager logs do not satisfy the required mint evidence.
    }
  }
  throw new UniswapSdkError('EVENT_NOT_FOUND', 'Mint receipt did not create a position NFT for the reviewed recipient');
}

/** Reduces only same-manager, same-position, same-recipient receipt evidence. */
export function summarizeV3PositionReceipt(input: {
  logs: readonly V3ReceiptLog[]; manager: Address; tokenId: bigint; recipient: Address;
}): V3PositionReceiptEvidence {
  const evidence: V3PositionReceiptEvidence = {
    liquidityAdded: 0n,
    amount0Added: 0n,
    amount1Added: 0n,
    liquidityRemoved: 0n,
    amount0Collected: 0n,
    amount1Collected: 0n,
    burned: false,
  };
  for (const log of input.logs) {
    if (log.address.toLowerCase() !== input.manager.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({ abi: v3PositionManagerEventAbi, data: log.data, topics: decodableTopics(log.topics) }) as PositionManagerEvent;
      if (decoded.args.tokenId !== input.tokenId) continue;
      if (decoded.eventName === 'IncreaseLiquidity') {
        evidence.liquidityAdded += decoded.args.liquidity;
        evidence.amount0Added += decoded.args.amount0;
        evidence.amount1Added += decoded.args.amount1;
      } else if (decoded.eventName === 'DecreaseLiquidity') {
        evidence.liquidityRemoved += decoded.args.liquidity;
      } else if (decoded.eventName === 'Collect' && decoded.args.recipient.toLowerCase() === input.recipient.toLowerCase()) {
        evidence.amount0Collected += decoded.args.amount0;
        evidence.amount1Collected += decoded.args.amount1;
      } else if (decoded.eventName === 'Transfer'
        && decoded.args.from.toLowerCase() === input.recipient.toLowerCase()
        && decoded.args.to === zeroAddress) {
        evidence.burned = true;
      }
    } catch {
      // Unrelated or malformed manager logs do not contribute evidence.
    }
  }
  return evidence;
}
