#!/usr/bin/env node

// Vendored copy of ReptilianHQ/reptilian scripts/check-sdk-conformance.mjs, the shared Protocol SDK
// Standard's conformance script (docs/SDK_STANDARDS.md there). This standalone package
// cannot read the private source, so the source repository checks this copy against its
// own on every change. Do not edit the body below; the adjacent self-test fails if it no
// longer matches the recorded hash. Invoked as `node scripts/check-conformance.mjs .`.
// Canonical body sha256: e03bec3ea1db3451f3306ca5dd48f432dd061db02a3c9dd445c1f557e6408bb4

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const requiredCapabilityExports = [
  './deployments',
  './compatibility',
  './errors',
  './transactions',
  './receipts',
];

// Property-based invariant suites required per exported capability. See
// docs/SDK_STANDARDS.md, "Invariant testing for capital-moving flows".
export const requiredInvariantSuites = [
  ['./transactions', 'transactions.hegel.test.ts'],
  ['./receipts', 'receipts.hegel.test.ts'],
  ['./math', 'math.hegel.test.ts'],
  ['./economics', 'economics.hegel.test.ts'],
  ['./swap', 'swap.hegel.test.ts'],
  ['./fees', 'fees.hegel.test.ts'],
];

// Invariant suites a package has not adopted yet, keyed by repository-relative
// root. Only the listed suites downgrade to warnings; any other missing suite
// fails. Remove a suite once the package adopts it.
export const invariantAdoptionPending = new Map([
  // Every governed package in this repository has adopted its suites. Add a
  // [root, Set(suites)] entry only for a new package that has not yet.
]);

// Returns [{ suite, issue }] so callers can decide per suite whether a gap is
// pending adoption or a failure.
export function invariantSuiteFindings(manifest, sourceFiles = new Map()) {
  if (sourceFiles.size === 0) return [];
  const findings = [];
  for (const [exportPath, suite] of requiredInvariantSuites) {
    if (!manifest.exports?.[exportPath]) continue;
    const source = sourceFiles.get(suite);
    if (!source) {
      findings.push({ suite, missing: true, issue: `${exportPath} is exported but src/${suite} is missing (property-based invariant suite)` });
    } else if (!source.includes('@hegeldev/hegel')) {
      findings.push({ suite, missing: false, issue: `src/${suite} must use @hegeldev/hegel for its invariant properties` });
    }
  }
  return findings;
}

export function invariantSuiteIssues(manifest, sourceFiles = new Map()) {
  return invariantSuiteFindings(manifest, sourceFiles).map(({ issue }) => issue);
}

export function sdkConformanceIssues(manifest, sourceFiles = new Map(), options = {}) {
  const issues = [];
  if (manifest.type !== 'module') issues.push('package must use ESM (`type: module`)');
  if (manifest.sideEffects !== false) issues.push('package must declare `sideEffects: false`');
  if (!Array.isArray(manifest.files) || !manifest.files.includes('dist') || !manifest.files.includes('README.md')) {
    issues.push('published files must include `dist` and `README.md`');
  }

  for (const exportPath of requiredCapabilityExports) {
    const entry = manifest.exports?.[exportPath];
    if (!entry) {
      issues.push(`missing required capability export ${exportPath}`);
      continue;
    }
    if (typeof entry.types !== 'string' || !entry.types.startsWith('./dist/') || !entry.types.endsWith('.d.ts')) {
      issues.push(`${exportPath} types must resolve to a declaration under ./dist`);
    }
    if (typeof entry.import !== 'string' || !entry.import.startsWith('./dist/') || !entry.import.endsWith('.js')) {
      issues.push(`${exportPath} import must resolve to ESM JavaScript under ./dist`);
    }
  }

  if (!manifest.exports?.['./abis'] && !manifest.exports?.['./idl']) {
    issues.push('missing chain artifact export (`./abis` for EVM or `./idl` for Solana)');
  }
  if (!manifest.exports?.['./provenance/mainnet.json'] && !manifest.exports?.['./provenance/testnet.json']) {
    issues.push('missing an exported deployment provenance document');
  }

  if (sourceFiles.size > 0) {
    const errorsSource = sourceFiles.get('errors.ts');
    if (!errorsSource) {
      issues.push('missing src/errors.ts for the exported SDK error contract');
    } else {
      const errorContractChecks = [
        [/export\s+type\s+\w*ErrorCode/u, 'a public error-code union'],
        [/export\s+class\s+\w+\s+extends\s+Error/u, 'an exported Error subclass'],
        [/readonly\s+code/u, 'a readonly error code'],
        [/\btoJSON\s*\(/u, 'a JSON representation'],
        [/export\s+function\s+is\w*Error\s*\(/u, 'an exported error type guard'],
      ];
      for (const [pattern, label] of errorContractChecks) {
        if (!pattern.test(errorsSource)) issues.push(`src/errors.ts must expose ${label}`);
      }
    }
  }

  for (const [path, source] of sourceFiles) {
    if (path.endsWith('.test.ts') || path.endsWith('.spec.ts')) continue;
    if (/throw\s+new\s+Error\s*\(/u.test(source)) {
      issues.push(`${path} throws an untyped Error instead of the SDK error contract`);
    }
  }
  if (options.requireInvariantSuites !== false) {
    issues.push(...invariantSuiteIssues(manifest, sourceFiles));
  }
  return issues;
}

function collectTypeScriptSources(directory, base = directory, result = new Map()) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) collectTypeScriptSources(path, base, result);
    else if (entry.isFile() && entry.name.endsWith('.ts')) {
      result.set(relative(base, path), readFileSync(path, 'utf8'));
    }
  }
  return result;
}

function loadSdkPackage(packageRoot) {
  const manifestPath = join(packageRoot, 'package.json');
  const sourceRoot = join(packageRoot, 'src');
  if (!existsSync(manifestPath)) return { error: `missing package manifest at ${manifestPath}` };
  if (!existsSync(sourceRoot)) return { error: `missing SDK source directory at ${sourceRoot}` };
  return {
    manifest: JSON.parse(readFileSync(manifestPath, 'utf8')),
    sourceFiles: collectTypeScriptSources(sourceRoot),
  };
}

export function checkSdkPackage(packageRoot, options = {}) {
  const loaded = loadSdkPackage(packageRoot);
  if (loaded.error) return [loaded.error];
  return sdkConformanceIssues(loaded.manifest, loaded.sourceFiles, options);
}

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

// Repository-relative, forward-slash form used as the pending-adoption key,
// anchored on this script's location so the key is the same from any cwd.
export function pendingAdoptionKey(packageRoot) {
  return relative(repositoryRoot, resolve(packageRoot)).split(sep).join('/');
}

// Splits a package's issues into failures and pending-adoption warnings in one pass.
export function classifySdkPackage(packageRoot) {
  const loaded = loadSdkPackage(packageRoot);
  if (loaded.error) return { failures: [loaded.error], warnings: [] };
  const base = sdkConformanceIssues(loaded.manifest, loaded.sourceFiles, { requireInvariantSuites: false });
  const pendingSuites = invariantAdoptionPending.get(pendingAdoptionKey(packageRoot)) ?? new Set();
  const failures = [...base];
  const warnings = [];
  for (const { suite, issue, missing } of invariantSuiteFindings(loaded.manifest, loaded.sourceFiles)) {
    // Pending adoption means "not written yet": only a missing file is
    // downgraded. A file that exists without Hegel is a failure everywhere.
    (missing && pendingSuites.has(suite) ? warnings : failures).push(issue);
  }
  return { failures, warnings };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const packageRoots = process.argv.slice(2);
  if (packageRoots.length === 0) {
    console.error('Usage: node scripts/check-sdk-conformance.mjs <package-root> [...]');
    process.exitCode = 2;
  } else {
    const results = packageRoots.map((packageRoot) => [packageRoot, classifySdkPackage(packageRoot)]);
    const failures = results.flatMap(([root, { failures: f }]) => f.map((issue) => `${root}: ${issue}`));
    const warnings = results.flatMap(([root, { warnings: w }]) => w.map((issue) => `${root}: pending adoption: ${issue}`));
    if (warnings.length > 0) console.warn(warnings.join('\n'));
    if (failures.length > 0) {
      console.error(failures.join('\n'));
      process.exitCode = 1;
    } else {
      console.log(`SDK conformance passed for ${packageRoots.join(', ')}`);
    }
  }
}
