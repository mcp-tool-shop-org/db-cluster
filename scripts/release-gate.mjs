#!/usr/bin/env node
/**
 * Release gate script — runs all pre-release checks in sequence.
 * Exit 0 = releasable. Exit 1 = not ready.
 *
 * Usage: node scripts/release-gate.mjs
 *
 * Diagnostics:
 *   Every stage writes full stdout+stderr to `.release-gate-output/`
 *   (gitignored). On failure, the file path is printed so operators can
 *   inspect the complete output rather than a tail. The console fail
 *   summary uses an 8 KB slice (8000 chars), which is wide enough to
 *   surface a failing vitest test name even in a 699-test suite.
 *   See docs/release-readiness.md "Diagnosing a failing release-gate run".
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const LOG_DIR = join(ROOT, '.release-gate-output');
const TAIL_BYTES = 8000;

// AGG-B1-3: read the package version from package.json so the tarball name
// stays in sync with bumps. The SURFACE-B-013 family probe stopped at src/
// and missed scripts/, leaving these hardcoded literals to break the release
// gate after every version bump.
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
const TGZ_NAME = `${PKG.name}-${PKG.version}.tgz`;

mkdirSync(LOG_DIR, { recursive: true });

// Timestamp shared across this run so all stage logs sort together.
function isoStamp() {
  // 20260527-091803Z
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}
const RUN_STAMP = isoStamp();

let failures = 0;
let stageIndex = 0;

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'stage';
}

function writeStageLog(stageNum, label, stdout, stderr, status) {
  const slug = slugify(label);
  const file = join(LOG_DIR, `stage-${stageNum}-${slug}-${RUN_STAMP}.log`);
  const header = [
    `# release-gate stage ${stageNum} — ${label}`,
    `# status: ${status}`,
    `# run: ${RUN_STAMP}`,
    `# cwd: ${ROOT}`,
    '',
  ].join('\n');
  const body = `${stdout || ''}\n---STDERR---\n${stderr || ''}\n`;
  try {
    writeFileSync(file, header + body, 'utf8');
  } catch (e) {
    console.error(`    (warning: could not write log file ${file}: ${e.message})`);
  }
  return file;
}

function run(label, cmd, opts = {}) {
  stageIndex++;
  const stageNum = opts.stageNum ?? stageIndex;
  process.stdout.write(`  ${label}... `);
  let stdout = '';
  let stderr = '';
  try {
    const buf = execSync(cmd, {
      cwd: opts.cwd || ROOT,
      stdio: 'pipe',
      timeout: opts.timeout ?? 120_000,
    });
    stdout = buf ? buf.toString() : '';
    console.log('OK');
    writeStageLog(stageNum, label, stdout, stderr, 'PASS');
    return true;
  } catch (e) {
    stdout = e.stdout ? e.stdout.toString() : '';
    stderr = e.stderr ? e.stderr.toString() : '';
    console.log('FAIL');
    if (stdout) console.error('    stdout:', stdout.slice(-TAIL_BYTES));
    if (stderr) console.error('    stderr:', stderr.slice(-TAIL_BYTES));
    const file = writeStageLog(stageNum, label, stdout, stderr, 'FAIL');
    console.error(`    Full output at: ${file}`);
    failures++;
    return false;
  }
}

console.log('\n=== Release Gate ===');
console.log(`Run stamp: ${RUN_STAMP}`);
console.log(`Logs: ${LOG_DIR}\n`);

// 1. Build
console.log('[1/8] Build');
run('tsc --noEmit', 'npx tsc --noEmit', { stageNum: 1 });
run('npm run build', 'npm run build', { stageNum: 1 });

// 2. Test suite
console.log('\n[2/8] Tests');
run('vitest run', 'npx vitest run', { stageNum: 2, timeout: 300_000 });

// 3. Pack
console.log('\n[3/8] Package');
run('npm pack', 'npm pack', { stageNum: 3 });
const tgz = join(ROOT, TGZ_NAME);
if (!existsSync(tgz)) {
  console.log('  FAIL: tarball not found at', tgz);
  writeStageLog(3, 'tarball-presence', '', `expected tarball not found: ${tgz}`, 'FAIL');
  failures++;
}

// 4. Fresh install smoke
console.log('\n[4/8] Fresh install smoke');
const smokeDir = mkdtempSync(join(tmpdir(), 'release-gate-'));
try {
  run('smoke-install', `node ${join(ROOT, 'scripts', 'smoke-install.mjs')} ${tgz}`, { stageNum: 4, cwd: smokeDir });
} finally {
  rmSync(smokeDir, { recursive: true, force: true });
}

// 5. Docs drift check — shipped directories don't import from src/
console.log('\n[5/8] Docs drift');
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
  const file = writeStageLog(5, 'docs-drift', offenders.join('\n'), '', 'FAIL');
  console.error(`    Full output at: ${file}`);
  failures++;
} else {
  console.log('OK');
  writeStageLog(5, 'docs-drift', `scanned dirs: examples, dashboard/lib\nno offenders\n`, '', 'PASS');
}

// 6. Package exports exist in dist
console.log('\n[6/8] Export paths exist in dist');
const exportPaths = ['dist/index.js', 'dist/sdk/index.js', 'dist/mcp/index.js', 'dist/policy/index.js', 'dist/types/index.js'];
const exportResults = [];
let exportFailed = false;
for (const exp of exportPaths) {
  process.stdout.write(`  ${exp}... `);
  if (existsSync(join(ROOT, exp))) {
    console.log('OK');
    exportResults.push(`OK  ${exp}`);
  } else {
    console.log('FAIL');
    exportResults.push(`FAIL ${exp}`);
    failures++;
    exportFailed = true;
  }
}
writeStageLog(6, 'package-exports', exportResults.join('\n') + '\n', '', exportFailed ? 'FAIL' : 'PASS');

// 7. Completeness — mechanical ast-grep gates for known legacy patterns
console.log('\n[7/8] Completeness');
run('completeness-checks', `node ${join(ROOT, 'scripts', 'completeness-checks.mjs')}`, { stageNum: 7, timeout: 180_000 });

// 8. Doc-drift detector — typechecks every typescript block in docs/ and
// verifies every `from 'db-cluster[/sub]'` named import resolves to a real
// export. Wave B1-Amend §2d (CIDOCS-B-001). The pattern recurred 4 waves
// in a row before this detector landed.
console.log('\n[8/8] Doc-drift');
run('doc-drift', `node ${join(ROOT, 'scripts', 'doc-drift.mjs')}`, { stageNum: 8, timeout: 180_000 });

// Verdict
console.log('\n=== Verdict ===');
if (failures === 0) {
  console.log('PASS — ready for release\n');
  process.exit(0);
} else {
  console.log(`FAIL — ${failures} check(s) failed`);
  console.log(`Logs: ${LOG_DIR}\n`);
  process.exit(1);
}
