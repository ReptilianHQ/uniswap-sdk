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

**Limitation:** according to the constructor parameters in the retained manifest, the pinned
router was built with `spokePool = 0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f`, Arc's wrapped native.
That is a placeholder, not an Across SpokePool, so `ACROSS_V4_DEPOSIT_V3` (0x40) is not usable
through it. It is the same class of defect that ruled out Robinhood v2.1.1. It is accepted on Arc
because swap and Permit2 commands are unaffected and the Argus SDK pins this router. The codec
excludes 0x40 by default.

`Uniswap/contracts` lists a v2.1.2 router (`0x8702463e73f74d0b6765aBceb314Ef07aCb92650`) as
Arc's latest. It is known and deliberately not pinned. The Argus SDK manifest pins
`0x4fcA…9Fb1`, and the mined `PERMIT2_PERMIT` sell below went through it.

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
- the sender had no code at that block, so Permit2 took its ecrecover branch. With the domain
  bound to chain 5042 and canonical Permit2, `verifyPermitSingleSignature` accepts the mined
  signature for the real sender, both from SDK-built typed data and from the decoded permit.
  It rejects another owner, and rejects any single domain or message field changed;
- the receipt's Permit2 `Permit` event and the before/after allowance reads match the decoded
  permit, and the permit consumed nonce 0.

The mined permit is unlimited (2^160 − 1) for about 30 days. That was the operator's choice,
recorded as evidence, not a recommendation; prefer an exact amount and a short expiration.

## Robinhood mainnet (4663)

`robinhoodUniversalRouterMainnet` pins Universal Router v2.1.2 at
`0x204FAca1764B154221e35c0d20aBb3c525710498`. This is the manifest's `latest.UniversalRouter`. The
record is `provenance/robinhood-mainnet-universal-router.json`, reviewed against
`Uniswap/contracts` `deployments/json/4663.json` at commit
`047d585853f89726c0fdef46bbf633bab8fc9051` (SHA-256 recorded). The evidence:

- deployment transaction `0xf669b9a4…a339` (block 65,727,895) is a plain CREATE from
  `0x2179a608…27B6` at nonce 7, which reproduces the router address;
- keccak256 of that transaction's input equals the manifest's `initcodeHash`
  (`0x30985525…d539`);
- its constructor arguments decode to canonical Permit2, the reviewed v3 factory, wrapped
  native and position manager, the v4 PoolManager the router's `poolManager()` reports, and
  the production Across SpokePool `0xD29C85F15DF544bA632C9E25829fd29d767d7978`;
- `Commands.sol` at the router's source commit (`Uniswap/universal-router` `802fe4c`) is
  byte-identical to the copy the command codec follows;
- the runtime hashes were taken at block `80,454,448`. The public RPC serves no historical
  state, so verification reads the latest block, as the v3 deployments do.

**Not pinned:** v2.1.1 `0x8876789976dEcBfCbBbe364623C63652db8C0904`. The manifest labels it
orphaned because it was deployed with the UnsupportedProtocol placeholder
(`0x7332D11BD10d18A04B119Cd4671a96f3148002c4`) as its Across SpokePool. A deployment test keeps
it from becoming the pin.

## Command codec

Command types follow `contracts/libraries/Commands.sol` at universal-router commit
`999d561c3ad58fb5cab91b602911f3c75591a9c7`, the package commit Arc's router was built from.
The command byte's high bit (0x80) is allow-revert; the low seven bits are the type.
Placeholder slots are not modelled. The default permitted set is
`UNIVERSAL_ROUTER_DEFAULT_COMMANDS`, a swap-focused allowlist. Any other command must be
listed in `permittedCommands`. A permitted `EXECUTE_SUB_PLAN` is decoded recursively under the
same options, up to `UNIVERSAL_ROUTER_MAX_SUB_PLAN_DEPTH` (2), so its inner commands and
allow-revert flags are checked like the outer plan's. Allow-revert can be permitted per
command type, for example only on `PERMIT2_PERMIT`.

Run `npm run test:live-compatibility` to recheck both routers against their public RPCs.
`UNISWAP_ARC_RPC_URL` and `UNISWAP_MAINNET_RPC_URL` override the endpoints. Arc's endpoint is
Cloudflare-fronted, so the scripts send a User-Agent header.
