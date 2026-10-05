#!/usr/bin/env node

import { createPublicClient, http } from 'viem';
import {
  arcUniversalRouterMainnet,
  robinhoodUniversalRouterMainnet,
  verifyUniversalRouterCompatibility,
} from '../dist/v3.js';

// Arc's public RPC is Cloudflare-fronted and rejects requests without a user agent.
const fetchOptions = { headers: { 'User-Agent': 'reptilian-uniswap-sdk live-compatibility (read-only)' } };
const targets = [
  { deployment: arcUniversalRouterMainnet, rpcUrl: process.env.UNISWAP_ARC_RPC_URL?.trim() || 'https://rpc.mainnet.arc.io' },
  { deployment: robinhoodUniversalRouterMainnet, rpcUrl: process.env.UNISWAP_MAINNET_RPC_URL?.trim() || 'https://rpc.mainnet.chain.robinhood.com' },
];

for (const { deployment, rpcUrl } of targets) {
  const client = createPublicClient({ transport: http(rpcUrl, { fetchOptions }) });
  const report = await verifyUniversalRouterCompatibility(client, deployment);
  process.stdout.write(
    `ok - ${deployment.id}: router and Permit2 runtime hashes and router PoolManager verified at block ${report.blockNumber}\n`,
  );
}
