import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertMirrorIdentity,
  lookupPublicPackage,
  MIRROR_REGISTRY,
  mirrorRecord,
  PACKAGE_NAME,
  prepareMirrorArtifact,
  publicDownloadExpectation,
} from './github-packages-mirror.mjs';
import { integrity } from './publisher.mjs';

const sourceSha = 'a'.repeat(40);
const manifest = {
  name: PACKAGE_NAME,
  version: '0.13.0',
  publishConfig: { registry: 'https://registry.npmjs.org', access: 'public' },
  reptilianRelease: { schemaVersion: 1, group: 'uniswap-sdk', sourceSha },
};

test('accepts only the public artifact bound to the immutable main release tag', () => {
  assert.deepEqual(assertMirrorIdentity({
    manifest,
    releaseTag: 'uniswap-sdk-v0.13.0',
    taggedCommit: sourceSha,
    versionAtTag: '0.13.0',
    belongsToMain: true,
  }), { version: '0.13.0', taggedCommit: sourceSha });

  assert.throws(() => assertMirrorIdentity({
    manifest,
    releaseTag: 'uniswap-sdk-v0.13.1',
    taggedCommit: sourceSha,
    versionAtTag: '0.13.1',
    belongsToMain: true,
  }), /Public package version/);
  assert.throws(() => assertMirrorIdentity({
    manifest,
    releaseTag: 'uniswap-sdk-v0.13.0',
    taggedCommit: sourceSha,
    versionAtTag: '0.13.0',
    belongsToMain: false,
  }), /does not belong to main/);
});

test('public registry lookup never forwards GitHub Packages credentials', async () => {
  const calls = [];
  const result = await lookupPublicPackage('0.13.0', async (...args) => {
    calls.push(args);
    return {
      ok: true,
      json: async () => ({ versions: { '0.13.0': { name: PACKAGE_NAME, version: '0.13.0' } } }),
    };
  });
  assert.equal(result.version, '0.13.0');
  assert.deepEqual(calls, [['https://registry.npmjs.org/%40reptilianhq%2Funiswap-sdk']]);
});

test('maps public packument integrity into the shared downloaded-byte contract', () => {
  const publicIntegrity = integrity(Buffer.from('reviewed public bytes'));
  const expected = publicDownloadExpectation({
    name: PACKAGE_NAME,
    version: '0.13.0',
    dist: { integrity: publicIntegrity },
  }, manifest.reptilianRelease);
  assert.deepEqual(expected, {
    name: PACKAGE_NAME,
    version: '0.13.0',
    integrity: publicIntegrity,
    reptilianRelease: manifest.reptilianRelease,
  });
  assert.throws(() => publicDownloadExpectation({
    name: PACKAGE_NAME,
    version: '0.13.0',
    dist: {},
  }, manifest.reptilianRelease), /no SHA-512 integrity/);
});

test('artifact preparation maps packument integrity and verifies the exact public tarball', () => {
  const root = mkdtempSync(join(tmpdir(), 'uniswap-mirror-artifact-'));
  try {
    mkdirSync(join(root, 'package'));
    writeFileSync(join(root, 'package/package.json'), JSON.stringify(manifest));
    execFileSync('tar', ['-czf', join(root, 'package.tgz'), '-C', root, 'package']);
    const bytes = readFileSync(join(root, 'package.tgz'));
    const record = prepareMirrorArtifact({
      publicPackage: {
        name: PACKAGE_NAME,
        version: '0.13.0',
        dist: { integrity: integrity(bytes) },
      },
      bytes,
      manifest,
      releaseTag: 'uniswap-sdk-v0.13.0',
      taggedCommit: sourceSha,
      versionAtTag: '0.13.0',
      belongsToMain: true,
      filename: 'package.tgz',
    });
    assert.equal(record.packages[0].integrity, integrity(bytes));
    assert.throws(() => prepareMirrorArtifact({
      publicPackage: {
        name: PACKAGE_NAME,
        version: '0.13.0',
        dist: { integrity: integrity(Buffer.from('different bytes')) },
      },
      bytes,
      manifest,
      releaseTag: 'uniswap-sdk-v0.13.0',
      taggedCommit: sourceSha,
      versionAtTag: '0.13.0',
      belongsToMain: true,
      filename: 'package.tgz',
    }), /Downloaded registry tarball differs/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('preserves canonical bytes and source identity in the restricted mirror record', () => {
  const bytes = Buffer.from('reviewed public registry bytes');
  const record = mirrorRecord({
    releaseTag: 'uniswap-sdk-v0.13.0',
    taggedCommit: sourceSha,
    version: '0.13.0',
    filename: 'uniswap-sdk.tgz',
    bytes,
  });
  assert.equal(record.registry, MIRROR_REGISTRY);
  assert.equal(record.access, 'restricted');
  assert.equal(record.channel, 'latest');
  assert.deepEqual(record.packages[0].reptilianRelease, manifest.reptilianRelease);
});
