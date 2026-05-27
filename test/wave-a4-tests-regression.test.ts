/**
 * Wave A4 — Tests-domain regression nets.
 *
 * These tests close should-have-been-Stage-A items that Wave A3's v2
 * ensemble missed because the failure modes only fire in compound
 * conditions (Windows + Defender + in-repo paths + nested subdirs). The
 * Wave A4 strategy is "convert silent flake to structural pass": the
 * mass migration to `os.tmpdir()` is the actual fix, and these nets
 * sentinel that future regressions cannot re-introduce the in-repo
 * TEST_DIR pattern that produced the ~85% wave6-proof flake rate.
 *
 * Findings covered:
 *
 * - TESTS-B-001 / TESTS-B-007 — sentinel that no test file uses
 *   `join(import.meta.dirname, '.test-XYZ')` for a working directory.
 *   This is the pattern that placed temp dirs INSIDE the repo where
 *   Windows Defender real-time scanning aggressively locked files during
 *   write+rename races. The fix migrated all 25 affected files to
 *   `mkdtempSync(join(tmpdir(), '...'))`. This sentinel keeps the
 *   migration in place — a future test that recreates the pattern fails
 *   the suite immediately rather than re-introducing platform-specific
 *   flake.
 *
 * - TESTS-B-002 — wave6-policy-proof.test.ts cleanup. The file previously
 *   leaked ~80 mkdtempSync directories per run with zero cleanup hooks.
 *   This sentinel asserts the file now has both a tracker and an
 *   afterEach that drains it.
 *
 * - TESTS-B-004 — makePolicyKernel/__admin cast removed. The previous
 *   helper attached an admin kernel as a hidden `__admin` instance
 *   property via double-cast (`as unknown as { __admin: ... }`). Bypassed
 *   TypeScript's structural checks AND was invisible to the verb-parity
 *   allowlist. The fix returns a typed `{ restricted, admin }` tuple.
 *   This sentinel asserts the cast pattern and the `__admin` property
 *   no longer appear in the source file.
 *
 * - mkdtempSync pattern uniformity sentinel — global check that no
 *   `.test-*` directory pattern remains in the test/ subtree. The
 *   migration is structurally complete and stays complete.
 *
 * These tests live in a separate file (not in `typed-error-regression.test.ts`
 * or `wave-a3-tests-regression.test.ts`) per the Wave A3 consolidation
 * pattern — when a future wave amends typed-error coverage, do it in
 * `wave-a{wave}-{domain}-regression.test.ts` so parallel agents don't
 * collide on sequencing.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const TEST_DIR_ROOT = resolve(import.meta.dirname);

function readAllTestFiles(): Array<{ path: string; name: string; source: string }> {
    return readdirSync(TEST_DIR_ROOT)
        .filter((name) => name.endsWith('.test.ts'))
        .map((name) => ({
            path: join(TEST_DIR_ROOT, name),
            name,
            source: readFileSync(join(TEST_DIR_ROOT, name), 'utf-8'),
        }));
}

describe('Wave A4 — Tests regression nets', () => {

    // ─── TESTS-B-001 / TESTS-B-007 — no in-repo TEST_DIR pattern remains ─
    //
    // The compound Windows-filesystem race that produced wave6-proof's
    // ~85% flake rate was rooted in `const TEST_DIR = join(import.meta.dirname,
    // '.test-XYZ')` — a working dir INSIDE the repo where Defender scans
    // and the indexer compete for file handles against `rmSync` →
    // `mkdirSync` → `writeFileSync` → `renameSync` chains in `beforeEach`.
    // Migration moved all 25 affected files to `os.tmpdir()` per-test.
    //
    // This sentinel asserts the migration is complete and stays complete.
    // A future test that re-introduces the pattern fails THIS test first,
    // before it can flake silently in CI.
    describe('TESTS-B-001/B-007 — no in-repo TEST_DIR pattern remains', () => {
        it('no test file uses join(import.meta.dirname, \'.test-...\') for a working directory', () => {
            const files = readAllTestFiles();
            const offenders: string[] = [];

            // Matches `join(import.meta.dirname, '.test-`, including
            // whitespace variations and double-quoted strings.
            const pattern = /join\s*\(\s*import\.meta\.dirname\s*,\s*['"]\.test-/;

            for (const file of files) {
                // Skip this very file — its own source contains the
                // pattern as a regex literal in the offender check above.
                if (file.name === 'wave-a4-tests-regression.test.ts') continue;
                if (pattern.test(file.source)) {
                    offenders.push(file.name);
                }
            }

            expect(
                offenders,
                `Expected ZERO test files with in-repo TEST_DIR pattern; found: ${offenders.join(', ')}. ` +
                `Use mkdtempSync(join(tmpdir(), 'db-cluster-XYZ-')) instead — see Wave A4 dispatch.`,
            ).toHaveLength(0);
        });

        it('mass migration retained at least one mkdtempSync per affected file', () => {
            // Twenty-five files were migrated. Each should now contain a
            // mkdtempSync call. (Not all 63 test files use temp dirs; this
            // only asserts the migrated cohort kept their cleanup pattern.)
            const expectedMigrated = [
                'adapters.test.ts',
                'cli.test.ts',
                'dashboard-command-preview.test.ts',
                'dashboard-model.test.ts',
                'dashboard-ops.test.ts',
                'dashboard-snapshot.test.ts',
                'explain.test.ts',
                'kernel.test.ts',
                'phase13-proof.test.ts',
                'phase14-proof.test.ts',
                'phase2-proof.test.ts',
                'phase3-proof.test.ts',
                'phase4-proof.test.ts',
                'phase5-proof.test.ts',
                'proof.test.ts',
                'rebuild.test.ts',
                'repo-knowledge-dashboard.test.ts',
                'repo-knowledge-ingest.test.ts',
                'repo-knowledge-mutation.test.ts',
                'repo-knowledge-ops.test.ts',
                'repo-knowledge-retrieval.test.ts',
                'resolver.test.ts',
                'retrieval.test.ts',
                'wave5-parity.test.ts',
                'wave6-proof.test.ts',
            ];

            const missingMkdtempSync: string[] = [];
            for (const name of expectedMigrated) {
                const source = readFileSync(join(TEST_DIR_ROOT, name), 'utf-8');
                if (!source.includes('mkdtempSync')) {
                    missingMkdtempSync.push(name);
                }
            }

            expect(
                missingMkdtempSync,
                `Files expected to use mkdtempSync (mass migration cohort) but don't: ${missingMkdtempSync.join(', ')}`,
            ).toHaveLength(0);
        });
    });

    // ─── TESTS-B-002 — wave6-policy-proof has cleanup ────────────────────
    //
    // The file previously leaked ~80 mkdtempSync directories per run with
    // zero cleanup hooks. While migrating other files to tmpdir(), this
    // file's helpers (`makeStoresWithDir`, `makeSDK`) were updated to push
    // their dataDir to a `_trackedDirs` array, and an `afterEach` hook
    // walks the array and rmSync's everything.
    //
    // Sentinel: assert the cleanup pattern is in place.
    describe('TESTS-B-002 — wave6-policy-proof.test.ts has tracked cleanup', () => {
        it('wave6-policy-proof.test.ts has both _trackedDirs tracker and afterEach', () => {
            const source = readFileSync(join(TEST_DIR_ROOT, 'wave6-policy-proof.test.ts'), 'utf-8');

            expect(source).toMatch(/_trackedDirs\s*:\s*string\[\]/);
            expect(source).toMatch(/_trackedDirs\.push/);
            expect(source).toMatch(/afterEach\s*\(\s*\(\s*\)\s*=>\s*{/);
            expect(source).toMatch(/rmSync\s*\(\s*dir\s*,\s*\{\s*recursive:\s*true/);
        });

        it('wave6-policy-proof.test.ts still calls mkdtempSync in helpers', () => {
            // Defends against the opposite regression — someone removing
            // the helpers entirely "to fix the leak" and breaking the
            // tests that use the helpers.
            const source = readFileSync(join(TEST_DIR_ROOT, 'wave6-policy-proof.test.ts'), 'utf-8');
            const mkdtempCount = (source.match(/mkdtempSync/g) || []).length;
            expect(mkdtempCount).toBeGreaterThanOrEqual(2);
        });
    });

    // ─── TESTS-B-004 — __admin cast removed from policy-kernel.test.ts ──
    //
    // The previous makePolicyKernel returned only the restricted kernel
    // and attached an admin-wrapped kernel via:
    //
    //   (restricted as unknown as { __admin: PolicyEnforcedKernel }).__admin = ...
    //
    // and read it back via the same double-cast. This bypassed TypeScript
    // entirely AND was invisible to the verb-parity allowlist (which
    // governs prototype methods, not instance properties).
    //
    // The fix returns a typed `{ restricted: PolicyEnforcedKernel, admin:
    // PolicyEnforcedKernel }` tuple. The cast is gone; reader's job is
    // obvious; verb-parity drift can no longer be hidden in an instance
    // property.
    //
    // Sentinel: assert the cast pattern and `__admin` no longer appear,
    // AND the new tuple shape IS present.
    describe('TESTS-B-004 — makePolicyKernel returns typed tuple, no __admin cast', () => {
        it('policy-kernel.test.ts does not contain the __admin double-cast', () => {
            const source = readFileSync(join(TEST_DIR_ROOT, 'policy-kernel.test.ts'), 'utf-8');

            // The unsafe pattern: `as unknown as { __admin:`. Comments
            // about the OLD pattern are allowed (the JSDoc explains the
            // migration), but ACTIVE code with the cast is not.
            // Strip line comments and JSDoc, then check.
            const codeOnly = source
                .replace(/\/\*[\s\S]*?\*\//g, '')   // strip /* ... */
                .replace(/\/\/[^\n]*/g, '');         // strip // ...

            expect(codeOnly).not.toMatch(/as\s+unknown\s+as\s*\{\s*__admin/);
            expect(codeOnly).not.toContain('.__admin');
        });

        it('policy-kernel.test.ts uses the PolicyKernelPair tuple shape', () => {
            const source = readFileSync(join(TEST_DIR_ROOT, 'policy-kernel.test.ts'), 'utf-8');

            // The typed tuple interface must be present.
            expect(source).toMatch(/interface\s+PolicyKernelPair/);
            // Call sites destructure both `restricted` and `admin`.
            expect(source).toMatch(/const\s*\{\s*restricted\s*:\s*pk\s*,\s*admin\s*:\s*adminK\s*\}\s*=\s*makePolicyKernel/);
        });

        it('seedKernel helper is gone (replaced by direct admin kernel)', () => {
            const source = readFileSync(join(TEST_DIR_ROOT, 'policy-kernel.test.ts'), 'utf-8');
            // Strip comments first — the JSDoc may mention the old name.
            const codeOnly = source
                .replace(/\/\*[\s\S]*?\*\//g, '')
                .replace(/\/\/[^\n]*/g, '');

            // No function declaration named `seedKernel` remains.
            expect(codeOnly).not.toMatch(/function\s+seedKernel\s*\(/);
            // No call to `seedKernel(...)` remains.
            expect(codeOnly).not.toMatch(/seedKernel\s*\(/);
        });
    });

    // ─── Pattern uniformity sentinel — global mkdtempSync hygiene ────────
    //
    // Defense-in-depth: even if a future test does NOT use `join(import.
    // meta.dirname, '.test-...')` directly but instead constructs a path
    // inside the repo via some other mechanism (e.g., process.cwd()
    // joined with a literal), we want to surface it. This sentinel reads
    // every test file's mkdir/temp-dir creation sites and asserts they
    // root in `tmpdir()` from `node:os`.
    describe('mkdtempSync pattern uniformity — temp dirs root in os.tmpdir', () => {
        it('every test file that calls mkdtempSync passes a path that includes tmpdir() or os tmpdir', () => {
            const files = readAllTestFiles();
            const offenders: Array<{ name: string; preview: string }> = [];

            // Match `mkdtempSync(<arg>)` where <arg> is anything up to the
            // first `)`. We then check that the arg contains either
            // `tmpdir(` or `os.tmpdir`.
            const pattern = /mkdtempSync\s*\(([^)]*)\)/g;

            for (const file of files) {
                // Skip this very file — sentinel-on-self false positive.
                if (file.name === 'wave-a4-tests-regression.test.ts') continue;
                let match: RegExpExecArray | null;
                while ((match = pattern.exec(file.source)) !== null) {
                    const arg = match[1];
                    if (!/tmpdir\s*\(|os\.tmpdir/.test(arg)) {
                        offenders.push({
                            name: file.name,
                            preview: match[0].slice(0, 100),
                        });
                    }
                }
            }

            expect(
                offenders,
                `Found mkdtempSync calls NOT rooted in tmpdir():\n${offenders.map((o) => `  ${o.name}: ${o.preview}`).join('\n')}`,
            ).toHaveLength(0);
        });
    });
});
