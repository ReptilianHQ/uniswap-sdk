import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export function verifyRelease(version, tag) {
  assert.match(version, /^\d+\.\d+\.\d+(?:-rc\.\d+)?$/);
  assert.equal(tag, `uniswap-sdk-v${version}`, 'Tag must match the exact package version');
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  verifyRelease(JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version, process.env.ARTIFACT_RELEASE_TAG);
}
