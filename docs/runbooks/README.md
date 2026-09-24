# Operator Runbooks

One runbook per failure class. Each runbook follows the same shape:

- **Symptom** — what the operator observes (doctor output, error message, behavior)
- **Cause** — what the failure means at the cluster level
- **Verify** — commands to confirm the diagnosis
- **Recover** — step-by-step recovery
- **Escalate** — when to bail / contact support

## Runbook index

| Runbook | When to use |
|---|---|
| [corrupt-store.md](corrupt-store.md) | A store file fails JSON.parse or integrity check (`CorruptStoreError`, `CommandQueueCorruptError`) |
| [orphan-mutations.md](orphan-mutations.md) | `mutation_orphaned` events in the ledger or `doctor()` flagging orphan count (`ReceiptFailedError`) |
| [index-stale.md](index-stale.md) | Stale-records reported by `rebuild check` / `verify`; missing or out-of-date index entries |
| [postgres-unreachable.md](postgres-unreachable.md) | Postgres adapter degraded mode; connection drops; migration drift |

## Typed-error → runbook matrix

Every typed-error class in the kernel + adapter hierarchy maps to a runbook (or a remediationHint on the error itself when the action is one command). The error's `remediationHint` is the one-line summary; the runbook is the full procedure.

| Error class | Code | Runbook |
|---|---|---|
| `CorruptStoreError` | `CORRUPT_STORE` | [corrupt-store.md](corrupt-store.md) |
| `CommandQueueCorruptError` | `COMMAND_QUEUE_CORRUPT` | [corrupt-store.md](corrupt-store.md) (Command queue section) |
| `CommandQueuePersistenceLostError` | `COMMAND_QUEUE_PERSISTENCE_LOST` | [corrupt-store.md](corrupt-store.md) (Command queue section) |
| `ReceiptFailedError` | `RECEIPT_FAILED` | [orphan-mutations.md](orphan-mutations.md) |
| `LedgerCycleDetectedError` | `LEDGER_CYCLE_DETECTED` | [corrupt-store.md](corrupt-store.md) (Ledger section) |
| `InvalidContentHashError` | `INVALID_CONTENT_HASH` | inline — recompute the hash and re-propose |
| `ContentHashMismatchError` | `CONTENT_HASH_MISMATCH` | inline — recompute the hash and re-propose |
| `StagedContentTamperedError` | `STAGED_CONTENT_TAMPERED` | inline — investigate, do NOT retry without inspection |
| `ImportConflictError` | `IMPORT_CONFLICT` | inline — inspect both records before retrying |
| `ImportSnapshotNotSupportedError` | `IMPORT_SNAPSHOT_NOT_SUPPORTED` | inline — adapter doesn't support restore |
| `NotFoundError` | `NOT_FOUND` | inline — verify id, run `db-cluster find` |
| `ProvenanceMissingError` | `PROVENANCE_MISSING` | inline — run `db-cluster verify` |
| `CommandNotValidatedError` | `COMMAND_NOT_VALIDATED` | inline — call `validateMutation` first |
| `CommandNotFoundError` | `COMMAND_NOT_FOUND` | inline — re-propose |
| `CommandRejectedError` | `COMMAND_REJECTED` | inline — terminal; propose fresh |
| `CommandAlreadyTerminalError` | `COMMAND_ALREADY_TERMINAL` | inline — propose fresh or compensate |
| `InvalidStateTransitionError` | `INVALID_STATE_TRANSITION` | inline — call `validTransitions(from)` |
| `PolicyConfigError` | `INVALID_POLICY_CONFIG` | inline — fix the YAML/JSON; CLI exit 78 |
| `InvalidRotateTimestampError` | `INVALID_ROTATE_TIMESTAMP` | inline — pass an ISO-8601 string |
| `RotateBoundaryInFutureError` | `ROTATE_BOUNDARY_IN_FUTURE` | inline — use a past or current boundary |
| `BufferSideChannelNotSupportedError` | `BUFFER_SIDE_CHANNEL_NOT_SUPPORTED` | inline — use a local-adapter cluster |
| `InvalidContentShapeError` | `INVALID_CONTENT_SHAPE` | inline — pass a real Buffer or contentHash string |
| `InvalidActorError` | `INVALID_ACTOR` | inline — name the actor: pass its id as a non-empty string |
| `PolicyDeniedError` | `POLICY_DENIED` | inline — request the named capability; CLI exit 77 |
| `InvalidBackendConfigError` | `INVALID_BACKEND_CONFIG` | inline — set `DB_CLUSTER_CANONICAL_BACKEND` to local, postgres or sqlite (and `DB_CLUSTER_POSTGRES_URL` for postgres); CLI exit 78 |
| `ClusterUriError` | `INVALID_CLUSTER_URI` | inline — check the URI shape `cluster://<store>/<id>` and the store name; CLI exit 65 |
| `ResolveError` | `RESOLVE_NOT_FOUND` | inline — verify URI; the record may have been compensated; CLI exit 1 |
| `CommandValidationFailedError` | `COMMAND_VALIDATION_FAILED` | inline — inspect `result.checks[]` and re-propose with corrected payload |
| `BackupTargetExistsError` | `BACKUP_TARGET_EXISTS` | inline — pass `--force` or choose a different output path; CLI exit 73 |
| Postgres unreachable | (no error code — surfaced via `doctor()`) | [postgres-unreachable.md](postgres-unreachable.md) |
| Stale / orphan index records | (no error class — surfaced via `rebuild check`) | [index-stale.md](index-stale.md) |

## CLI exit-code mapping

When the CLI surfaces a typed error, it maps to a stable POSIX exit code:

| Exit | sysexits | Used for |
|---|---|---|
| `65` | `EX_DATAERR` | Bad input data (`CONTENT_HASH_MISMATCH`, `INVALID_CONTENT_HASH`, `STAGED_CONTENT_TAMPERED`, `INVALID_CONTENT_SHAPE`, `IMPORT_CONFLICT`, `INVALID_ACTOR`, `INVALID_CLUSTER_URI`, `IMPORT_SNAPSHOT_NOT_SUPPORTED`, `COMMAND_VALIDATION_FAILED`) |
| `70` | `EX_SOFTWARE` | Internal failure (`CORRUPT_STORE`, `COMMAND_QUEUE_CORRUPT`, `COMMAND_QUEUE_PERSISTENCE_LOST`, `RECEIPT_FAILED`, `LEDGER_CYCLE_DETECTED`, `BUFFER_SIDE_CHANNEL_NOT_SUPPORTED`) |
| `73` | `EX_CANTCREAT` | Output file already exists (`BACKUP_TARGET_EXISTS`) |
| `77` | `EX_NOPERM` | Permission denied (`POLICY_DENIED`) |
| `78` | `EX_CONFIG` | Configuration error (`INVALID_POLICY_CONFIG`, `INVALID_REDACTION_RULE`, `INVALID_ROTATE_TIMESTAMP`, `ROTATE_BOUNDARY_IN_FUTURE`, `INVALID_BACKEND_CONFIG`) |
| `1` | (generic) | Not-found and lifecycle guards (`NOT_FOUND`, `PROVENANCE_MISSING`, `RESOLVE_NOT_FOUND`, `COMMAND_NOT_VALIDATED`, `COMMAND_REJECTED`, `COMMAND_NOT_FOUND`, `COMMAND_ALREADY_TERMINAL`, `INVALID_STATE_TRANSITION`), and anything else, including unhandled `Error`. Investigate via stderr. |

See [`docs/cli.md`](../cli.md) "Exit Codes" for the full table with example triggers.
