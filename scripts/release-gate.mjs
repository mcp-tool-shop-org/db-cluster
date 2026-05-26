#!/usr/bin/env node
/**
 * Release gate script — runs all pre-release checks in sequence.
 * Exit 0 = releasable. Exit 1 = not ready.
 *
 * Usage: node scripts/release-gate.mjs
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
let failures = 0;

function run(label, cmd, opts = {}) {
  process.stdout.write(`  ${label}... `);
  try {
    execSync(cmd, { cwd: opts.cwd || ROOT, stdio: 'pipe', timeout: 120_000 });
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
console.log('[1/6] Build');
run('tsc --noEmit', 'npx tsc --noEmit');
run('npm run build', 'npm run build');

// 2. Test suite
console.log('\n[2/6] Tests');
run('vitest run', 'npx vitest run');

// 3. Pack
console.log('\n[3/6] Package');
run('npm pack', 'npm pack');
const tgz = join(ROOT, 'db-cluster-0.1.0.tgz');
if (!existsSync(tgz)) {
  console.log('  FAIL: tarball not found at', tgz);
  failures++;
}

// 4. Fresh install smoke
console.log('\n[4/6] Fresh install smoke');
const smokeDir = mkdtempSync(join(tmpdir(), 'release-gate-'));
try {
  run('smoke-install', `node ${join(ROOT, 'scripts', 'smoke-install.mjs')} ${tgz}`, { cwd: smokeDir });
} finally {
  rmSync(smokeDir, { recursive: true, force: true });
}

// 5. Docs drift check — examples don't import from src/
console.log('\n[5/6] Docs drift');
process.stdout.write('  No src/ imports in examples... ');
try {
  const grep = execSync(`findstr /S /M "from '../../src/" examples\\*.ts`, { cwd: ROOT, stdio: 'pipe' });
  if (grep.toString().trim().length > 0) {
    console.log('FAIL — found src/ imports');
    failures++;
  } else {
    console.log('OK');
  }
} catch {
  // findstr returns exit 1 when no matches — that's what we want
  console.log('OK');
}

// 6. Package exports exist in dist
console.log('\n[6/6] Export paths exist in dist');
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

// Verdict
console.log('\n=== Verdict ===');
if (failures === 0) {
  console.log('PASS — ready for release\n');
  process.exit(0);
} else {
  console.log(`FAIL — ${failures} check(s) failed\n`);
  process.exit(1);
}
