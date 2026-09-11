import { keccak256 } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import { robinhoodUniswapV3Testnet, type UniswapV3Deployment } from './deployments.js';
import { verifyUniswapV3Compatibility } from './compatibility.js';

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
