# Phase 8 — Physical Store Expansion

## Mandate

Prove `db-cluster` store contracts can bind to real physical backends without weakening owner truth, index rebuildability, provenance, policy, redaction, or command-gated mutation law.

## Doctrine

1. **Physical backend is subordinate to logical store contract.** The `CanonicalStore` interface is law. Postgres implements it — it does not extend, redefine, or override it.

2. **Backend may optimize storage, not change ownership law.** A Postgres backend may index columns, partition tables, or use transactions for durability. It must not introduce new query paths, new truth shapes, or new ownership semantics that the local backend does not have.

3. **Postgres canonical adapter is the first target.** Canonical truth is the load-bearing store. Proving physical binding here proves the thesis. Other stores follow later from a position of discipline.

4. **No vector DB yet.** Index store remains local/memory in Phase 8.

5. **No graph DB yet.** Provenance ledger remains local/memory in Phase 8.

6. **No distributed cluster behavior yet.** Single-node Postgres. No replication, no sharding, no multi-region.

7. **No schema drift from existing `CanonicalStore`.** The Postgres adapter implements `CanonicalStore` exactly. Same methods, same types, same behavior. The kernel cannot tell which backend is active.

## Exit Sentence

Physical backends are implementations of store law, not new product centers.

## First Target

**Postgres-backed CanonicalStore only.**

This proves the physical-store thesis without stack sprawl. Once canonical truth survives Postgres, later phases can add object storage, graph, vector, and time-series backends from a position of discipline rather than enthusiasm.

## Non-Goals (Phase 8)

- Vector DB backend
- Graph DB backend
- S3 artifact backend
- Distributed nodes / replication
- Multi-tenant hosting
- Cloud deployment
- External policy engine
- SQL query tool / raw Postgres admin CLI
- Magical backend auto-detection
