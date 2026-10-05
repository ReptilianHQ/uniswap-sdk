# Shared Uniswap protocol SDK

Reptilian-maintained integration SDK, released independently through GitHub Packages.
It owns Uniswap protocol mechanics: reviewed deployments, ABI encoding and decoding,
unsigned v3/v4 transaction material, calldata review, receipt evidence, and v4 observations.
It never owns keys, authorization policy, transaction submission, persistence, or orchestration.

## Capabilities and ownership

- `./v4`: full pool identity, Initialize-log normalization, pool state,
  exact-input Quoter simulation, ordered quote batches, initialized tick windows,
  reviewed Arc infrastructure, and unsigned position mint, increase, partial-removal,
  and atomic full-close material with strict review.
- `./v3`: Robinhood v3 deployment identity, compatibility checks, unsigned
  position transaction builders, strict calldata review, and receipt evidence.
- `./deployments`, `./compatibility`, `./transactions`, `./receipts`: stable
  capability subpaths for the capital-moving v3 surface.
- `./permit2`: Permit2 typed data for a signed `PermitSingle` (one token's allowance) and the
  v4-mint `PermitBatch`, signature verification for EOAs and contract wallets, and allowance reads.
- `./universal-router`: Universal Router 2.x `execute(bytes,bytes[],uint256)` encoding, strict
  decoding, the `PERMIT2_PERMIT` input codec, and a host-bounded permit reviewer.
- `./batch`: host-owned multicall integration for quoting, state decoding, and tick discovery.
- `./abis`: minimal v3, v4, Permit2, and Universal Router ABI surface used by the package.
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

Generic v4 reads still require an explicit `reviewedDeployment`. Hosts select one from
`uniswapV4Deployments` with `getUniswapV4Deployment(chainId)` or
`findUniswapV4DeploymentForNetwork(network)` (today only `arcUniswapV4Mainnet`), and must
run `verifyUniswapV4Compatibility` before relying on its pinned shared Uniswap infrastructure.
V3 hosts use `uniswapV3Deployments` and `getUniswapV3Deployment(chainId)` the same way.
Addresses are pinned in this package, not read from `@uniswap/sdk-core`; a unit test fails
when a pinned address disagrees with the address Uniswap publishes for that chain. This does not authenticate Argus Portal,
hook, locker, splitter, tracker, or fee semantics. Hosts own endpoint selection,
finality, capability policy and secret storage. For multicall consumers, use
`quoteV4WithBatch`, `v4PoolStateCalls`, `decodeV4PoolState`,
`readV4PoolStatesWithBatch`, and `readV4TicksWithBatch` from `./batch`.
Those helpers preserve the existing host's transport, block and sender context;
the host must check chain/deployment identity and Quoter multicall compatibility.

V4 position management is deliberately position-scoped. The host must first bind
the owner, token ID, PoolKey, ticks, and current liquidity at one observation block,
then independently authorize and simulate the returned unsigned transaction. Increase
material may carry an exact Permit2 batch. Removal material returns both currencies to
PositionManager's `msgSender()`; a full exit can burn the NFT atomically. These builders
do not merge positions or imply that a managed strategy position is the launch position,
even when both positions happen to share the same underlying pool.

## Permit2 signed permits and the Universal Router

A Universal Router swap can carry its own Permit2 allowance: the owner signs a `PermitSingle`
and the router's `PERMIT2_PERMIT` command (0x0a) calls `Permit2.permit` before the swap, with
no separate `Permit2.approve` transaction. The package builds and checks that material. The
host signs, simulates and submits it.

```ts
import { getUniversalRouterDeployment } from '@reptilianhq/uniswap-sdk/deployments';
import { verifyUniversalRouterCompatibility } from '@reptilianhq/uniswap-sdk/compatibility';
import { buildPermitSingleTypedData, readPermit2Allowance, verifyPermitSingleSignature } from '@reptilianhq/uniswap-sdk/permit2';
import {
  UNIVERSAL_ROUTER_COMMAND,
  encodePermit2PermitInput,
  encodeUniversalRouterExecute,
} from '@reptilianhq/uniswap-sdk/universal-router';

const router = getUniversalRouterDeployment(chainId);
await verifyUniversalRouterCompatibility(publicClient, router);
const { nonce } = await readPermit2Allowance(publicClient, {
  owner, token, spender: router.contracts.universalRouter, chainId,
});
const typedData = buildPermitSingleTypedData({
  chainId, token, amount, expiration, nonce, spender: router.contracts.universalRouter, sigDeadline: deadline,
});
const signature = await wallet.signTypedData(typedData); // host-owned signer
if (!await verifyPermitSingleSignature(publicClient, { owner, typedData, signature })) throw new Error('bad permit');
const data = encodeUniversalRouterExecute({
  commands: [
    { command: UNIVERSAL_ROUTER_COMMAND.PERMIT2_PERMIT, input: encodePermit2PermitInput(typedData.message, signature) },
    { command: UNIVERSAL_ROUTER_COMMAND.V4_SWAP, input: v4SwapInput },
  ],
  deadline,
});
```

- `buildPermitSingleTypedData` takes its domain and types from `@uniswap/permit2-sdk`. It checks
  uint160 amount, uint48 expiration and nonce, uint256 `sigDeadline`, and nonzero token, spender
  and Permit2. The result passes unchanged to viem `signTypedData`, `hashTypedData` and
  `verifyTypedData`.
- `verifyPermitSingleSignature` rebuilds the typed data from its domain and message before checking it.
  It recovers EOA signatures locally. ERC-1271, ERC-6492 and every local mismatch fall back to
  the client's `verifyTypedData`. It proves authorship only. Nonce freshness, deadlines and
  spender choice remain host checks.
- `decodeUniversalRouterExecute` accepts only the deadline overload. It rejects unknown or
  placeholder commands and allow-revert flags unless the caller permits them
  (`permittedCommands`, `allowRevert`). It also rejects calldata that does not re-encode byte for
  byte. `reviewPermit2PermitInput` requires explicit token, spender, amount range, signature
  deadline and expiration bounds, as the v4 position reviewers do for a folded `permitBatch`.
  It does not check the signer.
- The `PERMIT2_PERMIT` owner is the router's `msgSender()`, so the signer must send the transaction.

Reviewed Universal Routers come from `universalRouterDeployments` through
`getUniversalRouterDeployment(chainId)` or `findUniversalRouterDeploymentForNetwork(network)`.
That covers Arc (`arcUniversalRouterMainnet`, derived from the Arc v4 record) and Robinhood
mainnet (`robinhoodUniversalRouterMainnet`). Each record pins the router and Permit2 runtime
hashes; Permit2's hash differs per chain because it caches a chain-specific domain separator.
See [docs/UNIVERSAL_ROUTER.md](./docs/UNIVERSAL_ROUTER.md) for provenance, the pinned
Arc mainnet evidence, and limitations. In particular, Uniswap labels the pinned Robinhood router
orphaned for Across bridging.

## Observation and quote guarantees

The direct-client RPC operations check chain identity (the `./batch` host owns that check). Pool/tick reads check StateView's
PoolManager pointer; quotes check the Quoter pointer at the observation block.
`verifyV4DeploymentWiring` checks both pointers. This proves wiring only. Arc's stronger
compatibility check pins the canonical block, exact runtime hashes, and immutable manager
wiring; the separate retained-artifact verifier validates the official manifest and
reproduces the generated deployment artifacts. It does not freshly compile Solidity.
Hook-specific compatibility remains an adapter release gate.

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
transport, plus official SDK identity comparisons, Hegel property invariants,
pinned finalized Robinhood mainnet receipt fixtures, and a pinned finalized Arc mainnet
Universal Router `PERMIT2_PERMIT` + `V4_SWAP` transaction.
It covers v3 construction/review identity, manager-scoped receipt evidence, multiple chain
IDs, native/ERC-20 direction, dynamic-fee hook data, pointer/chain mismatch,
partial depth, failed versus zero quotes, discovery identity, batched transport
compatibility, exact reviewed runtime code hashes, and the runnable
package-subpath consumer example. `npm run test:fork` additionally executes an
SDK-built and reviewed Robinhood v3 full close plus an Arc v4 unhooked
mint/increase/partial-remove/full-close lifecycle against pinned Anvil forks,
documented in [docs/FORK_TESTING.md](./docs/FORK_TESTING.md).

`npm run test:live-compatibility` rechecks the two Robinhood v3 deployments, the Arc v4
deployment, and both reviewed Universal Routers against their public RPCs. `UNISWAP_MAINNET_RPC_URL`,
`UNISWAP_TESTNET_RPC_URL`, and `UNISWAP_ARC_RPC_URL` may override those read-only
endpoints. Retained-artifact reproduction is documented in
[docs/ARC_V4_PROVENANCE.md](./docs/ARC_V4_PROVENANCE.md).

Releases use the versioned Reptilian publisher, exact main-ancestry tags,
immutable archive verification, and retained evidence; see [RELEASING.md](./RELEASING.md).
The v3 and v4 transaction surfaces prepare unsigned calldata and verify protocol-specific
facts. They do not grant authorization or submit transactions. Arc shared Uniswap source
and runtime identity are reviewed; Argus custom-hook, fee, custody, and permanently locked
launch-principal semantics are not claimed here. Keep application write capability gated
until the launcher adapter proves those semantics with exact-router simulation and pinned
fork evidence.

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
