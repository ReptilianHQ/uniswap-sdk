#!/usr/bin/env node

import { createPublicClient, http } from 'viem';
import { arcUniswapV4Mainnet, verifyArcUniswapV4Compatibility } from '../dist/v4.js';

const rpcUrl = process.env.UNISWAP_ARC_RPC_URL?.trim() || 'https://rpc.arc-scan.org';
const client = createPublicClient({ transport: http(rpcUrl) });
const report = await verifyArcUniswapV4Compatibility(client, arcUniswapV4Mainnet);

process.stdout.write(
  `ok - ${arcUniswapV4Mainnet.id}: ${Object.keys(report.runtimeCodeHashes).length} runtime hashes, pinned block, and manager wiring verified\n`,
);
