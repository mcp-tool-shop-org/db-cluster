# Phase 6 Closeout — AI-Facing Interface: MCP and SDK

## Exit sentence

db-cluster can be safely used by AI systems through SDK and MCP surfaces that expose retrieval, provenance, and command-gated mutation without bypassing cluster ownership, index derivation, or mutation law.

## What was built

| Layer | Purpose |
|-------|---------|
| `src/sdk/cluster-sdk.ts` | Clean programmatic API over kernel — retrieval, provenance, mutation lifecycle |
| `src/mcp/server.ts` | MCP stdio server — 14 tools as thin adapter over SDK/kernel |
| `src/mcp/index.ts` | Barrel export — TOOLS, handleTool, ToolAnnotations, AnnotatedTool |
| `src/sdk/index.ts` | Barrel export — ClusterSDK, SDKOptions |

## Tool surface (14 tools)

### Read tools (8)
- `cluster_find_sources` — index search → resolved owner truth
- `cluster_retrieve_bundle` — structured evidence bundle with freshness/gaps/confidence
- `cluster_explain_retrieval` — explain what was found/missing/bounded
- `cluster_resolve` — resolve cluster URI to owner-store object
- `cluster_trace` — provenance graph for any cluster URI
- `cluster_why` — compact explanation from actual provenance
- `cluster_inspect_command` — full command lifecycle state
- `cluster_list_receipts` — proof of committed operations

### Lifecycle tools (4)
- `cluster_propose_mutation` — staged-only, writes NO cluster truth
- `cluster_validate_mutation` — runs named checks, transitions to validated
- `cluster_approve_mutation` — operator/policy gate (approval-sensitive)
- `cluster_reject_mutation` — terminal state, cannot commit after

### Write tools (2)
- `cluster_commit_mutation` — writes cluster truth, issues receipt (approval-sensitive)
- `cluster_compensate_mutation` — corrects without erasing (approval-sensitive)

## Safety properties proven

1. MCP is a thin adapter over SDK → kernel → stores. No alternate write path exists.
2. `cluster_propose_mutation` writes NO cluster truth (store state verified unchanged).
3. Commit requires existing command ID — no natural-language write shortcut.
4. Rejected commands cannot commit through any surface.
5. Validation guards cannot be bypassed through MCP.
6. Artifact content stripped from MCP output. Content policy marker enforced.
7. Retrieved content is DATA — cannot authorize tool calls or modify cluster behavior.
8. Every output carries `_meta.operation`, `_meta.writesCluster`, owner store, URI.
9. Index results labeled `derivative`; resolved objects labeled `owner-truth`.
10. Stale/missing truth conditions remain visible in MCP output.
11. Tool annotations are machine-readable: `readOnly`, `writesCluster`, `approvalSensitive`, `stagedOnly`, `requiresExistingCommand`.
12. No raw adapter, kernel, or store method is exported through any public surface.
13. CLI ↔ MCP ↔ SDK produce equivalent behavior for the same operations.

## Test coverage

| File | Tests | What it proves |
|------|------:|----------------|
| `test/wave5-parity.test.ts` | 22 | MCP/SDK produce same structural truth |
| `test/wave6-proof.test.ts` | 22 | MCP cannot bypass cluster law |

**Phase 6 total: 44 new tests. Cumulative: 210 tests across 16 files.**

## Architecture diagram

```
AI System
    │
    ▼
┌───────────────┐
│  MCP Server   │  (14 tools, annotations, safety metadata)
│  stdio/JSONRPC│
└───────┬───────┘
        │ delegates
        ▼
┌───────────────┐
│  ClusterSDK   │  (programmatic API, same verbs)
└───────┬───────┘
        │ routes through
        ▼
┌───────────────┐
│ ClusterKernel │  (command lifecycle, provenance, validation)
└───────┬───────┘
        │ dispatches to
        ▼
┌─────┬─────┬─────┬──────┐
│Canon│Artif│Index│Ledger│  (4 specialized truth stores)
└─────┴─────┴─────┴──────┘
```

## What this phase did NOT do

- No multi-principal policy (no "who can propose what" beyond actor ID)
- No rate limiting or cost metering on MCP tools
- No streaming/pagination for large result sets
- No remote transport (stdio only)
- No auth layer (MCP transport assumed trusted)

These are Phase 7+ concerns.

## Tag

```
git tag phase-6-ai-interface
```
