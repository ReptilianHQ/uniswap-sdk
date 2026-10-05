#!/usr/bin/env node

import { createPublicClient, http } from 'viem';
import { arcUniswapV4Mainnet, verifyUniswapV4Compatibility } from '../dist/v4.js';

// Circle's public Arc endpoint; rpc.arc-scan.org stopped serving on 2026-10-04. It is
// Cloudflare-fronted and rejects requests without a user agent.
const rpcUrl = process.env.UNISWAP_ARC_RPC_URL?.trim() || 'https://rpc.mainnet.arc.io';
const fetchOptions = { headers: { 'User-Agent': 'reptilian-uniswap-sdk live-compatibility (read-only)' } };
const client = createPublicClient({ transport: http(rpcUrl, { fetchOptions }) });
const report = await verifyUniswapV4Compatibility(client, arcUniswapV4Mainnet);

process.stdout.write(
  `ok - ${arcUniswapV4Mainnet.id}: ${Object.keys(report.runtimeCodeHashes).length} runtime hashes, pinned block, and manager wiring verified\n`,
);
