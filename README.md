# Shared Uniswap protocol SDK

Reptilian-maintained integration SDK, released independently through GitHub Packages.
It owns Uniswap protocol mechanics: reviewed deployments, ABI encoding and decoding,
unsigned v3 transaction material, calldata review, receipt evidence, and v4 observations.
It never owns keys, authorization policy, transaction submission, persistence, or orchestration.

## Capabilities and ownership

- `./v4`: full pool identity, Initialize-log normalization, pool state,
  exact-input Quoter simulation, ordered quote batches, initialized tick windows.
- `./v3`: Robinhood v3 deployment identity, compatibility checks, unsigned
  position transaction builders, strict calldata review, and receipt evidence.
- `./deployments`, `./compatibility`, `./transactions`, `./receipts`: stable
  capability subpaths for the capital-moving v3 surface.
- `./batch`: host-owned multicall integration for quoting, state decoding, and tick discovery.
- `./abis`: minimal v3 and v4 ABI surface used by the package.
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

V3 hosts select an exported reviewed deployment, verify it against their RPC,
then build unsigned transaction material. The host must independently authorize,
simulate, sign, submit, and reconcile that material.

```ts
import {
  buildV3IncreaseLiquidityTransaction,
  reviewV3IncreaseLiquidityCalldata,
  robinhoodUniswapV3Mainnet,
  verifyUniswapV3Compatibility,
} from '@reptilianhq/uniswap-sdk/v3';

await verifyUniswapV3Compatibility(publicClient, robinhoodUniswapV3Mainnet);
const material = buildV3IncreaseLiquidityTransaction({
  manager: robinhoodUniswapV3Mainnet.contracts.nonfungiblePositionManager,
  params,
});
reviewV3IncreaseLiquidityCalldata(material.data, params.tokenId);
```

A complete deterministic consumer example is available in
[`examples/read-only-consumer.mjs`](./examples/read-only-consumer.mjs). It uses
the published package subpaths and demonstrates a pool observation, a partial
tick result, and branching on `isUniswapSdkError`.

The v4 `reviewedDeployment` contains chainId, PoolManager, StateView and Quoter addresses.
There are no implicit v4 Robinhood or Arc deployments. Hosts own endpoint selection,
finality, capability policy and secret storage. For multicall consumers, use
`quoteV4WithBatch`, `v4PoolStateCalls`, `decodeV4PoolState`,
`readV4PoolStatesWithBatch`, and `readV4TicksWithBatch` from `./batch`.
Those helpers preserve the existing host's transport, block and sender context;
the host must check chain/deployment identity and Quoter multicall compatibility.

## Observation and quote guarantees

The direct-client RPC operations check chain identity (the `./batch` host owns that check). Pool/tick reads check StateView's
PoolManager pointer; quotes check the Quoter pointer at the observation block.
`verifyV4DeploymentWiring` checks both pointers. This proves wiring only: a contract that
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

The `./batch` helpers preserve legacy host behavior deliberately. Unlike direct
quotes, `quoteV4WithBatch` accepts zero input for sizing probes. Invalid input
rejects the whole helper call; only Quoter reverts and malformed Quoter responses
become item-level failures. `decodeV4PoolState` permits zero state for
uninitialized-pool probes. `readV4TicksWithBatch` accepts an explicit set of up
to 259 bitmap words and marks the result partial unless that set covers the full
usable range without failures. Batch transports must pin the block and preserve
the sender context themselves.

## Verification and release boundary

CI runs the full check suite on Node 24 and 26 with npm 11.5.2. Node 24
remains the publication runtime and the minimum supported consumer version.

From this independent repository:

```sh
npm ci --ignore-scripts
npm run check
```

The local suite uses real viem ABI encoding/decoding over a deterministic RPC
transport, plus official SDK identity comparisons and Hegel property invariants.
It covers v3 construction/review identity, manager-scoped receipt evidence, multiple chain
IDs, native/ERC-20 direction, dynamic-fee hook data, pointer/chain mismatch,
partial depth, failed versus zero quotes, discovery identity, batched transport
compatibility, and the runnable package-subpath consumer example. Local tests do
not establish live deployment compatibility or bytecode provenance.

Releases use the versioned Reptilian publisher, exact main-ancestry tags,
immutable archive verification, and retained evidence; see [RELEASING.md](./RELEASING.md).
The v3 surface is capital-moving protocol support: it prepares unsigned calldata
and verifies protocol-specific transaction and receipt facts. It does not grant
authorization or submit transactions. The v4 surface remains read-only and does
not claim Arc deployment or custom-hook compatibility. Never treat a local test
or a successful wiring check as live-chain bytecode provenance.

Next: supply Arc contract/RPC details, verify code and hook/custody semantics,
then add its adapter and a tested managed-position lifecycle. Existing v3-only
application capability gates remain appropriate until that adapter is verified.

## Protocol provider composition

`./providers` exports portable `V4ProviderDescriptor` and `V4ProviderPool` types,
structural verifiers, and `buildV4PoolSubscriptions`. Protocol SDKs own canonical
membership, reviewed deployment/hook semantics and position capabilities. The
shared planner checks complete identity and emits bounded event-topic requests
for explicitly selected pools. Empty selection returns no requests; transports
without indexed topic filtering are rejected.

Callers own RPC selection, finality, canonical membership storage and reorg
rollback. Replay the full discovery block. Structural checks cannot authenticate
arbitrary supplied membership evidence and never authorize execution.
