# Uniswap v3 fork testing

The fork suite pins Robinhood mainnet block `60269962` with hash
`0x0c8248fedd0d28673c6852b5d65d806dfad9be361e4d90ed5a84664ca72fd8bf`.
It checks deployment runtime hashes and position-manager wiring, then uses an
impersonated owner of position `1132071` to execute an SDK-built full close.
The suite reviews the exact calldata before submission and verifies liquidity
removal, token collection, NFT burn, and the final absence of `ownerOf` on the
fork receipt.

Install Foundry so `anvil` is available, provide an archive-capable Robinhood
mainnet endpoint, and run:

```sh
UNISWAP_FORK_RPC_URL=https://example.invalid npm run test:fork
```

The public Robinhood RPC served the pinned fork during this review, but its
long-term historical retention is not contractual. Use an archive-capable RPC
if that endpoint stops serving block `60269962`. The script fails closed if the
block hash, deployment code, wiring, position owner, or liquidity has changed.
No private key is used and all state changes remain inside Anvil.
