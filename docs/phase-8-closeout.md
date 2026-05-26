# Phase 8 Closeout — Physical Store Expansion

## Exit Sentence

db-cluster can bind a real physical backend to a logical truth store without weakening cluster ownership, retrieval, provenance, policy, redaction, or mutation law.

## Doctrine Sentence

Physical backends are implementations of store law, not new product centers.

## Waves

| Wave | Scope | Tests | Status |
|------|-------|-------|--------|
| 1 | Backend adapter doctrine | — | PASS |
| 2 | Postgres canonical schema | 19 | PASS |
| 3 | PostgresCanonicalStore adapter | (in W2) | PASS |
| 4 | Store factory and config | (in W7) | PASS |
| 5 | Kernel regression against Postgres | 9 | PASS |
| 6 | CLI support | — | PASS |
| 7 | Backend parity tests | 10 | PASS |
| 8 | Phase 8 proof suite | 10 | PASS |

## Test Coverage

- 387 tests across 25 files
- TypeScript strict mode, zero errors
- All phases 1–8 tests pass without regression
- Postgres tests skip gracefully when DB_CLUSTER_POSTGRES_URL is unset

## Architecture Additions

### Adapter Layer (`src/adapters/postgres/`)
- `schema.ts` — DDL for `canonical_entities` table (UUID PK, JSONB attrs, CHECK constraint on owner)
- `migrations/001_create_canonical_entities.ts` — up/down migration
- `postgres-canonical-store.ts` — `PostgresCanonicalStore` implements `CanonicalStore` exactly
- `index.ts` — barrel export

### Factory (`src/adapters/factory.ts`)
- `createCluster(config)` — explicit backend selection per store
- `createClusterFromEnv(rootDir)` — env var driven (`DB_CLUSTER_CANONICAL_BACKEND`, `DB_CLUSTER_POSTGRES_URL`)
- Fails fast on missing config — never silently falls back

### CLI (`src/cli.ts`)
- `stores verify` — reports backend config, connection status, migration status
- `stores migrate` — runs pending Postgres migrations
- `stores list` — lists configured backend per store

## Design Decisions

1. **One backend, fully proven.** Postgres canonical only. No stack sprawl.
2. **Contract parity is law.** PostgresCanonicalStore passes the same contract tests as LocalCanonicalStore. The kernel cannot tell them apart.
3. **No ambient backend detection.** Config is explicit. Missing URL = hard error.
4. **Mixed mode is the default.** Postgres canonical + local artifact/index/ledger. Each store hardens independently in future phases.
5. **Parallel test isolation.** Postgres tests share a DB — `fileParallelism: false` prevents interference. Future: per-test schema isolation.

## What Was NOT Built (Phase 8 Non-Goals)

- Vector DB backend
- Graph DB backend
- S3 artifact backend
- Distributed nodes / replication
- Multi-tenant hosting
- Cloud deployment
- External policy engine
- SQL query tool
- Raw Postgres admin CLI

## Commits

- `b20fde6` — Phase 8: Physical Store Expansion (implementation)

## Tag

`phase-8-physical-store-expansion`
