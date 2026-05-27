#!/usr/bin/env node
/**
 * Release gate script — runs all pre-release checks in sequence.
 * Exit 0 = releasable. Exit 1 = not ready.
 *
 * Usage: node scripts/release-gate.mjs
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
let failures = 0;

function run(label, cmd, opts = {}) {
  process.stdout.write(`  ${label}... `);
  try {
    execSync(cmd, { cwd: opts.cwd || ROOT, stdio: 'pipe', timeout: opts.timeout ?? 120_000 });
    console.log('OK');
    return true;
  } catch (e) {
    console.log('FAIL');
    if (e.stdout) console.error('    stdout:', e.stdout.toString().slice(-500));
    if (e.stderr) console.error('    stderr:', e.stderr.toString().slice(-500));
    failures++;
    return false;
  }
}

console.log('\n=== Release Gate ===\n');

// 1. Build
console.log('[1/7] Build');
run('tsc --noEmit', 'npx tsc --noEmit');
run('npm run build', 'npm run build');

// 2. Test suite
console.log('\n[2/7] Tests');
run('vitest run', 'npx vitest run', { timeout: 300_000 });

// 3. Pack
console.log('\n[3/7] Package');
run('npm pack', 'npm pack');
const tgz = join(ROOT, 'db-cluster-0.1.0.tgz');
if (!existsSync(tgz)) {
  console.log('  FAIL: tarball not found at', tgz);
  failures++;
}

// 4. Fresh install smoke
console.log('\n[4/7] Fresh install smoke');
const smokeDir = mkdtempSync(join(tmpdir(), 'release-gate-'));
try {
  run('smoke-install', `node ${join(ROOT, 'scripts', 'smoke-install.mjs')} ${tgz}`, { cwd: smokeDir });
} finally {
  rmSync(smokeDir, { recursive: true, force: true });
}

// 5. Docs drift check — shipped directories don't import from src/
console.log('\n[5/7] Docs drift');
process.stdout.write('  No src/ imports in shipped dirs... ');
function scanForDrift(dir) {
  const offenders = [];
  // Match both static `from '../../src/...'` and dynamic `import('../../src/...')`.
  // The `.d.ts` ambient module syntax `import('../../src/...').T` is also caught.
  const driftPattern = /(?:from|import)\s*\(?\s*['"]\.\.\/\.\.\/src\//;
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && /\.(ts|tsx|js|jsx|mjs|d\.ts)$/.test(entry.name)) {
      const p = join(entry.parentPath ?? dir, entry.name);
      const text = readFileSync(p, 'utf8');
      if (driftPattern.test(text)) offenders.push(p);
    }
  }
  return offenders;
}
function scanAllShippedDirs() {
  // CIDOCS-R008: examples/ + dashboard/lib/ both ship in the npm package
  // and must not reference src/ paths (which do not ship).
  const dirs = ['examples', 'dashboard/lib'];
  let allOffenders = [];
  for (const dir of dirs) {
    const abs = join(ROOT, dir);
    if (existsSync(abs)) {
      allOffenders = allOffenders.concat(scanForDrift(abs));
    }
  }
  return allOffenders;
}
const offenders = scanAllShippedDirs();
if (offenders.length > 0) {
  console.log('FAIL — found src/ imports');
  for (const o of offenders) console.error(`    ${o}`);
  failures++;
} else {
  console.log('OK');
}

// 6. Package exports exist in dist
console.log('\n[6/7] Export paths exist in dist');
const exports = ['dist/index.js', 'dist/sdk/index.js', 'dist/mcp/index.js', 'dist/policy/index.js', 'dist/types/index.js'];
for (const exp of exports) {
  process.stdout.write(`  ${exp}... `);
  if (existsSync(join(ROOT, exp))) {
    console.log('OK');
  } else {
    console.log('FAIL');
    failures++;
  }
}

// 7. Completeness — mechanical ast-grep gates for known legacy patterns
console.log('\n[7/7] Completeness');
run('completeness-checks', `node ${join(ROOT, 'scripts', 'completeness-checks.mjs')}`, { timeout: 180_000 });

// Verdict
console.log('\n=== Verdict ===');
if (failures === 0) {
  console.log('PASS — ready for release\n');
  process.exit(0);
} else {
  console.log(`FAIL — ${failures} check(s) failed\n`);
  process.exit(1);
}
