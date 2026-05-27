# Example: Project Memory Cluster

A development team's project memory — meeting notes, decisions, repos, tasks — backed by a db-cluster substrate. The cluster proves: decisions trace back to source notes, every task update goes through the command lifecycle with a receipt, and backup/restore preserves the audit trail.

## What this demonstrates

- Ingesting source documents (meeting notes, API specs) as artifacts.
- Creating typed canonical entities (repo, decision, task) via the propose → validate → approve → commit lifecycle.
- Tracing a decision back to its source meeting note through the provenance graph.
- Updating a task status as a typed mutation — the original state survives in the ledger.
- Backup + restore round-trip with a doctor check on the restored cluster.

## Prerequisites

- Node.js 20+
- npm or pnpm
- `db-cluster` installed (`npm install db-cluster` or local `npm link`)

## Run

```bash
cd examples/project-memory-cluster
npx tsx index.ts
```

## Expected output

```
=== Project Memory Cluster ===

Docs ingested: <notesId> <specId>
Entities: <repoId> | <decisionId> | <taskId>

--- Trace decision provenance ---
Decision trace nodes: <N>

--- Command-gated mutation ---
Proposed: <commandId> → proposed
Committed: committed
Receipt: <receiptId> → affected: [<taskId>]

--- Receipts ---
Total receipts: <N>

--- Backup/Restore ---
Backup: entities: <N> artifacts: <N> events: <N>
Restored: entities: <created> events: <created>
Restored cluster health: healthy

Done.
```

## Variations to try

- Add a `link` provenance event between the decision entity and the source meeting note. Trace the decision and confirm the link appears in the graph.
- Tamper with the backup JSON (change a field on one entity, keep the id) and call `restore` — observe `ImportConflictError` instead of silent first-write-wins (closed in Wave B1, see CHANGELOG).
- Run `db-cluster doctor` on the restored cluster — should report `healthy` if backup + restore was clean.
- Inspect the receipt for the task update — it carries the original entity state in `affectedIds` and a link to the source command.

## Failure paths

| Class | Code | What it means |
|---|---|---|
| Already-terminal command | `COMMAND_ALREADY_TERMINAL` | Cannot re-validate / re-commit a committed command — propose a compensating mutation. |
| Import conflict | `IMPORT_CONFLICT` | Backup record id exists with different content; inspect both before retrying. |
| Provenance missing | `PROVENANCE_MISSING` | Subject has no lineage events; run `db-cluster verify` to confirm. |

## Next steps

- Read `docs/handbook.md` for the canonical operator + developer guide.
- Read `docs/operations.md` §backup / §restore for the format + safety contract.
- See `examples/research-evidence-cluster/` for a retrieval-focused example.
- See `examples/agent-safe-app-db/` for an AI-proposes / operator-commits split.
