---
title: Operations
description: doctor, verify, rebuild, backup, restore. Runbooks per typed-error class.
sidebar:
  order: 3
---

This page covers the operational surface — health checks, integrity proofs, rebuild from truth, and backup / restore. All operations are **read-only by default**; destructive operations gate behind `--yes` plus an interactive TTY confirmation.

## Health: `doctor`

```bash
npx db-cluster doctor [--json]
```

`doctor` performs a full reachability assessment across the four stores:

- Canonical store reachable, schema present.
- Artifact store directory writable, hash file readable.
- Index store reachable, count consistent.
- Ledger store reachable, last event timestamp readable.
- Postgres connection (if `DB_CLUSTER_POSTGRES_URL` set) — pool acquirable, migration status.
- Policy file loadable (if `DB_CLUSTER_POLICIES_FILE` set).

Output is a list of `HealthCheck` objects (`status` ∈ `healthy | degraded | unverified | missing | stale | unreachable | corrupt`), with the cluster-level worst-of severity ordering applied.

`doctor` never mutates state. It runs in seconds even on large clusters.

## Integrity: `verify`

```bash
npx db-cluster verify [--json] [--sample <N>]
```

`verify` proves data consistency invariants:

- **Index → source** — every index record points to a real canonical or artifact ID.
- **Provenance → subject** — every ledger event references a real subject.
- **Receipt → event** — every receipt chains to a real provenance event.

Mismatches are reported with the offending IDs and a remediation hint. `verify` is more expensive than `doctor` (full walks of the index + ledger). Use `--sample <N>` for a fast probe on very large clusters.

## Rebuild from truth: `rebuild index`

```bash
npx db-cluster rebuild index [--dry-run] [--yes]
```

Reconstructs the index store from canonical + artifact owner truth. The index is **derivative** — losing it loses no cluster state.

This is destructive (clears the existing index) and gates behind `--yes` + an interactive TTY confirmation. Pre-mutation snapshot is captured automatically; the undo hint points at the snapshot path.

The `IndexStore.replaceAll()` contract method makes the rebuild atomic — a crash mid-rebuild cannot leave the index empty.

## Detect stale records: `rebuild check`

```bash
npx db-cluster rebuild check [--json]
```

Detects:

- **Orphan index records** — index points to a canonical / artifact ID that no longer exists.
- **Missing index entries** — canonical / artifact rows that the index doesn't reflect.

Read-only. Pair with `rebuild index` to repair.

## Backup: `backup`

```bash
npx db-cluster backup [-o <file>] [--force-overwrite] [--yes]
```

Exports cluster state as portable JSON: entities, artifacts (content base64-encoded + SHA-256 checksum), events, receipts. Backup is **content-complete** — restore reconstructs the cluster including raw artifact bytes.

`--force-overwrite` (gated by `--yes`) replaces an existing backup file. Without it, `BackupTargetExistsError` is raised with a hint pointing to a freshly-timestamped filename.

## Restore: `restore`

```bash
npx db-cluster restore <file> [--yes]
```

Imports cluster state from a backup file. Restore is **additive** — duplicate restores don't corrupt state (`INSERT … ON CONFLICT` semantics on the Postgres adapter; idempotent `importSnapshot` / `importEvent` / `importReceipt` on local adapters).

Artifact content is verified against the recorded SHA-256 checksum before write. After import, the index is rebuilt; `restore` exits non-zero if the index rebuild propagates an error (the `RestoreResult.index` field surfaces the rebuild outcome).

## Compensate a committed mutation: `compensate`

```bash
npx db-cluster compensate <command-id> --reason "..." [--yes]
```

Compensation creates a **new** compensating command that reverses the effect of a committed one. The original receipt is preserved — nothing is erased; the audit trail shows both the original and the compensation.

You cannot compensate non-committed commands.

## Postgres status: `migration-status` / `verify-schema`

```bash
npx db-cluster migration-status [--json]
npx db-cluster verify-schema [--json]
```

`migration-status` reports whether the Postgres canonical schema is current. `verify-schema` validates column structure matches the contract. Both work against a live Postgres pool.

## Runbooks — one per typed-error class

The `docs/runbooks/` directory in the repo carries one runbook per recurring failure class. Each follows the same Symptom / Cause / Verify / Recover / Escalate shape:

- **corrupt-store** — `CommandQueueCorruptError`, `CorruptStoreError`. JSON parse failures, truncated writes.
- **orphan-mutations** — `mutation_orphaned` ledger events. Receipt-failed commands whose state needs reconciliation.
- **index-stale** — index records older than canonical / artifact truth. Use `rebuild check` then `rebuild index`.
- **postgres-unreachable** — pool connect failures. SSL config, network, credential checks.

Read these before paging anyone.

## Logging

Every CLI invocation supports:

- `--quiet` — suppress STDOUT non-error output entirely (errors still emit to STDERR).
- `--log-level <level>` — gate STDERR-bound info / warn / debug output. `'error'` is quietest, `'debug'` is noisiest. Default: `'info'`.
- `--no-color` — disable ANSI color codes (the `NO_COLOR` env var is also honoured per https://no-color.org).

For pipe-friendly output: `npx db-cluster doctor --json --quiet | jq` produces clean JSON with no stderr noise mixed in.

## Exit codes

`db-cluster` uses the sysexits.h convention. See [CLI Reference](../cli/) for the full table.
