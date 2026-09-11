# Uniswap SDK

Use Node 24 or 26 and the pinned npm version; CI verifies both supported consumer runtimes. Keep this repository independently
installable; no parent-relative imports or platform configuration dependencies.
Run `npm ci --ignore-scripts` and `npm run check` before releasing.

The v4 API is read-only. The v3 API may construct unsigned transaction material
and verify calldata and receipt evidence. Do not imply bytecode or hook
compatibility from a standard ABI or successful pointer check. Preserve chain,
manager, PoolKey, currency orientation, hook data, observation block and partial
failures.

Keep runtime code hashes, pinned receipt fixtures, and the documented fork block
in sync with reviewed deployments. Fork tests must use impersonation only; do
not add keys, funded live-chain accounts, or transaction submission.

Publish through the shared versioned artifact publisher as documented in
RELEASING.md. Preserve immutable tags, main ancestry and exact consumer pins.
Do not add keys or transaction submission to protocol helpers.
