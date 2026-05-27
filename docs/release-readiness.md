# Release Readiness

Assessment of whether db-cluster is ready for a versioned release.

## Checklist

| Criterion | Status | Evidence |
|-----------|--------|----------|
| Package exports are intentional | ✓ | `exports` field in package.json, documented in package-boundary.md |
| CLI bin works from installed package | ✓ | smoke-install.mjs: `db-cluster --help`, `init`, `doctor` pass |
| MCP bin exists and is runnable | ✓ | smoke-install.mjs: bin found in node_modules/.bin |
| SDK import works | ✓ | smoke-install.mjs: `import { ClusterSDK } from 'db-cluster/sdk'` succeeds |
| Subpath exports work | ✓ | smoke-install.mjs: sdk, policy, types imports succeed |
| Quickstart runs from package | ✓ | smoke-install.mjs: ingest + create + retrieve cycle works |
| Docs match runtime CLI/SDK/MCP | ✓ | docs/cli.md, docs/sdk.md, docs/mcp.md updated post-Wave-A1 |
| Examples use package imports | ✓ | All examples import from `'db-cluster'`, not `'../../src/'` (release-gate enforces this) |
| Examples typecheck | ✓ | `tsconfig.examples.json` runs `tsc --noEmit` against `examples/**`; wired into `npm run lint` |
| No raw adapters leak | ✓ | Only factory functions exported, not store implementations |
| Package excludes test/scripts | ✓ | `files` field restricts to dist/docs/examples/dashboard |
| Postgres is optional | ✓ | Documented, works without it |
| Versioning is honest | ✓ | 0.1.0 — pre-1.0, no stability promise beyond documented API |
| Release notes preserve thesis | ✓ | docs/release-notes-v0.1.md — positioned correctly |
| Build + test pass | ✓ | `npm run build` clean, full test suite passes |
| Fresh install works | ✓ | 9/9 smoke tests pass from tarball |
| Continuous verification | ✓ | `.github/workflows/{ci,release-gate,smoke-install}.yml` run on push/PR/tag |

## Verdict

**Release-readiness verified post-Wave-A1.**

Phase 15 originally self-declared PASS without continuous verification, with
TypeScript examples that did not typecheck and a release-gate drift check that
only worked on Windows. Wave A1 of the dogfood-swarm Stage A amend pass added:

- A `.github/workflows/` directory wiring CI (Node 20/22 × ubuntu/windows),
  release-gate (push to main + tag), and smoke-install (tag push).
- A portable Node-native drift check in `scripts/release-gate.mjs`
  (previously Windows-only `findstr`).
- `tsconfig.examples.json` + `npm run lint:examples`, wired into
  `npm run lint`, so example drift is caught at PR time.
- Every TypeScript example rewritten against the current public API surface
  (correct `actorId`, correct method names, correct SDK constructor).

The package boundary is deliberate, the install path works, docs match
artifacts, examples don't import private internals, and the release notes
explain what db-cluster is (and is not) honestly.

## What remains before npm publish

1. GitHub release with tag
2. Decision: npm publish or GitHub Packages only
3. Optional: provenance attestation for npm

## Recommended release flow (post-Wave-A2)

The smoke-install workflow now triggers on three events:
`push: tags: ['v*']`, `pull_request: paths: ['package.json']`, and
`workflow_dispatch`. Use them in this order so a failing smoke can stop
the tag from going out:

1. **Bump version in a PR** (e.g., `0.1.0` → `0.1.1`). The
   `pull_request: paths: ['package.json']` trigger runs smoke-install
   against the version-bumping PR, proving the to-be-tagged commit
   installs cleanly. CI also runs on the PR.
2. **Merge the PR to main.** `release-gate.yml` runs on push-to-main.
3. **Before tagging:** if you want a defense-in-depth check on the exact
   SHA you are about to tag, trigger `smoke-install` via the
   `workflow_dispatch` button against that SHA.
4. **Create the tag** (`v0.1.1`). `release-gate.yml` runs on tag push
   AND `smoke-install.yml` runs on tag push as a final defense.
5. **If smoke fails on tag push:** the tag is already published but the
   release is broken. Roll back by publishing a fixed patch (e.g.,
   `0.1.2`) with the smoke-install fix; leave the broken tag in place
   for audit traceability and mark the GitHub release as a draft or
   pre-release.

## What is NOT blocking release

- Postgres not tested in CI (it's optional, documented as such)
- Dashboard is reference/demo (documented, shipped intentionally)
- repo-knowledge integration is internal (not exported)
- No vector DB, no graph DB, no hosted service
