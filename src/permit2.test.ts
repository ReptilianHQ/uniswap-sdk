import { describe, expect, it, vi } from 'vitest';
import { AllowanceTransfer } from '@uniswap/permit2-sdk';
import { getAddress, hashTypedData, zeroAddress, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  buildPermitSingleTypedData,
  buildV4MintPermitBatchTypedData,
  readPermit2Allowance,
  validatePermitSingle,
  verifyPermitSingleSignature,
} from './permit2.js';
import { isUniswapSdkError } from './errors.js';

const spender: Address = '0x0000000000000000000000000000000000000900';
const tokenA: Address = '0x0000000000000000000000000000000000000010';
const tokenB: Address = '0x0000000000000000000000000000000000000020';
const permit2Address: Address = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
// zkSync's Permit2 deployment, per @uniswap/permit2-sdk's own permit2Address(chainId).
const zkSyncPermit2Address: Address = '0x0000000000225e31D15943971F47aD3022F714Fa';

const baseInput = {
  chainId: 1,
  spender,
  details: [
    { token: tokenA, amount: 1_000_000n, expiration: 9_999_999_999n, nonce: 0n },
    { token: tokenB, amount: 2_000_000n, expiration: 9_999_999_999n, nonce: 1n },
  ],
  sigDeadline: 9_999_999_999n,
};

describe('v4 mint Permit2 typed data', () => {
  it('builds the canonical Permit2 domain and PermitBatch/PermitDetails EIP-712 types', () => {
    const typedData = buildV4MintPermitBatchTypedData(baseInput);
    expect(typedData.domain).toEqual({ name: 'Permit2', chainId: 1, verifyingContract: permit2Address });
    expect(typedData.primaryType).toBe('PermitBatch');
    expect(typedData.types.PermitBatch).toEqual([
      { name: 'details', type: 'PermitDetails[]' },
      { name: 'spender', type: 'address' },
      { name: 'sigDeadline', type: 'uint256' },
    ]);
    expect(typedData.types.PermitDetails).toEqual([
      { name: 'token', type: 'address' },
      { name: 'amount', type: 'uint160' },
      { name: 'expiration', type: 'uint48' },
      { name: 'nonce', type: 'uint48' },
    ]);
  });

  it('round-trips the batch details, spender, and sigDeadline as bigints', () => {
    const typedData = buildV4MintPermitBatchTypedData(baseInput);
    expect(typedData.message).toEqual({
      details: [
        { token: tokenA, amount: 1_000_000n, expiration: 9_999_999_999n, nonce: 0n },
        { token: tokenB, amount: 2_000_000n, expiration: 9_999_999_999n, nonce: 1n },
      ],
      spender,
      sigDeadline: 9_999_999_999n,
    });
  });

  it('accepts an explicit permit2Address override for a non-standard deployment', () => {
    const override: Address = '0x0000000000000000000000000000000000000abc';
    const typedData = buildV4MintPermitBatchTypedData({ ...baseInput, permit2Address: override });
    expect(typedData.domain.verifyingContract.toLowerCase()).toBe(override.toLowerCase());
  });

  it('resolves the chain-specific Permit2 deployment instead of always using the mainnet address', () => {
    // zkSync (324) is deployed at a different address; a chain-unaware default would emit
    // the mainnet address here, producing a signature Permit2 never sees on that chain.
    const typedData = buildV4MintPermitBatchTypedData({ ...baseInput, chainId: 324 });
    expect(typedData.domain.verifyingContract).toBe(zkSyncPermit2Address);
    expect(typedData.domain.chainId).toBe(324);
    const mainnet = buildV4MintPermitBatchTypedData({ ...baseInput, chainId: 1 });
    expect(mainnet.domain.verifyingContract).toBe(permit2Address);
    expect(mainnet.domain.chainId).toBe(1);
  });

  it('matches the official Permit2 SDK\'s own EIP-712 digest exactly', () => {
    const typedData = buildV4MintPermitBatchTypedData(baseInput);
    const viemHash = hashTypedData({
      domain: typedData.domain,
      types: typedData.types,
      primaryType: 'PermitBatch',
      message: typedData.message,
    });
    const officialHash = AllowanceTransfer.hash(
      {
        details: baseInput.details.map(d => ({ token: d.token, amount: d.amount.toString(), expiration: d.expiration.toString(), nonce: d.nonce.toString() })),
        spender: baseInput.spender,
        sigDeadline: baseInput.sigDeadline.toString(),
      },
      permit2Address,
      baseInput.chainId,
    );
    expect(viemHash.toLowerCase()).toBe(officialHash.toLowerCase());
  });

  it('rejects an empty details array, an invalid chainId, an invalid address, or a zero address as UniswapSdkError', () => {
    for (const bad of [
      { details: [] },
      { chainId: 0 },
      { chainId: -1 },
      { spender: 'not-an-address' as Address },
      { spender: zeroAddress },
      { permit2Address: zeroAddress },
    ]) {
      try {
        buildV4MintPermitBatchTypedData({ ...baseInput, ...bad });
        expect.unreachable(`expected buildV4MintPermitBatchTypedData to reject ${JSON.stringify(bad)}`);
      } catch (error) {
        expect(isUniswapSdkError(error)).toBe(true);
      }
    }
  });

  it('rejects negative amounts, expirations, nonces, and signature deadlines', () => {
    for (const bad of [
      { sigDeadline: -1n },
      { details: [{ ...baseInput.details[0]!, amount: -1n }] },
      { details: [{ ...baseInput.details[0]!, expiration: -1n }] },
      { details: [{ ...baseInput.details[0]!, nonce: -1n }] },
    ]) {
      try {
        buildV4MintPermitBatchTypedData({ ...baseInput, ...bad });
        expect.unreachable(`expected buildV4MintPermitBatchTypedData to reject ${JSON.stringify(bad)}`);
      } catch (error) {
        expect(isUniswapSdkError(error)).toBe(true);
      }
    }
  });

  it('normalizes an official-SDK invariant failure (nonce out of range) into a UniswapSdkError', () => {
    // Permit2's own AllowanceTransfer.getPermitData enforces MaxOrderedNonce; this wrapper's
    // own pre-validation doesn't duplicate that upper-bound range check, so this reaches the
    // official SDK.
    try {
      buildV4MintPermitBatchTypedData({
        ...baseInput,
        details: [{ ...baseInput.details[0]!, nonce: 1n << 60n }],
      });
      expect.unreachable('expected an out-of-range nonce to be rejected');
    } catch (error) {
      expect(isUniswapSdkError(error)).toBe(true);
    }
  });

  it('does not mutate the shared types object across calls', () => {
    const first = buildV4MintPermitBatchTypedData(baseInput);
    // @ts-expect-error -- deliberately mutating a supposedly-independent copy
    first.types.PermitBatch.push({ name: 'forged', type: 'address' });
    const second = buildV4MintPermitBatchTypedData(baseInput);
    expect(second.types.PermitBatch).toHaveLength(3);
  });
});

describe('Permit2 PermitSingle typed data', () => {
  const single = {
    chainId: 5_042,
    token: tokenA,
    amount: 1_000_000n,
    expiration: 9_999_999_999n,
    nonce: 3n,
    spender,
    sigDeadline: 9_999_999_999n,
  };
  const maxUint48 = (1n << 48n) - 1n;
  const maxUint160 = (1n << 160n) - 1n;
  const maxUint256 = (1n << 256n) - 1n;

  it('builds the canonical Permit2 domain and PermitSingle/PermitDetails EIP-712 types', () => {
    const typedData = buildPermitSingleTypedData(single);
    expect(typedData.domain).toEqual({ name: 'Permit2', chainId: 5_042, verifyingContract: permit2Address });
    expect(typedData.primaryType).toBe('PermitSingle');
    expect(typedData.types.PermitSingle).toEqual([
      { name: 'details', type: 'PermitDetails' },
      { name: 'spender', type: 'address' },
      { name: 'sigDeadline', type: 'uint256' },
    ]);
    expect(typedData.types.PermitDetails).toEqual([
      { name: 'token', type: 'address' },
      { name: 'amount', type: 'uint160' },
      { name: 'expiration', type: 'uint48' },
      { name: 'nonce', type: 'uint48' },
    ]);
    expect(typedData.message).toEqual({
      details: { token: tokenA, amount: 1_000_000n, expiration: 9_999_999_999n, nonce: 3n },
      spender,
      sigDeadline: 9_999_999_999n,
    });
  });

  it('matches the official Permit2 SDK digest as viem typed data, unchanged', () => {
    const typedData = buildPermitSingleTypedData(single);
    const officialHash = AllowanceTransfer.hash(
      {
        details: { token: tokenA, amount: '1000000', expiration: '9999999999', nonce: '3' },
        spender,
        sigDeadline: '9999999999',
      },
      permit2Address,
      5_042,
    );
    expect(hashTypedData(typedData).toLowerCase()).toBe(officialHash.toLowerCase());
  });

  it('accepts every field at its declared width boundary', () => {
    const typedData = buildPermitSingleTypedData({ ...single, amount: maxUint160, expiration: maxUint48, nonce: maxUint48, sigDeadline: maxUint256 });
    expect(typedData.message.details).toMatchObject({ amount: maxUint160, expiration: maxUint48, nonce: maxUint48 });
    expect(typedData.message.sigDeadline).toBe(maxUint256);
    expect(buildPermitSingleTypedData({ ...single, amount: 0n, expiration: 0n, nonce: 0n, sigDeadline: 0n }).message.details.amount).toBe(0n);
  });

  it('rejects each field one past its width, negative values, zero addresses, and a bad chain', () => {
    for (const bad of [
      { amount: maxUint160 + 1n },
      { expiration: maxUint48 + 1n },
      { nonce: maxUint48 + 1n },
      { sigDeadline: maxUint256 + 1n },
      { amount: -1n },
      { expiration: -1n },
      { nonce: -1n },
      { sigDeadline: -1n },
      { amount: 1 as unknown as bigint },
      { token: zeroAddress },
      { spender: zeroAddress },
      { permit2Address: zeroAddress },
      { token: 'not-an-address' as Address },
      { chainId: 0 },
      { chainId: 1.5 },
    ]) {
      expect(() => buildPermitSingleTypedData({ ...single, ...bad }), JSON.stringify(bad, (_, v) => typeof v === 'bigint' ? v.toString() : v))
        .toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    }
  });

  it('does not mutate the shared types object across calls', () => {
    const first = buildPermitSingleTypedData(single);
    // @ts-expect-error -- deliberately mutating a supposedly-independent copy
    first.types.PermitSingle.push({ name: 'forged', type: 'address' });
    expect(buildPermitSingleTypedData(single).types.PermitSingle).toHaveLength(3);
  });

  it('validatePermitSingle checksums addresses and rejects out-of-range fields', () => {
    const lower = tokenA.toLowerCase() as Address;
    expect(validatePermitSingle({ details: { token: lower, amount: 1n, expiration: 1n, nonce: 1n }, spender, sigDeadline: 1n }).details.token).toBe(tokenA);
    expect(() => validatePermitSingle({ details: { token: tokenA, amount: 1n, expiration: 1n, nonce: maxUint48 + 1n }, spender, sigDeadline: 1n }))
      .toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
  });
});

describe('Permit2 PermitSingle signature verification', () => {
  // A per-run in-memory key: nothing is committed, funded, or submitted.
  const account = privateKeyToAccount(generatePrivateKey());
  const typedData = buildPermitSingleTypedData({
    chainId: 5_042, token: tokenA, amount: 5n, expiration: 9_999_999_999n, nonce: 0n, spender, sigDeadline: 9_999_999_999n,
  });

  it('recovers an EOA signature locally without calling the client', async () => {
    const signature = await account.signTypedData(typedData);
    const client = { verifyTypedData: vi.fn() };
    await expect(verifyPermitSingleSignature(client, { owner: account.address, typedData, signature })).resolves.toBe(true);
    expect(client.verifyTypedData).not.toHaveBeenCalled();
  });

  it('falls back to the client for an owner local recovery does not match, and returns its answer', async () => {
    const signature = await account.signTypedData(typedData);
    const contractWallet = getAddress('0x0000000000000000000000000000000000001271');
    const accepting = { verifyTypedData: vi.fn().mockResolvedValue(true) };
    await expect(verifyPermitSingleSignature(accepting, { owner: contractWallet, typedData, signature })).resolves.toBe(true);
    expect(accepting.verifyTypedData).toHaveBeenCalledWith(expect.objectContaining({
      address: contractWallet, primaryType: 'PermitSingle', signature, domain: typedData.domain, message: typedData.message,
    }));
    const rejecting = { verifyTypedData: vi.fn().mockResolvedValue(false) };
    await expect(verifyPermitSingleSignature(rejecting, { owner: contractWallet, typedData, signature })).resolves.toBe(false);
  });

  it('sends ERC-6492 and unrecoverable signatures straight to the client', async () => {
    const wrapped = `0x${'ab'.repeat(96)}${'6492'.repeat(16)}` as Hex;
    const client = { verifyTypedData: vi.fn().mockResolvedValue(true) };
    await expect(verifyPermitSingleSignature(client, { owner: account.address, typedData, signature: wrapped })).resolves.toBe(true);
    await expect(verifyPermitSingleSignature(client, { owner: account.address, typedData, signature: '0x1234' })).resolves.toBe(true);
    expect(client.verifyTypedData).toHaveBeenCalledTimes(2);
  });

  it('verifies against rebuilt typed data, so forged types cannot change what was signed', async () => {
    // Sign a struct that only differs from PermitSingle by its declared types.
    const forgedTypes = { ...typedData.types, PermitSingle: [...typedData.types.PermitSingle, { name: 'extra', type: 'uint256' }] };
    const forgedSignature = await account.signTypedData({ ...typedData, types: forgedTypes, message: { ...typedData.message, extra: 1n } } as never);
    const client = { verifyTypedData: vi.fn().mockResolvedValue(false) };
    await expect(verifyPermitSingleSignature(client, {
      owner: account.address, typedData: { ...typedData, types: forgedTypes }, signature: forgedSignature,
    })).resolves.toBe(false);
    expect(client.verifyTypedData).toHaveBeenCalledWith(expect.objectContaining({ types: typedData.types }));
  });

  it('rejects malformed input and surfaces fallback failures as RPC_ERROR', async () => {
    const signature = await account.signTypedData(typedData);
    const client = { verifyTypedData: vi.fn().mockRejectedValue(new Error('https://user:secret@rpc.example failed')) };
    for (const bad of [
      { owner: zeroAddress },
      { signature: '0x' as Hex },
      { signature: 'abc' as Hex },
      { typedData: { ...typedData, primaryType: 'PermitBatch' as 'PermitSingle' } },
      { typedData: { ...typedData, domain: { ...typedData.domain, name: 'Other' as 'Permit2' } } },
      { typedData: { ...typedData, message: { ...typedData.message, sigDeadline: -1n } } },
    ]) {
      await expect(verifyPermitSingleSignature(client, { owner: account.address, typedData, signature, ...bad }))
        .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    }
    await expect(verifyPermitSingleSignature(client, { owner: spender, typedData, signature })).rejects.toMatchObject({ code: 'RPC_ERROR' });
  });
});

describe('Permit2 allowance reads', () => {
  const owner = getAddress('0x0000000000000000000000000000000000000a11');

  function client(chainId = 5_042) {
    return {
      getChainId: vi.fn().mockResolvedValue(chainId),
      getBlockNumber: vi.fn().mockResolvedValue(77n),
      readContract: vi.fn().mockResolvedValue([9n, 1_234, 5]),
    };
  }

  it('reads the canonical per-chain Permit2 at one block and returns bigints', async () => {
    const rpc = client(324);
    const allowance = await readPermit2Allowance(rpc as never, { owner, token: tokenA, spender });
    expect(allowance).toEqual({
      chainId: 324, permit2: zkSyncPermit2Address, owner, token: tokenA, spender, amount: 9n, expiration: 1_234n, nonce: 5n, blockNumber: 77n,
    });
    expect(rpc.readContract).toHaveBeenCalledWith(expect.objectContaining({
      address: zkSyncPermit2Address, functionName: 'allowance', args: [owner, tokenA, spender], blockNumber: 77n,
    }));
  });

  it('honours an explicit block and Permit2 override, and checks an expected chain', async () => {
    const rpc = client();
    const override = getAddress('0x0000000000000000000000000000000000000abc');
    await readPermit2Allowance(rpc as never, { owner, token: tokenA, spender, permit2Address: override, blockNumber: 5n, chainId: 5_042 });
    expect(rpc.getBlockNumber).not.toHaveBeenCalled();
    expect(rpc.readContract).toHaveBeenCalledWith(expect.objectContaining({ address: override, blockNumber: 5n }));
    await expect(readPermit2Allowance(client(1) as never, { owner, token: tokenA, spender, chainId: 5_042 }))
      .rejects.toMatchObject({ code: 'CHAIN_MISMATCH' });
  });

  it('rejects zero addresses and a negative block before any RPC, and wraps RPC failures', async () => {
    const rpc = client();
    for (const bad of [{ owner: zeroAddress }, { token: zeroAddress }, { spender: zeroAddress }, { blockNumber: -1n }, { permit2Address: zeroAddress }]) {
      await expect(readPermit2Allowance(rpc as never, { owner, token: tokenA, spender, ...bad })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    }
    expect(rpc.getChainId).not.toHaveBeenCalled();
    const failing = { ...client(), readContract: vi.fn().mockRejectedValue(new Error('boom')) };
    await expect(readPermit2Allowance(failing as never, { owner, token: tokenA, spender })).rejects.toMatchObject({ code: 'RPC_ERROR' });
  });
});
