# MCP Tool Catalog

Complete list of tools exposed by `db-cluster-mcp`.

## Read-only tools

| Tool | Parameters | Returns |
|------|-----------|---------|
| `cluster_find_sources` | `query: string`, `limit?: number` | Index records + resolved entities + artifacts |
| `cluster_retrieve_bundle` | `query: string`, `limit?: number` | Evidence bundle (owner truth, freshness, gaps, confidence) |
| `cluster_explain_retrieval` | `query: string`, `limit?: number` | Summary, resolved count, missing count, freshness |
| `cluster_resolve` | `uri: string` | Store name + owner-store object |
| `cluster_trace` | `uri: string`, `depth?: number` | Provenance graph (nodes + edges) |
| `cluster_why` | `uri: string` | Human-readable explanation string |
| `cluster_inspect_command` | `commandId: string` | Full command lifecycle state |
| `cluster_list_receipts` | `limit?: number`, `since?: string` | Array of mutation receipts |
| `cluster_list_entity_versions` | `id: string` | Array of entity versions (oldest-first, redacted per version) |
| `cluster_get_entity_version` | `id: string`, `version: number` | One entity version (redacted) or null |
| `cluster_list_commands` | `status?: string` | Array of commands (per-item gated + redacted) |
| `cluster_policy_explain` | `principal: Principal`, `resource?: string` | Policy decision explanation |
| `cluster_policy_test` | `principal: Principal`, `actions: Action[]` | Per-action decision results |

## Staged-only tools (no store writes)

| Tool | Parameters | Returns |
|------|-----------|---------|
| `cluster_propose_mutation` | `verb: string`, `targetStore: string`, `payload: object`, `proposedBy: string` | Command in `proposed` status |
| `cluster_validate_mutation` | `commandId: string` | Command in `validated` status |

## Approval-sensitive tools

| Tool | Parameters | Returns |
|------|-----------|---------|
| `cluster_approve_mutation` | `commandId: string`, `approvedBy: string`, `note?: string` | Command in `approved` status |
| `cluster_reject_mutation` | `commandId: string`, `rejectedBy: string`, `reason: string` | Command in `rejected` status |

## Write tools (mutate cluster truth)

| Tool | Parameters | Returns |
|------|-----------|---------|
| `cluster_commit_mutation` | `commandId: string`, `actorId: string` | Command + receipt |
| `cluster_compensate_mutation` | `commandId: string`, `compensatedBy: string`, `reason: string` | Compensating command + receipt |

## Annotations

Every tool carries behavioral annotations:

```json
{
  "readOnlyHint": true,
  "destructiveHint": false,
  "idempotentHint": true
}
```

| Category | readOnlyHint | destructiveHint | idempotentHint |
|----------|-------------|-----------------|----------------|
| Read-only | `true` | `false` | `true` |
| Staged-only | `true` | `false` | `true` |
| Approval | `false` | `false` | `true` |
| Write | `false` | `true` | `false` |

## Tool count

Total: **19 tools**

- 13 read-only
- 2 staged-only
- 2 approval-sensitive
- 2 write (cluster-mutating)
