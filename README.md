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
- `./v3`: Robinhood and Arc v3 deployment identity, compatibility checks, unsigned
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
V3 hosts use `uniswapV3Deployments` and `getUniswapV3Deployment(chainId)` the same way
(`robinhoodUniswapV3Mainnet`, `robinhoodUniswapV3Testnet`, `arcUniswapV3Mainnet`).
Arc v3 has no WETH9: the chain's gas token is USDC, exposed as an ordinary ERC-20, so
`arcUniswapV3Mainnet.contracts.wrappedNative` is that token (6 decimals) and every pool is
ERC-20/ERC-20. The position manager's own `WETH9()` returns a revert stub, pinned under
`positionManagerWiring` for the wiring check only; hosts must never send native value or
build `refundETH`/`unwrapWETH9` calls on that deployment. See
[provenance/arc-mainnet-v3.json](./provenance/arc-mainnet-v3.json).
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

Building and signing:

```ts
import { getUniversalRouterDeployment } from '@reptilianhq/uniswap-sdk/deployments';
import { verifyUniversalRouterCompatibility } from '@reptilianhq/uniswap-sdk/compatibility';
import { buildPermitSingleTypedData, readPermit2Allowance } from '@reptilianhq/uniswap-sdk/permit2';
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
// Exact amount and a short expiration: permit overwrites the allowance, and anything left
// over stays usable by any later router calldata this owner sends.
const typedData = buildPermitSingleTypedData({
  chainId, token, amount: amountIn, expiration: deadline, nonce,
  spender: router.contracts.universalRouter, sigDeadline: deadline,
});
const signature = await wallet.signTypedData(typedData); // host-owned signer
const data = encodeUniversalRouterExecute({
  commands: [
    { command: UNIVERSAL_ROUTER_COMMAND.PERMIT2_PERMIT, input: encodePermit2PermitInput(typedData.message, signature), allowRevert: true },
    { command: UNIVERSAL_ROUTER_COMMAND.V4_SWAP, input: v4SwapInput },
  ],
  deadline,
}, { allowRevert: [UNIVERSAL_ROUTER_COMMAND.PERMIT2_PERMIT] });
```

Reviewing calldata someone else built (decode, review the permit, verify the signer):

```ts
import { readPermit2Allowance, verifyPermitSingleSignature } from '@reptilianhq/uniswap-sdk/permit2';
import { decodeUniversalRouterExecute, reviewPermit2PermitInput } from '@reptilianhq/uniswap-sdk/universal-router';

const plan = decodeUniversalRouterExecute(data, {
  permittedCommands: [UNIVERSAL_ROUTER_COMMAND.PERMIT2_PERMIT, UNIVERSAL_ROUTER_COMMAND.V4_SWAP],
  allowRevert: [UNIVERSAL_ROUTER_COMMAND.PERMIT2_PERMIT],
});
const { permitSingle, signature } = reviewPermit2PermitInput(plan.commands[0].input, {
  token, spender: router.contracts.universalRouter,
  minAmount: amountIn, maxAmount: amountIn,
  maxSigDeadline: plan.deadline, maxExpiration: plan.deadline,
});
const accepted = await verifyPermitSingleSignature(publicClient, {
  owner: sender, chainId: router.chainId, permit2Address: router.contracts.permit2, permitSingle, signature,
});
// Allow-revert on PERMIT2_PERMIT means a failed permit still lets the swap run on whatever
// allowance the owner already has. Bound that standing allowance too, or simulate the exact call.
const standing = await readPermit2Allowance(publicClient, {
  owner: sender, token, spender: router.contracts.universalRouter, chainId: router.chainId,
});
if (standing.amount > amountIn && standing.expiration >= nowSeconds) throw new Error('standing router allowance exceeds the plan');
```

- `buildPermitSingleTypedData` takes its domain and types from `@uniswap/permit2-sdk`. It checks
  uint160 amount, uint48 expiration and nonce, uint256 `sigDeadline`, and nonzero token, spender
  and Permit2. The result passes unchanged to viem `signTypedData` and `hashTypedData`.
- `verifyPermitSingleSignature` follows Permit2's `SignatureVerification`, with the domain built
  from the expected chain and Permit2 (supplied typed data with another domain is refused, as
  is a client on another chain).
  - An owner without code must give a 65-byte signature with `v` of 27 or 28, or a 64-byte
    EIP-2098 signature, that ecrecovers to it; after one `getCode` read, this is checked
    locally.
  - An owner with code, including an EIP-7702-delegated EOA, is asked only through its own
    ERC-1271 `isValidSignature`.
  - ERC-6492-wrapped signatures are rejected because Permit2 does not unwrap them.
  - It proves acceptance by Permit2, not nonce freshness, deadlines or spender choice.
- `decodeUniversalRouterExecute` is a structural check, not a review. It accepts only the
  deadline overload and canonical encodings. By default it admits only
  `UNIVERSAL_ROUTER_DEFAULT_COMMANDS` (Permit2 permits, swaps, wrap/unwrap, `SWEEP`,
  `PAY_PORTION`, `BALANCE_CHECK_ERC20`). `EXECUTE_SUB_PLAN`, `TRANSFER`, Permit2 transfers,
  position-manager calls and `ACROSS_V4_DEPOSIT_V3` need an explicit opt-in. A permitted
  sub-plan is decoded recursively under the same options, up to depth 2. Hosts reviewing
  third-party calldata should always pass the exact `permittedCommands` their plan uses.
- Allow-revert is rejected unless permitted, and it can be permitted per command. Allowing it
  only on `PERMIT2_PERMIT` is the standard mitigation for front-running: anyone who sees the
  signature can submit it to `Permit2.permit` first and consume the nonce. With the flag, the
  swap still runs on the allowance that call installed. The swap also runs whenever the permit
  fails for any other reason, on the owner's existing allowance. Hosts that permit the flag
  should also bound the standing allowance (`readPermit2Allowance`) or simulate the exact call.
- `reviewPermit2PermitInput` validates every bound at runtime (`INVALID_ARGUMENT` when one is
  missing or malformed) and then checks token, spender, amount range, signature deadline and
  expiration. Expiration 0, which Permit2 treats as "this block", satisfies `minExpiration`.
  It does not check the signer.
- Nonces: `readPermit2Allowance` is a snapshot. Two permits signed concurrently for the same
  owner, token and router reuse a nonce, and the second reverts, so serialize them.
  `lockdown` and `invalidateNonces` also move state between read and use.
- The `PERMIT2_PERMIT` owner is the router's `msgSender()`, so the signer must send the
  transaction. The pinned Arc evidence signed an unlimited (2^160 − 1) allowance for about 30
  days. That was the operator's choice, not a recommendation.

Reviewed Universal Routers come from `universalRouterDeployments` through
`getUniversalRouterDeployment(chainId)` or `findUniversalRouterDeploymentForNetwork(network)`.
That covers Arc (`arcUniversalRouterMainnet`, derived from the Arc v4 record) and Robinhood
mainnet (`robinhoodUniversalRouterMainnet`). Each record pins the router and Permit2 runtime
hashes; Permit2's hash differs per chain because it caches a chain-specific domain separator.
See [docs/UNIVERSAL_ROUTER.md](./docs/UNIVERSAL_ROUTER.md) for provenance, the pinned
Arc mainnet evidence, and the newer or orphaned upstream routers that are deliberately not pinned.
Arc's pinned router was built with a placeholder Across SpokePool, so `ACROSS_V4_DEPOSIT_V3`
does not work through it.

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

`npm run test:types` compiles the public v4 read API against real chainless and
chain-bound viem clients with strict null checking both enabled and disabled.
The read-client interface retains ABI-typed simulation results without requiring
unused chain/account-dependent transaction-request metadata.

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

`npm run test:live-compatibility` rechecks the three v3 deployments, the Arc v4
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
