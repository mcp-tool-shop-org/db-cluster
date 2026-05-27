---
title: CLI Reference
description: Full command list, exit-code table, --quiet / --log-level / --no-color.
sidebar:
  order: 7
---

The `db-cluster` CLI is the operator surface. Every command is documented via `--help`; this page is the high-level map.

## Command groups

```bash
# Cluster lifecycle
db-cluster init                          # initialize .db-cluster/
db-cluster doctor [--json]               # health assessment
db-cluster verify [--json] [--sample N]  # data integrity proofs

# Artifact / entity primitives
db-cluster ingest <path>                                     # ingest an artifact
db-cluster entity create --kind <K> --name <N> [--attr <J>]  # create an entity
db-cluster link --entity-id <E> --artifact-id <A>            # link evidence

# Discovery / retrieval
db-cluster find <query>                  # candidate index records
db-cluster inspect <id>                  # entity / artifact / receipt details
db-cluster retrieve <query>              # evidence bundle with confidence
db-cluster explain-retrieval <query>     # what the bundle can / cannot claim
db-cluster resolve <uri>                 # owner truth from any cluster:// URI

# Provenance
db-cluster trace <uri> [--direction] [--depth] [--graph]
db-cluster why <uri>
db-cluster lineage <uri>                 # bidirectional full trace
db-cluster trace-bundle <query>          # retrieve + trace
db-cluster explain-index <record-id>     # why this index record exists

# Mutation lifecycle
db-cluster propose <command-json>
db-cluster validate <command-id>
db-cluster approve <command-id> [--note]
db-cluster reject <command-id> --reason
db-cluster commit <command-id>
db-cluster compensate <command-id> --reason
db-cluster inspect-command <command-id>
db-cluster receipts [--limit N]

# Index maintenance
db-cluster index rebuild [--dry-run] [--yes]
db-cluster index status [--json]
db-cluster index stale
db-cluster index explain <record-id>

# Backup / restore
db-cluster backup [-o <file>] [--force-overwrite] [--yes]
db-cluster restore <file> [--yes]

# Policy
db-cluster policy explain --principal <json>
db-cluster policy test --principal <json> --verb <V> --resource <uri>

# Postgres canonical store
db-cluster stores verify
db-cluster stores migrate
db-cluster stores list
db-cluster migration-status [--json]
db-cluster verify-schema [--json]

# Help meta
db-cluster --help                        # top-level
db-cluster <cmd> --help                  # per-command
db-cluster --help-exit-codes             # the exit-code table
```

## Global flags

| Flag | Effect |
|------|--------|
| `--actor <id>` | Operator identity for this invocation (overrides `DB_CLUSTER_OPERATOR` / OS user). |
| `--quiet` | Suppress STDOUT non-error output entirely. Errors still emit to STDERR. |
| `--log-level <level>` | `debug` / `info` / `warn` / `error`. Default: `info`. |
| `--no-color` | Disable ANSI color codes. `NO_COLOR` env var also honoured (https://no-color.org). |
| `--debug` | (env: `DEBUG=1`) — surface raw stack traces on STDERR. |

## Exit codes

db-cluster uses the **sysexits.h** convention. Codes are **stable across versions** — CI scripts can branch on them safely.

| Exit | Sysexits | Typed-error codes mapped here |
|-----:|----------|-------------------------------|
| 0 | EX_OK | success |
| 1 | (general) | `NOT_FOUND`, `PROVENANCE_MISSING`, `COMMAND_NOT_VALIDATED`, `COMMAND_REJECTED`, usage error |
| 65 | EX_DATAERR | `CONTENT_HASH_MISMATCH`, `INVALID_CONTENT_HASH`, `STAGED_CONTENT_TAMPERED`, `IMPORT_CONFLICT`, `INVALID_CONTENT_SHAPE` |
| 70 | EX_SOFTWARE | `CORRUPT_STORE`, `COMMAND_QUEUE_CORRUPT`, `COMMAND_QUEUE_PERSISTENCE_LOST`, `LEDGER_CYCLE_DETECTED`, `RECEIPT_FAILED`, `BUFFER_SIDE_CHANNEL_NOT_SUPPORTED` |
| 77 | EX_NOPERM | `POLICY_DENIED` |
| 78 | EX_CONFIG | `INVALID_POLICY_CONFIG`, `INVALID_REDACTION_RULE`, `INVALID_ROTATE_TIMESTAMP`, `ROTATE_BOUNDARY_IN_FUTURE` |

Run `db-cluster --help-exit-codes` to print the current table from the live CLI.

### Branching example

```bash
if ! db-cluster verify --json > /tmp/verify.json; then
    case $? in
        65) echo "Data integrity issue — see /tmp/verify.json" ;;
        70) echo "Cluster corruption — run doctor + rebuild index" ;;
        77) echo "Policy denied — check DB_CLUSTER_PRINCIPAL" ;;
        78) echo "Config error — check policies file" ;;
        *)  echo "General failure — exit code $?" ;;
    esac
    exit 1
fi
```

## Output discipline

CLI output is **uniformly colored** when running on a TTY without `--no-color`:

- **Errors** (red) — `Error: <message>` prefix on every cliCommand catch arm.
- **Hints** (dim italic) — the `→ try: <remediation>` line that follows every typed error.
- **Success** (green) — `Cluster initialized`, `Ingested`, `Created entity`, `Linked`, `Committed`.
- **Headers** (bold cyan) — entity inspection headlines, doctor / verify section markers.

When piped (`db-cluster doctor --json | jq`), or when `--no-color` is set, or when `NO_COLOR` is in env, no ANSI bytes are emitted.

## Environment variables

| Variable | Effect |
|----------|--------|
| `DB_CLUSTER_DIR` | Override the default `.db-cluster/` location. |
| `DB_CLUSTER_PRINCIPAL` | JSON principal identity (schema-validated, fail-closed). |
| `DB_CLUSTER_POLICIES_FILE` | Path to a policies JSON file (path-sandboxed against cwd). |
| `DB_CLUSTER_OPERATOR` | Operator name for the actor field (used when `--actor` not passed). |
| `DB_CLUSTER_POSTGRES_URL` | Postgres connection string for the canonical store backend. |
| `DB_CLUSTER_POSTGRES_SSL` | `true` to require SSL on the Postgres connection. |
| `NO_COLOR` | Any non-empty value disables ANSI color (https://no-color.org). |
| `DEBUG` | `1` enables raw stack traces on STDERR. |

## See also

- [Getting Started](../getting-started/) — the 5-minute golden path.
- [Operations](../operations/) — doctor, verify, rebuild, backup, restore in depth.
- [SDK Reference](../sdk/) — the programmatic equivalent.
