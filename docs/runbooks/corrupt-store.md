# Runbook: Corrupt store

Recovery procedure when a store file fails JSON.parse or fails an integrity check. Covers `CorruptStoreError`, `CommandQueueCorruptError`, `CommandQueuePersistenceLostError`, and `LedgerCycleDetectedError`.

## Symptom

Any of the following:

- CLI exits **70** (`EX_SOFTWARE`).
- Error message names a file: `Local store file is unreadable or corrupt: <path> (<cause>)`.
- `db-cluster doctor` reports a store in `corrupt` status.
- `db-cluster doctor` reports `mutation_orphaned > 0` (covered separately in [orphan-mutations.md](orphan-mutations.md)).
- An MCP error envelope arrives with `code: 'CORRUPT_STORE'`, `code: 'COMMAND_QUEUE_CORRUPT'`, `code: 'COMMAND_QUEUE_PERSISTENCE_LOST'`, or `code: 'LEDGER_CYCLE_DETECTED'`.

## Cause

A store file under `.db-cluster/` (entities.json, artifacts.json, ledger events.ndjson, the index dir, or the command queue's `pending-commands.json`) is unreadable:

- The JSON failed to parse (truncated write, manual edit, disk error).
- A backup-restore mixed a partial state with a live state.
- A crash mid-rebuild left the index in an inconsistent state.
- The ledger's parentEventId chain has a cycle (tampering or corruption).

## Verify

```bash
# Find which store is reporting the corruption.
db-cluster doctor --json | jq '.checks[] | select(.status == "corrupt")'

# Inspect the named file.
ls -lah .db-cluster/canonical/ .db-cluster/artifact/ .db-cluster/index/ .db-cluster/ledger/

# Confirm the file fails JSON.parse on its own.
node -e "JSON.parse(require('fs').readFileSync('.db-cluster/canonical/entities.json','utf8'))"
```

If the corruption is in the command queue:

```bash
# Marker file present but pending-commands.json missing → CommandQueuePersistenceLostError.
ls -lah .db-cluster/command-queue-marker .db-cluster/pending-commands.json

# Both files present but pending-commands.json fails JSON.parse → CommandQueueCorruptError.
node -e "JSON.parse(require('fs').readFileSync('.db-cluster/pending-commands.json','utf8'))"
```

If the corruption is in the ledger and the cycle was reported:

```bash
# LedgerCycleDetectedError carries the visited event-id path. Locate each id:
grep -E '"id":"<id-from-cycle>"' .db-cluster/ledger/events.ndjson
```

## Recover

### Path 1 — Restore from backup (preferred)

```bash
# 1. Locate the most recent backup.
ls -lt cluster-backup-*.json | head -1

# 2. Stop any process holding the cluster open.

# 3. Move the corrupt cluster aside (DO NOT delete — useful for forensics).
mv .db-cluster .db-cluster.corrupt-$(date -u +%Y%m%dT%H%M%SZ)

# 4. Re-init and restore.
db-cluster init
db-cluster restore ./cluster-backup-<timestamp>.json

# 5. Confirm health.
db-cluster doctor
db-cluster verify
```

### Path 2 — Excise the corrupt file (acceptable loss of pending state)

Only use when a backup is unavailable AND the corrupt file is one of:
- `pending-commands.json` — losing pending (un-committed) commands is acceptable.
- `command-queue-marker` — losing the marker re-cold-starts the queue.
- An index file — the index is derivative; rebuild from truth.

```bash
# Command queue corruption — delete pending commands and marker.
rm .db-cluster/pending-commands.json .db-cluster/command-queue-marker

# Index corruption — clear and rebuild.
rm -rf .db-cluster/index
db-cluster rebuild index

# Confirm.
db-cluster doctor
```

DO NOT excise a corrupt canonical, artifact, or ledger file without a backup — those stores own truth.

### Path 3 — Ledger cycle (LedgerCycleDetectedError)

The ledger is append-only on disk; a cycle means tampering or on-disk corruption.

```bash
# 1. The error message lists the visited id path. Locate the cycle:
grep -B1 -A5 '"id":"<id-from-cycle>"' .db-cluster/ledger/events.ndjson

# 2. Inspect the offending parentEventId. Either:
#    (a) excise the cycling event by hand (preserve a copy first), or
#    (b) restore from backup (Path 1).

# 3. Re-verify.
db-cluster verify --sample 0
```

### Path 4 — Inspect by hand

Only when restore + excise are both unavailable:

```bash
# Open the file in an editor.
$EDITOR .db-cluster/canonical/entities.json

# Common shapes — typically a trailing-comma or truncated JSON at EOF.
# Restore valid JSON shape, then:
db-cluster doctor
db-cluster verify
```

## Escalate

Bail and contact support if:

- The corruption recurs after restore + rebuild.
- Multiple stores are corrupt simultaneously (suggests filesystem or hardware failure).
- The ledger cycle is more than 5 events deep (manual excision is unsafe).
- You don't have a backup AND the corrupt file is a canonical or artifact store (truth lost).

When escalating, attach:

- The full `db-cluster doctor --json` output.
- The first 200 bytes and the last 200 bytes of the corrupt file (do not paste the whole file — may contain redacted content).
- The complete error message and stack trace.
- The cluster's age (`stat .db-cluster/` first-create timestamp).
- The output of `db-cluster verify --json` if it completes.

## Related

- [orphan-mutations.md](orphan-mutations.md) — when corruption shows up as `mutation_orphaned` events.
- [index-stale.md](index-stale.md) — when corruption is index-only (use rebuild).
- `docs/operations.md` — backup/restore semantics + content-addressable artifact checksum.
- `docs/handbook.md` §9 — health model.
