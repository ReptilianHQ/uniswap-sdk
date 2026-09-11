import { createPublicClient, http } from 'viem';
import {
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
];

for (const { deployment, rpcUrl } of targets) {
  const client = createPublicClient({ transport: http(rpcUrl) });
  const report = await verifyUniswapV3Compatibility(client, deployment);
  process.stdout.write(`ok - ${deployment.id}: ${Object.keys(report.runtimeCodeHashes).length} runtime hashes and manager wiring verified\n`);
}
