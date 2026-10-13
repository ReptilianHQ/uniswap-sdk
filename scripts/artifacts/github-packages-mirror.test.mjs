import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertMirrorIdentity,
  lookupPublicPackage,
  MIRROR_REGISTRY,
  mirrorRecord,
  PACKAGE_NAME,
} from './github-packages-mirror.mjs';

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
