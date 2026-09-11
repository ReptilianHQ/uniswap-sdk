import { describe, expect, it, vi } from 'vitest';
import { robinhoodUniswapV3Testnet } from './deployments.js';
import { verifyUniswapV3Compatibility } from './compatibility.js';

describe('Uniswap v3 compatibility', () => {
  it('checks chain, code presence, and position-manager wiring', async () => {
    const client = {
      getChainId: vi.fn().mockResolvedValue(robinhoodUniswapV3Testnet.chainId),
      getBytecode: vi.fn().mockResolvedValue('0x01'),
      readContract: vi.fn()
        .mockResolvedValueOnce(robinhoodUniswapV3Testnet.contracts.factory)
        .mockResolvedValueOnce(robinhoodUniswapV3Testnet.contracts.wrappedNative),
    };
    const report = await verifyUniswapV3Compatibility(client as never, robinhoodUniswapV3Testnet);
    expect(report.chainId).toBe(46_630);
    expect(report.contractsWithCode).toHaveLength(6);
  });

  it('rejects a wrong chain before inspecting contracts', async () => {
    const client = { getChainId: vi.fn().mockResolvedValue(1), getBytecode: vi.fn() };
    await expect(verifyUniswapV3Compatibility(client as never, robinhoodUniswapV3Testnet)).rejects.toMatchObject({ code: 'DEPLOYMENT_MISMATCH' });
    expect(client.getBytecode).not.toHaveBeenCalled();
  });
});
