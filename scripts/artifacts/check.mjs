// Standalone checksum guard for the versioned publisher distribution.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const root = import.meta.dirname;
const lock = JSON.parse(readFileSync(join(root, 'publisher.lock.json'), 'utf8'));
assert.equal(lock.schemaVersion, 1);
assert.equal(lock.version, '1.2.0');
assert.deepEqual(Object.keys(lock.files).sort(), ['check.mjs', 'publisher.mjs', 'publisher.test.mjs']);
for (const [file, expected] of Object.entries(lock.files)) {
  const actual = createHash('sha256').update(readFileSync(join(root, file))).digest('hex');
  assert.equal(actual, expected, `${file} differs from the pinned publisher distribution`);
}
console.log(`Publisher ${lock.version} distribution verified`);
