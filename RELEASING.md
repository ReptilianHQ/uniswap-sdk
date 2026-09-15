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
2. Land the version on `main` and push its tag (`uniswap-sdk-v0.2.1`) as
   usual. This triggers `publish.yml` automatically — let it fail; Trusted
   Publishing cannot exist yet, so it will error on a plain E401/E403. That
   is expected for the bootstrap version only.
3. Publish that same tagged version yourself with a temporary org-scoped
   access token (a granular token cannot target a package that doesn't exist
   yet), using the **Local fallback** publisher flow below (`publisher.mjs
   prepare` then `publish`) — not a raw `npm publish`. `prepare` injects the
   `reptilianRelease` manifest metadata and repacks the tarball; a
   hand-published tarball would be missing that and would permanently fail
   CI's immutable-byte check on every later run for that same version, since
   the only recovery for a byte mismatch is a new numbered RC. The publisher
   shells out to `npm publish`/`npm dist-tag` from a temp directory, so put
   the token in `~/.npmrc` (or `NPM_CONFIG_//registry.npmjs.org/:_authToken`)
   — this repo has no `.npmrc`, and one placed in the repo root would be
   ignored. Revoke the token once this succeeds.
4. On the package's npmjs.org settings, add this repository and
   `.github/workflows/publish.yml` as a Trusted Publisher. Optionally scope
   it to the `npm` GitHub environment name — matching `launch-on-block-sdk`
   — but this is optional metadata on npm's side; leaving it unscoped works
   too. Set the Trusted Publisher itself to **always publish** rather than
   the staged/approval default — the publisher script
   (`scripts/artifacts/publisher.mjs`) runs a plain `npm publish` with no
   support for a staged-approval step, so a staged config will hang the
   workflow.
5. The `npm` GitHub environment referenced by the job does not need to exist
   on this repo ahead of time; GitHub creates it automatically the first time
   the workflow runs. **Leave it with no protection rules** (no required
   reviewers, no wait timer) — `launch-on-block-sdk`'s own `npm` environment
   has a required-reviewer rule, but copying that here would reintroduce the
   same staged-approval hang from step 4, just via GitHub's environment gate
   instead of npm's. `timeout-minutes: 30` on the job bounds execution time,
   not an approval wait, so a gated run would park rather than fail loudly.

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
