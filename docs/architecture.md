# Architecture

db-cluster is a federated database cluster. Not a single database with plugins. Not a vector store with metadata. Not an AI wrapper.

## The thesis

An AI system should not query one flattened database. It should operate over a **cluster of specialized truth stores**, where each store preserves its native truth shape and the cluster exposes one coherent retrieval, provenance, and mutation surface.

## Four stores, four owners

| Store | Owns | Shape | Derivative? |
|-------|------|-------|-------------|
| **Canonical** | Entities — stable IDs, structured state | `{id, kind, name, attributes, owner: 'canonical'}` | No — owner truth |
| **Artifact** | Raw files — documents, source text, uploads | `{id, filename, contentHash, mimeType, owner: 'artifact'}` | No — owner truth |
| **Index** | Discoverability — full-text, metadata search | `{id, sourceId, sourceStore, text, metadata, owner: 'index'}` | **Yes** — rebuildable from canonical + artifact |
| **Ledger** | History — provenance events, mutation receipts | `{id, action, actorId, subjectId, timestamp, owner: 'ledger'}` | No — owner truth |

### Key invariant

The index store can be **destroyed and rebuilt** from canonical + artifact truth without losing any cluster state. It is the only derivative store.

## The kernel

The kernel routes operations to the correct store. It never holds truth itself.

```
┌──────────────────────────────────────────────────┐
│                  ClusterKernel                     │
│                                                    │
│   find → index → resolve → canonical/artifact     │
│   retrieve → index + canonical + artifact         │
│   trace → ledger                                   │
│   mutate → command lifecycle → canonical/artifact │
│   receipt → ledger                                 │
└──────────────────────────────────────────────────┘
```

The kernel enforces:
- **Retrieval always resolves to owner truth** — index records are never returned as final answers
- **Mutations always cross a command boundary** — no direct store writes
- **Provenance is always emitted** — every write produces a ledger event
- **Receipts prove operations** — every committed mutation gets a receipt

## Cluster URIs

Every object in the cluster has a URI:

```
cluster://canonical/<entity-id>
cluster://artifact/<artifact-id>
cluster://index/<record-id>
cluster://ledger/<event-id>
```

URIs identify the **owner store**. Resolving a URI always returns owner truth.

## What this is NOT

| Misreading | Reality |
|------------|---------|
| RAG pipeline | Retrieval resolves to owner truth, not vector similarity |
| AI memory layer | Entities have structured state, not conversation history |
| SQL assistant | Mutations require typed commands, not natural language |
| Vector database | Index is derivative; the cluster owns structured truth |
| Governance middleware | Policy and provenance are native, not bolted on |

## Physical backends

Stores have **logical contracts** and **physical backends**:

- The canonical store contract is the same whether backed by local JSON or Postgres
- Physical backends implement store law — they do not become the product center
- Backend choice is invisible to the kernel, SDK, MCP, and CLI

Currently supported:
- **Local** (JSON files) — all four stores
- **Postgres** — canonical store only
- **SQLite** (optional, via `better-sqlite3`) — all four stores. A single WAL-mode database file (`<rootDir>/sqlite/cluster.db`) backs every store through one shared connection. The driver is lazy-loaded — local stays the default and SQLite is strictly opt-in. Like every backend, it implements store law without becoming the product center: the choice is invisible to the kernel, SDK, MCP, and CLI.

## Layers

```
CLI / SDK / MCP
      │
PolicyEnforcedKernel (policy + redaction)
      │
  ClusterKernel (routing, retrieval, mutation)
      │
┌─────┼─────┬─────────┐
│     │     │         │
Canonical  Artifact  Index  Ledger
(Postgres   (local)  (local) (local)
 or local)
```

The per-store backend in parentheses is one example configuration. Each store's physical backend is chosen independently via the `backends` config — canonical can be Postgres while the rest are local, or all four can be SQLite. The lane the kernel talks to never changes; only what sits behind it does.

## Further reading

- [Store Contracts](store-contracts.md) — the interface each store implements
- [Cluster URIs](cluster-uris.md) — URI scheme and resolution
- [Retrieval Bundles](retrieval-bundles.md) — how retrieval works
- [Mutation Law](mutation-law.md) — the command lifecycle
- [Provenance Graphs](provenance-graphs.md) — how lineage is tracked
- [Policy and Redaction](policy-and-redaction.md) — trust boundaries
