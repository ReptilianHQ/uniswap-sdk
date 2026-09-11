# Uniswap SDK releases

This repository owns `@reptilianhq/uniswap-sdk`. Publish to restricted GitHub
Packages using the same Reptilian artifact publisher 1.2.1 used by the other
standalone package owners. `scripts/artifacts/publisher.lock.json` pins the
canonical publisher bytes; update them from the Reptilian root's vendor command.
Do not edit the emitted publisher locally.

## Release verification

Run `npm ci --ignore-scripts` and `npm run check`. Checks include TypeScript,
lint, unit tests, built Node ESM runtime smoke, a runnable consumer example using
the public package subpaths, publisher checksum and tests,
packed export lint, and packed ESM/type resolution. The published scope is pool
observations, events, quote simulation and selective provider subscription plans only. Contract wiring checks are not
bytecode provenance or custom-hook compatibility. Arc details remain unavailable.

Set one exact version such as `0.1.0-rc.1` in package.json and package-lock.json,
land the source on main, then push its immutable tag `uniswap-sdk-v0.1.0-rc.1`.
The publish workflow verifies version identity and main ancestry, reruns package
checks, prepares archives and source metadata, publishes the archive without
rerunning lifecycle scripts, and verifies the registry metadata and downloaded
bytes. Numbered RCs use `rc`; stable releases use `latest`. Never move a tag,
overwrite bytes, or move a channel backwards.

Publication evidence is retained for 90 days as `release-record.json` and
`verification.json`. A manual dispatch with the same exact version retries the
same tag. Existing registry content must have matching source and archive bytes.
If it differs, fix the source and publish a new numbered RC.

## Local fallback

When CI minutes are unavailable, run the same checks locally and use the same
publisher, from a clean tagged checkout with origin/main fetched:

```sh
ARTIFACT_RELEASE_TAG=uniswap-sdk-v0.1.0-rc.1 node scripts/artifacts/publisher.mjs prepare uniswap-sdk .release
ARTIFACT_RELEASE_TAG=uniswap-sdk-v0.1.0-rc.1 node scripts/artifacts/publisher.mjs publish uniswap-sdk .release
```

Registry credentials must already be configured; do not print tokens or put
them in committed configuration. Retain the two evidence files with the release.
The fallback does not relax tag, ancestry, version, or immutable-byte checks.

## Consumer adoption

Consumers install an exact registry version and commit their lockfile. They must
not reference a sibling checkout, git branch, or vendored SDK tarball. Run the
bot's scanner/depth parity tests and browser build before promoting a new pin.
Host multicall policy remains explicit: the bot preserves its zero fallback for
failed sizing probes, while the SDK exposes those results as failures.
