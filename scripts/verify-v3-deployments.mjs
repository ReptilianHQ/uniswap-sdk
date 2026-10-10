import { createPublicClient, http } from 'viem';
import {
  arcUniswapV3Mainnet,
  robinhoodUniswapV3Mainnet,
  robinhoodUniswapV3Testnet,
  verifyUniswapV3Compatibility,
} from '../dist/v3.js';

const targets = [
  {
    deployment: robinhoodUniswapV3Mainnet,
    rpcUrl: process.env.UNISWAP_MAINNET_RPC_URL?.trim() || 'https://rpc.mainnet.chain.robinhood.com',
  },
  {
    deployment: robinhoodUniswapV3Testnet,
    rpcUrl: process.env.UNISWAP_TESTNET_RPC_URL?.trim() || 'https://rpc.testnet.chain.robinhood.com',
  },
  {
    deployment: arcUniswapV3Mainnet,
    // Same variable the v4 script reads. The public arc-scan endpoint prunes history and was
    // unreachable on 2026-10-10, so this defaults to the dRPC endpoint the hashes were read from.
    rpcUrl: process.env.UNISWAP_ARC_RPC_URL?.trim() || 'https://rpc.drpc.mainnet.arc.io',
  },
];

for (const { deployment, rpcUrl } of targets) {
  const client = createPublicClient({ transport: http(rpcUrl) });
  const report = await verifyUniswapV3Compatibility(client, deployment);
  process.stdout.write(`ok - ${deployment.id}: ${Object.keys(report.runtimeCodeHashes).length} runtime hashes and manager wiring verified\n`);
}
