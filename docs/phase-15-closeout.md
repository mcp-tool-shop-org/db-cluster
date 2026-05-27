# Phase 15 Closeout — Release Readiness & Package Boundary

**Status**: PASS (with Wave A1 amend)
**Date**: 2026-05-26 (amended after dogfood-swarm Stage A)
**Tag**: `phase-15-release-readiness`

**Wave A1 amend note (2026-05-26):** Phase 15 originally self-declared PASS
without continuous verification; Stage A audit (`swarm-stage-a-audit-20260526-225638Z.md`)
showed no `.github/` directory, no Node-native drift check, and broken
TypeScript examples. Wave A1 added CI workflows, a portable release-gate
drift scan, `tsconfig.examples.json` + `lint:examples`, and rewrote all
examples against the current public API. The PASS verdict now rests on
continuous verification, not a self-declaration. See
`docs/release-readiness.md` for the updated checklist.

## Objective

Prepare db-cluster for a real versioned release without weakening the product thesis or exposing unstable internals as public API.

## Delivered

| Wave | Deliverable | Status |
|------|-------------|--------|
| 1 | Public API audit — src/index.ts rewritten | ✓ |
| 2 | Package contents audit — npm pack verified | ✓ |
| 3 | Fresh install smoke — 9/9 from tarball | ✓ |
| 4 | Docs/package consistency — examples fixed | ✓ |
| 5 | Release notes + positioning | ✓ |
| 6 | CI / release gate script | ✓ |
| 7 | Phase 15 proof suite — 10/10 pass | ✓ |

## Key decisions

1. **Main entry exports runtime values** — ClusterKernel, factory functions, ops, URI utilities. This is intentional: consumers need to import and use these.
2. **Subpath exports for separation** — SDK, MCP, Policy, Types each get their own entry point.
3. **Internal details NOT exported** — Raw adapters, CommandQueue, repo-knowledge integration, provenance recording helpers stay internal.
4. **Postgres is optional** — Ships with `pg` in dependencies but Postgres functionality is opt-in.
5. **Examples ship as reference** — They use package import paths (`'db-cluster'`) not relative src paths.
6. **Version 0.1.0** — Pre-1.0, breaking changes possible between minor versions. Honest about stability.

## Test evidence

- 10/10 Phase 15 proofs pass
- 612+ tests pass across full suite
- Fresh install smoke: 9/9 from tarball
- `npx tsc --noEmit` clean
- `npm pack --dry-run` shows no test/scripts/src leakage

## What does NOT block release

- Postgres not tested in CI (optional, documented)
- Dashboard is reference/demo (documented, ships intentionally)
- repo-knowledge integration is internal (not exported)

## Next phase candidates

- npm publish or GitHub Packages
- CI pipeline (GitHub Actions)
- Provenance attestation
- v0.2.0 feature planning
