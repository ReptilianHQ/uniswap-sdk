import { describe, expect, it, vi } from 'vitest';
import { AllowanceTransfer } from '@uniswap/permit2-sdk';
import {
  CallExecutionError,
  encodeFunctionData,
  ExecutionRevertedError,
  getAddress,
  hashTypedData,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  buildPermitSingleTypedData,
  buildV4MintPermitBatchTypedData,
  readPermit2Allowance,
  validatePermitSingle,
  verifyPermitSingleSignature,
} from './permit2.js';
import { erc1271Abi } from './abis.js';
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
  const curveOrder = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const sign = () => account.signTypedData(typedData);
  const parts = (signature: Hex) => ({ r: signature.slice(2, 66), s: BigInt(`0x${signature.slice(66, 130)}`), v: parseInt(signature.slice(130, 132), 16) });
  const word = (value: bigint) => value.toString(16).padStart(64, '0');

  // An EOA owner (no code) on the expected chain; the ERC-1271 call must never be reached.
  function eoaClient(chainId = 5_042) {
    return { getChainId: vi.fn().mockResolvedValue(chainId), getCode: vi.fn().mockResolvedValue(undefined), call: vi.fn() };
  }
  function contractClient(result: unknown) {
    return {
      getChainId: vi.fn().mockResolvedValue(5_042),
      getCode: vi.fn().mockResolvedValue('0x6080'),
      call: result instanceof Error ? vi.fn().mockRejectedValue(result) : vi.fn().mockResolvedValue({ data: result }),
    };
  }
  const base = { owner: account.address, chainId: 5_042 };
  const magicWord = `0x1626ba7e${'00'.repeat(28)}` as Hex;

  it('accepts a 65-byte v=27/28 EOA signature by ecrecover, from typed data or a decoded permit', async () => {
    const signature = await sign();
    expect([27, 28]).toContain(parts(signature).v);
    const client = eoaClient();
    await expect(verifyPermitSingleSignature(client, { ...base, typedData, signature })).resolves.toBe(true);
    await expect(verifyPermitSingleSignature(client, { ...base, permitSingle: typedData.message, signature })).resolves.toBe(true);
    expect(client.call).not.toHaveBeenCalled();
    expect(client.getCode).toHaveBeenCalledWith({ address: account.address, blockNumber: undefined });
  });

  it('accepts the EIP-2098 compact form and a high-s signature, as ecrecover does', async () => {
    const { r, s, v } = parts(await sign());
    const compact = `0x${r}${word(s | (BigInt(v - 27) << 255n))}` as Hex;
    await expect(verifyPermitSingleSignature(eoaClient(), { ...base, typedData, signature: compact })).resolves.toBe(true);
    const highS = `0x${r}${word(curveOrder - s)}${(v === 27 ? 28 : 27).toString(16)}` as Hex;
    await expect(verifyPermitSingleSignature(eoaClient(), { ...base, typedData, signature: highS })).resolves.toBe(true);
  });

  it('rejects v=0/1, other lengths, ERC-6492 wrapping, and another owner, as Permit2 would', async () => {
    const signature = await sign();
    const { r, s, v } = parts(signature);
    // Pick the v=27 form of this signature (it or its high-s twin), then restate its parity
    // as 0: the same point, which ecrecover still refuses because v is not 27 or 28.
    const sV27 = v === 27 ? s : curveOrder - s;
    await expect(verifyPermitSingleSignature(eoaClient(), { ...base, typedData, signature: `0x${r}${word(sV27)}1b` })).resolves.toBe(true);
    for (const rejected of [
      `0x${r}${word(sV27)}00`,
      `0x${r}${word(curveOrder - sV27)}01`,
      `0x${r}${word(s)}`.slice(0, -2),
      `0x${r}${word(sV27)}1b00`,
      `0x${'ab'.repeat(96)}${'6492'.repeat(16)}`,
      `${signature}${'6492'.repeat(16)}`,
      `0x${r}${word(0n)}${v.toString(16)}`,
    ] as Hex[]) {
      await expect(verifyPermitSingleSignature(eoaClient(), { ...base, typedData, signature: rejected }), rejected.slice(-6)).resolves.toBe(false);
    }
    await expect(verifyPermitSingleSignature(eoaClient(), { ...base, owner: spender, typedData, signature })).resolves.toBe(false);
  });

  it('asks only the owner\'s ERC-1271 when the owner has code, including an EIP-7702 delegation', async () => {
    const signature = await sign();
    for (const code of ['0x6080', `0xef0100${'12'.repeat(20)}`]) {
      const client = { ...contractClient(magicWord), getCode: vi.fn().mockResolvedValue(code) };
      // Even a signature that ecrecovers to the owner is judged by the owner's code.
      await expect(verifyPermitSingleSignature(client, { ...base, typedData, signature, blockNumber: 9n })).resolves.toBe(true);
      expect(client.call).toHaveBeenCalledWith({
        to: account.address,
        data: encodeFunctionData({ abi: erc1271Abi, functionName: 'isValidSignature', args: [hashTypedData(typedData), signature] }),
        blockNumber: 9n,
      });
    }
    // A wrapped ERC-6492 signature is refused before asking the owner, even one that would accept it.
    const wrappedClient = contractClient(magicWord);
    await expect(verifyPermitSingleSignature(wrappedClient, { ...base, typedData, signature: `${signature}${'6492'.repeat(16)}` as Hex })).resolves.toBe(false);
    expect(wrappedClient.getChainId).not.toHaveBeenCalled();
    const reverted = new CallExecutionError(new ExecutionRevertedError({ message: 'execution reverted' }), {});
    await expect(verifyPermitSingleSignature(contractClient(reverted), { ...base, typedData, signature })).resolves.toBe(false);
    await expect(verifyPermitSingleSignature(contractClient(new Error('https://user:secret@rpc.example failed')), { ...base, typedData, signature }))
      .rejects.toMatchObject({ code: 'RPC_ERROR' });
  });

  it('accepts only the magic value as one zero-padded word, as Permit2\'s decoder does', async () => {
    const signature = await sign();
    for (const [label, data] of [
      ['dirty padding', `0x1626ba7e${'00'.repeat(27)}01`],
      ['short', '0x1626ba7e'],
      ['long', `${magicWord}${'00'.repeat(32)}`],
      ['wrong value', `0xffffffff${'00'.repeat(28)}`],
      ['empty', undefined],
    ] as const) {
      await expect(verifyPermitSingleSignature(contractClient(data), { ...base, typedData, signature }), label).resolves.toBe(false);
    }
    await expect(verifyPermitSingleSignature(contractClient(magicWord.toUpperCase().replace('0X', '0x')), { ...base, typedData, signature })).resolves.toBe(true);
  });

  it('binds the domain to the expected chain and Permit2, and refuses a client on another chain', async () => {
    const signature = await sign();
    for (const bad of [
      { chainId: 1 },
      { permit2Address: getAddress('0x0000000000000000000000000000000000000abc') },
    ]) {
      await expect(verifyPermitSingleSignature(eoaClient(bad.chainId), { ...base, ...bad, typedData, signature }))
        .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    }
    // A decoded permit carries no domain: the expected chain decides, so a chain-1 check fails.
    await expect(verifyPermitSingleSignature(eoaClient(1), { ...base, chainId: 1, permitSingle: typedData.message, signature })).resolves.toBe(false);
    const wrongChain = eoaClient(1);
    await expect(verifyPermitSingleSignature(wrongChain, { ...base, typedData, signature })).rejects.toMatchObject({ code: 'CHAIN_MISMATCH' });
    expect(wrongChain.getCode).not.toHaveBeenCalled();
  });

  it('verifies against rebuilt typed data, so forged types cannot change what was signed', async () => {
    const forgedTypes = { ...typedData.types, PermitSingle: [...typedData.types.PermitSingle, { name: 'extra', type: 'uint256' }] };
    const forgedSignature = await account.signTypedData({ ...typedData, types: forgedTypes, message: { ...typedData.message, extra: 1n } } as never);
    await expect(verifyPermitSingleSignature(eoaClient(), { ...base, typedData: { ...typedData, types: forgedTypes }, signature: forgedSignature }))
      .resolves.toBe(false);
  });

  it('rejects malformed input before any RPC', async () => {
    const signature = await sign();
    const client = eoaClient();
    for (const bad of [
      { owner: zeroAddress },
      { chainId: 0 },
      { signature: '0x' as Hex },
      { signature: 'abc' as Hex },
      { signature: '0x123' as Hex },
      { blockNumber: -1n },
      { permitSingle: typedData.message },
      { typedData: undefined, permitSingle: undefined },
      { typedData: { ...typedData, primaryType: 'PermitBatch' as 'PermitSingle' } },
      { typedData: { ...typedData, domain: { ...typedData.domain, name: 'Other' as 'Permit2' } } },
      { typedData: { ...typedData, message: { ...typedData.message, sigDeadline: -1n } } },
    ]) {
      await expect(verifyPermitSingleSignature(client, { ...base, typedData, signature, ...bad } as never)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    }
    expect(client.getChainId).not.toHaveBeenCalled();
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
