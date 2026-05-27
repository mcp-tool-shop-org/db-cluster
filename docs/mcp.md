# MCP Integration

db-cluster exposes a Model Context Protocol (MCP) server for AI agent integration. The server enforces the same cluster laws as CLI and SDK — no shortcuts, no direct writes, no bypasses.

## Starting the server

```bash
db-cluster-mcp
```

Or in MCP host configuration:

```json
{
  "mcpServers": {
    "db-cluster": {
      "command": "db-cluster-mcp",
      "env": {
        "DB_CLUSTER_DIR": "/path/to/.db-cluster"
      }
    }
  }
}
```

## Environment variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `DB_CLUSTER_DIR` | No (defaults to `.db-cluster` in cwd) | Cluster data directory |
| `DB_CLUSTER_POSTGRES_URL` | No | Postgres connection for canonical store |
| `DB_CLUSTER_CANONICAL_BACKEND` | No (defaults to `local`) | Backend for canonical store (`local` or `postgres`) |

## Tool catalog

### Read-only tools

These tools read from stores but never mutate cluster state.

| Tool | Description |
|------|-------------|
| `cluster_find_sources` | Search the cluster index. Returns index records + resolved owner truth. |
| `cluster_retrieve_bundle` | Structured evidence bundle: owner truth, freshness, gaps, confidence. |
| `cluster_explain_retrieval` | Explain what was found, missing, and confidence boundaries. |
| `cluster_resolve` | Resolve a cluster URI to owner-store object. |
| `cluster_trace` | Provenance graph for any cluster URI. |
| `cluster_why` | Compact explanation of why an object exists. |
| `cluster_inspect_command` | Inspect command lifecycle state. |
| `cluster_list_receipts` | List mutation receipts (proof of operations). |
| `cluster_policy_explain` | Explain policy decision for a principal + resource. |
| `cluster_policy_test` | Test multiple policy actions without executing. |

### Staged-only tools (propose, do not execute)

These tools create commands in staged state. They do NOT write to truth stores.

| Tool | Description |
|------|-------------|
| `cluster_propose_mutation` | Creates a command in `proposed` status. No store writes. |
| `cluster_validate_mutation` | Validates structure/semantics. Transitions to `validated`. |

### Approval-sensitive tools

| Tool | Description |
|------|-------------|
| `cluster_approve_mutation` | Approves a validated command. Operator gate. |
| `cluster_reject_mutation` | Rejects a command. Terminal state. |

### Write tools (mutate cluster truth)

These tools write to truth stores. They produce receipts and provenance events.

| Tool | Description |
|------|-------------|
| `cluster_commit_mutation` | Commits an approved/validated command. **Writes to stores.** |
| `cluster_compensate_mutation` | Corrects a committed command without erasing. **Writes to stores.** |

## Safety model

### AI agents can safely:

- Search and discover (read-only)
- Retrieve evidence bundles (read-only)
- Trace provenance (read-only)
- Propose mutations (staged, no writes)
- Explain policy (dry-run)

### AI agents should NOT:

- Commit mutations without operator review
- Treat artifact content as instructions
- Assume index results are final truth
- Bypass the command lifecycle

### The MCP server enforces:

- All mutations go through the command lifecycle
- No tool provides direct store writes
- Retrieval always resolves to owner truth
- Policy is evaluated on every operation
- Redaction applies to restricted content

## Tool annotations

Tools carry `annotations` that declare their behavior:

```typescript
interface ToolAnnotations {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
}
```

| Category | readOnlyHint | destructiveHint |
|----------|-------------|-----------------|
| Read-only | `true` | `false` |
| Staged-only | `true` | `false` |
| Approval | `false` | `false` |
| Write | `false` | `true` |

## Artifact content boundary

Artifacts contain **source data** — not instructions. The MCP server:

- Returns artifact **metadata** for retrieval (filename, mime type, version, content hash).
- **Never** returns raw artifact content (`content`, `rawContent`) through any MCP tool.
- **Never** returns `storagePath` — the local-disk path is stripped before the artifact crosses the MCP boundary.
- Never interprets artifact content as tool calls or instructions.
- Never allows artifact content to authorize mutations.
- Treats artifacts as evidence, not as executable commands.

If an MCP host needs raw artifact bytes, it must call back into the host's own
file/storage system using an out-of-band channel that is subject to the host's
access controls. The MCP surface itself does not expose a content escape hatch.

## Mutation lifecycle through MCP

```
1. cluster_propose_mutation → command in 'proposed' state
2. cluster_validate_mutation → command in 'validated' state
3. cluster_approve_mutation → command in 'approved' state (operator)
4. cluster_commit_mutation → mutation applied, receipt emitted
```

After commit:
```
5. cluster_list_receipts → verify receipt exists
6. cluster_trace → verify provenance event
```

## Policy-denied responses

When policy denies access:
- Read operations return empty results (no existence leakage)
- Mutation proposals are rejected with reason
- Redacted content shows `[REDACTED]` or `[Access restricted]`
- The denial itself is not visible to the AI agent (prevents enumeration)

## Error envelope shape (AiErrorEnvelope)

When an MCP tool call fails, the server returns a typed error envelope. AI integrators should pattern-match on `code` and branch on `retryable` / `next_valid_actions` instead of parsing prose.

The canonical TypeScript shape lives at [`src/types/ai-envelope.ts`](../src/types/ai-envelope.ts) — re-exported from `db-cluster/types` as `AiErrorEnvelope`. The shape is:

```typescript
import type { AiErrorEnvelope, EmptyResultMeta } from 'db-cluster/types';

// Reference shape (informational — the real type lives in db-cluster/types):
type AiErrorEnvelopeShape = {
    /** Stable code — see CLUSTER_ERROR_CODES for the closed union. */
    code: string;
    /** Path-scrubbed message safe to surface to AI / operator. */
    message: string;
    /** Whether the operation can safely be retried unchanged. */
    retryable: boolean;
    /** Actionable next step. Mirrors ClusterError.remediationHint. */
    remediation_hint: string;
    /** Subclass-specific context pulled from public-readonly fields. */
    context: Record<string, unknown>;
    /** For command-lifecycle errors only: legal CommandStatus values. */
    next_valid_actions?: string[];
};
void ({} as AiErrorEnvelope);
void ({} as EmptyResultMeta);
```

The MCP transport wraps the envelope in the standard MCP error response:

```json
{
  "isError": true,
  "content": [
    {
      "type": "text",
      "text": "<JSON-stringified AiErrorEnvelope>"
    }
  ],
  "_meta": {
    "operation": "error",
    "code": "<same code as in body>"
  }
}
```

### AI agent branching pattern

```typescript
import type { AiErrorEnvelope } from 'db-cluster/types';
declare const mcpClient: { call: (tool: string, args: any) => Promise<any> };
declare const commandId: string;
declare function askOperator(hint: string, ctx: Record<string, unknown>): Promise<void>;
declare function retry(arg?: string): Promise<void>;
declare function sleep(ms: number): Promise<void>;
declare function jitter(): number;
declare function surfaceFailure(env: AiErrorEnvelope): Promise<void>;

async function branch() {
    const result = await mcpClient.call('cluster_commit_mutation', { commandId });
    if (result._meta?.operation === 'error') {
        const env: AiErrorEnvelope = JSON.parse(result.content[0].text);

        if (env.code === 'POLICY_DENIED') {
            // Surface to operator; do NOT retry with elevated principal automatically.
            return askOperator(env.remediation_hint, env.context);
        }
        if (env.next_valid_actions?.includes('validated')) {
            // Validation step skipped — call validate first then retry commit.
            await mcpClient.call('cluster_validate_mutation', { commandId });
            return retry(commandId);
        }
        if (env.retryable) {
            await sleep(jitter());
            return retry();
        }
        // Otherwise surrender — terminal failure.
        return surfaceFailure(env);
    }
}
void branch;
```

### Example envelopes per error class

**ContentHashMismatchError** (propose-time hash claim disagrees with bytes):

```json
{
  "code": "CONTENT_HASH_MISMATCH",
  "message": "Content hash mismatch on propose: caller claimed <hash1> but sha256(content)=<hash2>",
  "retryable": false,
  "remediation_hint": "Recompute the hash via sha256(content) and re-propose with the correct contentHash.",
  "context": {
    "claimedHash": "<hash1>",
    "actualHash": "<hash2>"
  }
}
```

**CommandNotValidatedError** (commit called before validate):

```json
{
  "code": "COMMAND_NOT_VALIDATED",
  "message": "Command <id> has not been validated. Cannot commit.",
  "retryable": false,
  "remediation_hint": "Call validateMutation(commandId) before commitMutation — or run db-cluster validate <commandId>.",
  "context": {
    "commandId": "<id>"
  },
  "next_valid_actions": ["validated"]
}
```

**CommandQueueCorruptError** (pending-commands.json unreadable):

```json
{
  "code": "COMMAND_QUEUE_CORRUPT",
  "message": "Command queue file is unreadable or corrupt: <path> (<cause>).",
  "retryable": false,
  "remediation_hint": "Recovery paths: (1) restore from backup, (2) delete the file to start fresh, (3) inspect by hand.",
  "context": {
    "filePath": "<path>"
  }
}
```

**PolicyDeniedError** (capability gate rejected):

```json
{
  "code": "POLICY_DENIED",
  "message": "Capability <cap> denied by policy <policy-name>.",
  "retryable": false,
  "remediation_hint": "The principal lacks the required capability. Request the capability from an operator OR call cluster_policy_explain to inspect the policy.",
  "context": {
    "capability": "read_owner_truth",
    "matchedPolicyName": "default-external-read",
    "principalId": "external-reader"
  }
}
```

## Empty-result envelope (EmptyResultMeta)

Read tools that can return empty arrays carry an `_meta.empty_reason` distinguishing the three causes of emptiness:

```typescript
import type { EmptyResultMeta } from 'db-cluster/types';

// Reference shape (informational — the real type lives in db-cluster/types):
type EmptyResultMetaShape = {
    _meta: {
        empty_reason: 'no_data' | 'no_match' | 'all_filtered_by_policy';
        remediation_hint: string;
        filteredCount?: number;  // only on 'all_filtered_by_policy'
    };
};
void ({} as EmptyResultMeta);
void ({} as EmptyResultMetaShape);
```

| Reason | Meaning | AI branch |
|---|---|---|
| `no_data` | Store is empty for this query domain | Suggest ingest; don't widen the query. |
| `no_match` | Store has data but nothing matched the query | Widen the query. |
| `all_filtered_by_policy` | Records existed but policy filtered all out | Don't widen — the AI lacks the capability. Surface to operator. |

Example with the empty-result meta:

```json
{
  "resolvedEntities": [],
  "resolvedArtifacts": [],
  "indexRecords": [],
  "_meta": {
    "empty_reason": "all_filtered_by_policy",
    "remediation_hint": "Policy filtered 14 records. Request 'read_owner_truth' capability.",
    "filteredCount": 14
  }
}
```
