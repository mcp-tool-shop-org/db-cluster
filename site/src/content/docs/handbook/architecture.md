---
title: Architecture
description: The four-store federation thesis. Kernel routes, cluster owns. Indexes are derivative.
sidebar:
  order: 2
---

db-cluster is a **federated database cluster**. Not a single database with plugins. Not a vector store with metadata. Not an AI wrapper.

## The thesis

An AI system should not query one flattened database. It should operate over a **cluster of specialized truth stores**, where each store preserves its native truth shape and the cluster exposes one coherent retrieval, provenance, and mutation surface.

## Four stores, four owners

| Store | Owns | Shape | Derivative? |
|-------|------|-------|-------------|
| **Canonical** | Entities — stable IDs, structured state | `{id, kind, name, attributes, owner: 'canonical'}` | No — owner truth |
| **Artifact** | Raw files — documents, source text, uploads | `{id, filename, contentHash, mimeType, owner: 'artifact'}` | No — owner truth |
| **Index** | Discoverability — full-text, metadata search | `{id, sourceId, sourceStore, text, metadata, owner: 'index'}` | **Yes** — rebuildable from canonical + artifact |
| **Ledger** | History — provenance events, mutation receipts | `{id, action, actorId, subjectId, timestamp, owner: 'ledger'}` | No — owner truth |

### Key invariant — index is rebuildable

The index store can be **destroyed and rebuilt** from canonical + artifact truth without losing any cluster state. It is the only derivative store. `db-cluster rebuild index` produces an identical index from owned stores; `db-cluster verify` confirms the rebuild is loss-free.

This is the load-bearing law. Indexes can lie — they may stale, they may be wrong about a name, they may miss a record. But canonical + artifact + ledger can rebuild any index from scratch.

## The kernel

The kernel **routes** operations to the correct store. It never holds truth itself.

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

- **Retrieval always resolves to owner truth** — index records are never returned as final answers.
- **Mutations always cross a command boundary** — no direct store writes.
- **Provenance is always emitted** — every write produces a ledger event.
- **Receipts prove operations** — every committed mutation gets a receipt.

## Cluster URIs

Every object in the cluster has a URI:

```
cluster://canonical/<entity-id>
cluster://artifact/<artifact-id>
cluster://index/<record-id>
cluster://ledger/<event-id>
cluster://receipt/<receipt-id>
```

URIs identify the **owner store**. Resolving a URI always returns owner truth — never an index projection.

## What db-cluster is NOT

| Misreading | Reality |
|------------|---------|
| RAG pipeline | Retrieval resolves to owner truth, not vector similarity. |
| AI memory layer | Entities have structured state, not conversation history. |
| SQL assistant | Mutations require typed commands, not natural language. |
| Vector database | Index is derivative; the cluster owns structured truth. |
| Governance middleware | Policy and provenance are native, not bolted on. |

## Physical backends

Stores have **logical contracts** and **physical backends**:

- The canonical store contract is the same whether backed by local JSON or Postgres.
- Physical backends implement store law — they do not become the product center.
- Backend choice is invisible to the kernel, SDK, MCP, and CLI.

Currently supported:

- **Local** (JSON files) — all four stores.
- **Postgres** — canonical store only (artifact / index / ledger remain local).

The Postgres adapter respects `DB_CLUSTER_POSTGRES_SSL`, attaches an `pool.on('error', …)` handler (so an idle-client RST doesn't crash the process), and uses `INSERT … ON CONFLICT` to close the TOCTOU window on concurrent imports.

## Layers

```
CLI / SDK / MCP                      ← surfaces (operator, developer, AI-agent)
      │
PolicyEnforcedKernel                 ← policy + redaction (the only exported entry)
      │
  ClusterKernel                      ← routing, retrieval, mutation lifecycle
      │
┌─────┼─────┬─────────┐
│     │     │         │
Canonical Artifact Index Ledger      ← stores
(Postgres  (local) (local) (local)
 or local)
```

`PolicyEnforcedKernel` is the **only** exported kernel entry. `ClusterKernel` is intentionally not on the public surface — there is no policy-bypass code path through the public API.

## Cross-cutting concerns

- **Mutation lifecycle** — propose → validate → approve → commit → (compensate). [See SDK reference](../sdk/).
- **Provenance graph** — `kernel.traceObject(uri)` returns a `ProvenanceGraph` with nodes (entity, artifact, index_record, provenance_event, receipt, command, evidence_bundle) and edges (11 variants).
- **Policy** — `Principal` + `Capability` + `Policy` + `TrustZone` + `VisibilityRule`. [See Policy & Redaction](../policy-and-redaction/).
- **Redaction** — applied at every read path through `PolicyEnforcedKernel`. Marker types are explicit; the redactor uses an **allowlist**, not a denylist.
- **Typed errors** — `ClusterError` base + per-class subclasses, each with `code` / `remediationHint` / `retryable`. CLI exit codes map sysexits.h.

## Further reading

- [Operations](../operations/) — doctor, verify, rebuild, backup, restore, and the per-error runbooks.
- [Policy & Redaction](../policy-and-redaction/) — the full policy model.
- [MCP Integration](../mcp/) — how AI agents consume the cluster.
