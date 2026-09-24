# db-cluster test conventions

This directory holds vitest test files for the db-cluster package. Tests are
organized by domain and by wave.

## File naming convention

- `<domain>.test.ts` — long-lived per-domain test files (e.g.
  `kernel.test.ts`, `cli.test.ts`, `adapters.test.ts`).
- `wave-<wave-id>-<domain>-regression.test.ts` — wave-scoped regression
  nets dropped per amend wave (e.g. `wave-b1-surface-regression.test.ts`,
  `wave-c1-tests-mcp-envelope.test.ts`). One file per wave per domain.
- `dogfood-*.test.ts` — dogfood-mode integration tests (mutation, retrieval,
  policy, replay, trace, etc.).
- `phaseN-proof.test.ts` — phase milestone proof tests.

When adding a new wave-scoped test file, follow the naming pattern so the
swarm orchestrator can match it to a domain.

## Tmpdir discipline

For any test that writes to disk, use `src/util/tmp-paths.ts` (or
`node:os.tmpdir()` for ephemeral fixtures). Cleanup is best-effort —
swallow errors in `afterAll` / `finally` blocks.

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const dir = mkdtempSync(join(tmpdir(), 'mytest-'));
try {
  // ... use dir ...
} finally {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}
```

## Test-first gate discipline (swarm waves)

Per the canonical `dogfood-swarm.md` v2 protocol, swarm waves follow a
test-first gate:

1. **Write the test FIRST** against the failing-against-HEAD invariant.
2. **Run** — confirm it fails against current HEAD.
3. **Land the source fix** in a sibling agent.
4. **Re-run** — confirm the test now passes.

Tests that pass against HEAD on initial write either (a) document a gap the
audit got wrong, or (b) the corresponding source fix already landed. Both
are valid outcomes; the swarm deliverable JSON documents which is which.

## Family-of-call-sites probe

After writing a test for one site, scan the family of call-sites for the
same pattern. If a test asserts `cluster_find_sources` returns an
AiErrorEnvelope on error, scan every other MCP tool error path for the
same shape. The probe is a load-bearing discipline named in the audit
protocol — every wave-scoped regression file should include a FAMILY-PROBE
test.

## Running tests

```sh
# Full suite (canonical):
npm test

# A single file:
npx vitest run test/wave-c1-tests-mcp-envelope.test.ts

# Filter by test name:
npx vitest run test/wave-c1-tests-exit-codes.test.ts --testNamePattern "POLICY_DENIED"

# Watch mode (re-runs on file change):
npm run test:watch

# Release-gate pipeline:
node scripts/release-gate.mjs

# Mutation testing (Stryker): the full run, or only its initial test pass:
npm run test:mutation
npx stryker run --dryRunOnly
```

## Mutation testing (Stryker)

Stryker runs the suite on a sandbox copy of the repo in which the files
listed in `stryker.conf.json` (`mutate`) are instrumented, inside worker
threads. Two consequences for test authors:

- **Assertions about source text must read it with `sourceText()`**
  (`test/support/source-text.ts`), passing the test context:
  `it('...', (ctx) => { const src = sourceText(path, ctx); ... })`. Under
  Stryker the text of a mutated file is Stryker's rewrite, so the helper
  skips the test there. Everywhere else it returns the text unchanged.
- **Test files that cannot run in the sandbox are excluded by a rule**,
  `scripts/stryker-exclusions.mjs`: files that use the built package
  (`dist/`), call `process.chdir()`, or read a mutated file as text other
  than through `sourceText()`. Nothing needs listing by hand.

`test/stryker-exclusions.test.ts` fails if the rule stops finding what it
should, or if a file would be excluded only for a raw source-text read,
which would drop its other tests from the mutation run. The Release Gate
workflow runs `npx stryker run --dryRunOnly` on every push to main.

`npm run test:mutation` ends with `scripts/stryker-trust-check.mjs`, which
fails the run when a mutant counted as Survived had covering tests but ran
none. That is what Vitest 5 does to `@stryker-mutator/vitest-runner` 10.0.0
(stryker-mutator/stryker-js#6210): the score collapses to single digits and
Stryker still exits 0. Until a fixed runner ships, measure a full run with
Vitest 4.1.x installed. The dry run is unaffected.

## What this directory does NOT contain

- Mutation testing config — see `stryker.conf.json` and
  `vitest.stryker.config.ts` at the repo root.
- Doc-drift / completeness checks — see `scripts/doc-drift.mjs` and
  `scripts/completeness-checks.mjs`.
- Dashboard JSX render tests — JSDOM is not configured (see
  `wave-a3-tests-regression.test.ts` for the static-source probe pattern).

## CI gate dependency

The `release-gate.mjs` script runs:
1. Build
2. Tests (`npm test`)
3. Package
4. Fresh install smoke
5. Docs drift
6. Export paths exist in dist
7. Completeness checks
8. Doc-drift typecheck
9. JSDoc completeness

The test pass is one of 9 hard gates. A regression here blocks release. The
Release Gate workflow then runs the Stryker dry run described above.
