import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { strykerExclusions } from './scripts/stryker-exclusions.mjs';

/**
 * Mutation-testing-only vitest config, used by Stryker via
 * `npm run test:mutation` (stryker.conf.json → `vitest.configFile`). The
 * regular suite runs through vitest.config.ts.
 *
 * Stryker runs these tests in a sandbox copy of the repo with the `mutate`
 * files instrumented, in worker threads. Test files that cannot run there
 * are excluded by a rule, not a list: scripts/stryker-exclusions.mjs scans
 * the test files and excludes any that use the built package (`dist/`),
 * read a mutated source file as text other than through `sourceText()`
 * (test/support/source-text.ts, which skips the assertion on instrumented
 * text), or call `process.chdir()`. The rule reads `mutate` from
 * stryker.conf.json, so it follows that list.
 *
 * The hand-kept list this replaces stopped at Wave A3, and
 * `stryker run --dryRunOnly` failed without anyone noticing. The Release
 * Gate workflow now runs that dry run on every push to main, and
 * test/stryker-exclusions.test.ts checks the scan itself.
 *
 * Stryker's runner also filters to test files that import a mutated file
 * (`vitest.related`), so an excluded file that imports none of them would
 * not have run anyway.
 */
const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
    test: {
        include: ['test/**/*.test.ts'],
        exclude: strykerExclusions(root).map((e) => e.file),
        fileParallelism: false,
    },
});
