# Operations

Cluster operations for diagnosis, repair, rebuild, backup, and recovery.

## Philosophy

1. **Health is explicit** — every store has a machine-readable status
2. **Doctor diagnoses, verify proves** — doctor reports state; verify proves invariants
3. **Derivative state is rebuildable** — the index can be destroyed and rebuilt
4. **Provenance is independently verifiable** — audit history checks without happy-path APIs
5. **Backup preserves identity** — restoring doesn't lose provenance or mutation history
6. **Migration state is visible** — operators know backend schema state

## Doctor

Runs full cluster health assessment: store reachability, index freshness, policy defaults, migration state.

```bash
db-cluster doctor
db-cluster doctor --json
```

Reports:
- Store reachability (canonical, artifact, index, ledger)
- Index populated vs. empty-with-data (degraded)
- Postgres migration status (if configured)
- Policy defaults loadable
- Suggested repair commands

## Verify

Proves data consistency invariants. Read-only — never mutates.

```bash
db-cluster verify
db-cluster verify --sample 200 --json
```

Checks:
- Index records resolve to existing source objects
- Provenance events reference valid subjects
- Receipts reference valid provenance events

## Rebuild

### Rebuild index

Reconstructs the index from canonical + artifact truth. Safe because the index is derivative.

```bash
db-cluster rebuild index
db-cluster rebuild index --dry-run
```

This:
1. Clears the entire index store
2. Re-indexes all canonical entities
3. Re-indexes all artifacts
4. Reports count and errors

### Check stale

Reports stale records without rebuilding.

```bash
db-cluster rebuild check
```

Detects:
- Orphan index records (point to non-existent sources)
- Missing index entries (entities/artifacts not indexed)

## Backup

Exports full cluster state as portable JSON.

```bash
db-cluster backup -o ./backup.json
```

The backup includes:
- All canonical entities
- All artifacts (with content, base64-encoded + SHA-256 checksum)
- All provenance events
- All mutation receipts
- Command queue state

See `docs/handbook.md` §9.5 for the doctrine.

## Restore

Imports cluster state from a backup file. Additive — existing records are not deleted.

```bash
db-cluster restore ./backup.json
```

After restore:
- Index is automatically rebuilt
- Doctor should report healthy
- All provenance chains are intact

## Migration status

For Postgres-backed stores: checks whether required tables exist.

```bash
db-cluster migration-status
```

Requires `DB_CLUSTER_POSTGRES_URL` environment variable.

## Schema verification

Validates that Postgres schema matches expected column structure.

```bash
db-cluster verify-schema
```

## Programmatic access

All operations are available as functions from the package root:

```typescript
import { doctor, verify, backup, restore } from '@mcptoolshop/db-cluster';

const health = await doctor(stores);
const verified = await verify(stores);
const data = await backup(stores);
await restore(freshStores, data);
```

Index rebuild + stale-check live on `PolicyEnforcedKernel`. Use the policy
subpath if you need to drive these in-process; otherwise the CLI surface
(`db-cluster rebuild index`, `db-cluster rebuild check`) covers the same
verbs:

```typescript
import { PolicyEnforcedKernel } from '@mcptoolshop/db-cluster/policy';

declare const kernel: PolicyEnforcedKernel; // see SDK + adapter docs for setup
await kernel.rebuildIndex('operator');
const stale = await kernel.listStaleRecords();
// Postgres migration status: `db-cluster stores migrate` (CLI) — there is
// no public SDK surface for migration management today.
```

## Ownership law

- Doctor and verify are **read-only** — they never mutate state
- Rebuild only touches the **index store** (derivative)
- Backup reads all stores; restore writes to all stores
- Provenance and receipt checks are read-only
- Migration commands only affect Postgres schema, not stored data
