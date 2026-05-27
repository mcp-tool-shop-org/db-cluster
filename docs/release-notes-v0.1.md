# Release Notes — v0.1.0

**db-cluster** is an AI-native federated database cluster for owner-truth retrieval, provenance, policy, operations, and command-gated mutation.

## What this is

A database cluster where specialized truth stores (canonical, artifact, index, ledger) behave as one governed substrate. AI systems retrieve evidence bundles — not flat rows. Every mutation flows through a typed command lifecycle. Every fact traces to a source.

## What this is NOT

| Not this | Why |
|-----------|-----|
| AI memory / chat history database | db-cluster is not a memory layer |
| RAG framework | Evidence bundles are not RAG pipeline outputs |
| Vector search layer | Index is derivative, not the product |
| Database chatbot | No conversational interface |
| LLM wrapper | No model calls inside the kernel |
| Agent memory magic | Explicit governance, not implicit storage |

## Core capabilities

### Truth stores
- **Canonical** — entities with stable IDs, owner truth
- **Artifact** — immutable source documents (files, evidence)
- **Index** — derivative search (rebuildable from owner stores)
- **Ledger** — provenance events, mutation receipts, audit trail

### Retrieval
- Evidence bundles with provenance, freshness, confidence boundaries
- Query resolves across stores, not just text search
- Index is derivative — can be deleted and rebuilt without data loss

### Mutation
- Typed command lifecycle: propose → validate → approve → commit
- Every committed mutation produces a receipt
- Agent can propose, operator approves

### Provenance
- Every fact traces to source artifacts
- Full event chain: who did what, when, with what evidence
- Graph traversal (forward/backward/bidirectional)

### Policy & Redaction
- Role-based visibility without mutating truth
- PolicyEnforcedKernel wraps raw kernel with access control
- Redaction is view-layer only — source truth preserved

### Operations
- `doctor` — cluster health diagnosis
- `verify` — data consistency proofs
- `backup` / `restore` — portable JSON snapshots
- `rebuildIndex` — recover search from owner truth

### Interfaces
- **CLI** — `db-cluster init`, `ingest`, `entity`, `retrieve`, `doctor`, etc.
- **SDK** — `ClusterSDK` for programmatic TypeScript access
- **MCP** — Model Context Protocol server for AI agent integration

## Install

```bash
npm install @mcptoolshop/db-cluster
```

## Quick start

```bash
db-cluster init
db-cluster ingest ./evidence.md
db-cluster entity create --kind fact --name "key finding"
db-cluster retrieve "key finding"
db-cluster doctor
```

## Package exports

```typescript
import { createLocalCluster, createCluster, doctor, verify, backup, restore } from '@mcptoolshop/db-cluster';
import { ClusterSDK } from '@mcptoolshop/db-cluster/sdk';
import { PolicyEnforcedKernel } from '@mcptoolshop/db-cluster/policy';
```

The raw `ClusterKernel` class is no longer publicly exported (KERNEL-013); drive
the kernel via `ClusterSDK` (recommended) or `PolicyEnforcedKernel` for
in-process callers that need policy-enforced direct kernel access.

## Postgres (optional)

Default: filesystem stores, zero config.  
Optional: Postgres canonical backend via `createCluster({ backends: { canonical: 'postgres' }, postgresUrl })`.

## Status

15 development phases complete. 699+ tests passing across 63 files (post-Wave-A3 count finalized in the amend report). Integration gate with repo-knowledge proven. Package boundary deliberate and documented. Dogfood-swarm Stage A surfaced and corrected drift across CI, examples, and docs through three amend waves (A1, A2, and A3 — A3 introduced the v2 architecture with lens-specialized adversarial verifier ensemble).

## License

MIT
