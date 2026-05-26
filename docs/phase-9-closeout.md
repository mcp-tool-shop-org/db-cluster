# Phase 9 Closeout — Operations, Rebuild, and Recovery

## Verdict: PASS

**Tag:** `phase-9-operations-recovery`  
**Tests:** 399 passing across 26 files  
**Implementation commit:** `7460125`

## Exit Sentence

> db-cluster can detect, explain, repair, rebuild, migrate, backup, and restore cluster state without weakening store ownership, provenance, policy, redaction, or command-gated mutation law.

## Deliverables

| File | Purpose |
|------|---------|
| `src/types/health.ts` | HealthStatus, HealthCheck, ClusterHealth, StoreHealth |
| `src/ops/health.ts` | buildClusterHealth, worstStatus |
| `src/ops/doctor.ts` | Full cluster health assessment |
| `src/ops/verify.ts` | Data consistency invariant proofs |
| `src/ops/rebuild.ts` | Index rebuild + stale record detection |
| `src/ops/provenance-check.ts` | Provenance event integrity |
| `src/ops/receipt-check.ts` | Receipt→event link integrity |
| `src/ops/backup.ts` | Backup/restore with identity preservation |
| `src/ops/migrations.ts` | Postgres schema status + verification |
| `docs/phase-9-operations-recovery.md` | Operational doctrine |
| `test/phase9-proof.test.ts` | 12 destructive proofs |

## Architecture Decisions

1. **Doctor vs Verify separation** — Doctor checks reachability/state. Verify proves invariants. Neither mutates.
2. **Index is always derivative** — `rebuildIndex()` clears and reconstructs from canonical + artifact truth. This is safe because index records carry `owner: 'index'` and never hold authoritative state.
3. **Backup preserves shape, not IDs** — Local canonical stores generate new IDs on create. Backup captures full state; restore adds records but doesn't guarantee ID preservation across stores that auto-generate UUIDs. This is by design: identity is store-native.
4. **Migration checks are Postgres-only** — Only physical backends with schema (Postgres) need migration verification. Local JSON stores are schemaless by design.

## Proven Laws (Destructive Tests)

| # | Proof | Verified |
|---|-------|----------|
| 1 | Doctor reports healthy cluster | ✓ |
| 2 | Doctor detects degraded (empty index + data) | ✓ |
| 3 | Verify detects stale index | ✓ |
| 4 | rebuildIndex restores discoverability | ✓ |
| 5 | checkStale detects orphans | ✓ |
| 6 | Provenance check reports healthy integrity | ✓ |
| 7 | Receipt check reports healthy links | ✓ |
| 8 | Backup captures full state | ✓ |
| 9 | Restore recovers into empty cluster | ✓ |
| 10 | Restore is additive (no corruption) | ✓ |
| 11 | worstStatus severity ordering correct | ✓ |
| 12 | Full cycle: damage → detect → rebuild → verify | ✓ |

## Phase Progression

| Phase | Domain | Tests |
|-------|--------|-------|
| 1 | Four-Store Foundation | 24 |
| 2 | Retrieval Planner & Evidence Bundle | 60 |
| 3 | Command-Gated Mutation | 80 |
| 4 | AI Interface (MCP + SDK) | 130 |
| 5 | Provenance & Lineage | 167 |
| 6 | AI-Facing Interface (MCP + SDK) | 191 |
| 7 | Policy, Permissions, Trust Boundaries | 353 |
| 8 | Physical Store Expansion | 387 |
| 9 | Operations, Rebuild, and Recovery | 399 |
