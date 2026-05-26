# Package Boundary

This document defines what is public API and what is internal implementation.

## Public exports

| Import path | Surface | Stability |
|-------------|---------|-----------|
| `db-cluster` | ClusterKernel, store contracts, domain types, factory, ops, URI | Stable |
| `db-cluster/sdk` | ClusterSDK high-level client | Stable |
| `db-cluster/mcp` | MCP tool catalog + handler | Stable |
| `db-cluster/policy` | PolicyEnforcedKernel, redaction, default policies | Stable |
| `db-cluster/types` | All type re-exports (Entity, Artifact, etc.) | Stable |

## Bin commands

| Command | Purpose |
|---------|---------|
| `db-cluster` | CLI for cluster operations |
| `db-cluster-mcp` | MCP stdio server |

## Intentionally NOT public

These are implementation details. They may change without notice.

| Path | Reason |
|------|--------|
| `src/adapters/local/*` | Internal store implementations |
| `src/adapters/postgres/*` | Internal Postgres adapter |
| `src/kernel/command-queue.ts` | Internal command persistence |
| `src/kernel/provenance.ts` | Internal provenance helpers |
| `src/integrations/repo-knowledge/*` | Integration harness (Phase 14 gate) |
| `src/indexing/*` | Internal indexing utilities |
| `src/dashboard/*` | Dashboard model (reference, not product center) |
| `scripts/*` | Development/phase scripts |
| `test/*` | Test suite (not shipped) |

## What ships in the package

```
dist/           — compiled JS + declarations + source maps
docs/           — user-facing documentation
examples/       — runnable examples using package import paths
dashboard/      — reference dashboard (demo, not product center)
README.md       — product description
CHANGELOG.md    — release history
LICENSE         — MIT
```

## What does NOT ship

```
src/            — TypeScript source (use dist/)
test/           — test suite
scripts/        — dev scripts
node_modules/   — dependencies (installed by consumer)
.db-cluster/    — local cluster data
*.tgz           — built tarballs
.test-*         — test temp directories
```

## Postgres dependency

`pg` is included in `dependencies`. It installs with the package but Postgres functionality is opt-in:
- Default: all stores use local filesystem (zero config)
- Optional: set `backends.canonical: 'postgres'` + provide `postgresUrl` to use Postgres for canonical store

No Postgres server is required for core functionality.

## Versioning

- Current: `0.1.0` (pre-1.0, breaking changes possible between minor versions)
- Semver: patch = bugfix, minor = new features or breaking pre-1.0, major = reserved for 1.0
- API stability: exports marked "Stable" above will not break without minor version bump
