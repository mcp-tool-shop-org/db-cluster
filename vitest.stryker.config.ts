import { defineConfig } from 'vitest/config';

/**
 * EXPERIMENTAL — NOT IN CI as of Wave B1-Amend.
 *
 * Stryker mutation testing is kept in the repo as an ad-hoc tool — operators
 * who want to spot-check the test suite's discrimination on a specific file
 * may run `npm run test:mutation` locally. The 28-hour wall at
 * `coverageAnalysis: 'off'` (current setting) makes this infeasible in the
 * standing release-gate.
 *
 * Per the v2 dogfood-swarm protocol's verifier-3 doctrine
 * (`C:/Users/mikey/.claude/projects/F--AI/memory/dogfood-swarm.md`), the
 * invariant-test-completeness lens substitutes for mutation coverage in the
 * standing gate. See `docs/release-readiness.md` "Stryker mutation testing
 * — current disposition" for the full rationale.
 *
 * Mutation-testing-only vitest config (used by Stryker via
 * `npm run test:mutation`). Excludes test files that spawn `dist/cli.js`
 * subprocesses because Stryker's vitest-runner sandbox does not include the
 * built CLI binary — the excluded files would all fail in a stryker dry-run
 * with "ENOENT: dist/cli.js" before any mutant is evaluated.
 *
 * The exclusion is for SUBPROCESS-sandbox reasons, NOT flake-prone files.
 * Each entry below is a file whose `it()` blocks `execSync` the CLI binary
 * at least once (verified Wave A4). The regular `npm test` runs the full
 * 63-file suite via `vitest.config.ts`; this narrower 53-file scope is
 * mutation-testing-specific.
 *
 * If you add a new test that spawns `dist/cli.js`, add its file path here.
 *
 * Wave A4 (CIDOCS-B-026) documented the architectural intent. The earlier
 * Stage B audit theory that this list overlapped with the wave6-proof flake
 * was a coincidence — wave6-proof is on the list for the same CLI-subprocess
 * reason as the other 9.
 */
export default defineConfig({
    test: {
        include: ['test/**/*.test.ts'],
        exclude: [
            'test/cli.test.ts',
            'test/cli-docs.test.ts',
            'test/phase10-proof.test.ts',
            'test/phase15-proof.test.ts',
            'test/install-smoke.test.ts',
            'test/wave6-proof.test.ts',
            'test/policy-surface.test.ts',
            'test/wave-a3-tests-regression.test.ts',
            'test/wave-a3-surface-regression.test.ts',
            'test/wave-a3-stores-regression.test.ts',
        ],
        fileParallelism: false,
    },
});
