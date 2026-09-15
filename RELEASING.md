# Uniswap SDK releases

This repository owns `@reptilianhq/uniswap-sdk`. Publish to the public npm
registry using the same Reptilian artifact publisher 1.2.2 used by the other
standalone package owners. `scripts/artifacts/publisher.lock.json` pins the
canonical publisher bytes; update them from the Reptilian root's vendor command.
Do not edit the emitted publisher locally.

## One-time npm setup

The publish workflow authenticates via npm OIDC Trusted Publishing
(`id-token: write`, no static token). Trusted Publishing is configured on an
*existing* npm package, so it cannot be the very first thing you set up for a
scope that has never published:

1. Create/claim the `@reptilianhq` org on npmjs.org if it does not exist yet.
2. Publish the first version by hand with a temporary granular access token
   (`npm publish --access public` from a clean checkout), then revoke that
   token.
3. On the package's npmjs.org settings, add this repository and
   `.github/workflows/publish.yml` as a Trusted Publisher, and set it to
   **always publish** rather than the staged/approval default — the publisher
   script (`scripts/artifacts/publisher.mjs`) runs a plain `npm publish` with
   no support for a staged-approval step, so a staged config will hang the
   workflow.

After that one-time setup, every subsequent release goes through the tagged
CI flow below with no token in the repository.

## Release verification

Run `npm ci --ignore-scripts` and `npm run check`. Checks include TypeScript,
lint, unit tests, built Node ESM runtime smoke, a runnable consumer example using
the public package subpaths, publisher checksum and tests,
packed export lint, and packed ESM/type resolution. The published scope includes
v4 observations and provider plans plus v3 reviewed deployments, exact runtime
code hashes, unsigned transaction construction, calldata review, compatibility
checks, pinned receipt evidence, and a self-hash-checked copy of the shared SDK
conformance rules. Run `npm run test:fork` separately with an
archive-capable `SDK_FORK_EIP155_4663_RPC_URL`; it simulates and executes the
reviewed close path on a pinned Anvil fork, then requires the collected receipt
amounts to match the simulation. Run `npm run test:live-compatibility` before release to
recheck both deployment records. Runtime code identity is not source verification or
custom-hook compatibility. Arc details remain unavailable.

Set one exact version such as `0.2.1` in package.json and package-lock.json,
land the source on main, then push its immutable tag `uniswap-sdk-v0.2.1`.
The publish workflow verifies version identity and main ancestry, reruns package
checks, prepares archives and source metadata, publishes the archive without
rerunning lifecycle scripts, and verifies the registry metadata and downloaded
bytes. Numbered RCs use `rc`; stable releases use `latest`. Never move a tag,
overwrite bytes, or move a channel backwards.

Publication evidence is retained for 90 days as `release-record.json` and
`verification.json`. A manual dispatch with the same exact version retries the
same tag. Existing registry content must have matching source and archive bytes.
If it differs, fix the source and publish a new numbered RC.

On the public npm registry, automatic dist-tag/channel repair for an
interrupted publish (version published, channel not yet moved) is not
available — npm OIDC only authorizes the publish itself, not tag repair.
If a run is interrupted after the version lands but before its channel moves,
fix the dist-tag by hand (`npm dist-tag add <pkg>@<version> <channel>`) rather
than relying on retry. If OIDC authentication itself is misconfigured (no
Trusted Publisher entry for this repo/workflow, or it is set to staged
rather than always-publish), `npm publish` fails with a plain E401/E403 with
no specific OIDC diagnostic — check the npmjs.org package settings first.

## Local fallback

When CI minutes are unavailable, run the same checks locally and use the same
publisher, from a clean tagged checkout with origin/main fetched:

```sh
ARTIFACT_RELEASE_TAG=uniswap-sdk-v0.2.1 node scripts/artifacts/publisher.mjs prepare uniswap-sdk .release
ARTIFACT_RELEASE_TAG=uniswap-sdk-v0.2.1 node scripts/artifacts/publisher.mjs publish uniswap-sdk .release
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
