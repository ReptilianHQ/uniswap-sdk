import { getAddress, keccak256, type Address, type Hex, type PublicClient } from 'viem';
import { v4PositionManagerAbi, v4QuoterAbi, v4StateViewAbi } from './abis.js';
import { V3_ABI_REVISION, v3PositionManagerAbi } from './v3-abis.js';
import type {
  ArcUniswapV4ContractName,
  ArcUniswapV4Deployment,
  UniswapV3ContractName,
  UniswapV3Deployment,
} from './deployments.js';
import { rpc, UniswapSdkError } from './errors.js';

export interface UniswapV3CompatibilityReport {
  chainId: number;
  abiRevision: string;
  contractsWithCode: readonly Address[];
  runtimeCodeHashes: Readonly<Record<UniswapV3ContractName, Hex>>;
  positionManagerFactory: Address;
  positionManagerWrappedNative: Address;
}

export interface ArcUniswapV4CompatibilityReport {
  chainId: number;
  blockNumber: bigint;
  blockHash: Hex;
  contractsWithCode: readonly Address[];
  runtimeCodeHashes: Readonly<Record<ArcUniswapV4ContractName, Hex>>;
  stateViewPoolManager: Address;
  quoterPoolManager: Address;
  positionManagerPoolManager: Address;
  positionManagerPermit2: Address;
  positionManagerWrappedNative: Address;
  positionManagerTokenDescriptor: Address;
  positionManagerUnsubscribeGasLimit: bigint;
}

/**
 * Checks chain identity, exact runtime code hashes, and position-manager wiring.
 */
export async function verifyUniswapV3Compatibility(
  client: PublicClient,
  deployment: UniswapV3Deployment,
): Promise<UniswapV3CompatibilityReport> {
  return rpc(async () => {
    if (deployment.abiRevision !== V3_ABI_REVISION) mismatch('deployment.abiRevision', V3_ABI_REVISION, deployment.abiRevision);
    const chainId = await client.getChainId();
    if (chainId !== deployment.chainId) mismatch('chainId', deployment.chainId, chainId);

    const contractNames = Object.keys(deployment.contracts) as UniswapV3ContractName[];
    const checked = contractNames.map(name => deployment.contracts[name]);
    const runtimeCodeHashes = {} as Record<UniswapV3ContractName, Hex>;
    for (const name of contractNames) {
      const address = deployment.contracts[name];
      const bytecode = await client.getBytecode({ address });
      if (!bytecode || bytecode === '0x') mismatch(`contracts.${address}`, 'deployed bytecode', bytecode ?? 'undefined');
      const runtimeCodeHash = keccak256(bytecode);
      if (runtimeCodeHash !== deployment.runtimeCodeHashes[name]) {
        mismatch(`runtimeCodeHashes.${name}`, deployment.runtimeCodeHashes[name], runtimeCodeHash);
      }
      runtimeCodeHashes[name] = runtimeCodeHash;
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
      runtimeCodeHashes,
      positionManagerFactory: factory,
      positionManagerWrappedNative: wrappedNative,
    };
  });
}

/**
 * Rechecks the exact Arc block, runtime bytecode, and v4 immutable wiring.
 * Retained upstream generated initcode is verified separately by
 * verify-v4-retained-artifacts.mjs; that check is not a fresh source compilation.
 */
export async function verifyArcUniswapV4Compatibility(
  client: PublicClient,
  deployment: ArcUniswapV4Deployment,
): Promise<ArcUniswapV4CompatibilityReport> {
  return rpc(async () => {
    for (const name of ['poolManager', 'stateView', 'quoter'] as const) {
      if (deployment[name].toLowerCase() !== deployment.contracts[name].toLowerCase()) {
        mismatch(name, deployment.contracts[name], deployment[name]);
      }
    }

    const chainId = await client.getChainId();
    if (chainId !== deployment.chainId) mismatch('chainId', deployment.chainId, chainId);

    const block = await client.getBlock({ blockNumber: deployment.referenceBlock.number });
    if (block.hash !== deployment.referenceBlock.hash) {
      mismatch('referenceBlock.hash', deployment.referenceBlock.hash, block.hash);
    }

    const contractNames = Object.keys(deployment.contracts) as ArcUniswapV4ContractName[];
    const checked = contractNames.map(name => deployment.contracts[name]);
    const runtimeCodeHashes = {} as Record<ArcUniswapV4ContractName, Hex>;
    for (const name of contractNames) {
      const address = deployment.contracts[name];
      const bytecode = await client.getBytecode({ address, blockNumber: deployment.referenceBlock.number });
      if (!bytecode || bytecode === '0x') mismatch(`contracts.${name}`, 'deployed bytecode', bytecode ?? 'undefined');
      const runtimeCodeHash = keccak256(bytecode);
      if (runtimeCodeHash !== deployment.runtimeCodeHashes[name]) {
        mismatch(`runtimeCodeHashes.${name}`, deployment.runtimeCodeHashes[name], runtimeCodeHash);
      }
      runtimeCodeHashes[name] = runtimeCodeHash;
    }

    const blockNumber = deployment.referenceBlock.number;
    const [
      stateViewPoolManagerValue,
      quoterPoolManagerValue,
      positionManagerPoolManagerValue,
      positionManagerPermit2Value,
      positionManagerWrappedNativeValue,
      positionManagerTokenDescriptorValue,
      positionManagerUnsubscribeGasLimit,
    ] = await Promise.all([
      client.readContract({ address: deployment.contracts.stateView, abi: v4StateViewAbi, functionName: 'poolManager', blockNumber }),
      client.readContract({ address: deployment.contracts.quoter, abi: v4QuoterAbi, functionName: 'poolManager', blockNumber }),
      client.readContract({ address: deployment.contracts.positionManager, abi: v4PositionManagerAbi, functionName: 'poolManager', blockNumber }),
      client.readContract({ address: deployment.contracts.positionManager, abi: v4PositionManagerAbi, functionName: 'permit2', blockNumber }),
      client.readContract({ address: deployment.contracts.positionManager, abi: v4PositionManagerAbi, functionName: 'WETH9', blockNumber }),
      client.readContract({ address: deployment.contracts.positionManager, abi: v4PositionManagerAbi, functionName: 'tokenDescriptor', blockNumber }),
      client.readContract({ address: deployment.contracts.positionManager, abi: v4PositionManagerAbi, functionName: 'unsubscribeGasLimit', blockNumber }),
    ]);

    const stateViewPoolManager = getAddress(stateViewPoolManagerValue);
    const quoterPoolManager = getAddress(quoterPoolManagerValue);
    const positionManagerPoolManager = getAddress(positionManagerPoolManagerValue);
    const positionManagerPermit2 = getAddress(positionManagerPermit2Value);
    const positionManagerWrappedNative = getAddress(positionManagerWrappedNativeValue);
    const positionManagerTokenDescriptor = getAddress(positionManagerTokenDescriptorValue);

    for (const [path, actual] of [
      ['stateView.poolManager', stateViewPoolManager],
      ['quoter.poolManager', quoterPoolManager],
      ['positionManager.poolManager', positionManagerPoolManager],
    ] as const) {
      if (actual !== deployment.contracts.poolManager) mismatch(path, deployment.contracts.poolManager, actual);
    }
    if (positionManagerPermit2 !== deployment.contracts.permit2) {
      mismatch('positionManager.permit2', deployment.contracts.permit2, positionManagerPermit2);
    }
    if (positionManagerWrappedNative !== deployment.positionManagerWiring.wrappedNative) {
      mismatch('positionManager.WETH9', deployment.positionManagerWiring.wrappedNative, positionManagerWrappedNative);
    }
    if (positionManagerTokenDescriptor !== deployment.positionManagerWiring.tokenDescriptor) {
      mismatch('positionManager.tokenDescriptor', deployment.positionManagerWiring.tokenDescriptor, positionManagerTokenDescriptor);
    }
    if (positionManagerUnsubscribeGasLimit !== deployment.positionManagerWiring.unsubscribeGasLimit) {
      mismatch(
        'positionManager.unsubscribeGasLimit',
        deployment.positionManagerWiring.unsubscribeGasLimit,
        positionManagerUnsubscribeGasLimit,
      );
    }

    return {
      chainId,
      blockNumber,
      blockHash: block.hash,
      contractsWithCode: checked,
      runtimeCodeHashes,
      stateViewPoolManager,
      quoterPoolManager,
      positionManagerPoolManager,
      positionManagerPermit2,
      positionManagerWrappedNative,
      positionManagerTokenDescriptor,
      positionManagerUnsubscribeGasLimit,
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
