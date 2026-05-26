# db-cluster

**AI-native federated database cluster.**

An AI system should not query one flattened database. It should operate over a cluster of specialized truth stores, where each store preserves its native truth shape and the cluster exposes one coherent retrieval, provenance, and mutation surface.

## What this is

A federated database cluster where:

- **Canonical store** — entities, IDs, stable state records
- **Artifact store** — raw files, documents, source text, generated outputs
- **Index store** — discoverability, full-text/vector lookup, metadata search
- **Event/provenance ledger** — actions, links, mutations, receipts, lineage

The kernel routes. The index discovers. The cluster owns truth.

## What this is not

- An AI database assistant
- An index over many stores
- Governance middleware
- A vector database with plugins
- An agent memory layer

## Architecture laws

1. Every fact has an owner store
2. Indexes are derivative — can be deleted and rebuilt from owned stores
3. AI never mutates raw state directly
4. Every answer traces to source truth
5. Every mutation crosses a typed command boundary
6. Artifact truth is immutable by default — corrections create versions, not overwrites
7. Kernel routes; cluster owns

## CLI

```bash
db-cluster init
db-cluster ingest ./source.md
db-cluster entity create ...
db-cluster find "..."
db-cluster inspect <id>
db-cluster trace <uri> [--direction] [--depth] [--graph]
db-cluster why <uri>
db-cluster lineage <uri>
db-cluster retrieve "..."
db-cluster trace-bundle "..."
db-cluster propose ...
db-cluster commit ...
db-cluster receipts
```

## Status

**Phase 4 — Provenance Graph and Trace Surface: COMPLETE.** 149 tests passing.

The cluster can trace any surfaced object, answer, retrieval bundle, mutation, receipt, or index record back through the cluster as a navigable provenance graph. Traces cross all four stores, surface gaps and stale projections honestly, and render as both machine-readable graphs and human-readable explanations.

Next: Phase 5 — Mutation Law and Command Runtime.

## License

MIT
