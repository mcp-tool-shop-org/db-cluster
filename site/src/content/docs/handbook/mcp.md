---
title: MCP Integration
description: 16 tools with safety annotations. AiErrorEnvelope shape. The AI-agent guide.
sidebar:
  order: 5
---

db-cluster ships an MCP server (`db-cluster-mcp`) that exposes 16 typed tools to AI agents over stdio. Every tool carries safety annotations the model can branch on; every error response is a structured `AiErrorEnvelope`.

## Quick wire-up

```json
// .mcp.json
{
  "mcpServers": {
    "db-cluster": {
      "command": "npx",
      "args": ["db-cluster-mcp"],
      "env": {
        "DB_CLUSTER_DIR": "/path/to/.db-cluster",
        "DB_CLUSTER_PRINCIPAL": "{\"id\":\"agent-1\",\"name\":\"Agent\",\"roles\":[\"agent\"],\"trustZone\":\"external-readonly\"}"
      }
    }
  }
}
```

The server is launched on demand; it terminates when the MCP host disconnects.

## Tool catalog (16 tools)

| Tool | Verb | `readOnlyHint` | `destructiveHint` | `requiresApprovalHint` |
|------|------|----------------|-------------------|------------------------|
| `cluster_find_sources` | discover | ✓ | | |
| `cluster_retrieve_bundle` | retrieve | ✓ | | |
| `cluster_explain_retrieval` | explain | ✓ | | |
| `cluster_resolve` | resolve URI | ✓ | | |
| `cluster_trace` | trace provenance | ✓ | | |
| `cluster_why` | explain provenance | ✓ | | |
| `cluster_inspect_command` | inspect | ✓ | | |
| `cluster_list_receipts` | list | ✓ | | |
| `cluster_policy_explain` | policy view | ✓ | | |
| `cluster_policy_test` | policy probe | ✓ | | |
| `cluster_propose_mutation` | stage | | | ✓ |
| `cluster_validate_mutation` | stage | | | ✓ |
| `cluster_approve_mutation` | stage | | | ✓ |
| `cluster_reject_mutation` | stage | | | ✓ |
| `cluster_commit_mutation` | commit | | ✓ | ✓ |
| `cluster_compensate_mutation` | compensate | | ✓ | ✓ |

`readOnlyHint: true` — tool never writes any cluster state. AI hosts can safely batch these.

`destructiveHint: true` — tool writes truth that produces ledger receipts. Pair with operator approval.

`requiresApprovalHint: true` — tool requires explicit human-in-the-loop approval per the mutation lifecycle. AI hosts should surface to the operator before invocation.

## AiErrorEnvelope shape

Every error result from any tool is shaped:

```ts
interface AiErrorEnvelope {
    code: string;                  // stable ClusterErrorCode, e.g. 'POLICY_DENIED', 'COMMAND_QUEUE_CORRUPT'
    message: string;               // human-readable, sanitized (no paths, no stack)
    retryable: boolean;            // is retry meaningful?
    remediation_hint: string;      // WHAT TO DO next, in one short sentence
    context: Record<string, unknown>;  // subclass-specific structured fields (entityId, store, capability, …)
    next_valid_actions?: string[]; // optional — for lifecycle errors, which verbs are valid next?
}
```

**Branch on `code` and `retryable`** — never parse the prose message. Stack traces are never exposed. The `_contentPolicy` marker on retrieve_bundle responses states that artifact content is **data**, not instructions, even when present in the bundle.

### Example error pattern-match

```ts
const result = await mcp.callTool('cluster_commit_mutation', { commandId: '...' });
if (result.body.code === 'COMMAND_NOT_VALIDATED') {
    // Run validation first.
    await mcp.callTool('cluster_validate_mutation', { commandId: '...' });
} else if (result.body.code === 'POLICY_DENIED' && !result.body.retryable) {
    // No retry — escalate to the operator.
} else if (result.body.retryable) {
    await sleep(backoff()); 
    // retry
}
```

## Output discipline

The MCP boundary applies four guarantees:

1. **Artifact content is sanitized** — `_contentAccess: 'sanitized'`. The raw artifact bytes are stripped from retrieve_bundle output. The `_contentPolicy` marker reminds consumers that any content that does pass through is data, not instructions.

2. **Stack traces are scrubbed** — `src/mcp/sanitize.ts::redactError` strips paths, environment values, and stack details before surfacing.

3. **Empty results carry `empty_reason`** — when a query returns nothing, `_meta.empty_reason` explains why (`all_filtered_by_policy`, `no_index_match`, `staleness_threshold_exceeded`, etc.), with a remediation_hint where applicable.

4. **Lifecycle responses carry `next_valid_actions`** — for any command-lifecycle response (`propose`, `validate`, `approve`, `commit`, `reject`, `compensate`), the response surfaces which verbs are valid as the next step.

## Tracked residuals (v1.x)

- `V2-C1-009` — long-running ops (doctor / verify / rebuild / backup / restore) surface as **single-shot** MCP tools, not streaming. Granular progress is documented but not on the v1.0.0 wire.

## See also

- [Policy & Redaction](../policy-and-redaction/) — what gets denied, and what gets redacted.
- [SDK Reference](../sdk/) — the SDK is the in-process equivalent of the MCP surface.
- The `examples/mcp/` directory in the repo has tool-by-tool example wire-ups.
