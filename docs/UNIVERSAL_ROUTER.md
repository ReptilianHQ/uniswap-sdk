# Universal Router and Permit2 provenance

`universalRouterDeployments` pins each reviewed Universal Router and the Permit2 it pulls
through, by exact runtime code hash. `verifyUniversalRouterCompatibility` fails closed on
the chain ID, the reference block hash where one is pinned, both runtime hashes, and the
router's `poolManager()` immutable. The router's Permit2 pointer is a private immutable, so
the exact runtime hash covers it rather than a separate read.

Permit2 is the canonical `0x000000000022D473030F116dDEE9F6B43aC78BA3` on both chains. Its
runtime hash still differs per chain because Permit2 caches its chain-specific EIP-712
domain separator as an immutable.

## Arc mainnet (5042)

`arcUniversalRouterMainnet` is derived from `arcUniswapV4Mainnet`, so it cannot drift from
that record. Router source, retained-artifact and runtime provenance are in
[ARC_V4_PROVENANCE.md](./ARC_V4_PROVENANCE.md) and `provenance/arc-mainnet-v4.json`. Pins are
checked at block `20,889,496`.

`Uniswap/contracts` now lists a v2.1.2 router (`0x8702463e73f74d0b6765aBceb314Ef07aCb92650`) as
Arc's latest. The pinned router is the one the reviewed Argus flow and the evidence below use.

### Pinned transaction evidence

`fixtures/transactions/arc-mainnet-universal-router-permit2-sell.json` holds a finalized Arc
mainnet sell captured read-only from `https://rpc.mainnet.arc.io`: transaction
`0xd891e2572053dfbc5d9cf57496f98501da98673a6aec0707e0ba4152fbea6277` in block `23,752,491`.
The fixture includes the transaction input and receipt logs, plus `Permit2.allowance` read
at the block before and the block of the transaction. The transaction calls
`execute(0x0a10, inputs, 1790881451)`: a `PERMIT2_PERMIT` for an unlimited allowance on
`0x6f438cB83040cDD55A602155710dd42f9C1B9257`, then `V4_SWAP`.

`src/universal-router-arc-mainnet.test.ts` proves, from that fixture alone:

- the execute decoder recovers both commands and the deadline, and the `PERMIT2_PERMIT`
  decoder recovers the PermitSingle and 65-byte signature;
- re-encoding reproduces the mined calldata byte for byte;
- `buildPermitSingleTypedData` with those values on chain 5042 yields typed data under which
  the mined signature recovers to the real sender. The signature fails for another owner,
  or with any single domain or message field changed;
- the receipt's Permit2 `Permit` event and the before/after allowance reads match the decoded
  permit, and the permit consumed nonce 0.

## Robinhood mainnet (4663)

`robinhoodUniversalRouterMainnet` pins Universal Router v2.1.1 at
`0x8876789976dEcBfCbBbe364623C63652db8C0904`. The record is
`provenance/robinhood-mainnet-universal-router.json`, reviewed against `Uniswap/contracts`
`deployments/json/4663.json` at commit `047d585853f89726c0fdef46bbf633bab8fc9051` (SHA-256
recorded). The evidence:

- deployment transaction `0x422569c9…ed1fa` (block 18,127) through the deterministic CREATE2
  deployer; its salt and initcode reproduce the router address;
- the constructor arguments in that transaction decode to the manifest's parameters,
  including canonical Permit2 and the v4 PoolManager the router reports;
- the runtime hashes were taken at block `80,447,948`. The public RPC serves no historical
  state, so verification reads the latest block, as the v3 deployments do.

**Limitation:** the manifest labels this instance *orphaned*. It was deployed with the
UnsupportedProtocol placeholder (`0x7332D11BD10d18A04B119Cd4671a96f3148002c4`) as its Across
SpokePool, so `ACROSS_V4_DEPOSIT_V3` cannot work through it. Swap and Permit2 commands are
unaffected. The manifest's latest Robinhood router is v2.1.2
`0x204FAca1764B154221e35c0d20aBb3c525710498`, which is not pinned here. Moving to it is a
separate reviewed change.

## Command codec

Command types follow `contracts/libraries/Commands.sol` at universal-router commit
`999d561c3ad58fb5cab91b602911f3c75591a9c7`, the package commit Arc's router was built from.
The command byte's high bit (0x80) is allow-revert; the low seven bits are the type.
Placeholder slots are not modelled. A reviewer must list one in `permittedCommands` to
accept it.

Run `npm run test:live-compatibility` to recheck both routers against their public RPCs.
`UNISWAP_ARC_RPC_URL` and `UNISWAP_MAINNET_RPC_URL` override the endpoints. Arc's endpoint is
Cloudflare-fronted, so the scripts send a User-Agent header.
