import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { createPublicClient, http, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { verifyUniswapV3Compatibility } from './compatibility.js';
import { robinhoodUniswapV3Mainnet } from './deployments.js';
import { v3PositionManagerAbi } from './v3-abis.js';
import { summarizeV3PositionReceipt } from './v3-receipts.js';
import { buildV3DecreaseAndCollectTransaction, reviewV3CloseCalldata } from './v3-transactions.js';

const FORK_BLOCK = 60_269_962n;
const FORK_BLOCK_HASH = '0x0c8248fedd0d28673c6852b5d65d806dfad9be361e4d90ed5a84664ca72fd8bf';
const POSITION_TOKEN_ID = 1_132_071n;
const POSITION_OWNER = '0x142E748EBcCd0D950B0c259a50B7a1A7c1C84492';
const MAX_UINT256 = (1n << 256n) - 1n;
const forkUrl = process.env.SDK_FORK_EIP155_4663_RPC_URL?.trim();

describe.skipIf(!forkUrl)('Uniswap v3 Robinhood mainnet fork', () => {
  it('builds, reviews, executes, and verifies a full position close', async () => {
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
      const publicClient = createPublicClient({ transport: http(localUrl) });
      const block = await publicClient.getBlock({ blockNumber: FORK_BLOCK });
      expect(block.hash).toBe(FORK_BLOCK_HASH);
      await verifyUniswapV3Compatibility(publicClient, robinhoodUniswapV3Mainnet);

      const manager = robinhoodUniswapV3Mainnet.contracts.nonfungiblePositionManager;
      const owner = await publicClient.readContract({ address: manager, abi: v3PositionManagerAbi, functionName: 'ownerOf', args: [POSITION_TOKEN_ID] });
      expect(owner).toBe(POSITION_OWNER);
      const position = await publicClient.readContract({ address: manager, abi: v3PositionManagerAbi, functionName: 'positions', args: [POSITION_TOKEN_ID] });
      const liquidity = position[7];
      expect(liquidity).toBeGreaterThan(0n);

      await rpc(localUrl, 'anvil_impersonateAccount', [POSITION_OWNER]);
      await rpc(localUrl, 'anvil_setBalance', [POSITION_OWNER, '0x56bc75e2d63100000']);
      const material = buildV3DecreaseAndCollectTransaction({
        manager,
        recipient: POSITION_OWNER,
        tokenId: POSITION_TOKEN_ID,
        decrease: { tokenId: POSITION_TOKEN_ID, liquidity, amount0Min: 0n, amount1Min: 0n, deadline: MAX_UINT256 },
        burn: true,
      });
      expect(reviewV3CloseCalldata(material.data, POSITION_OWNER, POSITION_TOKEN_ID)).toEqual({
        liquidityRemoved: liquidity,
        burned: true,
      });

      const hash = await rpc<Hex>(localUrl, 'eth_sendTransaction', [{
        from: POSITION_OWNER,
        to: material.to,
        data: material.data,
        value: '0x0',
        gas: '0x1e8480',
      }]);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      expect(receipt.status).toBe('success');
      const evidence = summarizeV3PositionReceipt({ logs: receipt.logs, manager, recipient: POSITION_OWNER, tokenId: POSITION_TOKEN_ID });
      expect(evidence.liquidityRemoved).toBe(liquidity);
      expect(evidence.amount0Collected > 0n || evidence.amount1Collected > 0n).toBe(true);
      expect(evidence.burned).toBe(true);
      await expect(publicClient.readContract({ address: manager, abi: v3PositionManagerAbi, functionName: 'ownerOf', args: [POSITION_TOKEN_ID] })).rejects.toThrow();
    } finally {
      anvil.kill('SIGTERM');
    }
  }, 30_000);
});

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
