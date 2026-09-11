import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createPublicClient, http } from 'viem';
import {
  buildV3DecreaseAndCollectTransaction,
  reviewV3CloseCalldata,
  robinhoodUniswapV3Mainnet,
  summarizeV3PositionReceipt,
  v3PositionManagerAbi,
  verifyUniswapV3Compatibility,
} from '../dist/v3.js';

const FORK_BLOCK = 60_269_962n;
const FORK_BLOCK_HASH = '0x0c8248fedd0d28673c6852b5d65d806dfad9be361e4d90ed5a84664ca72fd8bf';
const POSITION_TOKEN_ID = 1_132_071n;
const POSITION_OWNER = '0x142E748EBcCd0D950B0c259a50B7a1A7c1C84492';
const MAX_UINT256 = (1n << 256n) - 1n;

const forkUrl = process.env.UNISWAP_FORK_RPC_URL?.trim();
if (!forkUrl) throw new Error('UNISWAP_FORK_RPC_URL must point to an archive-capable Robinhood mainnet RPC.');

const port = await availablePort();
const localUrl = `http://127.0.0.1:${port}`;
const anvil = spawn('anvil', [
  '--fork-url', forkUrl,
  '--fork-block-number', FORK_BLOCK.toString(),
  '--host', '127.0.0.1',
  '--port', String(port),
  '--silent',
], { stdio: ['ignore', 'ignore', 'pipe'] });
let anvilError = '';
anvil.stderr.setEncoding('utf8');
anvil.stderr.on('data', chunk => { anvilError += chunk; });

try {
  await waitForRpc(localUrl, anvil);
  const publicClient = createPublicClient({ transport: http(localUrl) });
  const block = await publicClient.getBlock({ blockNumber: FORK_BLOCK });
  assert.equal(block.hash, FORK_BLOCK_HASH, 'fork block hash drifted');
  await verifyUniswapV3Compatibility(publicClient, robinhoodUniswapV3Mainnet);

  const manager = robinhoodUniswapV3Mainnet.contracts.nonfungiblePositionManager;
  const owner = await publicClient.readContract({ address: manager, abi: v3PositionManagerAbi, functionName: 'ownerOf', args: [POSITION_TOKEN_ID] });
  assert.equal(owner, POSITION_OWNER, 'pinned position owner drifted');
  const position = await publicClient.readContract({ address: manager, abi: v3PositionManagerAbi, functionName: 'positions', args: [POSITION_TOKEN_ID] });
  const liquidity = position[7];
  assert(liquidity > 0n, 'pinned position has no liquidity');

  await rpc(localUrl, 'anvil_impersonateAccount', [POSITION_OWNER]);
  await rpc(localUrl, 'anvil_setBalance', [POSITION_OWNER, '0x56bc75e2d63100000']);
  const material = buildV3DecreaseAndCollectTransaction({
    manager,
    recipient: POSITION_OWNER,
    tokenId: POSITION_TOKEN_ID,
    decrease: {
      tokenId: POSITION_TOKEN_ID,
      liquidity,
      amount0Min: 0n,
      amount1Min: 0n,
      deadline: MAX_UINT256,
    },
    burn: true,
  });
  assert.deepEqual(reviewV3CloseCalldata(material.data, POSITION_OWNER, POSITION_TOKEN_ID), {
    liquidityRemoved: liquidity,
    burned: true,
  });

  const hash = await rpc(localUrl, 'eth_sendTransaction', [{
    from: POSITION_OWNER,
    to: material.to,
    data: material.data,
    value: '0x0',
    gas: '0x1e8480',
  }]);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, 'success');
  const evidence = summarizeV3PositionReceipt({
    logs: receipt.logs,
    manager,
    recipient: POSITION_OWNER,
    tokenId: POSITION_TOKEN_ID,
  });
  assert.equal(evidence.liquidityRemoved, liquidity);
  assert(evidence.amount0Collected > 0n || evidence.amount1Collected > 0n, 'close collected no tokens');
  assert.equal(evidence.burned, true);
  await assert.rejects(publicClient.readContract({ address: manager, abi: v3PositionManagerAbi, functionName: 'ownerOf', args: [POSITION_TOKEN_ID] }));
  process.stdout.write(`ok - closed position ${POSITION_TOKEN_ID} on pinned Robinhood fork ${FORK_BLOCK}\n`);
} finally {
  anvil.kill('SIGTERM');
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  const { port: selected } = address;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return selected;
}

async function waitForRpc(url, child) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`anvil exited before startup: ${anvilError.trim()}`);
    try {
      await rpc(url, 'eth_chainId', []);
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  throw new Error(`anvil did not start: ${anvilError.trim()}`);
}

async function rpc(url, method, params) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const payload = await response.json();
  if (!response.ok || payload.error) throw new Error(payload.error?.message ?? `RPC ${response.status}`);
  return payload.result;
}
