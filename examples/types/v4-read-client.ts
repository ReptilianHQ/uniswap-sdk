import { createPublicClient, defineChain, http, type Address } from 'viem';
import {
  readV4Pool, quoteV4ExactInput, quoteV4Batch, readV4TickWindow, verifyV4DeploymentWiring,
  type V4Deployment, type V4PoolKey, type V4QuoteInput, type V4ReadClient,
} from '@reptilianhq/uniswap-sdk/v4';
import { v4QuoterAbi } from '@reptilianhq/uniswap-sdk/abis';

declare const deployment: V4Deployment;
declare const key: V4PoolKey;
declare const input: V4QuoteInput;
declare const account: Address;

// Compiled only: no RPC calls. Cover both consumer null-check settings.
export async function verifyClientCompatibility() {
  const chainless = createPublicClient({ transport: http() });
  const chain = defineChain({ id: 5042, name: 'Arc', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: ['https://example.invalid'] } } });
  const chainBound = createPublicClient({ chain, transport: http() });
  for (const client of [chainless, chainBound]) {
    client satisfies V4ReadClient;
    await verifyV4DeploymentWiring(client, deployment);
    await readV4Pool(client, deployment, key);
    await quoteV4ExactInput(client, deployment, key, input);
    await quoteV4Batch(client, deployment, key, [input]);
    await readV4TickWindow(client, deployment, key, { fromWord: 0, toWord: 0 });
  }
  const client: V4ReadClient = chainless;
  const simulation = await client.simulateContract({
    address: deployment.quoter, abi: v4QuoterAbi, functionName: 'quoteExactInputSingle', account,
    args: [{ poolKey: key, zeroForOne: true, exactAmount: 1n, hookData: '0x' }],
  });
  simulation.result satisfies readonly [bigint, bigint];
  // @ts-expect-error ABI result must retain its bigint tuple.
  simulation.result satisfies string;
  // @ts-expect-error Invalid quoter function names must remain rejected.
  await client.simulateContract({ address: deployment.quoter, abi: v4QuoterAbi, functionName: 'notAFunction', account });
  // @ts-expect-error Read-only client still requires simulation support.
  const incomplete: V4ReadClient = { getChainId: chainless.getChainId, getBlockNumber: chainless.getBlockNumber, readContract: chainless.readContract };
  void incomplete;
}
