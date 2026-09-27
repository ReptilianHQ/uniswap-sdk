import { keccak256 } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import {
  arcUniswapV4Mainnet,
  robinhoodUniswapV3Testnet,
  type ArcUniswapV4Deployment,
  type UniswapV3Deployment,
} from './deployments.js';
import { verifyArcUniswapV4Compatibility, verifyUniswapV3Compatibility } from './compatibility.js';

const bytecode = '0x01' as const;
const runtimeCodeHash = keccak256(bytecode);
const deployment: UniswapV3Deployment = {
  ...robinhoodUniswapV3Testnet,
  runtimeCodeHashes: {
    factory: runtimeCodeHash,
    nonfungiblePositionManager: runtimeCodeHash,
    quoterV2: runtimeCodeHash,
    swapRouter02: runtimeCodeHash,
    wrappedNative: runtimeCodeHash,
    multicall3: runtimeCodeHash,
  },
};

describe('Uniswap v3 compatibility', () => {
  it('checks chain, runtime code hashes, and position-manager wiring', async () => {
    const client = {
      getChainId: vi.fn().mockResolvedValue(deployment.chainId),
      getBytecode: vi.fn().mockResolvedValue(bytecode),
      readContract: vi.fn()
        .mockResolvedValueOnce(deployment.contracts.factory)
        .mockResolvedValueOnce(deployment.contracts.wrappedNative),
    };
    const report = await verifyUniswapV3Compatibility(client as never, deployment);
    expect(report.chainId).toBe(46_630);
    expect(report.contractsWithCode).toHaveLength(6);
    expect(report.runtimeCodeHashes.factory).toBe(runtimeCodeHash);
  });

  it('rejects runtime code drift before checking wiring', async () => {
    const client = {
      getChainId: vi.fn().mockResolvedValue(deployment.chainId),
      getBytecode: vi.fn().mockResolvedValue('0x02'),
      readContract: vi.fn(),
    };
    await expect(verifyUniswapV3Compatibility(client as never, deployment)).rejects.toMatchObject({
      code: 'DEPLOYMENT_MISMATCH',
      path: 'runtimeCodeHashes.factory',
    });
    expect(client.readContract).not.toHaveBeenCalled();
  });

  it('rejects a wrong chain before inspecting contracts', async () => {
    const client = { getChainId: vi.fn().mockResolvedValue(1), getBytecode: vi.fn() };
    await expect(verifyUniswapV3Compatibility(client as never, deployment)).rejects.toMatchObject({ code: 'DEPLOYMENT_MISMATCH' });
    expect(client.getBytecode).not.toHaveBeenCalled();
  });
});

const arcDeployment: ArcUniswapV4Deployment = {
  ...arcUniswapV4Mainnet,
  runtimeCodeHashes: {
    poolManager: runtimeCodeHash,
    stateView: runtimeCodeHash,
    positionManager: runtimeCodeHash,
    quoter: runtimeCodeHash,
    universalRouter: runtimeCodeHash,
    permit2: runtimeCodeHash,
  },
};

function arcClient(overrides: Record<string, unknown> = {}) {
  return {
    getChainId: vi.fn().mockResolvedValue(arcDeployment.chainId),
    getBlock: vi.fn().mockResolvedValue({ hash: arcDeployment.referenceBlock.hash }),
    getBytecode: vi.fn().mockResolvedValue(bytecode),
    readContract: vi.fn()
      .mockResolvedValueOnce(arcDeployment.contracts.poolManager)
      .mockResolvedValueOnce(arcDeployment.contracts.poolManager)
      .mockResolvedValueOnce(arcDeployment.contracts.poolManager)
      .mockResolvedValueOnce(arcDeployment.contracts.permit2)
      .mockResolvedValueOnce(arcDeployment.positionManagerWiring.wrappedNative)
      .mockResolvedValueOnce(arcDeployment.positionManagerWiring.tokenDescriptor)
      .mockResolvedValueOnce(arcDeployment.positionManagerWiring.unsubscribeGasLimit),
    ...overrides,
  };
}

describe('Arc Uniswap v4 compatibility', () => {
  it('checks the pinned block, runtime code hashes, and immutable wiring', async () => {
    const client = arcClient();
    const report = await verifyArcUniswapV4Compatibility(client as never, arcDeployment);
    expect(report).toMatchObject({
      chainId: 5_042,
      blockNumber: arcDeployment.referenceBlock.number,
      blockHash: arcDeployment.referenceBlock.hash,
      positionManagerPoolManager: arcDeployment.contracts.poolManager,
      positionManagerPermit2: arcDeployment.contracts.permit2,
    });
    expect(report.contractsWithCode).toHaveLength(6);
    expect(client.getBytecode).toHaveBeenCalledWith(expect.objectContaining({
      blockNumber: arcDeployment.referenceBlock.number,
    }));
  });

  it('rejects a different canonical block before reading bytecode', async () => {
    const client = arcClient({ getBlock: vi.fn().mockResolvedValue({ hash: `0x${'00'.repeat(32)}` }) });
    await expect(verifyArcUniswapV4Compatibility(client as never, arcDeployment)).rejects.toMatchObject({
      code: 'DEPLOYMENT_MISMATCH',
      path: 'referenceBlock.hash',
    });
    expect(client.getBytecode).not.toHaveBeenCalled();
  });

  it('rejects runtime drift before checking wiring', async () => {
    const client = arcClient({ getBytecode: vi.fn().mockResolvedValue('0x02') });
    await expect(verifyArcUniswapV4Compatibility(client as never, arcDeployment)).rejects.toMatchObject({
      code: 'DEPLOYMENT_MISMATCH',
      path: 'runtimeCodeHashes.poolManager',
    });
    expect(client.readContract).not.toHaveBeenCalled();
  });
});
