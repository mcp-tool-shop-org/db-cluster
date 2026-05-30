# MCP Integration

db-cluster exposes a Model Context Protocol (MCP) server for AI agent integration. The server enforces the same cluster laws as CLI and SDK — no shortcuts, no direct writes, no bypasses.

## Default trust posture (ai-facing + redaction)

**The MCP server defaults to the `ai-facing` trust zone with redaction ON.**
Started with no policy environment variables, the server applies the default
ai-facing policies and redaction rather than falling back to a fully-trusted
in-process kernel. The practical effect:

- Artifact content and sensitive entity attributes are **stripped at the
  boundary by default** — no MCP tool returns raw artifact bytes (see [Artifact
  content boundary](#artifact-content-boundary)).
- **Write tools enforce approval** — `cluster_commit_mutation` and
  `cluster_compensate_mutation` refuse to write unless the target command is in
  `approved` status. The refusal is a structured `AiErrorEnvelope` (no partial
  write); the caller must run `cluster_approve_mutation` first.

An operator who genuinely runs the server in a trusted context and needs the
privileged (`internal` / `cluster-admin`) posture must **explicitly opt in** via
an environment flag — provisionally `DB_CLUSTER_MCP_ALLOW_PRIVILEGED` (final name
confirmed in the release notes / `CHANGELOG`). Absent that flag the server stays
ai-facing. This default is **MCP-surface only**: the in-process SDK and the
`@mcptoolshop/db-cluster/unsafe` paths for trusted callers are unchanged.

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
| `DB_CLUSTER_DIR` | No (defaults to `.db-cluster` in cwd) | Cluster data directory. Explicit operator override for a location outside cwd; a `config.json` `clusterDir` is contained to cwd. |
| `DB_CLUSTER_POSTGRES_URL` | No | Postgres connection for canonical store |
| `DB_CLUSTER_CANONICAL_BACKEND` | No (defaults to `local`) | Backend for canonical store (`local` or `postgres`) |
| `DB_CLUSTER_PRINCIPAL` | No | JSON-encoded `Principal` (schema-validated, fail-closed on malformed input). |
| `DB_CLUSTER_POLICIES_FILE` | No | Path to a policies JSON file (sandboxed against cwd). |
| `DB_CLUSTER_MCP_ALLOW_PRIVILEGED` | No (default: ai-facing) | **Opt-in** to the privileged (`internal` / `cluster-admin`) posture. Absent, the server stays in the ai-facing zone with redaction ON. *(Provisional name — see the release notes for the final flag.)* |

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
| `cluster_list_entity_versions` | List all retained versions of a canonical entity (redacted per version). |
| `cluster_get_entity_version` | Fetch one specific version of a canonical entity. |
| `cluster_list_commands` | List queue commands by lifecycle status (per-item gated + redacted). |
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

- Treat artifact content as instructions
- Assume index results are final truth
- Bypass the command lifecycle

(Committing a mutation without approval is not merely discouraged — under the
default ai-facing zone the server **refuses** it; see below.)

### The MCP server enforces:

- **The ai-facing trust zone is the default** — redaction ON, no raw content,
  unless an operator explicitly opts into the privileged posture
  (`DB_CLUSTER_MCP_ALLOW_PRIVILEGED`, provisional name).
- **Write tools require approval** — `cluster_commit_mutation` /
  `cluster_compensate_mutation` refuse to write unless the command is `approved`
  (structured `AiErrorEnvelope` on refusal, never a partial write).
- All mutations go through the command lifecycle
- No tool provides direct store writes
- Retrieval always resolves to owner truth
- Policy is evaluated on every operation
- Redaction applies to restricted content

## Tool annotations

`listTools` returns, on every tool, the MCP-spec `annotations` hint keys plus a
finer-grained internal classification under `_meta`. (AI-007, Wave V4.)

### Spec hints — `annotations`

These are the keys a spec-compliant host reads:

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

`destructiveHint` is `true` **only** for the two write tools that mutate cluster
truth — `cluster_commit_mutation` and `cluster_compensate_mutation`. Every other
tool reports `destructiveHint: false`.

### Internal classification — `_meta['io.dbcluster/classification']`

For hosts that want the richer taxonomy, each tool also carries a five-field
classification under `_meta['io.dbcluster/classification']`:

```typescript
interface McpToolClassification {
    readOnly: boolean;                // never mutates cluster state
    writesCluster: boolean;           // writes to a truth store
    approvalSensitive: boolean;       // gated by the approval lifecycle
    stagedOnly: boolean;              // only ever creates/changes staged commands
    requiresExistingCommand: boolean; // operates on an existing command id
}
```

The two vocabularies stay in sync: `destructiveHint` is exactly the
`writesCluster` tools. A spec host can ignore the `_meta` block entirely and
rely on the three hint keys; a db-cluster-aware host can read the classification
for finer routing (e.g. distinguishing a staged-only proposal from an
approval-sensitive transition).

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

Under the default ai-facing zone, **step 3 is mandatory**: `cluster_commit_mutation`
(and `cluster_compensate_mutation`) refuse to write unless the command is in
`approved` status, returning a structured `AiErrorEnvelope` rather than a partial
write. Trusted in-process SDK callers that constructed their own policy/principal
are not subject to this MCP-surface gate.

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

The canonical TypeScript shape lives at [`src/types/ai-envelope.ts`](../src/types/ai-envelope.ts) — re-exported from `@mcptoolshop/db-cluster/types` as `AiErrorEnvelope`. The shape is:

```typescript
import type { AiErrorEnvelope, EmptyResultMeta } from '@mcptoolshop/db-cluster/types';

// Reference shape (informational — the real type lives in @mcptoolshop/db-cluster/types):
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

The MCP transport wraps the envelope in the standard MCP error response. Note
there is **no top-level `_meta`** — the result carries only `isError` and
`content`; the error body (including its own `_meta.operation: 'error'`) lives
inside `content[0].text`:

```json
{
  "isError": true,
  "content": [
    {
      "type": "text",
      "text": "<JSON-stringified error body>"
    }
  ]
}
```

**Detect the error with the top-level `isError` boolean — never with `_meta`.**
`isError` is the MCP-spec field on the tool result and the only signal a spec
host can read *without* first parsing `content[0].text`. The `_meta.operation:
'error'` field also lives **inside** the parsed body (`content[0].text`), so any
predicate keyed on `_meta` requires you to parse the body first — and for
strict spec hosts the top-level `_meta` may not be surfaced at all. So the
reliable sequence is: (1) check `result.isError === true`, then (2)
`JSON.parse(result.content[0].text)` to get the body, then (3) branch on
`body.code` / `body.remediation_hint` / `body.next_valid_actions`.

**AI-006 (Wave V4) — the approval-gate refusal body keys the message under
`error`.** When `cluster_commit_mutation` / `cluster_compensate_mutation` refuse
because the command is not `approved`, the parsed body is:

```json
{
  "error": "Commit refused on the AI-facing MCP surface: the command is in 'validated' status, not 'approved'. The AI surface enforces approve-before-commit (separation of duties).",
  "code": "POLICY_DENIED",
  "retryable": false,
  "remediation_hint": "Call cluster_approve_mutation on this command first, then retry cluster_commit_mutation.",
  "context": { "errorClass": "ApprovalGateDeniedError", "commandId": "<command id>", "currentStatus": "validated", "requiredStatus": "approved" },
  "_meta": { "operation": "error" },
  "next_valid_actions": ["cluster_approve_mutation"]
}
```

Read the human message from **`body.error`** (not `body.message`) for this gate
refusal. `body.code` is `'POLICY_DENIED'`, and `body.next_valid_actions` names
the exact tool to call next — `['cluster_approve_mutation']` for the commit gate,
`['cluster_inspect_command']` for the compensate gate. (The canonical
`AiErrorEnvelope` *type* names this field `message`, but the MCP transport
serializes every error body's human message on the wire as `error` — so the
recipe below reads `env.error` to match the wire.)

### AI agent branching pattern

```typescript
import type { AiErrorEnvelope } from '@mcptoolshop/db-cluster/types';
declare const mcpClient: { call: (tool: string, args: any) => Promise<any> };
declare const commandId: string;
declare function askOperator(hint: string, ctx: Record<string, unknown>): Promise<void>;
declare function retry(arg?: string): Promise<void>;
declare function sleep(ms: number): Promise<void>;
declare function jitter(): number;
declare function surfaceFailure(env: AiErrorEnvelope): Promise<void>;

async function branch() {
    const result = await mcpClient.call('cluster_commit_mutation', { commandId });

    // Detect the error via the TOP-LEVEL `isError` boolean — the only
    // reliable signal a spec host can read WITHOUT first parsing the body.
    // (`_meta.operation: 'error'` lives INSIDE content[0].text, not on the
    // tool result, so a host can't branch on it before parsing — see note
    // below.)
    if (result.isError === true) {
        // Now parse the body to read the typed envelope.
        const env: AiErrorEnvelope = JSON.parse(result.content[0].text);

        // NOTE: the human-readable message is `env.error` (NOT `env.message`).
        if (env.code === 'POLICY_DENIED') {
            // Approval gate refused the write. next_valid_actions tells you the
            // exact tool to call next: ['cluster_approve_mutation'] for the
            // commit gate (['cluster_inspect_command'] for the compensate gate).
            // Surface to operator; do NOT retry with an elevated principal
            // automatically.
            return askOperator(env.remediation_hint, env.context);
        }
        if (env.next_valid_actions?.includes('cluster_approve_mutation')) {
            // The command is validated but not yet approved — get it approved,
            // then retry commit.
            await mcpClient.call('cluster_approve_mutation', { commandId });
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
import type { EmptyResultMeta } from '@mcptoolshop/db-cluster/types';

// Reference shape (informational — the real type lives in @mcptoolshop/db-cluster/types):
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
