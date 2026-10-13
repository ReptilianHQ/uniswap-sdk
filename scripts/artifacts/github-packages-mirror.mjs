import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  assertDownloaded,
  channelFor,
  integrity,
  publishArchive,
  publishRelease,
  registryDownload,
  registryLookup,
} from './publisher.mjs';

export const PUBLIC_REGISTRY = 'https://registry.npmjs.org';
export const MIRROR_REGISTRY = 'https://npm.pkg.github.com';
export const PACKAGE_NAME = '@reptilianhq/uniswap-sdk';

const run = (command, args, cwd = process.cwd()) => execFileSync(command, args, {
  cwd,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit'],
}).trim();

export function parseMirrorReleaseTag(releaseTag) {
  const match = /^uniswap-sdk-v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-rc\.(?:0|[1-9]\d*))?)$/.exec(releaseTag ?? '');
  assert.ok(match, 'Expected an exact uniswap-sdk-v<version> release tag');
  return match[1];
}

export function assertMirrorIdentity({ manifest, releaseTag, taggedCommit, versionAtTag, belongsToMain }) {
  const version = parseMirrorReleaseTag(releaseTag);
  assert.match(taggedCommit, /^[0-9a-f]{40}$/i, 'Release tag must resolve to one commit');
  assert.equal(versionAtTag, version, 'Release tag version differs from package.json');
  assert.equal(belongsToMain, true, 'Release tag commit does not belong to main');
  assert.equal(manifest.name, PACKAGE_NAME, 'Public package name mismatch');
  assert.equal(manifest.version, version, 'Public package version differs from release tag');
  assert.deepEqual(manifest.reptilianRelease, {
    schemaVersion: 1,
    group: 'uniswap-sdk',
    sourceSha: taggedCommit,
  }, 'Public package source identity differs from the release tag');
  assert.equal(manifest.publishConfig?.registry?.replace(/\/$/, ''), PUBLIC_REGISTRY);
  assert.equal(manifest.publishConfig?.access, 'public');
  return { version, taggedCommit };
}

export async function lookupPublicPackage(version, fetchImpl = fetch) {
  const response = await fetchImpl(`${PUBLIC_REGISTRY}/${encodeURIComponent(PACKAGE_NAME)}`);
  assert.ok(response.ok, `Public registry lookup failed (HTTP ${response.status})`);
  const packument = await response.json();
  return packument.versions?.[version] ?? null;
}

export function mirrorRecord({ releaseTag, taggedCommit, version, filename, bytes }) {
  return {
    schemaVersion: 1,
    group: 'uniswap-sdk-github-packages-mirror',
    sourceSha: taggedCommit,
    tag: releaseTag,
    version,
    channel: channelFor(version, ['rc', 'latest']),
    registry: MIRROR_REGISTRY,
    access: 'restricted',
    packages: [{
      name: PACKAGE_NAME,
      version,
      filename,
      integrity: integrity(bytes),
      reptilianRelease: {
        schemaVersion: 1,
        group: 'uniswap-sdk',
        sourceSha: taggedCommit,
      },
    }],
  };
}

export async function runMirror({
  argv = process.argv.slice(2),
  repoRoot = process.cwd(),
  fetchImpl = fetch,
} = {}) {
  const [releaseTag, output, ...extra] = argv;
  assert.ok(releaseTag && output && extra.length === 0,
    'Usage: node scripts/artifacts/github-packages-mirror.mjs <uniswap-sdk-vVERSION> <directory>');
  assert.ok(process.env.NODE_AUTH_TOKEN, 'NODE_AUTH_TOKEN with GitHub Packages write access is required');

  const version = parseMirrorReleaseTag(releaseTag);
  const taggedCommit = run('git', ['rev-parse', `refs/tags/${releaseTag}^{commit}`], repoRoot);
  let belongsToMain = true;
  try {
    run('git', ['merge-base', '--is-ancestor', taggedCommit, 'refs/remotes/origin/main'], repoRoot);
  } catch {
    belongsToMain = false;
  }
  const versionAtTag = JSON.parse(run('git', ['show', `${releaseTag}:package.json`], repoRoot)).version;
  // Public lookup deliberately sends no GitHub Packages token to npmjs.org.
  const publicPackage = await lookupPublicPackage(version, fetchImpl);
  assert.ok(publicPackage, `${PACKAGE_NAME}@${version} is not published on public npm`);
  assert.equal(publicPackage.name, PACKAGE_NAME);
  assert.equal(publicPackage.version, version);
  assert.ok(publicPackage.dist?.tarball, 'Public package metadata has no tarball URL');

  const tarballUrl = new URL(publicPackage.dist.tarball);
  assert.equal(tarballUrl.protocol, 'https:', 'Public package tarball must use HTTPS');
  assert.equal(tarballUrl.hostname, 'registry.npmjs.org', 'Public package tarball must remain on npmjs.org');
  const response = await fetchImpl(tarballUrl);
  assert.ok(response.ok, `Public package download failed (HTTP ${response.status})`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const manifest = JSON.parse(execFileSync('tar', ['-xzOf', '-', 'package/package.json'], {
    input: bytes,
    maxBuffer: 4 * 1024 * 1024,
  }));
  const identity = assertMirrorIdentity({ manifest, releaseTag, taggedCommit, versionAtTag, belongsToMain });
  assertDownloaded({ ...publicPackage, reptilianRelease: manifest.reptilianRelease }, bytes);

  const destination = resolve(output);
  mkdirSync(destination, { recursive: true });
  const filename = `reptilianhq-uniswap-sdk-${identity.version}.tgz`;
  assert.equal(filename, basename(filename));
  writeFileSync(join(destination, filename), bytes);
  const record = mirrorRecord({ ...identity, releaseTag, filename, bytes });
  writeFileSync(join(destination, 'mirror-intent.json'), `${JSON.stringify({
    ...record,
    canonicalRegistry: PUBLIC_REGISTRY,
    startedAt: new Date().toISOString(),
  }, null, 2)}\n`);

  await publishRelease(record, {
    lookup: registryLookup,
    download: registryDownload,
    publish: (pkg, release) => publishArchive(pkg, release, destination),
    tag: (pkg, release) => run('npm', [
      'dist-tag', 'add', `${pkg.name}@${pkg.version}`, release.channel,
      '--registry', release.registry,
    ], tmpdir()),
  });

  writeFileSync(join(destination, 'mirror-verification.json'), `${JSON.stringify({
    ...record,
    canonicalRegistry: PUBLIC_REGISTRY,
    verifiedAt: new Date().toISOString(),
  }, null, 2)}\n`);
  rmSync(join(destination, filename), { force: true });
  process.stdout.write(`Mirrored and verified ${PACKAGE_NAME}@${version} in GitHub Packages.\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMirror().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
