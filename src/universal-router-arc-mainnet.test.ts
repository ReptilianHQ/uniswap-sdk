import { readFileSync } from 'node:fs';
import { decodeEventLog, getAddress, type Address, type Hex } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import { permit2Abi } from './abis.js';
import { arcUniversalRouterMainnet } from './deployments.js';
import { buildPermitSingleTypedData, readPermit2Allowance, verifyPermitSingleSignature } from './permit2.js';
import {
  UNIVERSAL_ROUTER_COMMAND,
  decodePermit2PermitInput,
  decodeUniversalRouterExecute,
  encodePermit2PermitInput,
  encodeUniversalRouterExecute,
  reviewPermit2PermitInput,
} from './universal-router.js';

type AllowanceObservation = { blockNumber: number; amount: string; expiration: string; nonce: string };
type TransactionFixture = {
  schemaVersion: number;
  deploymentId: string;
  chainId: number;
  recordedHead: number;
  minimumFinalityDepth: number;
  transactionHash: Hex;
  blockHash: Hex;
  blockNumber: number;
  status: 'success';
  from: Address;
  to: Address;
  value: string;
  input: Hex;
  receipt: { gasUsed: string; logs: { address: Address; topics: [Hex, ...Hex[]]; data: Hex; logIndex: number }[] };
  permit2Allowance: { before: AllowanceObservation; after: AllowanceObservation };
};

// A real Arc mainnet sell through the reviewed Universal Router: PERMIT2_PERMIT folded into
// the same execute as V4_SWAP, with no separate Permit2.approve transaction.
const value = JSON.parse(readFileSync(
  new URL('../fixtures/transactions/arc-mainnet-universal-router-permit2-sell.json', import.meta.url),
  'utf8',
)) as TransactionFixture;

const owner = getAddress('0xa8d8FfaCCD89D7DAC297Fc669B9B2fDdB4402336');
const token = getAddress('0x6f438cB83040cDD55A602155710dd42f9C1B9257');
const router = arcUniversalRouterMainnet.contracts.universalRouter;
const maxUint160 = (1n << 160n) - 1n;
const deadline = 1_790_881_451n;
const expiration = 1_793_471_651n;

const minedPermit = {
  details: { token, amount: maxUint160, expiration, nonce: 0n },
  spender: router,
  sigDeadline: deadline,
};

function minedTypedData(overrides: Partial<Parameters<typeof buildPermitSingleTypedData>[0]> = {}) {
  return buildPermitSingleTypedData({
    chainId: arcUniversalRouterMainnet.chainId,
    token,
    amount: maxUint160,
    expiration,
    nonce: 0n,
    spender: router,
    sigDeadline: deadline,
    ...overrides,
  });
}

// The fallback is only reached when local recovery fails; for this EOA it reports the
// on-chain answer, which is false for anything recovery already rejected.
function fallbackClient() {
  return { verifyTypedData: vi.fn().mockResolvedValue(false) };
}

describe('pinned Arc mainnet Universal Router PERMIT2_PERMIT sell', () => {
  it('is finalized evidence from the reviewed router and Permit2', () => {
    expect(value.schemaVersion).toBe(1);
    expect(value.deploymentId).toBe(arcUniversalRouterMainnet.id);
    expect(value.chainId).toBe(arcUniversalRouterMainnet.chainId);
    expect(value.transactionHash).toBe('0xd891e2572053dfbc5d9cf57496f98501da98673a6aec0707e0ba4152fbea6277');
    expect(value.blockNumber).toBe(23_752_491);
    expect(value.recordedHead - value.blockNumber).toBeGreaterThanOrEqual(value.minimumFinalityDepth);
    expect(value.status).toBe('success');
    expect(getAddress(value.from)).toBe(owner);
    expect(getAddress(value.to)).toBe(router);
    expect(value.value).toBe('0');
  });

  it('decodes both commands and the deadline exactly', () => {
    const decoded = decodeUniversalRouterExecute(value.input);
    expect(decoded.deadline).toBe(deadline);
    expect(decoded.commands.map(({ command, allowRevert }) => ({ command, allowRevert }))).toEqual([
      { command: UNIVERSAL_ROUTER_COMMAND.PERMIT2_PERMIT, allowRevert: false },
      { command: UNIVERSAL_ROUTER_COMMAND.V4_SWAP, allowRevert: false },
    ]);
    // Also accepted when the reviewer narrows the plan to exactly these two commands.
    expect(decodeUniversalRouterExecute(value.input, {
      permittedCommands: [UNIVERSAL_ROUTER_COMMAND.PERMIT2_PERMIT, UNIVERSAL_ROUTER_COMMAND.V4_SWAP],
    })).toEqual(decoded);
  });

  it('decodes the PermitSingle and its 65-byte signature', () => {
    const { commands } = decodeUniversalRouterExecute(value.input);
    const { permitSingle, signature } = decodePermit2PermitInput(commands[0]!.input);
    expect(permitSingle).toEqual(minedPermit);
    expect((signature.length - 2) / 2).toBe(65);
  });

  it('re-encodes the mined calldata byte for byte', () => {
    const { commands, deadline: decodedDeadline } = decodeUniversalRouterExecute(value.input);
    const { permitSingle, signature } = decodePermit2PermitInput(commands[0]!.input);
    const permitInput = encodePermit2PermitInput(permitSingle, signature);
    expect(permitInput).toBe(commands[0]!.input);
    expect(encodeUniversalRouterExecute({
      commands: [
        { command: UNIVERSAL_ROUTER_COMMAND.PERMIT2_PERMIT, input: permitInput },
        { command: UNIVERSAL_ROUTER_COMMAND.V4_SWAP, input: commands[1]!.input },
      ],
      deadline: decodedDeadline,
    })).toBe(value.input);
  });

  it('accepts the real signature for the real owner under SDK-built typed data, with no RPC', async () => {
    const { commands } = decodeUniversalRouterExecute(value.input);
    const { signature } = decodePermit2PermitInput(commands[0]!.input);
    const client = fallbackClient();
    await expect(verifyPermitSingleSignature(client, { owner, typedData: minedTypedData(), signature })).resolves.toBe(true);
    expect(client.verifyTypedData).not.toHaveBeenCalled();
  });

  it('rejects the real signature for another owner or with any one field changed', async () => {
    const { commands } = decodeUniversalRouterExecute(value.input);
    const { signature } = decodePermit2PermitInput(commands[0]!.input);
    const other = getAddress('0x0000000000000000000000000000000000000bad');
    await expect(verifyPermitSingleSignature(fallbackClient(), { owner: other, typedData: minedTypedData(), signature })).resolves.toBe(false);

    for (const change of [
      { chainId: 1 },
      { permit2Address: getAddress('0x0000000000000000000000000000000000000abc') },
      { token: getAddress('0x0000000000000000000000000000000000000010') },
      { amount: maxUint160 - 1n },
      { expiration: expiration + 1n },
      { nonce: 1n },
      { spender: getAddress('0x0000000000000000000000000000000000000900') },
      { sigDeadline: deadline + 1n },
    ]) {
      const client = fallbackClient();
      await expect(
        verifyPermitSingleSignature(client, { owner, typedData: minedTypedData(change), signature }),
        JSON.stringify(change, (_, field) => typeof field === 'bigint' ? field.toString() : field),
      ).resolves.toBe(false);
      // Recovery disagreed, so the contract-wallet fallback was consulted rather than trusted locally.
      expect(client.verifyTypedData).toHaveBeenCalledTimes(1);
    }
  });

  it('passes the host review bounds the mined plan satisfies, and fails each one it does not', () => {
    const { commands } = decodeUniversalRouterExecute(value.input);
    const input = commands[0]!.input;
    const bounds = { token, spender: router, minAmount: 1n, maxAmount: maxUint160, maxSigDeadline: deadline, maxExpiration: expiration, minExpiration: deadline, nonce: 0n };
    expect(reviewPermit2PermitInput(input, bounds).permitSingle).toEqual(minedPermit);
    for (const change of [
      { maxAmount: maxUint160 - 1n },
      { maxSigDeadline: deadline - 1n },
      { maxExpiration: expiration - 1n },
      { minExpiration: expiration + 1n },
      { nonce: 1n },
      { spender: arcUniversalRouterMainnet.contracts.permit2 },
    ]) {
      expect(() => reviewPermit2PermitInput(input, { ...bounds, ...change })).toThrow(expect.objectContaining({ code: 'CALLDATA_MISMATCH' }));
    }
  });

  it('agrees with the Permit event and the allowance Permit2 recorded', async () => {
    const permitLogs = value.receipt.logs.filter(log => getAddress(log.address) === arcUniversalRouterMainnet.contracts.permit2);
    expect(permitLogs).toHaveLength(1);
    const event = decodeEventLog({ abi: permit2Abi, data: permitLogs[0]!.data, topics: permitLogs[0]!.topics });
    expect(event.eventName).toBe('Permit');
    expect(event.args).toEqual({ owner, token, spender: router, amount: maxUint160, expiration: Number(expiration), nonce: 0 });

    // Replays the archived allowance reads through readPermit2Allowance's own ABI decoding.
    for (const observation of [value.permit2Allowance.before, value.permit2Allowance.after]) {
      const client = {
        getChainId: vi.fn().mockResolvedValue(arcUniversalRouterMainnet.chainId),
        getBlockNumber: vi.fn(),
        readContract: vi.fn().mockResolvedValue([BigInt(observation.amount), Number(observation.expiration), Number(observation.nonce)]),
      };
      const allowance = await readPermit2Allowance(client as never, {
        owner, token, spender: router, chainId: 5_042, blockNumber: BigInt(observation.blockNumber),
      });
      expect(client.readContract).toHaveBeenCalledWith(expect.objectContaining({
        address: arcUniversalRouterMainnet.contracts.permit2,
        functionName: 'allowance',
        args: [owner, token, router],
        blockNumber: BigInt(observation.blockNumber),
      }));
      expect(client.getBlockNumber).not.toHaveBeenCalled();
      expect(allowance).toMatchObject({ amount: BigInt(observation.amount), expiration: BigInt(observation.expiration), nonce: BigInt(observation.nonce) });
    }
    // The permit consumed nonce 0 and installed exactly the signed allowance.
    expect(value.permit2Allowance.before).toMatchObject({ amount: '0', expiration: '0', nonce: '0' });
    expect(value.permit2Allowance.after).toMatchObject({ amount: maxUint160.toString(), expiration: expiration.toString(), nonce: '1' });
  });
});
