import { getAddress, type Address, type PublicClient } from 'viem';
import { V3_ABI_REVISION, v3PositionManagerAbi } from './v3-abis.js';
import type { UniswapV3Deployment } from './deployments.js';
import { rpc, UniswapSdkError } from './errors.js';

export interface UniswapV3CompatibilityReport {
  chainId: number;
  abiRevision: string;
  contractsWithCode: readonly Address[];
  positionManagerFactory: Address;
  positionManagerWrappedNative: Address;
}

/**
 * Checks chain identity, deployed code, and position-manager wiring. This does
 * not claim bytecode provenance; release evidence must establish that separately.
 */
export async function verifyUniswapV3Compatibility(
  client: PublicClient,
  deployment: UniswapV3Deployment,
): Promise<UniswapV3CompatibilityReport> {
  return rpc(async () => {
    if (deployment.abiRevision !== V3_ABI_REVISION) mismatch('deployment.abiRevision', V3_ABI_REVISION, deployment.abiRevision);
    const chainId = await client.getChainId();
    if (chainId !== deployment.chainId) mismatch('chainId', deployment.chainId, chainId);

    const checked = [
    deployment.contracts.factory,
    deployment.contracts.nonfungiblePositionManager,
    deployment.contracts.quoterV2,
    deployment.contracts.swapRouter02,
    deployment.contracts.wrappedNative,
    deployment.contracts.multicall3,
    ];
    for (const address of checked) {
      const bytecode = await client.getBytecode({ address });
      if (!bytecode || bytecode === '0x') mismatch(`contracts.${address}`, 'deployed bytecode', bytecode ?? 'undefined');
    }

    const [factory, wrappedNative] = await Promise.all([
      readAddress(client, deployment.contracts.nonfungiblePositionManager, 'factory'),
      readAddress(client, deployment.contracts.nonfungiblePositionManager, 'WETH9'),
    ]);
    if (factory.toLowerCase() !== deployment.contracts.factory.toLowerCase()) mismatch('positionManager.factory', deployment.contracts.factory, factory);
    if (wrappedNative.toLowerCase() !== deployment.contracts.wrappedNative.toLowerCase()) mismatch('positionManager.WETH9', deployment.contracts.wrappedNative, wrappedNative);

    return {
      chainId,
      abiRevision: deployment.abiRevision,
      contractsWithCode: checked,
      positionManagerFactory: factory,
      positionManagerWrappedNative: wrappedNative,
    };
  });
}

async function readAddress(client: PublicClient, address: Address, functionName: 'factory' | 'WETH9'): Promise<Address> {
  const value = await client.readContract({ address, abi: v3PositionManagerAbi, functionName });
  return getAddress(value);
}

function mismatch(path: string, expected: unknown, actual: unknown): never {
  throw new UniswapSdkError('DEPLOYMENT_MISMATCH', `${path} mismatch: expected ${String(expected)}, got ${String(actual)}`, {
    path,
    expected: String(expected),
    actual: String(actual),
  });
}
