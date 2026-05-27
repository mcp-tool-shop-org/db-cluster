# CLI Reference

Complete command reference for `db-cluster`.

## Cluster initialization

### `db-cluster init`

Initialize a new cluster in the current directory. Creates `.db-cluster/` with canonical, artifact, index, and ledger stores.

```bash
db-cluster init
```

## Artifact ingestion

### `db-cluster ingest <file>`

Ingest a source file into the artifact store. Creates an index record for discoverability.

```bash
db-cluster ingest ./research-paper.pdf
db-cluster ingest ./meeting-notes.md
```

The artifact store takes ownership. The file is immutable after ingestion.

## Entity management

### `db-cluster entity create`

Create a canonical entity.

```bash
db-cluster entity create --kind claim --name "LLMs need structured mutation boundaries" --attr '{"confidence":"high"}'
```

### `db-cluster entity list`

List entities with optional filters.

```bash
db-cluster entity list
db-cluster entity list --kind claim
db-cluster entity list --limit 10
```

## Linking

### `db-cluster link`

Link an artifact as evidence for an entity.

```bash
db-cluster link --entity-id <id> --artifact-id <id>
```

Creates a provenance event in the ledger. Neither store's truth is mutated.

## Discovery and retrieval

### `db-cluster find <query>`

Search the cluster index.

```bash
db-cluster find "database architecture"
db-cluster find "safety claims" --limit 5
```

### `db-cluster inspect <entity-id>`

Inspect a canonical entity. Returns owner truth, not index projection.

```bash
db-cluster inspect <entity-id>
```

### `db-cluster retrieve <query>`

Retrieve a structured evidence bundle.

```bash
db-cluster retrieve "LLM safety"
db-cluster retrieve "mutation boundaries" --limit 10
```

### `db-cluster explain-retrieval <query>`

Retrieve and explain — shows what was found, missing, and confidence.

```bash
db-cluster explain-retrieval "provenance model"
```

### `db-cluster resolve <uri>`

Resolve a cluster URI to its owner-store object.

```bash
db-cluster resolve cluster://canonical/<id>
db-cluster resolve cluster://artifact/<id>
```

## Provenance

### `db-cluster trace <uri>`

Trace provenance for any cluster URI.

```bash
db-cluster trace cluster://canonical/<id>
db-cluster trace cluster://artifact/<id> --depth 5
```

### `db-cluster why <uri>`

Compact explanation of why an object exists.

```bash
db-cluster why cluster://canonical/<id>
```

### `db-cluster lineage <uri>`

Full bidirectional lineage trace.

```bash
db-cluster lineage cluster://canonical/<id>
db-cluster lineage cluster://canonical/<id> --depth 10
```

### `db-cluster trace-bundle <query>`

Retrieve a bundle and trace its full provenance graph.

```bash
db-cluster trace-bundle "database claims"
```

## Mutation lifecycle

### `db-cluster propose <command-json>`

Propose a mutation. Does NOT write to stores.

```bash
db-cluster propose '{"verb":"update_entity","targetStore":"canonical","payload":{"entityId":"...","patch":{"name":"new"}},"proposedBy":"dev"}'
```

### `db-cluster validate <command-id>`

Validate a proposed command.

```bash
db-cluster validate <command-id>
```

### `db-cluster approve <command-id>`

Approve a validated command.

```bash
db-cluster approve <command-id> --by operator --note "Reviewed"
```

### `db-cluster reject <command-id>`

Reject a command.

```bash
db-cluster reject <command-id> --by operator --reason "Not needed"
```

### `db-cluster commit <command-id>`

Commit a mutation. **Writes to the target store.** Emits receipt and provenance event.

```bash
db-cluster commit <command-id>
```

### `db-cluster compensate <command-id>`

Compensate a committed command. Creates a correction without erasing.

```bash
db-cluster compensate <command-id> --by operator --reason "Name was wrong"
```

### `db-cluster inspect-command <command-id>`

Inspect full command lifecycle state.

```bash
db-cluster inspect-command <command-id>
```

### `db-cluster receipts`

List mutation receipts.

```bash
db-cluster receipts
db-cluster receipts --limit 5
db-cluster receipts --since 2026-05-01
```

## Policy

### `db-cluster policy explain`

Explain effective policy for a principal.

```bash
db-cluster policy explain --principal '{"id":"agent","name":"Agent","roles":["reader","proposer"],"trustZone":"agent"}' --resource 'cluster://canonical/entity-id'
```

### `db-cluster policy test`

Test policy actions.

```bash
db-cluster policy test --principal '{"id":"external","name":"External","roles":["reader"],"trustZone":"external"}' --capability read_owner_truth --store canonical
```

## Store management

### `db-cluster stores verify`

Verify store backend configuration and connectivity.

```bash
db-cluster stores verify
```

### `db-cluster stores migrate`

Run pending migrations for physical backends.

```bash
db-cluster stores migrate
```

### `db-cluster stores list`

List configured backends.

```bash
db-cluster stores list
```

## Operations

### `db-cluster doctor`

Full cluster health assessment.

```bash
db-cluster doctor
db-cluster doctor --json
```

### `db-cluster verify`

Verify cluster invariants (data consistency).

```bash
db-cluster verify
db-cluster verify --json --sample 200
```

### `db-cluster rebuild index`

Rebuild the index from canonical + artifact truth.

```bash
db-cluster rebuild index
db-cluster rebuild index --dry-run
db-cluster rebuild index --json
```

### `db-cluster rebuild check`

Check for stale or orphan index records.

```bash
db-cluster rebuild check
db-cluster rebuild check --json
```

### `db-cluster backup`

Export cluster state to JSON.

```bash
db-cluster backup
db-cluster backup -o ./cluster-backup.json
```

### `db-cluster restore <file>`

Restore cluster state from backup.

```bash
db-cluster restore ./cluster-backup.json
db-cluster restore ./cluster-backup.json --json
```

### `db-cluster migration-status`

Check Postgres schema migration state.

```bash
db-cluster migration-status
db-cluster migration-status --json
```

### `db-cluster verify-schema`

Validate physical backend schema structure.

```bash
db-cluster verify-schema
db-cluster verify-schema --json
```

## Shell completion

### `db-cluster completion <shell>`

Output a shell-completion script for `db-cluster`. Pipe through `source` (bash/zsh) or dot-source (pwsh) to install for the current shell.

```bash
# bash
source <(db-cluster completion bash)

# zsh
db-cluster completion zsh > "${fpath[1]}/_db-cluster"

# pwsh
db-cluster completion pwsh | Out-String | Invoke-Expression
```

Completion is generated by walking the registered command tree — adding a new subcommand auto-flows through.

## JSON output

Most operational commands support `--json` for structured output:

```bash
db-cluster doctor --json
db-cluster verify --json
db-cluster rebuild check --json
db-cluster backup
db-cluster migration-status --json
```

All JSON output is valid, parseable, and suitable for automation pipelines.

## Exit Codes

The CLI maps every typed error to a stable POSIX exit code (`<sysexits.h>`). Operator pipelines can branch on the exit code without parsing stderr.

| Code | Exit | sysexits | Description | Example trigger |
|---|---|---|---|---|
| `POLICY_DENIED` | `77` | `EX_NOPERM` | Capability gate rejected the action | `db-cluster propose --actor low-trust-actor mutation foo` |
| `CORRUPT_STORE` | `70` | `EX_SOFTWARE` | A store file failed JSON.parse / integrity check | `db-cluster doctor` against a tampered `entities.json` |
| `COMMAND_QUEUE_CORRUPT` | `70` | `EX_SOFTWARE` | `pending-commands.json` unreadable | `db-cluster validate <id>` after manual edit |
| `COMMAND_QUEUE_PERSISTENCE_LOST` | `70` | `EX_SOFTWARE` | Marker file present but queue file deleted | `db-cluster validate <id>` after partial restore |
| `RECEIPT_FAILED` | `70` | `EX_SOFTWARE` | Store mutated but receipt write failed | `db-cluster commit <id>` when ledger is full |
| `PROVENANCE_MISSING` | `70` | `EX_SOFTWARE` | Subject has no lineage events | `db-cluster trace <uri>` on a record without provenance |
| `CONTENT_HASH_MISMATCH` | `65` | `EX_DATAERR` | propose-time hash mismatch on `ingest_artifact` | `db-cluster propose '{"verb":"ingest_artifact","payload":{"contentHash":"deadbeef..","content":..}}'` |
| `INVALID_CONTENT_HASH` | `65` | `EX_DATAERR` | Hash isn't 64-char lowercase hex | `db-cluster ingest --hash bogus123` |
| `STAGED_CONTENT_TAMPERED` | `65` | `EX_DATAERR` | Staging file rewritten between propose and commit | `db-cluster commit <id>` after manual staging-dir edit |
| `INVALID_CONTENT_SHAPE` | `65` | `EX_DATAERR` | `payload.content` is JSON-roundtripped Buffer | propose with `content: {type:'Buffer', data:[...]}` |
| `IMPORT_CONFLICT` | `65` | `EX_DATAERR` | Restore record id matches but content differs | `db-cluster restore tampered-backup.json` |
| `LEDGER_CYCLE_DETECTED` | `65` | `EX_DATAERR` | parentEventId chain has a cycle | `db-cluster trace <uri>` over a corrupted ledger |
| `INVALID_POLICY_CONFIG` | `78` | `EX_CONFIG` | Policy YAML failed validation | `db-cluster --policy bad.yaml ...` |
| `INVALID_ROTATE_TIMESTAMP` | `78` | `EX_CONFIG` | `rotate(beforeTimestamp)` not ISO-8601 | `db-cluster ledger rotate "not-a-date"` |
| `ROTATE_BOUNDARY_IN_FUTURE` | `78` | `EX_CONFIG` | rotate boundary is in the future | `db-cluster ledger rotate 2099-01-01` |
| `NOT_FOUND` | `1` | (generic) | Object missing in named store | `db-cluster inspect bogus-id` |
| `RESOLVE_NOT_FOUND` | `1` | (generic) | URI cannot be resolved to owner truth | `db-cluster resolve cluster://canonical/bogus` |
| `INVALID_CLUSTER_URI` | `1` | (generic) | URI doesn't match `cluster://<store>/<id>` shape | `db-cluster resolve 'not a uri'` |
| `COMMAND_NOT_VALIDATED` | `1` | (generic) | Cannot commit an unvalidated command | `db-cluster commit <id>` before `validate <id>` |
| `COMMAND_NOT_FOUND` | `1` | (generic) | Command id missing from queue | `db-cluster validate bogus-id` |
| `COMMAND_REJECTED` | `1` | (generic) | Cannot operate on a rejected command | `db-cluster commit <id>` on a rejected command |
| `COMMAND_ALREADY_TERMINAL` | `1` | (generic) | Command in terminal status (committed/rejected/compensated) | `db-cluster approve <id>` on a committed command |
| `INVALID_STATE_TRANSITION` | `1` | (generic) | Transition not legal for current status | `db-cluster commit <id>` directly on a proposed command |
| `INVALID_REDACTION_RULE` | `78` | `EX_CONFIG` | Redaction rule failed schema validation | malformed `redactionRules` in policy YAML |
| `BUFFER_SIDE_CHANNEL_NOT_SUPPORTED` | `1` | (generic) | Adapter can't stage Buffer payloads | (reserved for v0.2 remote adapters) |
| (anything else / unhandled) | `1` | (generic) | Generic failure — inspect stderr | crash without a typed error |

### Branching on exit codes

```bash
# Example: retry on transient, escalate on data error, surrender on permission.
db-cluster commit "$ID"
case $? in
  0) echo "committed" ;;
  65) echo "DATA INTEGRITY FAILURE — see stderr; do NOT retry"; exit 65 ;;
  70) echo "INTERNAL — restore from backup; see docs/runbooks/"; exit 70 ;;
  77) echo "PERMISSION DENIED — request capability; do NOT widen automatically"; exit 77 ;;
  78) echo "CONFIG ERROR — fix policy / args"; exit 78 ;;
  *)  echo "unhandled — investigate"; exit 1 ;;
esac
```

For the typed-error → runbook map and recovery procedures, see [`docs/runbooks/README.md`](runbooks/README.md).
