import { type Address, type Hex, type PublicClient } from 'viem';
import { v4QuoterAbi, v4StateViewAbi } from './abis.js';
import { UniswapSdkError, invalid, rpc } from './errors.js';
import { checkedAddress, poolReference, validateDeployment, type V4Deployment, type V4PoolKey, type V4PoolReference } from './pool.js';

export type V4ReadClient = Pick<PublicClient, 'getChainId' | 'getBlockNumber' | 'readContract' | 'simulateContract'>;
export interface V4Observation extends V4PoolReference { blockNumber: bigint }
export interface V4PoolSnapshot extends V4Observation { sqrtPriceX96: bigint; tick: number; protocolFee: number; lpFee: number; liquidity: bigint }

export async function assertManager(client: V4ReadClient, deployment: V4Deployment, address: Address, blockNumber: bigint): Promise<void> {
  const manager = await rpc(() => client.readContract({ address, abi: v4StateViewAbi, functionName: 'poolManager', blockNumber }));
  if (manager.toLowerCase() !== deployment.poolManager.toLowerCase()) throw new UniswapSdkError('DEPLOYMENT_MISMATCH', 'Periphery points to a different PoolManager');
}

export async function observationBlock(client: V4ReadClient, deployment: V4Deployment, blockNumber?: bigint): Promise<bigint> {
  validateDeployment(deployment);
  if (blockNumber !== undefined && (typeof blockNumber !== 'bigint' || blockNumber < 0n)) invalid('blockNumber must be a nonnegative bigint');
  return rpc(async () => {
    if (await client.getChainId() !== deployment.chainId) throw new UniswapSdkError('CHAIN_MISMATCH', 'RPC chain does not match the requested deployment');
    return blockNumber ?? await client.getBlockNumber();
  });
}

/** Wiring check only: not bytecode provenance or custom-hook compatibility. */
export async function verifyV4DeploymentWiring(client: V4ReadClient, deployment: V4Deployment, options: { blockNumber?: bigint } = {}) {
  const blockNumber = await observationBlock(client, deployment, options.blockNumber);
  const managers = await rpc(() => Promise.all([
    client.readContract({ address: deployment.stateView, abi: v4StateViewAbi, functionName: 'poolManager', blockNumber }),
    client.readContract({ address: deployment.quoter, abi: v4QuoterAbi, functionName: 'poolManager', blockNumber }),
  ]));
  if (managers.some(manager => manager.toLowerCase() !== deployment.poolManager.toLowerCase())) throw new UniswapSdkError('DEPLOYMENT_MISMATCH', 'StateView or Quoter points to a different PoolManager');
  return { deployment: validateDeployment(deployment), blockNumber };
}

export async function readV4Pool(client: V4ReadClient, deployment: V4Deployment, key: V4PoolKey, options: { blockNumber?: bigint } = {}): Promise<V4PoolSnapshot> {
  const reference = poolReference(deployment, key);
  const blockNumber = await observationBlock(client, deployment, options.blockNumber);
  await assertManager(client, deployment, deployment.stateView, blockNumber);
  const [slot0, liquidity] = await rpc(() => Promise.all([
    client.readContract({ address: deployment.stateView, abi: v4StateViewAbi, functionName: 'getSlot0', args: [reference.poolId], blockNumber }),
    client.readContract({ address: deployment.stateView, abi: v4StateViewAbi, functionName: 'getLiquidity', args: [reference.poolId], blockNumber }),
  ]));
  if (slot0[0] === 0n) throw new UniswapSdkError('POOL_NOT_FOUND', 'Pool is not initialized at the requested block');
  return { ...reference, blockNumber, sqrtPriceX96: slot0[0], tick: slot0[1], protocolFee: slot0[2], lpFee: slot0[3], liquidity };
}

export interface V4QuoteInput {
  currencyIn: Address;
  amountIn: bigint;
  /** Required even when empty: custom hook encoding belongs to the protocol adapter. */
  hookData: Hex;
  /** eth_call sender; hooks may still see the Quoter as their caller. */
  account: Address;
}
export interface V4Quote extends V4Observation {
  currencyIn: Address; currencyOut: Address; amountIn: bigint; amountOut: bigint; gasEstimate: bigint;
  account: Address; hookData: Hex; quoter: Address;
}

export async function quoteV4ExactInput(client: V4ReadClient, deployment: V4Deployment, key: V4PoolKey, input: V4QuoteInput, options: { blockNumber?: bigint } = {}): Promise<V4Quote> {
  const reference = poolReference(deployment, key);
  const currencyIn = checkedAddress(input.currencyIn);
  const account = checkedAddress(input.account);
  if (currencyIn !== reference.key.currency0 && currencyIn !== reference.key.currency1) invalid('Input currency does not belong to this pool');
  if (typeof input.amountIn !== 'bigint' || input.amountIn <= 0n || input.amountIn >= 1n << 128n) invalid('amountIn must be a positive uint128');
  if (typeof input.hookData !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(input.hookData)) invalid('hookData must be explicit even-length hex bytes');
  const blockNumber = await observationBlock(client, deployment, options.blockNumber);
  await assertManager(client, deployment, deployment.quoter, blockNumber);
  const zeroForOne = currencyIn === reference.key.currency0;
  try {
    const { result: [amountOut, gasEstimate] } = await client.simulateContract({
      address: deployment.quoter, abi: v4QuoterAbi, functionName: 'quoteExactInputSingle', account, blockNumber,
      args: [{ poolKey: reference.key, zeroForOne, exactAmount: input.amountIn, hookData: input.hookData }],
    });
    return { ...reference, blockNumber, currencyIn, currencyOut: zeroForOne ? reference.key.currency1 : reference.key.currency0, amountIn: input.amountIn, amountOut, gasEstimate, account, hookData: input.hookData, quoter: deployment.quoter };
  } catch (cause) { throw new UniswapSdkError('QUOTE_FAILED', 'Quoter simulation failed; no executable quote is available', { cause }); }
}

export type V4QuoteResult = { status: 'success'; quote: V4Quote } | { status: 'failure'; index: number; error: UniswapSdkError };

/** Bounded concurrency, individual eth_calls preserve sender and isolate failures. */
export async function quoteV4Batch(client: V4ReadClient, deployment: V4Deployment, key: V4PoolKey, inputs: readonly V4QuoteInput[], options: { blockNumber?: bigint; concurrency?: number } = {}): Promise<V4QuoteResult[]> {
  const concurrency = options.concurrency ?? 4;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) invalid('concurrency must be between 1 and 16');
  if (inputs.length > 256) invalid('At most 256 quotes may be requested per batch');
  poolReference(deployment, key);
  if (inputs.length === 0) return [];
  const blockNumber = await observationBlock(client, deployment, options.blockNumber);
  const results: V4QuoteResult[] = [];
  for (let offset = 0; offset < inputs.length; offset += concurrency) {
    results.push(...await Promise.all(inputs.slice(offset, offset + concurrency).map(async (input, i): Promise<V4QuoteResult> => {
      try { return { status: 'success', quote: await quoteV4ExactInput(client, deployment, key, input, { blockNumber }) }; }
      catch (cause) {
        if (!(cause instanceof UniswapSdkError) || cause.code === 'CHAIN_MISMATCH' || cause.code === 'RPC_ERROR') throw cause;
        return { status: 'failure', index: offset + i, error: cause };
      }
    })));
  }
  return results;
}
