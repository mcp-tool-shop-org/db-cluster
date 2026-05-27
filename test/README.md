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
```

## What this directory does NOT contain

- Mutation testing config — see `stryker.config.json` at the repo root.
- Doc-drift / completeness checks — see `scripts/doc-drift.mjs` and
  `scripts/completeness-checks.mjs`.
- Dashboard JSX render tests — JSDOM is not configured (see
  `wave-a3-tests-regression.test.ts` for the static-source probe pattern).

## CI gate dependency

The `release-gate.mjs` script runs:
1. Build
2. Tests (`npm test`)
3. Package smoke
4. Smoke install
5. Doc drift
6. Exports
7. Completeness checks
8. Doc drift typecheck

The test pass is one of 8 hard gates. A regression here blocks release.
