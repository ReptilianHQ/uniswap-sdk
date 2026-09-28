# Uniswap fork testing

## Robinhood mainnet v3

The fork suite pins Robinhood mainnet block `60269962` with hash
`0x0c8248fedd0d28673c6852b5d65d806dfad9be361e4d90ed5a84664ca72fd8bf`.
It checks deployment runtime hashes and position-manager wiring, then uses an
impersonated owner of position `1132071` to execute an SDK-built full close.
The suite reviews the exact calldata before submission, simulates the complete
close to quote the principal and collected token amounts, then verifies that
the executed receipt contains those exact collection amounts alongside the
liquidity removal and NFT burn. It also confirms the final absence of `ownerOf`.

Install Foundry so `anvil` is available, provide an archive-capable Robinhood
mainnet endpoint, and run:

```sh
SDK_FORK_EIP155_4663_RPC_URL=https://example.invalid npm run test:fork
```

The public Robinhood RPC served the pinned fork during this review, but its
long-term historical retention is not contractual. Use an archive-capable RPC
if that endpoint stops serving block `60269962`. The test skips when the
chain-scoped variable is unset and fails closed if the
block hash, deployment code, wiring, position owner, or liquidity has changed.
No private key is used and all state changes remain inside Anvil.

## Arc mainnet v4

The Arc suite pins block `20889496` with hash
`0xf3fd31df5afb9d37a216dda53ac751a6a6c08a9c7e96ce4c07fb0df18d40810b`.
It first verifies every reviewed shared-Uniswap runtime hash and immutable
PositionManager pointer. It then impersonates a historical account which held
two ordinary pre-existing Argus ERC-20 launch tokens at that block, and creates
a fresh **unhooked** pool. Against that isolated pool it builds, independently
reviews, simulates, and executes the complete strategy-position lifecycle:

- mint one NFT to the impersonated strategy owner;
- increase that exact NFT's liquidity;
- remove part of its liquidity while preserving ownership; and
- remove the remainder and burn the NFT atomically.

The suite checks both ERC-20 and Permit2 allowances before the mint, verifies
the NFT owner and exact on-chain liquidity after each step, requires both token
balances to increase after each removal, and finally requires `ownerOf` to fail.
Every submitted lifecycle calldata blob comes from the SDK builder and passes
its matching independent reviewer first; the explicit ERC-20 and Permit2 setup
transactions are separately checked through their on-chain allowances.

Install Foundry and run:

```sh
SDK_FORK_EIP155_5042_RPC_URL=https://example.invalid npm run test:fork
```

This proves the unhooked strategy-owned position lifecycle against the pinned
Arc contracts. It does not touch or claim control over an Argus launcher-owned
NFT, and it does not establish Argus hook, fee, or locker compatibility. Arc's
system USDC contract cannot be moved through Permit2 on a stock Anvil fork, so
the test deliberately uses two ordinary Arc ERC-20s; the failed native-USDC
emulation is not treated as protocol evidence. No private key is used, nothing
is broadcast to Arc, and all approvals, pool state, and receipts disappear when
Anvil exits.
