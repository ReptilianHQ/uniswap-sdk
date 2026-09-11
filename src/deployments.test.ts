import { readFileSync } from 'node:fs';
import { getAddress } from 'viem';
import { describe, expect, it } from 'vitest';
import { robinhoodUniswapV3Mainnet, robinhoodUniswapV3Testnet } from './deployments.js';

function provenance(network: 'mainnet' | 'testnet'): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`../provenance/${network}.json`, import.meta.url), 'utf8')) as Record<string, unknown>;
}

describe('Uniswap v3 deployment provenance', () => {
  it.each([
    ['mainnet', robinhoodUniswapV3Mainnet],
    ['testnet', robinhoodUniswapV3Testnet],
  ] as const)('keeps %s runtime provenance aligned with the exported deployment', (network, deployment) => {
    const record = provenance(network) as {
      deploymentId: string; chainId: number; abiRevision: string;
      contracts: Record<string, string>; runtimeCodeHashes: Record<string, string>;
    };
    expect(record).toMatchObject({
      deploymentId: deployment.id,
      chainId: deployment.chainId,
      abiRevision: deployment.abiRevision,
      runtimeCodeHashes: deployment.runtimeCodeHashes,
    });
    for (const [name, address] of Object.entries(deployment.contracts)) {
      expect(getAddress(record.contracts[name])).toBe(address);
    }
  });
});
