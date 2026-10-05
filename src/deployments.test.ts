import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { getAddress } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  arcUniversalRouterMainnet,
  arcUniswapV4Mainnet,
  findUniversalRouterDeploymentForNetwork,
  findUniswapV3DeploymentForNetwork,
  getUniversalRouterDeployment,
  findUniswapV4DeploymentForNetwork,
  getUniswapV3Deployment,
  getUniswapV4Deployment,
  robinhoodUniswapV3Mainnet,
  robinhoodUniswapV3Testnet,
  robinhoodUniversalRouterMainnet,
  universalRouterDeployments,
  uniswapV3Deployments,
  uniswapV4Deployments,
} from './deployments.js';

// Upstream's ESM build has extensionless directory imports; its CJS export resolves.
const upstream = createRequire(import.meta.url)('@uniswap/sdk-core') as {
  CHAIN_TO_ADDRESSES_MAP: Record<number, Record<string, string | undefined> | undefined>;
};
// Reviewed chains Uniswap's own SDK does not list yet; every other deployment must match upstream.
const notInUpstream = new Set<number>([robinhoodUniswapV3Testnet.chainId]);

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

describe('Universal Router deployment provenance', () => {
  it('derives Arc from the reviewed v4 record so the two pins cannot drift apart', () => {
    expect(arcUniversalRouterMainnet).toMatchObject({
      chainId: arcUniswapV4Mainnet.chainId,
      network: arcUniswapV4Mainnet.network,
      referenceBlock: arcUniswapV4Mainnet.referenceBlock,
      contracts: { universalRouter: arcUniswapV4Mainnet.contracts.universalRouter, permit2: arcUniswapV4Mainnet.contracts.permit2 },
      runtimeCodeHashes: {
        universalRouter: arcUniswapV4Mainnet.runtimeCodeHashes.universalRouter,
        permit2: arcUniswapV4Mainnet.runtimeCodeHashes.permit2,
      },
      routerWiring: { poolManager: arcUniswapV4Mainnet.contracts.poolManager },
    });
  });

  it('keeps Robinhood runtime, constructor, and wiring evidence aligned with the exported deployment', () => {
    const record = JSON.parse(
      readFileSync(new URL('../provenance/robinhood-mainnet-universal-router.json', import.meta.url), 'utf8'),
    ) as {
      deploymentId: string; chainId: number; network: string;
      contracts: Record<string, { address: string; runtimeCodeHash: string; constructorParameters?: Record<string, string> }>;
      routerWiring: Record<string, string>;
    };
    const deployment = robinhoodUniversalRouterMainnet;
    expect(record).toMatchObject({ deploymentId: deployment.id, chainId: deployment.chainId, network: deployment.network });
    expect(Object.keys(record.contracts).sort()).toEqual(Object.keys(deployment.contracts).sort());
    for (const [name, address] of Object.entries(deployment.contracts)) {
      expect(getAddress(record.contracts[name].address)).toBe(address);
      expect(record.contracts[name].runtimeCodeHash).toBe(deployment.runtimeCodeHashes[name as keyof typeof deployment.contracts]);
    }
    const constructor = record.contracts.universalRouter.constructorParameters!;
    expect(getAddress(constructor.permit2)).toBe(deployment.contracts.permit2);
    expect(getAddress(constructor.v4PoolManager)).toBe(deployment.routerWiring.poolManager);
    expect(getAddress(record.routerWiring.poolManager)).toBe(deployment.routerWiring.poolManager);
    // The router was built against the same v3 factory and wrapped native the v3 pin reviews.
    expect(getAddress(constructor.v3Factory)).toBe(robinhoodUniswapV3Mainnet.contracts.factory);
    expect(getAddress(constructor.weth9)).toBe(robinhoodUniswapV3Mainnet.contracts.wrappedNative);
    expect(getAddress(constructor.v3NFTPositionManager)).toBe(robinhoodUniswapV3Mainnet.contracts.nonfungiblePositionManager);
    // The upstream-orphaned v2.1.1 router (placeholder Across SpokePool) must never be the pin.
    expect(deployment.contracts.universalRouter).not.toBe(getAddress('0x8876789976dEcBfCbBbe364623C63652db8C0904'));
    expect(getAddress(constructor.spokePool)).not.toBe(getAddress('0x7332D11BD10d18A04B119Cd4671a96f3148002c4'));
  });

  it('pins one canonical Permit2 address but a distinct runtime per chain', () => {
    const permit2 = new Set(universalRouterDeployments.map(deployment => deployment.contracts.permit2));
    expect([...permit2]).toEqual(['0x000000000022D473030F116dDEE9F6B43aC78BA3']);
    const hashes = new Set(universalRouterDeployments.map(deployment => deployment.runtimeCodeHashes.permit2));
    expect(hashes.size).toBe(universalRouterDeployments.length);
  });
});

describe('reviewed deployment tables', () => {
  it('resolves every reviewed deployment by chain and network, and nothing else', () => {
    // Non-empty, so the upstream comparisons below cannot pass by checking nothing.
    expect(uniswapV3Deployments.length).toBeGreaterThan(0);
    expect(uniswapV4Deployments.length).toBeGreaterThan(0);
    for (const deployment of uniswapV3Deployments) {
      expect(getUniswapV3Deployment(deployment.chainId)).toBe(deployment);
      expect(findUniswapV3DeploymentForNetwork(deployment.network)).toBe(deployment);
    }
    for (const deployment of uniswapV4Deployments) {
      expect(getUniswapV4Deployment(deployment.chainId)).toBe(deployment);
      expect(findUniswapV4DeploymentForNetwork(deployment.network)).toBe(deployment);
    }
    expect(universalRouterDeployments.length).toBeGreaterThan(0);
    for (const deployment of universalRouterDeployments) {
      expect(getUniversalRouterDeployment(deployment.chainId)).toBe(deployment);
      expect(findUniversalRouterDeploymentForNetwork(deployment.network)).toBe(deployment);
    }
    expect(() => getUniversalRouterDeployment(1)).toThrow(expect.objectContaining({ code: 'CHAIN_MISMATCH' }));
    expect(findUniversalRouterDeploymentForNetwork('__proto__')).toBeUndefined();
    expect(() => getUniswapV4Deployment(1)).toThrow(expect.objectContaining({ code: 'CHAIN_MISMATCH' }));
    expect(() => getUniswapV3Deployment(1)).toThrow(expect.objectContaining({ code: 'CHAIN_MISMATCH' }));
    expect(findUniswapV3DeploymentForNetwork('ethereum-mainnet')).toBeUndefined();
    expect(findUniswapV4DeploymentForNetwork('ethereum-mainnet')).toBeUndefined();
    expect(findUniswapV4DeploymentForNetwork('__proto__')).toBeUndefined();
  });

  // universalRouter, permit2, wrappedNative and multicall3 are not in upstream's per-chain map, so they are not compared.
  it('pins the same v4 addresses Uniswap publishes for each chain', () => {
    for (const deployment of uniswapV4Deployments) {
      const published = upstream.CHAIN_TO_ADDRESSES_MAP[deployment.chainId];
      if (notInUpstream.has(deployment.chainId)) {
        expect(published, `${deployment.id} is now listed upstream`).toBeUndefined();
        continue;
      }
      expect(published, `${deployment.id} is not listed upstream`).toBeDefined();
      expect(getAddress(published!.v4PoolManagerAddress!)).toBe(deployment.contracts.poolManager);
      expect(getAddress(published!.v4PositionManagerAddress!)).toBe(deployment.contracts.positionManager);
      expect(getAddress(published!.v4StateView!)).toBe(deployment.contracts.stateView);
      expect(getAddress(published!.v4QuoterAddress!)).toBe(deployment.contracts.quoter);
    }
  });

  it('pins the same v3 addresses Uniswap publishes for each chain', () => {
    for (const deployment of uniswapV3Deployments) {
      const published = upstream.CHAIN_TO_ADDRESSES_MAP[deployment.chainId];
      if (notInUpstream.has(deployment.chainId)) {
        expect(published, `${deployment.id} is now listed upstream`).toBeUndefined();
        continue;
      }
      expect(published, `${deployment.id} is not listed upstream`).toBeDefined();
      expect(getAddress(published!.v3CoreFactoryAddress!)).toBe(deployment.contracts.factory);
      expect(getAddress(published!.nonfungiblePositionManagerAddress!)).toBe(deployment.contracts.nonfungiblePositionManager);
      expect(getAddress(published!.quoterAddress!)).toBe(deployment.contracts.quoterV2);
      expect(getAddress(published!.swapRouter02Address!)).toBe(deployment.contracts.swapRouter02);
    }
  });
});
