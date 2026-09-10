# Uniswap SDK

Use Node 24 and the pinned npm version. Keep this repository independently
installable; no parent-relative imports or platform configuration dependencies.
Run `npm ci --ignore-scripts` and `npm run check` before releasing.

The initial API is read-only. Do not imply deployment/hook compatibility from a
standard ABI or successful pointer check. Preserve chain, manager, PoolKey,
currency orientation, hook data, observation block and partial failures.

Publish through the shared versioned artifact publisher as documented in
RELEASING.md. Preserve immutable tags, main ancestry and exact consumer pins.
Do not add keys or transaction submission to protocol helpers.
