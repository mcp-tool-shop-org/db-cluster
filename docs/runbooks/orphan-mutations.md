# Runbook: Orphan mutations

Recovery procedure when `doctor()` reports `mutation_orphaned > 0` or a caller catches `ReceiptFailedError`. An orphan mutation means a store write succeeded but the matching receipt + provenance write failed — the store is dirty without an audit trail.

## Symptom

Any of the following:

- CLI exits **70** (`EX_SOFTWARE`).
- Error message: `Mutation succeeded but receipt/provenance emission failed for subject <id> (command <id>): <cause>`.
- An MCP error envelope arrives with `code: 'RECEIPT_FAILED'`.
- `db-cluster doctor` reports `mutation_orphaned` count > 0 in its check output.
- Audit reveals an entity / artifact / ledger record with no matching receipt in `db-cluster receipts`.

## Cause

The kernel commits a mutation in three phases: write the truth store, emit a provenance event, emit a receipt. If phase 2 or phase 3 fails, the store is left dirty: the mutation happened, but no receipt records that it did. The kernel attempts to record a `mutation_orphaned` ledger event before throwing `ReceiptFailedError` so `doctor()` / `verify()` can surface the discrepancy.

Common triggers:

- The ledger file is full / read-only / on a failing disk.
- The provenance event write times out (Postgres adapter under load).
- A concurrent process locked the ledger file (Windows).
- The cluster directory was renamed / moved mid-commit.

## Verify

```bash
# 1. Quantify the orphan count.
db-cluster doctor --json | jq '.checks[] | select(.name == "mutation_orphaned")'

# 2. Read the mutation_orphaned events from the ledger.
grep '"verb":"mutation_orphaned"' .db-cluster/ledger/events.ndjson | jq .

# 3. For each orphan event, locate the dirty record:
#    The ledger event's detail field names the subjectId + commandId.
#    Inspect the canonical/artifact record directly.
db-cluster inspect <subject-id>

# 4. Confirm there's NO matching receipt for that command.
db-cluster receipts --json | jq '.[] | select(.commandId == "<commandId>")'
# Should return empty for true orphans.
```

## Recover

### Path 1 — Backfill the receipt (when audit trail is recoverable)

The store is already mutated. The cleanest recovery is to record a synthetic receipt that names the orphan — preserves the audit trail at the cost of one operator-recorded receipt.

```bash
# 1. Identify the orphaned mutation from the doctor output.
db-cluster doctor --json > /tmp/health.json
ORPHAN_CMD=$(jq -r '.checks[] | select(.name == "mutation_orphaned") | .details[0].commandId' /tmp/health.json)

# 2. Inspect the original command (should still be in queue with status: committed).
db-cluster inspect-command "$ORPHAN_CMD"

# 3. If your operator role permits, propose a compensating receipt-only command
#    that documents the orphan. Otherwise restore from backup.

# 4. Re-run doctor.
db-cluster doctor
```

### Path 2 — Restore from backup (when integrity matters more than recency)

```bash
# 1. Locate the most recent backup taken BEFORE the orphan occurred.
ls -lt cluster-backup-*.json | head -3

# 2. Confirm the orphan post-dates the backup.
stat cluster-backup-<timestamp>.json
grep '"verb":"mutation_orphaned"' .db-cluster/ledger/events.ndjson | head -1 | jq .timestamp

# 3. Move the dirty cluster aside.
mv .db-cluster .db-cluster.orphan-$(date -u +%Y%m%dT%H%M%SZ)

# 4. Re-init and restore.
db-cluster init
db-cluster restore ./cluster-backup-<timestamp>.json

# 5. Re-apply the mutations that happened AFTER the backup BUT BEFORE the orphan.
#    These can be replayed from the dirty cluster's ledger.
#    Re-propose through the normal lifecycle.

# 6. Confirm.
db-cluster doctor
db-cluster verify
```

### Path 3 — Investigate the cause first (preferred for repeating orphans)

DO NOT blindly retry the mutation that orphaned. Per the `ReceiptFailedError.remediationHint`:

> "A store mutation succeeded but the receipt write failed — the store is dirty without a matching receipt. Run `db-cluster doctor` to confirm the `mutation_orphaned` signal; inspect the ledger; if the ledger itself is broken, restore from backup. Do NOT blindly retry the mutation."

If the orphan recurs, the underlying cause is structural:

```bash
# Ledger file shape / disk space.
df -h .db-cluster/
ls -lah .db-cluster/ledger/

# File locks (Windows / WSL).
fuser .db-cluster/ledger/events.ndjson 2>/dev/null || lsof .db-cluster/ledger/events.ndjson

# Postgres connection (if canonical = postgres).
db-cluster migration-status
```

Fix the underlying disk / lock / connection issue BEFORE retrying.

## Escalate

Bail and contact support if:

- More than 5 orphans accumulate (indicates ongoing structural failure).
- The orphan event itself fails to record (silent corruption — the kernel falls back to a stderr write, but operators should see this).
- `verify()` reveals additional integrity failures cascading from the orphan.
- Postgres canonical adapter is in use and `migration-status` returns errors.

When escalating, attach:

- `db-cluster doctor --json` output.
- Tail of `.db-cluster/ledger/events.ndjson` covering the orphan event (last 50 lines).
- The exact `ReceiptFailedError.cause` chain (the `cause.name` and `cause.message`).
- Whether the cluster is local-only or has Postgres canonical.

## Related

- [corrupt-store.md](corrupt-store.md) — when the orphan is a symptom of ledger corruption.
- [postgres-unreachable.md](postgres-unreachable.md) — when Postgres canonical is the failing link.
- `docs/operations.md` §verify — invariant proofs that detect orphans.
- `src/kernel/errors.ts` — `ReceiptFailedError` class with full `remediationHint`.
