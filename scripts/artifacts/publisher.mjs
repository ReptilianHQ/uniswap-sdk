import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const PUBLISHER_VERSION = '1.2.1';
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const run = (cmd, args, cwd = process.cwd()) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
const safePath = value => typeof value === 'string' && value.length > 0 && !value.startsWith('/') && !value.includes('\\') && !value.split('/').includes('..');
export function validateGroup(group) {
  assert.match(group.id, /^[a-z][a-z0-9-]*$/);
  assert.ok(['https://registry.npmjs.org', 'https://npm.pkg.github.com'].includes(group.registry));
  assert.ok(['public', 'restricted'].includes(group.access));
  assert.ok(Array.isArray(group.channels) && group.channels.length > 0 && group.channels.every(channel => ['rc', 'latest'].includes(channel)));
  assert.ok(group.pack === undefined || ['npm', 'pnpm'].includes(group.pack));
  assert.match(group.tagPrefix ?? `${group.id}-v`, /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/);
  assert.ok(!group.tagPrefix?.includes('..'));
  assert.ok(Array.isArray(group.packages) && group.packages.length > 0);
  assert.equal(new Set(group.packages.map(pkg => pkg.name)).size, group.packages.length);
  for (const pkg of group.packages) {
    assert.match(pkg.name, /^@[a-z0-9-]+\/[a-z0-9][a-z0-9._-]*$/);
    assert.ok(safePath(pkg.path), 'Package path must remain inside its owner');
  }
  if (group.authority) {
    assert.ok(safePath(group.authority) && group.authority.includes('{version}'));
    assert.equal(group.pack, 'npm', 'Byte-authorized packages require npm packing without lifecycle scripts');
    assert.equal(group.packages.length, 1, 'Each byte authority describes one package');
  }
  return group;
}
export function loadConfig(repoRoot) {
  const config = json(join(repoRoot, 'artifact-releases.json'));
  assert.equal(config.schemaVersion, 1);
  assert.equal(config.publisherVersion, PUBLISHER_VERSION, 'Publisher version does not match owner configuration');
  assert.ok(Array.isArray(config.groups) && config.groups.length > 0);
  assert.equal(new Set(config.groups.map(group => group.id)).size, config.groups.length);
  return config.groups.map(validateGroup);
}
export function verifyAuthority(archivePath, group, repoRoot, version) {
  const authority = json(join(repoRoot, group.authority.replace('{version}', version)));
  assert.equal(authority.schemaVersion, 1);
  assert.equal(authority.package, group.packages[0].name);
  assert.equal(authority.version, version);
  const entries = run('tar', ['-tzf', archivePath]).split('\n').filter(Boolean);
  const expected = Object.keys(authority.files).map(path => {
    assert.ok(safePath(path), 'Unsafe byte authority path');
    return `package/${path}`;
  });
  assert.deepEqual(entries.sort(), expected.sort(), 'Tarball file set differs from reviewed byte authority');
  for (const [path, digest] of Object.entries(authority.files)) {
    const bytes = execFileSync('tar', ['-xOf', archivePath, `package/${path}`]);
    assert.equal(`sha256:${createHash('sha256').update(bytes).digest('hex')}`, digest, `${path} reviewed hash drift`);
  }
}
export const integrity = bytes => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
export function versionParts(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-rc\.(0|[1-9]\d*))?$/.exec(version);
  assert.ok(match, `Expected exact stable or numbered rc version, received ${version}`);
  return match.slice(1).map(value => value === undefined ? null : BigInt(value));
}
export function channelFor(version, channels) {
  const channel = versionParts(version)[3] === null ? 'latest' : 'rc';
  assert.ok(channels.includes(channel), `Channel ${channel} is not enabled for this group`);
  return channel;
}
export function compareVersions(left, right) {
  const a = versionParts(left), b = versionParts(right);
  for (let i = 0; i < 4; i++) {
    if (a[i] === b[i]) continue;
    if (a[i] === null) return 1;
    if (b[i] === null) return -1;
    return a[i] > b[i] ? 1 : -1;
  }
  return 0;
}
export function assertPublished(expected, actual) {
  assert.equal(actual.name, expected.name, 'Registry package name mismatch');
  assert.equal(actual.version, expected.version, 'Registry version mismatch');
  assert.equal(actual.dist?.integrity, expected.integrity, `Immutable bytes conflict for ${expected.name}@${expected.version}`);
  if (expected.reptilianRelease && actual.reptilianRelease !== undefined) assert.deepEqual(actual.reptilianRelease, expected.reptilianRelease, 'Registry source identity mismatch');
}
// Registries may omit custom packument fields. The integrity-verified archive is
// authoritative for the embedded source identity; never infer it from absence.
export function assertDownloaded(expected, bytes) {
  assert.equal(integrity(bytes), expected.integrity, `Downloaded registry tarball differs for ${expected.name}@${expected.version}`);
  if (!expected.reptilianRelease) return;
  const manifest = JSON.parse(execFileSync('tar', ['-xzOf', '-', 'package/package.json'], { input: bytes, maxBuffer: 4 * 1024 * 1024 }));
  assert.equal(manifest.name, expected.name, 'Tarball package name mismatch');
  assert.equal(manifest.version, expected.version, 'Tarball version mismatch');
  assert.deepEqual(manifest.reptilianRelease, expected.reptilianRelease, 'Tarball source identity mismatch');
}
export function registryLookup(spec, registry) {
  const result = spawnSync('npm', ['view', spec, '--json', '--registry', registry], { cwd: tmpdir(), encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status === 0) {
    const parsed = JSON.parse(result.stdout);
    assert.ok(parsed && !Array.isArray(parsed), `Unexpected registry response for ${spec}`);
    return parsed;
  }
  // Only a structured E404 means absent. Auth, timeout and transport errors fail closed.
  let error;
  try { error = JSON.parse(result.stdout).error; } catch { /* not a registry JSON response */ }
  if (error?.code === 'E404') return null;
  throw new Error(`Registry lookup failed for ${spec} (exit ${result.status}); refusing publication`);
}
export function registryDownload(spec, registry) {
  const staging = mkdtempSync(join(tmpdir(), 'artifact-registry-bytes-'));
  try {
    const [packed] = JSON.parse(run('npm', ['pack', spec, '--ignore-scripts', '--json', '--registry', registry, '--cache', join(staging, 'npm-cache'), '--pack-destination', staging], staging));
    assert.equal(packed.filename, basename(packed.filename));
    return readFileSync(join(staging, packed.filename));
  } finally { rmSync(staging, { recursive: true, force: true }); }
}
export async function publishRelease(record, { lookup, publish, tag, download, wait = () => new Promise(resolve => setTimeout(resolve, 5000)) }) {
  assert.equal(typeof download, 'function', 'Registry tarball download is required for immutable-byte verification');
  // Preflight the entire group before the first write, including channel rollback.
  const states = record.packages.map(pkg => {
    const existing = lookup(`${pkg.name}@${pkg.version}`, record.registry);
    if (existing) {
      assertPublished(pkg, existing);
      assertDownloaded(pkg, download(`${pkg.name}@${pkg.version}`, record.registry));
    }
    const current = lookup(`${pkg.name}@${record.channel}`, record.registry);
    assert.ok(!current || compareVersions(current.version, pkg.version) <= 0, `Refusing to move ${pkg.name}@${record.channel} backwards`);
    const repair = existing && current?.version !== pkg.version;
    assert.ok(!repair || record.registry === 'https://npm.pkg.github.com', `Existing ${pkg.name} needs authenticated channel repair; npm OIDC only authorizes publish`);
    return { pkg, existing, repair };
  });
  for (const { pkg, existing, repair } of states) {
    if (!existing) publish(pkg, record);
    // Repair an interrupted channel update even when the immutable version exists.
    if (repair) {
      const current = lookup(`${pkg.name}@${record.channel}`, record.registry);
      assert.ok(!current || compareVersions(current.version, pkg.version) <= 0, `Refusing to move ${pkg.name}@${record.channel} backwards`);
      if (current?.version !== pkg.version) tag(pkg, record);
    }
    let verified = false;
    for (let attempt = 0; attempt < 6; attempt++) {
      const exact = lookup(`${pkg.name}@${pkg.version}`, record.registry);
      const channel = lookup(`${pkg.name}@${record.channel}`, record.registry);
      if (exact) assertPublished(pkg, exact);
      if (exact && channel?.version === pkg.version) {
        assertPublished(pkg, channel);
        assertDownloaded(pkg, download(`${pkg.name}@${pkg.version}`, record.registry));
        verified = true;
        break;
      }
      if (attempt < 5) await wait();
    }
    assert.ok(verified, `Registry verification failed for ${pkg.name}`);
  }
}
export function prepare(group, destination, repoRoot) {
  validateGroup(group);
  const id = group.id;
  const sourceSha = run('git', ['rev-parse', 'HEAD'], repoRoot);
  assert.match(sourceSha, /^[0-9a-f]{40}$/);
  const version = json(join(repoRoot, group.packages[0].path, 'package.json')).version;
  const channel = channelFor(version, group.channels);
  const tag = `${group.tagPrefix ?? `${id}-v`}${version}`;
  assert.equal(run('git', ['rev-parse', `refs/tags/${tag}^{commit}`], repoRoot), sourceSha, 'Release tag must resolve to HEAD');
  run('git', ['merge-base', '--is-ancestor', sourceSha, 'refs/remotes/origin/main'], repoRoot);
  assert.equal(run('git', ['status', '--porcelain', '--untracked-files=no'], repoRoot), '', 'Release checkout has tracked modifications');
  mkdirSync(destination, { recursive: true });
  assert.equal(readdirSync(destination).length, 0, 'Release directory must be empty');
  const record = { schemaVersion: 1, group: id, sourceSha, tag, version, channel, registry: group.registry, access: group.access, packages: [] };
  for (const pkg of group.packages) {
    const source = json(join(repoRoot, pkg.path, 'package.json'));
    assert.equal(source.name, pkg.name);
    assert.equal(source.version, version, 'Coordinated versions must match');
    assert.equal(source.publishConfig.registry.replace(/\/$/, ''), group.registry);
    assert.equal(source.publishConfig.access, group.access);
    const staging = mkdtempSync(join(tmpdir(), 'artifact-pack-'));
    try {
      // pnpm resolves workspace/catalog specifiers and runs the existing prepack build.
      if (group.pack === 'npm') {
        run('npm', ['pack', '--ignore-scripts', '--cache', join(staging, 'npm-cache'), '--pack-destination', staging], join(repoRoot, pkg.path));
      } else {
        run('pnpm', ['pack', '--pack-destination', staging], join(repoRoot, pkg.path));
      }
      const archives = readdirSync(staging).filter(name => name.endsWith('.tgz'));
      assert.equal(archives.length, 1);
      run('tar', ['-xzf', join(staging, archives[0]), '-C', staging]);
      const manifestPath = join(staging, 'package/package.json');
      const manifest = json(manifestPath);
      assert.equal(manifest.name, pkg.name, 'Packed package name changed');
      assert.equal(manifest.version, version, 'Packed package version changed');
      assert.equal(manifest.publishConfig.registry.replace(/\/$/, ''), group.registry);
      assert.equal(manifest.publishConfig.access, group.access);
      for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
        for (const spec of Object.values(manifest[section] ?? {})) {
          assert.ok(!/^(workspace:|catalog:|file:|link:)/.test(spec), `Local dependency in ${pkg.name}`);
        }
      }
      const reptilianRelease = { schemaVersion: 1, group: id, sourceSha };
      if (group.authority) {
        const filename = archives[0];
        const archive = readFileSync(join(staging, filename));
        writeFileSync(join(destination, filename), archive);
        verifyAuthority(join(destination, filename), group, repoRoot, version);
        record.packages.push({ name: pkg.name, version, filename, integrity: integrity(archive) });
        continue;
      }
      manifest.reptilianRelease = reptilianRelease;
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      // Repack staged bytes only; publication must not rerun lifecycle scripts.
      const [packed] = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--cache', join(staging, 'npm-cache'), '--pack-destination', destination], join(staging, 'package')));
      const digest = integrity(readFileSync(join(destination, packed.filename)));
      assert.equal(digest, packed.integrity);
      record.packages.push({ name: pkg.name, version, filename: packed.filename, integrity: digest, reptilianRelease });
    } finally { rmSync(staging, { recursive: true, force: true }); }
  }
  assert.equal(run('git', ['status', '--porcelain', '--untracked-files=no'], repoRoot), '', 'Packing modified tracked source');
  writeFileSync(join(destination, 'release-record.json'), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}
export function validateRecord(record, destination, group, repoRoot) {
  validateGroup(group);
  assert.equal(record.group, group.id);
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.registry, group.registry);
  assert.equal(record.access, group.access);
  assert.equal(record.channel, channelFor(record.version, group.channels));
  assert.equal(record.tag, `${group.tagPrefix ?? `${group.id}-v`}${record.version}`);
  assert.match(record.sourceSha, /^[0-9a-f]{40}$/);
  assert.deepEqual(record.packages.map(pkg => pkg.name), group.packages.map(pkg => pkg.name));
  for (const pkg of record.packages) {
    assert.equal(pkg.version, record.version);
    assert.equal(pkg.filename, basename(pkg.filename));
    assert.ok(pkg.filename.endsWith('.tgz'));
    if (group.authority) {
      assert.equal(pkg.reptilianRelease, undefined);
      verifyAuthority(join(destination, pkg.filename), group, repoRoot, record.version);
    } else {
      assert.deepEqual(pkg.reptilianRelease, { schemaVersion: 1, group: record.group, sourceSha: record.sourceSha });
    }
    assert.equal(integrity(readFileSync(join(destination, pkg.filename))), pkg.integrity, 'Prepared tarball changed');
  }
}
export async function runCli({ repoRoot = process.cwd(), groups = loadConfig(repoRoot), argv = process.argv.slice(2), requestedTag = process.env.ARTIFACT_RELEASE_TAG } = {}) {
  const [command, id, output, ...extra] = argv;
  const group = groups.find(item => item.id === id);
  assert.ok(group, `Unknown release group: ${id}`);
  assert.ok(['prepare', 'publish'].includes(command) && id && output && !extra.length, 'Usage: node scripts/artifacts/release.mjs prepare|publish <group> <directory>');
  const destination = resolve(output);
  if (process.env.GITHUB_ACTIONS === 'true') assert.ok(requestedTag, 'CI requires an explicit requested release tag');
  if (requestedTag !== undefined) {
    const version = json(join(repoRoot, group.packages[0].path, 'package.json')).version;
    assert.equal(requestedTag, `${group.tagPrefix ?? `${id}-v`}${version}`, 'Requested release tag does not match package version');
  }
  if (command === 'prepare') {
    const record = prepare(group, destination, repoRoot);
    console.log(`Prepared ${record.packages.length} packages for ${record.tag} at ${record.sourceSha}`);
    return;
  }
  const record = json(join(destination, 'release-record.json'));
  assert.equal(record.group, id);
  if (requestedTag !== undefined) assert.equal(record.tag, requestedTag, 'Prepared record differs from requested release tag');
  validateRecord(record, destination, group, repoRoot);
  assert.equal(record.sourceSha, run('git', ['rev-parse', 'HEAD'], repoRoot));
  assert.equal(record.sourceSha, run('git', ['rev-parse', `refs/tags/${record.tag}^{commit}`], repoRoot));
  run('git', ['merge-base', '--is-ancestor', record.sourceSha, 'refs/remotes/origin/main'], repoRoot);
  await publishRelease(record, {
    lookup: registryLookup,
    download: registryDownload,
    publish: (pkg, release) => run('npm', ['publish', join(destination, pkg.filename), '--ignore-scripts', '--registry', release.registry, '--access', release.access, '--tag', release.channel], tmpdir()),
    tag: (pkg, release) => run('npm', ['dist-tag', 'add', `${pkg.name}@${pkg.version}`, release.channel, '--registry', release.registry], tmpdir()),
  });
  console.log(`Verified ${record.packages.length} registry artifacts for ${record.tag}`);
  writeFileSync(join(destination, 'verification.json'), `${JSON.stringify({ ...record, verifiedAt: new Date().toISOString() }, null, 2)}\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch(error => { console.error(error.message); process.exitCode = 1; });
}
