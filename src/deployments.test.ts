import { readFileSync } from 'node:fs';
import { getAddress } from 'viem';
import { describe, expect, it } from 'vitest';
import { arcUniswapV4Mainnet, robinhoodUniswapV3Mainnet, robinhoodUniswapV3Testnet } from './deployments.js';

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

describe('Arc Uniswap v4 deployment provenance', () => {
  it('keeps source, runtime, block, and wiring evidence aligned with the exported deployment', () => {
    const record = JSON.parse(
      readFileSync(new URL('../provenance/arc-mainnet-v4.json', import.meta.url), 'utf8'),
    ) as {
      deploymentId: string;
      chainId: number;
      referenceBlock: { number: string; hash: string };
      contracts: Record<string, {
        address: string;
        runtimeCodeHash: string;
        sourceCommit?: string;
        sourcePackageCommit?: string;
        deployerArtifactPath?: string;
        sourceContractPath?: string;
        deploymentTransaction?: string;
        generatedInitcodeHash?: string;
        deploymentManifestInputHash?: string;
        proxy?: boolean;
      }>;
      positionManagerWiring: Record<string, string>;
    };

    expect(record).toMatchObject({
      deploymentId: arcUniswapV4Mainnet.id,
      chainId: arcUniswapV4Mainnet.chainId,
      referenceBlock: {
        number: arcUniswapV4Mainnet.referenceBlock.number.toString(),
        hash: arcUniswapV4Mainnet.referenceBlock.hash,
      },
    });
    for (const [name, address] of Object.entries(arcUniswapV4Mainnet.contracts)) {
      expect(getAddress(record.contracts[name].address)).toBe(address);
      expect(record.contracts[name].runtimeCodeHash).toBe(arcUniswapV4Mainnet.runtimeCodeHashes[name as keyof typeof arcUniswapV4Mainnet.contracts]);
    }
    for (const [name, artifact] of Object.entries(arcUniswapV4Mainnet.retainedArtifacts)) {
      expect(record.contracts[name]).toMatchObject({
        sourceCommit: artifact.sourceCommit,
        sourcePackageCommit: artifact.sourcePackageCommit,
        deployerArtifactPath: artifact.deployerArtifactPath,
        sourceContractPath: artifact.sourceContractPath,
        deploymentTransaction: artifact.deploymentTransaction,
        generatedInitcodeHash: artifact.generatedInitcodeHash,
        deploymentManifestInputHash: artifact.deploymentManifestInputHash,
        proxy: artifact.proxy,
      });
    }
    expect(record.positionManagerWiring).toMatchObject({
      poolManager: arcUniswapV4Mainnet.contracts.poolManager,
      permit2: arcUniswapV4Mainnet.contracts.permit2,
      wrappedNative: arcUniswapV4Mainnet.positionManagerWiring.wrappedNative,
      tokenDescriptor: arcUniswapV4Mainnet.positionManagerWiring.tokenDescriptor,
      unsubscribeGasLimit: arcUniswapV4Mainnet.positionManagerWiring.unsubscribeGasLimit.toString(),
    });
    expect(arcUniswapV4Mainnet).toMatchObject({
      poolManager: arcUniswapV4Mainnet.contracts.poolManager,
      stateView: arcUniswapV4Mainnet.contracts.stateView,
      quoter: arcUniswapV4Mainnet.contracts.quoter,
    });
  });
});
