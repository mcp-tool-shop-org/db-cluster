# Phase 9: Operations, Rebuild, and Recovery

## Mandate

db-cluster can detect, explain, repair, rebuild, migrate, backup, and restore cluster state without weakening store ownership, provenance, policy, redaction, or command-gated mutation law.

## Operational Doctrine

1. **Health is explicit** — every store has a machine-readable health status, not "absence of errors"
2. **Doctor diagnoses, verify proves** — doctor reports reachability/state; verify proves invariants hold
3. **Derivative state is rebuildable** — the index is derived; it can be destroyed and rebuilt from canonical + artifact truth
4. **Provenance is independently verifiable** — audit history can be checked without happy-path APIs
5. **Backup preserves identity** — restoring a backup doesn't create new IDs; cluster identity survives
6. **Migration state is visible** — operators know whether physical backends have correct schema
7. **All ops produce JSON** — CLI operations output structured results for automation

## Architecture

```
src/ops/
├── health.ts           # Health assessment (buildClusterHealth, worstStatus)
├── doctor.ts           # Diagnoses cluster (reachability, staleness, migration)
├── verify.ts           # Proves invariants (index→source, provenance→subject, receipt→event)
├── rebuild.ts          # Reconstructs index from owner truth
├── provenance-check.ts # Verifies provenance event integrity
├── receipt-check.ts    # Verifies receipt→provenance links
├── backup.ts           # Export/import cluster state
└── migrations.ts       # Schema verification for physical backends

src/types/
└── health.ts           # HealthStatus, HealthCheck, ClusterHealth, StoreHealth
```

## Key Invariants

- `rebuildIndex` never mutates canonical, artifact, or ledger stores
- `restore` is idempotent — re-restoring skips existing records
- `verify` is read-only — it never repairs, only reports
- `doctor` is read-only — it reports findings with suggested commands
- `backup` captures the complete truth: entities, artifacts, events, receipts

## CLI Commands (Wave 7)

```
db-cluster doctor              # Full health assessment
db-cluster verify              # Prove cluster invariants
db-cluster rebuild index       # Reconstruct index from truth
db-cluster rebuild check       # Report stale index records
db-cluster backup              # Export cluster state to JSON
db-cluster restore <file>      # Import cluster state from backup
db-cluster migration-status    # Check Postgres schema state
db-cluster verify-schema       # Validate physical schema structure
```
