import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { checkSdkPackage } from './check-conformance.mjs';

const source = readFileSync(new URL('./check-conformance.mjs', import.meta.url), 'utf8').replace(/\r\n/gu, '\n');
const marker = '// Canonical body sha256:';
const lines = source.replace(/^#!\/usr\/bin\/env node\n/u, '').split('\n');
const markerIndex = lines.findIndex(line => line.startsWith(marker));
const recordedHash = markerIndex === -1 ? '' : lines[markerIndex].slice(marker.length).trim();
const body = lines.slice(markerIndex + 1).join('\n').replace(/^\n+/u, '');

test('vendored conformance body matches its canonical hash', () => {
  assert.notEqual(markerIndex, -1);
  assert.equal(createHash('sha256').update(body).digest('hex'), recordedHash);
});

test('the standalone SDK passes its vendored conformance rules', () => {
  assert.deepEqual(checkSdkPackage(new URL('..', import.meta.url).pathname), []);
});
