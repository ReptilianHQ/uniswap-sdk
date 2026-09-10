# Shared Uniswap v4 observations

Reptilian-maintained integration SDK, released independently through GitHub Packages. No signer,
transaction submission, liquidity management, Arc deployment, or custom-hook
compatibility is claimed. Existing Robinhood writes and bot execution are unchanged.

## Capabilities and ownership

- `./v4`: full pool identity, Initialize-log normalization, pool state,
  exact-input Quoter simulation, ordered quote batches, initialized tick windows.
- `./batch`: host-owned multicall integration for quoting, state decoding, and tick discovery.
- `./abis`: minimal standard v4 read/event ABI surface.
- `./errors`: stable error codes; JSON serialization omits underlying RPC errors,
  which may contain credentials. The in-process `cause` is diagnostic only.

The official `@uniswap/v4-sdk` and `@uniswap/sdk-core` versions are pinned.
Currency normalization uses the official SDK. Pool ID encoding is checked
against it for native/ERC-20 pairs and fee modes. On-chain Quoter simulation is
used instead of offline SDK swap math because custom hooks can change results.
The pinned upstream ESM export contains imports native Node cannot resolve;
`official-sdk.cts` uses its public CommonJS export through a local compiled shim.
The runtime smoke test exercises built ESM exports without a bundler. No upstream
files are patched or forked.

Reads/quotes/tick discovery were extracted from the bot's `scanner.ts`, `abi.ts`
and `depth.ts` read patterns. They now require explicit deployments and preserve
currency roles, hook data, failures and observation blocks. The bot consumes this package through an exact release dependency. Its host owns
multicall transport and trading policy; this package owns protocol encoding and decoding.

## Usage

Inject the caller's configured viem client. Reptilian continues to resolve its
chain and RPC through `@reptilianhq/evm-config`; this independent protocol SDK
does not depend on the platform configuration package.

```ts
import { readV4Pool, quoteV4ExactInput } from '@reptilianhq/uniswap-sdk/v4';

const pool = await readV4Pool(publicClient, reviewedDeployment, poolKey);
const quote = await quoteV4ExactInput(publicClient, reviewedDeployment, poolKey, {
  currencyIn, amountIn, account, hookData: protocolEncodedHookData,
}, { blockNumber: pool.blockNumber });
```

`reviewedDeployment` contains chainId, PoolManager, StateView and Quoter addresses.
There are no implicit Robinhood or Arc deployments. Hosts own endpoint selection,
finality, capability policy and secret storage. For multicall consumers, use
`quoteV4WithBatch`, `v4PoolStateCalls`, `decodeV4PoolState`,
`readV4PoolStatesWithBatch`, and `readV4TicksWithBatch` from `./batch`.
Those helpers preserve the existing host's transport, block and sender context;
the host must check chain/deployment identity and Quoter multicall compatibility.

## Observation and quote guarantees

The direct-client RPC operations check chain identity (the `./batch` host owns that check). Pool/tick reads check StateView's
PoolManager pointer; quotes check the Quoter pointer at the observation block.
`verifyWiring` checks both pointers. This proves wiring only: a contract that
returns the expected pointer is not necessarily the reviewed implementation.
Source/code verification and hook-specific compatibility remain release gates.

All state calls in an operation use one block number. Quote batches use up to
four concurrent individual eth_calls by default (maximum 16; at most 256 quotes).
They preserve account context rather than putting an extra Multicall contract
between the caller and the Quoter. A quote failure is distinct from successful
zero output. Invalid item input yields a typed item failure; chain/RPC identity
errors abort the batch. Quotes expose the account, hookData, quoter, amount and
observation block so consumers can retain exact context.

A quote is an observation, not executable or durable authorization. The Quoter
may call hooks differently from the intended router or custom executor. Arc's
adapter must prove those semantics and simulate the complete final transaction
with its actual sender, approvals and hook data before a write can be supported.
Requote after approvals or changed state. Block-number pinning does not establish
finality or protect against a reorg; the host must select appropriate blocks.

Pool IDs are not globally unique: retain chainId, PoolManager, PoolKey and poolId.
Native currency remains address(0), distinct from wrapped native ERC-20.
Initialize logs must come from the configured manager and reproduce their pool
ID. The decoder does not prove receipt finality, chain provenance or ingestion
completeness; the indexer must supply canonical logs and handle reorgs.

Tick windows return raw initialized ticks, never executable depth. Scans are
limited to 16 bitmap words with at most 16 concurrent tick calls. A narrower
range or any failed bitmap/tick sets `partial: true` and records missing
coordinates. Consumers must not reconstruct complete depth from partial ticks.

## Verification and release boundary

From this independent repository:

```sh
npm ci --ignore-scripts
npm run check
```

The local suite uses real viem ABI encoding/decoding over a deterministic RPC
transport, plus official SDK identity comparisons. It covers multiple chain
IDs, native/ERC-20 direction, dynamic-fee hook data, pointer/chain mismatch,
partial depth, failed versus zero quotes, discovery identity, and batched transport compatibility. It does not establish Arc or Robinhood live compatibility.

Releases use the versioned Reptilian publisher, exact main-ancestry tags,
immutable archive verification, and retained evidence; see [RELEASING.md](./RELEASING.md).
This initial release is read-only. It has no write preparation, position-management,
or receipt-verification API and does not claim Arc deployment or hook compatibility.
The capital-moving SDK conformance profile is not applicable until those
capabilities are implemented; never add placeholder transaction/receipt exports
or treat a local test as live-chain compatibility. The local suite and packed
runtime/type checks cover the read-only surface actually released.

Next: supply Arc contract/RPC details, verify code and hook/custody semantics,
then add its adapter and a tested managed-position lifecycle. Existing v3-only
application capability gates remain appropriate until that adapter is verified.
