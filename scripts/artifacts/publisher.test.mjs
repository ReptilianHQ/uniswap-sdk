import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PUBLISHER_VERSION, validateGroup, loadConfig, prepare, validateRecord, assertPublished, assertDownloaded, integrity, publishRelease, registryDownload } from './publisher.mjs';
const group = { id: 'consumer-contract', tagPrefix: 'consumer-v', registry: 'https://registry.npmjs.org', access: 'public', channels: ['latest'], pack: 'npm', packages: [{ name: '@example/consumer', path: 'packages/consumer' }] };
const sha256 = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'publisher-owner-'));
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const directory = join(root, 'packages/consumer');
  mkdirSync(directory, { recursive: true });
  const manifest = { name: '@example/consumer', version: '1.2.3', type: 'module', files: ['index.js'], publishConfig: { registry: group.registry, access: group.access } };
  writeFileSync(join(directory, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(directory, 'index.js'), 'export const value = 42;\n');
  const authority = { schemaVersion: 1, package: manifest.name, version: manifest.version, files: Object.fromEntries(['package.json', 'index.js'].map(file => [file, sha256(readFileSync(join(directory, file)))])) };
  writeFileSync(join(root, 'authority-1.2.3.json'), JSON.stringify(authority));
  const config = { schemaVersion: 1, publisherVersion: PUBLISHER_VERSION, groups: [group] };
  writeFileSync(join(root, 'artifact-releases.json'), JSON.stringify(config));
  git(['init']); git(['add', '.']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture']);
  git(['update-ref', 'refs/remotes/origin/main', 'HEAD']); git(['tag', 'consumer-v1.2.3']);
  try { return run({ root, git, directory, config }); } finally { rmSync(root, { recursive: true, force: true }); }
}
test('standalone owner configuration rejects unsafe paths, duplicate groups and tool drift', () => fixture(({ root, config }) => {
  assert.equal(loadConfig(root)[0].id, group.id);
  for (const path of ['../outside', '/outside', 'a/../../outside', 'a\\outside']) assert.throws(() => validateGroup({ ...group, packages: [{ ...group.packages[0], path }] }));
  assert.throws(() => validateGroup({ ...group, registry: 'https://wrong.example' }));
  assert.throws(() => validateGroup({ ...group, authority: '../outside-{version}' }));
  writeFileSync(join(root, 'artifact-releases.json'), JSON.stringify({ ...config, publisherVersion: '9.9.9' }));
  assert.throws(() => loadConfig(root), /Publisher version/);
  writeFileSync(join(root, 'artifact-releases.json'), JSON.stringify({ ...config, groups: [group, group] }));
  assert.throws(() => loadConfig(root));
}));
test('standalone CLI packs a custom owner, prefix and source without a parent checkout', () => fixture(({ root, git }) => {
  const output = join(root, 'output');
  execFileSync(process.execPath, [resolve(import.meta.dirname, 'publisher.mjs'), 'prepare', group.id, output], { cwd: root, stdio: 'pipe', env: { ...process.env, ARTIFACT_RELEASE_TAG: 'consumer-v1.2.3' } });
  const record = JSON.parse(readFileSync(join(output, 'release-record.json')));
  assert.equal(record.tag, 'consumer-v1.2.3');
  assert.equal(record.sourceSha, git(['rev-parse', 'HEAD']));
  validateRecord(record, output, group, root);
  const manifest = JSON.parse(execFileSync('tar', ['-xOf', join(output, record.packages[0].filename), 'package/package.json']));
  assert.equal(manifest.reptilianRelease.sourceSha, record.sourceSha);
  assert.throws(() => assertPublished(record.packages[0], { ...manifest, dist: { integrity: 'wrong' } }), /Immutable bytes/);
}));
test('reviewed-byte mode preserves package.json exactly and rechecks authority at publication', () => fixture(({ root, directory }) => {
  const reviewed = { ...group, authority: 'authority-{version}.json' };
  const output = join(root, 'reviewed');
  const record = prepare(reviewed, output, root);
  validateRecord(record, output, reviewed, root);
  const pkg = record.packages[0];
  assert.equal(pkg.reptilianRelease, undefined);
  const packedManifest = execFileSync('tar', ['-xOf', join(output, pkg.filename), 'package/package.json']);
  assert.deepEqual(packedManifest, readFileSync(join(directory, 'package.json')));
  assertPublished(pkg, { name: pkg.name, version: pkg.version, dist: { integrity: pkg.integrity } });
  const second = prepare(reviewed, join(root, 'second'), root);
  assert.equal(second.packages[0].integrity, pkg.integrity);
  const authorityPath = join(root, 'authority-1.2.3.json');
  const authority = JSON.parse(readFileSync(authorityPath));
  authority.files['index.js'] = `sha256:${'0'.repeat(64)}`;
  writeFileSync(authorityPath, JSON.stringify(authority));
  assert.throws(() => validateRecord(record, output, reviewed, root), /reviewed hash drift/);
}));
test('tag ancestry permits later main commits but rejects a changed release tag', () => fixture(({ root, git }) => {
  writeFileSync(join(root, 'later.txt'), 'later main change'); git(['add', 'later.txt']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'later']);
  git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  git(['switch', '--detach', 'consumer-v1.2.3']);
  prepare(group, join(root, 'older-tag'), root);
  git(['tag', '-f', 'consumer-v1.2.3', 'refs/remotes/origin/main']);
  assert.throws(() => prepare(group, join(root, 'moved-tag'), root), /tag must resolve/);
}));
test('public exact-byte retries skip publication and reject mismatched registry bytes', async () => {
  const bytes = Buffer.from('reviewed');
  const pkg = { name: group.packages[0].name, version: '1.2.3', integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` };
  const record = { registry: group.registry, channel: 'latest', packages: [pkg] };
  let writes = 0;
  const io = { lookup: () => ({ name: pkg.name, version: pkg.version, dist: { integrity: pkg.integrity } }), publish: () => writes++, tag: () => writes++, download: () => bytes, wait: async () => {} };
  await publishRelease(record, io); assert.equal(writes, 0);
  io.lookup = () => ({ name: pkg.name, version: pkg.version, dist: { integrity: 'wrong' } });
  await assert.rejects(publishRelease(record, io), /Immutable bytes/); assert.equal(writes, 0);
});
test('existing retry rejects downloaded bytes before a channel repair can write', async () => {
  const bytes = Buffer.from('reviewed registry bytes');
  const pkg = { name: group.packages[0].name, version: '1.2.3', integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` };
  const record = { registry: 'https://npm.pkg.github.com', channel: 'latest', packages: [pkg] };
  const exact = { name: pkg.name, version: pkg.version, dist: { integrity: pkg.integrity } };
  let writes = 0;
  await assert.rejects(publishRelease(record, {
    lookup: spec => spec.endsWith('@1.2.3') ? exact : { version: '1.2.2' },
    publish: () => writes++, tag: () => writes++, download: () => Buffer.from('corrupted registry bytes'), wait: async () => {},
  }), /Downloaded registry tarball differs/);
  assert.equal(writes, 0);
});
test('rechecks a stale channel immediately before repair and rejects a newer release', async () => {
  const bytes = Buffer.from('reviewed registry bytes');
  const pkg = { name: group.packages[0].name, version: '1.2.3', integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` };
  const record = { registry: 'https://npm.pkg.github.com', channel: 'latest', packages: [pkg] };
  const exact = { name: pkg.name, version: pkg.version, dist: { integrity: pkg.integrity } };
  let channelReads = 0;
  let writes = 0;
  await assert.rejects(publishRelease(record, {
    lookup: spec => {
      if (spec.endsWith('@1.2.3')) return exact;
      channelReads++;
      return { version: channelReads === 1 ? '1.2.2' : '1.2.4' };
    },
    publish: () => writes++, tag: () => writes++, download: () => bytes, wait: async () => {},
  }), /backwards/);
  assert.equal(channelReads, 2);
  assert.equal(writes, 0);
});


test('CLI rejects a different selected tag at the same commit before packing or registry access', () => fixture(({ root, git }) => {
  git(['tag', 'consumer-v9.9.9']);
  git(['switch', '--detach', 'consumer-v9.9.9']);
  for (const command of ['prepare', 'publish']) {
    const output = join(root, `wrong-${command}`);
    assert.throws(() => execFileSync(process.execPath, [resolve(import.meta.dirname, 'publisher.mjs'), command, group.id, output], {
      cwd: root, stdio: 'pipe', env: { ...process.env, ARTIFACT_RELEASE_TAG: 'consumer-v9.9.9' },
    }), /Requested release tag does not match package version/);
    assert.equal(existsSync(output), false);
  }
  assert.throws(() => execFileSync(process.execPath, [resolve(import.meta.dirname, 'publisher.mjs'), 'prepare', group.id, join(root, 'missing')], {
    cwd: root, stdio: 'pipe', env: { ...process.env, GITHUB_ACTIONS: 'true', ARTIFACT_RELEASE_TAG: '' },
  }), /CI requires an explicit requested release tag/);
}));


test('registry download uses an isolated cache and disabled lifecycle scripts', () => {
  const root = mkdtempSync(join(tmpdir(), 'publisher-npm-command-'));
  const previousPath = process.env.PATH;
  try {
    writeFileSync(join(root, 'npm'), `#!${process.execPath}
import assert from 'node:assert/strict';
import { writeFileSync, existsSync, realpathSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
const args=process.argv.slice(2);
assert.deepEqual(args.slice(0,6), ['pack','@example/consumer@1.2.3','--ignore-scripts','--json','--registry','https://npm.pkg.github.com']);
const cache=args[args.indexOf('--cache')+1];
assert.equal(realpathSync(dirname(cache)),process.cwd());
assert.equal(basename(cache),'npm-cache');
assert.equal(existsSync(cache),false);
assert.equal(realpathSync(args[args.indexOf('--pack-destination')+1]),process.cwd());
writeFileSync(join(process.cwd(),'archive.tgz'),'original registry bytes');
console.log(JSON.stringify([{filename:'archive.tgz'}]));
`, { mode: 0o755 });
    process.env.PATH = `${root}:${previousPath}`;
    assert.equal(registryDownload('@example/consumer@1.2.3', 'https://npm.pkg.github.com').toString(), 'original registry bytes');
  } finally { process.env.PATH = previousPath; rmSync(root, { recursive: true, force: true }); }
});

test('registry metadata may omit source identity but verified tarball must contain it', () => fixture(({ root }) => {
  const output = join(root, 'output');
  const record = prepare(group, output, root);
  const pkg = record.packages[0];
  const bytes = readFileSync(join(output, pkg.filename));
  const metadata = { name: pkg.name, version: pkg.version, dist: { integrity: pkg.integrity } };
  assertPublished(pkg, metadata);
  assertDownloaded(pkg, bytes);
  assert.throws(() => assertPublished(pkg, { ...metadata, reptilianRelease: {} }), /Registry source identity/);
  assert.throws(() => assertDownloaded({ ...pkg, reptilianRelease: { ...pkg.reptilianRelease, sourceSha: '0'.repeat(40) } }, bytes), /Tarball source identity/);
  assert.throws(() => assertDownloaded(pkg, Buffer.from('corrupt')), /Downloaded registry tarball/);
  const stripped = join(root, 'stripped');
  mkdirSync(stripped);
  execFileSync('tar', ['-xzf', join(output, pkg.filename), '-C', stripped]);
  const manifestPath = join(stripped, 'package/package.json');
  const manifest = JSON.parse(readFileSync(manifestPath));
  delete manifest.reptilianRelease;
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const strippedBytes = execFileSync('tar', ['-czf', '-', '-C', stripped, 'package']);
  assert.throws(() => assertDownloaded({ ...pkg, integrity: integrity(strippedBytes) }, strippedBytes), /Tarball source identity/);
}));
