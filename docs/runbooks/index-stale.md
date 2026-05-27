# Runbook: Stale or orphan index records

Recovery procedure when `rebuild check` reports stale or orphan index records. The index is the cluster's only derivative store — by architecture law it can always be deleted and rebuilt from canonical + artifact truth.

## Symptom

Any of the following:

- `db-cluster rebuild check` reports stale records (`possiblyStale > 0`).
- `db-cluster doctor` reports the index store in `stale` status.
- `db-cluster verify` returns a check named `index_consistency` with failing diagnostics.
- A retrieval query returns no hits for content the operator knows exists.
- A retrieval query returns hits for content that was compensated / deleted (orphan index record).

No CLI exit code beyond the standard 1 — stale records are a soft state, not a typed error.

## Cause

The index is derivative. Records can drift from owner truth when:

- A mutation committed but the auto-index step failed (network blip, concurrent write).
- A canonical entity was compensated but the index record wasn't compensated alongside.
- An artifact was re-ingested at a new version; the index record points to the old version.
- A backup-restore cycle ran but the post-restore index rebuild was skipped or partial.
- The index store was upgraded across an indexer version (different tokenization).

## Verify

```bash
# 1. Run rebuild check — does NOT mutate, returns stale + orphan record ids.
db-cluster rebuild check --json | jq '{
  total: .total,
  byStore: .byStore,
  expectedTotal: .expectedTotal,
  possiblyStale: .possiblyStale
}'

# 2. For each stale record, inspect its index entry and owner truth.
db-cluster index explain <record-id>

# 3. Confirm the owner truth differs from the projection.
db-cluster inspect <entity-or-artifact-id>

# 4. Run verify to surface any cascading inconsistencies.
db-cluster verify --json --sample 200
```

## Recover

### Path 1 — Rebuild index (preferred — always safe)

The index is derivative. Rebuild is the canonical recovery: clear + re-derive from canonical + artifact stores.

```bash
# Dry-run first — reports what would change without mutating.
db-cluster rebuild index --dry-run

# Confirm the dry-run output is what you expect, then commit.
db-cluster rebuild index

# Verify.
db-cluster doctor
db-cluster verify
```

`rebuild index` calls `IndexStore.replaceAll(records)` atomically — a crash mid-rebuild cannot leave the index empty (closed in Wave A3, see CHANGELOG).

### Path 2 — Targeted re-index (single record)

When only one record drifted and a full rebuild is wasteful:

```bash
# 1. Identify the stale record.
db-cluster index explain <record-id>

# 2. Read the owner truth — confirm what the index should say.
db-cluster inspect <owner-id>

# 3. Propose an update_entity / re-link command for the owner truth.
#    The auto-index step on commit will refresh the index record.
db-cluster propose '{"verb":"update_entity","targetStore":"canonical","payload":{"entityId":"<owner-id>","patch":{"attributes":{}}},"proposedBy":"operator"}'
# Validate, approve, commit the no-op patch — the commit triggers re-index.

# 4. Confirm.
db-cluster index explain <record-id>
```

### Path 3 — Index-store corruption (escalate to corrupt-store runbook)

If `doctor()` reports the index as `corrupt` (not just `stale`), the index files themselves are damaged — see [corrupt-store.md](corrupt-store.md). Recovery is the same: delete and rebuild.

```bash
# Last-resort hammer when the index directory is itself corrupt.
rm -rf .db-cluster/index/
db-cluster rebuild index
db-cluster doctor
```

## Escalate

Bail and contact support if:

- Rebuild leaves stale records (rebuild itself isn't completing or covering owner truth).
- The total index size after rebuild differs from `expectedTotal` by more than a few records.
- `verify --sample 200` returns the same `index_consistency` failures post-rebuild.
- The Postgres canonical adapter is in use and `migration-status` shows pending migrations (rebuild reads from a partial schema).

When escalating, attach:

- `db-cluster doctor --json` output.
- `db-cluster rebuild check --json` output.
- Pre-rebuild + post-rebuild diff of stale record counts.
- A list of 3-5 stale record ids you spot-checked with `index explain`.

## Related

- [corrupt-store.md](corrupt-store.md) — when index drift is a symptom of file corruption.
- `docs/operations.md` §rebuild — full rebuild + check semantics.
- `docs/architecture.md` — Architecture law #2: indexes are derivative.
