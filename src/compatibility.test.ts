import { keccak256 } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import {
  arcUniversalRouterMainnet,
  arcUniswapV3Mainnet,
  arcUniswapV4Mainnet,
  robinhoodUniversalRouterMainnet,
  robinhoodUniswapV3Testnet,
  type UniversalRouterDeployment,
  type UniswapV4Deployment,
  type UniswapV3Deployment,
} from './deployments.js';
import { verifyUniversalRouterCompatibility, verifyUniswapV4Compatibility, verifyUniswapV3Compatibility } from './compatibility.js';

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

  // Arc has no WETH9: the manager points at a revert stub while wrappedNative is the USDC ERC-20.
  const arcV3: UniswapV3Deployment = { ...arcUniswapV3Mainnet, runtimeCodeHashes: deployment.runtimeCodeHashes };

  it('checks the manager WETH9 pointer against the wiring pin, not the pair asset', async () => {
    const client = {
      getChainId: vi.fn().mockResolvedValue(arcV3.chainId),
      getBytecode: vi.fn().mockResolvedValue(bytecode),
      readContract: vi.fn()
        .mockResolvedValueOnce(arcV3.contracts.factory)
        .mockResolvedValueOnce(arcV3.positionManagerWiring.wrappedNative),
    };
    const report = await verifyUniswapV3Compatibility(client as never, arcV3);
    expect(report.chainId).toBe(5_042);
    expect(report.positionManagerWrappedNative).toBe(arcV3.positionManagerWiring.wrappedNative);
    expect(report.positionManagerWrappedNative).not.toBe(arcV3.contracts.wrappedNative);
  });

  it('rejects a manager whose WETH9 is the pair asset when the pin says otherwise', async () => {
    const client = {
      getChainId: vi.fn().mockResolvedValue(arcV3.chainId),
      getBytecode: vi.fn().mockResolvedValue(bytecode),
      readContract: vi.fn()
        .mockResolvedValueOnce(arcV3.contracts.factory)
        .mockResolvedValueOnce(arcV3.contracts.wrappedNative),
    };
    await expect(verifyUniswapV3Compatibility(client as never, arcV3)).rejects.toMatchObject({
      code: 'DEPLOYMENT_MISMATCH',
      path: 'positionManager.WETH9',
    });
  });
});

const arcDeployment: UniswapV4Deployment = {
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

function arcClient(overrides: Record<string, unknown> = {}, wiring: readonly unknown[] = [
  arcDeployment.contracts.poolManager,
  arcDeployment.contracts.poolManager,
  arcDeployment.contracts.poolManager,
  arcDeployment.contracts.permit2,
  arcDeployment.positionManagerWiring.wrappedNative,
  arcDeployment.positionManagerWiring.tokenDescriptor,
  arcDeployment.positionManagerWiring.unsubscribeGasLimit,
]) {
  const readContract = vi.fn();
  for (const value of wiring) readContract.mockResolvedValueOnce(value);
  return {
    getChainId: vi.fn().mockResolvedValue(arcDeployment.chainId),
    getBlock: vi.fn().mockResolvedValue({ hash: arcDeployment.referenceBlock.hash }),
    getBytecode: vi.fn().mockResolvedValue(bytecode),
    readContract,
    ...overrides,
  };
}

describe('Uniswap v4 compatibility', () => {
  it.each([
    ['poolManager', arcDeployment.contracts.permit2],
    ['stateView', arcDeployment.contracts.permit2],
    ['quoter', arcDeployment.contracts.permit2],
  ] as const)('rejects top-level %s drift before making RPC calls', async (name, wrongValue) => {
    const client = arcClient();
    const deployment = { ...arcDeployment, [name]: wrongValue };
    await expect(verifyUniswapV4Compatibility(client as never, deployment)).rejects.toMatchObject({
      code: 'DEPLOYMENT_MISMATCH',
      path: name,
    });
    expect(client.getChainId).not.toHaveBeenCalled();
    expect(client.getBlock).not.toHaveBeenCalled();
    expect(client.getBytecode).not.toHaveBeenCalled();
    expect(client.readContract).not.toHaveBeenCalled();
  });

  it('checks the pinned block, runtime code hashes, and immutable wiring', async () => {
    const client = arcClient();
    const report = await verifyUniswapV4Compatibility(client as never, arcDeployment);
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
    expect(client.readContract).toHaveBeenCalledTimes(7);
    for (const [request] of client.readContract.mock.calls) {
      expect(request).toEqual(expect.objectContaining({ blockNumber: arcDeployment.referenceBlock.number }));
    }
  });

  it('rejects a different canonical block before reading bytecode', async () => {
    const client = arcClient({ getBlock: vi.fn().mockResolvedValue({ hash: `0x${'00'.repeat(32)}` }) });
    await expect(verifyUniswapV4Compatibility(client as never, arcDeployment)).rejects.toMatchObject({
      code: 'DEPLOYMENT_MISMATCH',
      path: 'referenceBlock.hash',
    });
    expect(client.getBytecode).not.toHaveBeenCalled();
  });

  it('rejects runtime drift before checking wiring', async () => {
    const client = arcClient({ getBytecode: vi.fn().mockResolvedValue('0x02') });
    await expect(verifyUniswapV4Compatibility(client as never, arcDeployment)).rejects.toMatchObject({
      code: 'DEPLOYMENT_MISMATCH',
      path: 'runtimeCodeHashes.poolManager',
    });
    expect(client.readContract).not.toHaveBeenCalled();
  });

  it.each([
    ['stateView.poolManager', 0, arcDeployment.contracts.permit2],
    ['quoter.poolManager', 1, arcDeployment.contracts.permit2],
    ['positionManager.poolManager', 2, arcDeployment.contracts.permit2],
    ['positionManager.permit2', 3, arcDeployment.contracts.poolManager],
    ['positionManager.WETH9', 4, arcDeployment.contracts.poolManager],
    ['positionManager.tokenDescriptor', 5, arcDeployment.contracts.poolManager],
    ['positionManager.unsubscribeGasLimit', 6, 1n],
  ] as const)('rejects %s wiring drift at the pinned block', async (path, index, wrongValue) => {
    const wiring: unknown[] = [
      arcDeployment.contracts.poolManager,
      arcDeployment.contracts.poolManager,
      arcDeployment.contracts.poolManager,
      arcDeployment.contracts.permit2,
      arcDeployment.positionManagerWiring.wrappedNative,
      arcDeployment.positionManagerWiring.tokenDescriptor,
      arcDeployment.positionManagerWiring.unsubscribeGasLimit,
    ];
    wiring[index] = wrongValue;
    const client = arcClient({}, wiring);
    await expect(verifyUniswapV4Compatibility(client as never, arcDeployment)).rejects.toMatchObject({
      code: 'DEPLOYMENT_MISMATCH',
      path,
    });
    for (const [request] of client.readContract.mock.calls) {
      expect(request).toEqual(expect.objectContaining({ blockNumber: arcDeployment.referenceBlock.number }));
    }
  });
});

describe('Universal Router compatibility', () => {
  const pinned = (deployment: UniversalRouterDeployment): UniversalRouterDeployment => ({
    ...deployment,
    runtimeCodeHashes: { universalRouter: runtimeCodeHash, permit2: runtimeCodeHash },
  });
  const arcRouter = pinned(arcUniversalRouterMainnet);
  const robinhoodRouter = pinned(robinhoodUniversalRouterMainnet);

  function routerClient(deployment: UniversalRouterDeployment, overrides: Record<string, unknown> = {}) {
    return {
      getChainId: vi.fn().mockResolvedValue(deployment.chainId),
      getBlock: vi.fn().mockResolvedValue(deployment.referenceBlock ?? { number: 99n, hash: `0x${'99'.repeat(32)}` }),
      getBytecode: vi.fn().mockResolvedValue(bytecode),
      readContract: vi.fn().mockResolvedValue(deployment.routerWiring.poolManager),
      ...overrides,
    };
  }

  it('checks Arc at its pinned block: block hash, both runtimes, and router PoolManager', async () => {
    const client = routerClient(arcRouter);
    const report = await verifyUniversalRouterCompatibility(client as never, arcRouter);
    expect(report).toEqual({
      chainId: 5_042,
      blockNumber: arcRouter.referenceBlock!.number,
      blockHash: arcRouter.referenceBlock!.hash,
      runtimeCodeHashes: { universalRouter: runtimeCodeHash, permit2: runtimeCodeHash },
      routerPoolManager: arcRouter.routerWiring.poolManager,
    });
    expect(client.getBlock).toHaveBeenCalledWith({ blockNumber: arcRouter.referenceBlock!.number });
    for (const [request] of [...client.getBytecode.mock.calls, ...client.readContract.mock.calls]) {
      expect(request).toEqual(expect.objectContaining({ blockNumber: arcRouter.referenceBlock!.number }));
    }
  });

  it('checks Robinhood at the latest block because its public RPC keeps no history', async () => {
    const client = routerClient(robinhoodRouter);
    const report = await verifyUniversalRouterCompatibility(client as never, robinhoodRouter);
    expect(client.getBlock).toHaveBeenCalledWith({ blockTag: 'latest' });
    expect(report.blockNumber).toBe(99n);
    expect(client.getBytecode).toHaveBeenCalledWith(expect.objectContaining({ address: robinhoodRouter.contracts.universalRouter, blockNumber: 99n }));
  });

  it.each([
    ['chainId', { getChainId: vi.fn().mockResolvedValue(1) }],
    ['referenceBlock.hash', { getBlock: vi.fn().mockResolvedValue({ number: 1n, hash: `0x${'00'.repeat(32)}` }) }],
    ['runtimeCodeHashes.universalRouter', { getBytecode: vi.fn().mockResolvedValue('0x02') }],
    ['contracts.universalRouter', { getBytecode: vi.fn().mockResolvedValue(undefined) }],
    ['universalRouter.poolManager', { readContract: vi.fn().mockResolvedValue(arcUniversalRouterMainnet.contracts.permit2) }],
  ] as const)('rejects %s drift', async (path, override) => {
    await expect(verifyUniversalRouterCompatibility(routerClient(arcRouter, override) as never, arcRouter)).rejects.toMatchObject({
      code: 'DEPLOYMENT_MISMATCH',
      path,
    });
  });

  it('rejects a drifted Permit2 runtime even when the router matches', async () => {
    const client = routerClient(arcRouter, { getBytecode: vi.fn().mockResolvedValueOnce(bytecode).mockResolvedValueOnce('0x02') });
    await expect(verifyUniversalRouterCompatibility(client as never, arcRouter)).rejects.toMatchObject({ path: 'runtimeCodeHashes.permit2' });
  });
});
