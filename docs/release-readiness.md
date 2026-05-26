# Release Readiness

Assessment of whether db-cluster is ready for a versioned release.

## Checklist

| Criterion | Status | Evidence |
|-----------|--------|----------|
| Package exports are intentional | ✓ | `exports` field in package.json, documented in package-boundary.md |
| CLI bin works from installed package | ✓ | smoke-install.mjs: `db-cluster --help`, `init`, `doctor` pass |
| MCP bin exists and is runnable | ✓ | smoke-install.mjs: bin found in node_modules/.bin |
| SDK import works | ✓ | smoke-install.mjs: `import { ClusterKernel }` succeeds |
| Subpath exports work | ✓ | smoke-install.mjs: sdk, policy, types imports succeed |
| Quickstart runs from package | ✓ | smoke-install.mjs: ingest + create + retrieve cycle works |
| Docs match runtime CLI/SDK/MCP | ✓ | docs/cli.md, docs/sdk.md, docs/mcp.md updated |
| Examples use package imports | ✓ | All examples import from 'db-cluster' not '../../src/' |
| No raw adapters leak | ✓ | Only factory functions exported, not store implementations |
| Package excludes test/scripts | ✓ | `files` field restricts to dist/docs/examples/dashboard |
| Postgres is optional | ✓ | Documented, works without it |
| Versioning is honest | ✓ | 0.1.0 — pre-1.0, no stability promise beyond documented API |
| Release notes preserve thesis | ✓ | docs/release-notes-v0.1.md — positioned correctly |
| Build + test pass | ✓ | `npm run build` clean, `npm test` 600+ pass |
| Fresh install works | ✓ | 9/9 smoke tests pass from tarball |

## Verdict

**READY for v0.1.0 release candidate.**

The package boundary is deliberate, the install path works, docs match artifacts, examples don't import private internals, and the release notes explain what db-cluster is (and is not) honestly.

## What remains before npm publish

1. CI pipeline verifying build + test + smoke on push
2. GitHub release with tag
3. Decision: npm publish or GitHub Packages only
4. Optional: provenance attestation for npm

## What is NOT blocking release

- Postgres not tested in CI (it's optional, documented as such)
- Dashboard is reference/demo (documented, shipped intentionally)
- repo-knowledge integration is internal (not exported)
- No vector DB, no graph DB, no hosted service
