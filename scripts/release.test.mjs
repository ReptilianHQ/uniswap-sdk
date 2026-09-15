import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { verifyRelease } from './verify-release.mjs';
import { loadConfig } from './artifacts/publisher.mjs';
test('only matching immutable versions can request publication', () => {
  verifyRelease('0.1.0-rc.1', 'uniswap-sdk-v0.1.0-rc.1');
  assert.throws(() => verifyRelease('0.1.0-rc.1', 'uniswap-sdk-v0.1.0-rc.2'));
  assert.throws(() => verifyRelease('0.1.0-beta', 'uniswap-sdk-v0.1.0-beta'));
});
test('standalone owner uses the shared publisher and the public npm registry', () => {
  const [group] = loadConfig(process.cwd());
  assert.equal(group.registry, 'https://registry.npmjs.org');
  assert.equal(group.access, 'public');
  assert.deepEqual(group.packages, [{ path: '.', name: '@reptilianhq/uniswap-sdk' }]);
  const workflow = readFileSync(new URL('../.github/workflows/publish.yml', import.meta.url), 'utf8');
  assert.match(workflow, /git merge-base --is-ancestor HEAD refs\/remotes\/origin\/main/);
  assert.match(workflow, /publisher\.mjs publish uniswap-sdk/);
  assert.match(workflow, /npm run check/);
  assert.doesNotMatch(workflow, /npm publish/);
});
test('publish workflow authenticates via npm OIDC trusted publishing, not a static token', () => {
  const workflow = readFileSync(new URL('../.github/workflows/publish.yml', import.meta.url), 'utf8');
  assert.match(workflow, /id-token: write/);
  assert.doesNotMatch(workflow, /packages: write/);
  assert.match(workflow, /registry-url: https:\/\/registry\.npmjs\.org/);
  assert.doesNotMatch(workflow, /NODE_AUTH_TOKEN/);
});
