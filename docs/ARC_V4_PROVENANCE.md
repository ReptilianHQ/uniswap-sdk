# Arc Uniswap v4 provenance

`arcUniswapV4Mainnet` records the shared Uniswap v4 infrastructure used by the reviewed
Argus Arc integration at block `20,889,496` (`0xf3fd31df…d40810b`). The compatibility
check fails closed on chain ID, canonical block hash, exact runtime bytecode, PoolManager
pointers, Permit2, wrapped-native placeholder, token descriptor, and unsubscribe gas limit.

The provenance record retains the official `Uniswap/contracts` deployment manifest, its
SHA-256, each deployment transaction, the generated deployer artifact, referenced source
contract and package commit, generated creation-code hash, and pinned runtime hash. The
five artifact-backed contracts are PoolManager, StateView, PositionManager, V4Quoter, and
Universal Router. Permit2 is retained as a canonical-predeploy runtime pin only.

This evidence reproduces retained upstream generated artifacts; it does not freshly compile
the referenced Solidity sources. The source paths and package gitlinks establish which source
Uniswap associated with each generated artifact, not independent compiler reproducibility.

## Reproduce the source/runtime match

Check out `Uniswap/contracts` twice because Arc's Universal Router was retained from an
earlier source commit:

```sh
git clone https://github.com/Uniswap/contracts.git /tmp/uniswap-contracts
git -C /tmp/uniswap-contracts worktree add /tmp/uniswap-contracts-manifest 047d585853f89726c0fdef46bbf633bab8fc9051
git -C /tmp/uniswap-contracts worktree add /tmp/uniswap-contracts-v4 534603a5bc10d41d57a1c9c34417d472f0dbc0d3
git -C /tmp/uniswap-contracts worktree add /tmp/uniswap-contracts-router 02fd1760fa7c05096833c03e01a4143f963c350e
anvil --chain-id 5042 --hardfork cancun --port 8545
node scripts/verify-v4-retained-artifacts.mjs \
  --deployment-manifest /tmp/uniswap-contracts-manifest \
  --uniswap-contracts /tmp/uniswap-contracts-v4 \
  --universal-router-contracts /tmp/uniswap-contracts-router \
  --anvil-rpc http://127.0.0.1:8545
```

The script verifies the exact manifest commit and SHA-256, matches each address, deployment
transaction, manifest input hash, and proxy flag, then hashes the retained generated initcode
plus reviewed constructor arguments.
With `--anvil-rpc`, it then deploys that material using an impersonated local account—no
private key—and requires the resulting runtime to equal the Arc runtime hash. Solidity
embeds `address(this)` in these runtimes. PositionManager and Universal Router also cache
EIP-712 domain separators derived from that address. The verifier explicitly recomputes
those values for the Arc deployment address and requires reviewed occurrence counts before
replacement; it does not mask arbitrary byte ranges.

Run `npm run test:live-compatibility` for the independent read-only Arc RPC check. The raw
record is exported at `@reptilianhq/uniswap-sdk/provenance/arc-mainnet-v4.json`.

## Launcher boundary

This evidence deliberately stops at shared Uniswap infrastructure. The public
`arguspad/argus-world` source at `c8c3d5fc2b0a4557a535bb4f7e7a3be9301c289e` contains
explicitly reduced interfaces and simplified logic, with no pinned compiler build capable
of reproducing deployed Argus bytecode. It is reference documentation, not deployment
provenance.

Argus Portal, hook, locker, splitter, tracker, fee collection, creator/reward payouts,
custody, and permanently locked launch-principal semantics remain launcher-adapter gates.
Their pinned-fork lifecycle belongs in the Argus SDK's capital-moving workflow, where the
exact router call, sender, approvals, hook data, fee configuration, claims, and
non-withdrawable principal can be tested together. Do not duplicate that proof in this
generic SDK or infer it from a successful Quoter call.
