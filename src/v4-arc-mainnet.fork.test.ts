import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { Token } from '@uniswap/sdk-core';
import {
  createPublicClient,
  encodeFunctionData,
  getAddress,
  http,
  parseAbi,
  parseEventLogs,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from 'viem';
import { describe, expect, it } from 'vitest';
import { verifyUniswapV4Compatibility } from './compatibility.js';
import { arcUniswapV4Mainnet } from './deployments.js';
import { getV4PoolId } from './pool.js';
import { readV4Pool } from './reads.js';
import {
  buildV4IncreasePositionTransaction,
  buildV4MintPositionTransaction,
  buildV4RemovePositionTransaction,
  reviewV4IncreasePositionCalldata,
  reviewV4MintPositionCalldata,
  reviewV4RemovePositionCalldata,
  type V4PoolState,
  type V4TransactionMaterial,
} from './v4-transactions.js';

const FORK_BLOCK = 20_889_496n;
const FORK_BLOCK_HASH = '0xf3fd31df5afb9d37a216dda53ac751a6a6c08a9c7e96ce4c07fb0df18d40810b';
const INITIAL_SQRT_PRICE_X96 = 1n << 96n;
const MAX_UINT160 = (1n << 160n) - 1n;
const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_UINT48 = (1n << 48n) - 1n;
const FUNDED_ACCOUNT = getAddress('0xec57c01609cd12813f473e8cbef0e704b2a9fa62');
const TOKEN0 = getAddress('0x247D016816e4CCBb2f7C4D510843c6a3B1dD8Ef7');
const TOKEN1 = getAddress('0xA4824D1927ccC6B562a2d3BD5f7FBeC4ca045629');
const forkUrl = process.env.SDK_FORK_EIP155_5042_RPC_URL?.trim();

const erc20Abi = parseAbi([
  'function approve(address spender,uint256 amount) returns (bool)',
  'function allowance(address owner,address spender) view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
]);
const permit2Abi = parseAbi([
  'function approve(address token,address spender,uint160 amount,uint48 expiration)',
  'function allowance(address owner,address token,address spender) view returns (uint160 amount,uint48 expiration,uint48 nonce)',
  'function transferFrom(address from,address to,uint160 amount,address token)',
]);
const positionReadAbi = parseAbi([
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function getPositionLiquidity(uint256 tokenId) view returns (uint128)',
  'function getPoolAndPositionInfo(uint256 tokenId) view returns ((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,uint256 info)',
  'event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)',
]);

describe.skipIf(!forkUrl)('Uniswap v4 Arc mainnet fork', () => {
  it('mints, increases, partially removes, and atomically closes an independently owned unhooked position', async () => {
    const port = await availablePort();
    const localUrl = `http://127.0.0.1:${port}`;
    const anvil = spawn('anvil', [
      '--fork-url', forkUrl!,
      '--fork-block-number', FORK_BLOCK.toString(),
      '--host', '127.0.0.1',
      '--port', String(port),
      '--silent',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let anvilError = '';
    anvil.stderr?.setEncoding('utf8');
    anvil.stderr?.on('data', chunk => { anvilError += String(chunk); });

    try {
      await waitForRpc(localUrl, anvil, () => anvilError);
      const client = createPublicClient({ transport: http(localUrl) });
      const block = await client.getBlock({ blockNumber: FORK_BLOCK });
      expect(block.hash).toBe(FORK_BLOCK_HASH);
      await verifyUniswapV4Compatibility(client, arcUniswapV4Mainnet);

      const account = FUNDED_ACCOUNT;
      await rpc(localUrl, 'anvil_impersonateAccount', [account]);
      await rpc(localUrl, 'anvil_setBalance', [account, toHex(1_000n * 10n ** 18n)]);
      const manager = arcUniswapV4Mainnet.contracts.positionManager;
      const permit2 = arcUniswapV4Mainnet.contracts.permit2;

      for (const token of [TOKEN0, TOKEN1]) {
        await sendCall(localUrl, client, account, token, encodeFunctionData({
          abi: erc20Abi,
          functionName: 'approve',
          args: [permit2, MAX_UINT256],
        }));
        await sendCall(localUrl, client, account, permit2, encodeFunctionData({
          abi: permit2Abi,
          functionName: 'approve',
          args: [token, manager, MAX_UINT160, Number(MAX_UINT48)],
        }));
        expect(await client.readContract({
          address: token,
          abi: erc20Abi,
          functionName: 'allowance',
          args: [account, permit2],
        })).toBe(MAX_UINT256);
        expect((await client.readContract({
          address: permit2,
          abi: permit2Abi,
          functionName: 'allowance',
          args: [account, token, manager],
        }))[0]).toBe(MAX_UINT160);
        try {
          await client.call({
            account: manager,
            to: permit2,
            data: encodeFunctionData({
              abi: permit2Abi,
              functionName: 'transferFrom',
              args: [account, account, 1n, token],
            }),
          });
        } catch (cause) {
          throw new Error(`Permit2 transfer preflight failed for ${token}`, { cause });
        }
      }

      const currency0 = new Token(arcUniswapV4Mainnet.chainId, TOKEN0, 18, 'ARGUS-A');
      const currency1 = new Token(arcUniswapV4Mainnet.chainId, TOKEN1, 18, 'ARGUS-B');
      const key = {
        currency0: TOKEN0,
        currency1: TOKEN1,
        fee: 4_242,
        tickSpacing: 6,
        hooks: zeroAddress,
      } as const;
      const basePool: V4PoolState = {
        currency0,
        currency1,
        fee: key.fee,
        tickSpacing: key.tickSpacing,
        hooks: key.hooks,
        sqrtPriceX96: INITIAL_SQRT_PRICE_X96,
        liquidity: 0n,
        tickCurrent: 0,
      };
      const deadline = (await client.getBlock()).timestamp + 3_600n;
      const mintLiquidity = 10_000_000n;
      const mint = buildV4MintPositionTransaction({
        positionManager: manager,
        pool: basePool,
        tickLower: -600,
        tickUpper: 600,
        liquidity: mintLiquidity,
        recipient: account,
        slippageToleranceBps: 100,
        deadlineSeconds: deadline,
        createPool: true,
      });
      expect(reviewV4MintPositionCalldata(mint.data, {
        ...key,
        recipient: account,
        sqrtPriceX96: INITIAL_SQRT_PRICE_X96,
      })).toMatchObject({
        owner: account,
        liquidity: mintLiquidity,
        hookData: '0x',
        createdAtSqrtPriceX96: INITIAL_SQRT_PRICE_X96,
      });
      const mintReceipt = await sendMaterial(localUrl, client, account, mint);
      const transfer = parseEventLogs({
        abi: positionReadAbi,
        logs: mintReceipt.logs.filter(log => log.address.toLowerCase() === manager.toLowerCase()),
        eventName: 'Transfer',
      }).find(log => log.args.from === zeroAddress && log.args.to.toLowerCase() === account.toLowerCase());
      expect(transfer).toBeDefined();
      const tokenId = transfer!.args.tokenId;
      await expectPosition(client, manager, tokenId, account, mintLiquidity, key, -600, 600);

      const increaseLiquidity = 5_000_000n;
      const increasePool = await observedPool(client, basePool, key);
      const increase = buildV4IncreasePositionTransaction({
        positionManager: manager,
        pool: increasePool,
        tokenId,
        tickLower: -600,
        tickUpper: 600,
        liquidityToAdd: increaseLiquidity,
        slippageToleranceBps: 100,
        deadlineSeconds: deadline,
      });
      expect(reviewV4IncreasePositionCalldata(increase.data, { ...key, tokenId })).toMatchObject({
        tokenId,
        liquidityAdded: increaseLiquidity,
        hookData: '0x',
      });
      await sendMaterial(localUrl, client, account, increase);
      const totalLiquidity = mintLiquidity + increaseLiquidity;
      await expectPosition(client, manager, tokenId, account, totalLiquidity, key, -600, 600);

      const partialLiquidity = totalLiquidity / 3n;
      const partialPool = await observedPool(client, basePool, key);
      const partial = buildV4RemovePositionTransaction({
        positionManager: manager,
        pool: partialPool,
        tokenId,
        tickLower: -600,
        tickUpper: 600,
        liquidity: totalLiquidity,
        liquidityToRemove: partialLiquidity,
        slippageToleranceBps: 100,
        deadlineSeconds: deadline,
      });
      expect(reviewV4RemovePositionCalldata(partial.data, {
        ...key,
        tokenId,
        liquidityToRemove: partialLiquidity,
        burnToken: false,
      })).toMatchObject({ tokenId, liquidityRemoved: partialLiquidity, burned: false, hookData: '0x' });
      const balancesBeforePartial = await balances(client, account);
      await sendMaterial(localUrl, client, account, partial);
      const balancesAfterPartial = await balances(client, account);
      expect(balancesAfterPartial.token0).toBeGreaterThan(balancesBeforePartial.token0);
      expect(balancesAfterPartial.token1).toBeGreaterThan(balancesBeforePartial.token1);
      const remainingLiquidity = totalLiquidity - partialLiquidity;
      await expectPosition(client, manager, tokenId, account, remainingLiquidity, key, -600, 600);

      const closePool = await observedPool(client, basePool, key);
      const close = buildV4RemovePositionTransaction({
        positionManager: manager,
        pool: closePool,
        tokenId,
        tickLower: -600,
        tickUpper: 600,
        liquidity: remainingLiquidity,
        liquidityToRemove: remainingLiquidity,
        burnToken: true,
        slippageToleranceBps: 100,
        deadlineSeconds: deadline,
      });
      expect(reviewV4RemovePositionCalldata(close.data, {
        ...key,
        tokenId,
        liquidityToRemove: remainingLiquidity,
        burnToken: true,
      })).toMatchObject({ tokenId, liquidityRemoved: remainingLiquidity, burned: true, hookData: '0x' });
      const balancesBeforeClose = await balances(client, account);
      await sendMaterial(localUrl, client, account, close);
      const balancesAfterClose = await balances(client, account);
      expect(balancesAfterClose.token0).toBeGreaterThan(balancesBeforeClose.token0);
      expect(balancesAfterClose.token1).toBeGreaterThan(balancesBeforeClose.token1);
      await expect(client.readContract({ address: manager, abi: positionReadAbi, functionName: 'ownerOf', args: [tokenId] })).rejects.toThrow();
    } finally {
      anvil.kill('SIGTERM');
    }
  }, 90_000);
});

async function observedPool(
  client: PublicClient,
  base: V4PoolState,
  key: { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address },
): Promise<V4PoolState> {
  const snapshot = await readV4Pool(client, arcUniswapV4Mainnet, key);
  return { ...base, sqrtPriceX96: snapshot.sqrtPriceX96, liquidity: snapshot.liquidity, tickCurrent: snapshot.tick };
}

async function expectPosition(
  client: PublicClient,
  manager: Address,
  tokenId: bigint,
  owner: Address,
  liquidity: bigint,
  key: { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address },
  tickLower: number,
  tickUpper: number,
) {
  const [actualOwner, actualLiquidity, [actualKey, info]] = await Promise.all([
    client.readContract({ address: manager, abi: positionReadAbi, functionName: 'ownerOf', args: [tokenId] }),
    client.readContract({ address: manager, abi: positionReadAbi, functionName: 'getPositionLiquidity', args: [tokenId] }),
    client.readContract({ address: manager, abi: positionReadAbi, functionName: 'getPoolAndPositionInfo', args: [tokenId] }),
  ]);
  const expectedPoolId = getV4PoolId(key);
  expect(actualOwner).toBe(owner);
  expect(actualLiquidity).toBe(liquidity);
  expect(getV4PoolId(actualKey)).toBe(expectedPoolId);
  expect(info >> 56n).toBe(BigInt(expectedPoolId) >> 56n);
  expect(Number(BigInt.asIntN(24, info >> 8n))).toBe(tickLower);
  expect(Number(BigInt.asIntN(24, info >> 32n))).toBe(tickUpper);
}

async function balances(client: PublicClient, account: Address) {
  const [token0, token1] = await Promise.all([
    client.readContract({ address: TOKEN0, abi: erc20Abi, functionName: 'balanceOf', args: [account] }),
    client.readContract({ address: TOKEN1, abi: erc20Abi, functionName: 'balanceOf', args: [account] }),
  ]);
  return { token0, token1 };
}

async function sendMaterial(
  url: string,
  client: PublicClient,
  account: Address,
  material: V4TransactionMaterial,
): Promise<TransactionReceipt> {
  return sendCall(url, client, account, material.to, material.data, material.value);
}

async function sendCall(
  url: string,
  client: PublicClient,
  account: Address,
  to: Address,
  data: Hex,
  value = 0n,
): Promise<TransactionReceipt> {
  await client.call({ account, to, data, value });
  const hash = await rpc<Hex>(url, 'eth_sendTransaction', [{
    from: account,
    to,
    data,
    value: toHex(value),
    gas: toHex(10_000_000n),
  }]);
  const receipt = await client.waitForTransactionReceipt({ hash });
  expect(receipt.status).toBe('success');
  return receipt;
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to allocate an Anvil port');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

async function waitForRpc(url: string, child: ChildProcess, errorText: () => string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`anvil exited before startup: ${errorText().trim()}`);
    try {
      await rpc(url, 'eth_chainId', []);
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  throw new Error(`anvil did not start: ${errorText().trim()}`);
}

async function rpc<T = unknown>(url: string, method: string, params: unknown[]): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const payload = await response.json() as { result?: T; error?: { message?: string } };
  if (!response.ok || payload.error || payload.result === undefined) throw new Error(payload.error?.message ?? `RPC ${response.status}`);
  return payload.result;
}
