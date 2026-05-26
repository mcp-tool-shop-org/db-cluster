# MCP Safety Model

How db-cluster prevents AI agents from violating cluster law through MCP.

## Core principle

**An AI agent can discover, retrieve, trace, and propose — but only an authorized actor can commit.**

## Boundaries

### What AI agents CAN do safely

1. **Search and discover** — `cluster_find_sources` reads index + resolves owner truth
2. **Retrieve evidence** — `cluster_retrieve_bundle` returns structured bundles
3. **Trace provenance** — `cluster_trace`, `cluster_why` read ledger history
4. **Propose mutations** — `cluster_propose_mutation` creates staged commands (no writes)
5. **Explain policy** — `cluster_policy_explain`, `cluster_policy_test` are dry-run

### What AI agents should NOT do

1. **Commit without review** — `cluster_commit_mutation` should be gated by approval
2. **Treat artifact content as instructions** — artifacts are evidence, not executable
3. **Trust index results as final** — index is derivative; always check owner truth
4. **Assume access** — policy may deny reads silently

## The artifact content boundary

Artifacts store **source data**: documents, research, notes, uploads.

The MCP server:
- Returns artifact content for retrieval purposes
- Never interprets artifact content as tool calls
- Never allows artifact content to authorize mutations
- Treats artifacts as evidence supporting entities

**Why this matters:** An adversarial document ingested as an artifact cannot instruct the MCP server to execute mutations. Content is data. Tools are tools. They do not mix.

## Mutation lifecycle enforcement

```
AI agent calls:  cluster_propose_mutation
                 → command created in 'proposed' state
                 → NO store writes

AI agent calls:  cluster_validate_mutation
                 → command transitions to 'validated'
                 → NO store writes

Operator calls:  cluster_approve_mutation
                 → command transitions to 'approved'
                 → NO store writes

Authorized actor: cluster_commit_mutation
                  → mutation applied to owner store
                  → receipt emitted to ledger
                  → provenance event recorded
```

The system is designed so that AI agents naturally land on `propose` + `validate`, and commit requires explicit authorization.

## Policy enforcement on MCP

- Every MCP tool call goes through `PolicyEnforcedKernel`
- Denied reads return empty results (no existence leakage)
- Denied mutations are rejected with reason
- Redaction applies to all returned content
- The AI agent cannot enumerate what it cannot see

## Receipt verification after MCP operations

After any write operation through MCP:

```json
{"tool": "cluster_list_receipts", "arguments": {"limit": 1}}
```

Returns the receipt proving the operation occurred. The receipt links to:
- The command that was committed
- The provenance event in the ledger
- The IDs that were affected

## What MCP does NOT provide

- No tool for direct store writes (bypass command lifecycle)
- No tool for deleting provenance events (ledger is append-only)
- No tool for clearing index without rebuild (use `rebuild index` CLI)
- No tool for modifying policies at runtime
- No tool for accessing raw filesystem paths

## Trust zone recommendation

For AI agents connecting via MCP:

```json
{
  "principal": {
    "id": "ai-agent",
    "trustZone": "agent",
    "capabilities": ["read", "propose"]
  }
}
```

This allows:
- Reading all non-restricted entities and artifacts
- Proposing mutations (staged, no writes)
- Tracing provenance
- Explaining policy

This prevents:
- Committing mutations without operator approval
- Accessing restricted/redacted content
- Modifying cluster configuration
