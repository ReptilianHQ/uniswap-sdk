import { Pool } from './official-sdk.cjs';
import type { Currency } from '@uniswap/sdk-core';
import { encodeAbiParameters, getAddress, isAddress, keccak256, zeroAddress, type Address, type Hex } from 'viem';
import { invalid, UniswapSdkError } from './errors.js';

export interface V4PoolKey { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address }
export interface V4Deployment { chainId: number; poolManager: Address; stateView: Address; quoter: Address }
export interface V4PoolReference { chainId: number; poolManager: Address; poolId: Hex; key: V4PoolKey }

export function checkedAddress(value: Address): Address {
  if (!isAddress(value)) invalid('Expected a valid EVM address');
  return getAddress(value);
}
export function validateDeployment(deployment: V4Deployment): V4Deployment {
  if (!Number.isSafeInteger(deployment.chainId) || deployment.chainId <= 0) invalid('chainId must be a positive safe integer');
  const result = { chainId: deployment.chainId, poolManager: checkedAddress(deployment.poolManager), stateView: checkedAddress(deployment.stateView), quoter: checkedAddress(deployment.quoter) };
  if ([result.poolManager, result.stateView, result.quoter].includes(zeroAddress)) invalid('Deployment contracts cannot be zero addresses');
  return result;
}
export function validatePoolKey(key: V4PoolKey): V4PoolKey {
  const result = { ...key, currency0: checkedAddress(key.currency0), currency1: checkedAddress(key.currency1), hooks: checkedAddress(key.hooks) };
  if (BigInt(result.currency0) >= BigInt(result.currency1)) invalid('PoolKey currencies must be distinct and in canonical address order');
  if (!Number.isInteger(key.fee) || key.fee < 0 || (key.fee > 1_000_000 && key.fee !== 0x800000)) invalid('fee must be a static fee up to 1000000 or the dynamic fee flag');
  if (key.fee === 0x800000 && result.hooks === zeroAddress) invalid('Dynamic fee requires a hook');
  if (!Number.isInteger(key.tickSpacing) || key.tickSpacing < 1 || key.tickSpacing > 32767) invalid('tickSpacing must be between 1 and 32767');
  return result;
}

/** Official SDK currency normalization; native currencies remain address(0). */
export function poolKeyFromCurrencies(a: Currency, b: Currency, fee: number, tickSpacing: number, hooks: Address): V4PoolKey {
  if (a.chainId !== b.chainId) invalid('Pool currencies must belong to the same chain');
  if (a.equals(b)) invalid('Pool currencies must be distinct');
  try {
    const key = Pool.getPoolKey(a, b, fee, tickSpacing, hooks);
    return validatePoolKey({ ...key, currency0: checkedAddress(key.currency0 as Address), currency1: checkedAddress(key.currency1 as Address), hooks: checkedAddress(key.hooks as Address) });
  } catch (cause) {
    if (cause instanceof UniswapSdkError) throw cause;
    throw new UniswapSdkError('INVALID_ARGUMENT', 'Official Uniswap SDK rejected the pool parameters', { cause });
  }
}

/** Pool ID does not contain chain or manager identity; retain the full reference. */
export function getV4PoolId(input: V4PoolKey): Hex {
  const key = validatePoolKey(input);
  return keccak256(encodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
    [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
  ));
}
export function poolReference(deployment: V4Deployment, input: V4PoolKey): V4PoolReference {
  const { chainId, poolManager } = validateDeployment(deployment);
  const key = validatePoolKey(input);
  return { chainId, poolManager, key, poolId: getV4PoolId(key) };
}
