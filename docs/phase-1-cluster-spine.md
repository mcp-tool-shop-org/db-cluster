# Phase 1 — Cluster Spine

## Goal

> Build the smallest real db-cluster that proves specialized stores can behave as one governed AI-native truth substrate.

Not a mock. Not a generic data layer. Not one database pretending to be many. Not a kernel without a cluster.

## Minimum Cluster

| Store                   | Phase 1 responsibility                                    |
| ----------------------- | --------------------------------------------------------- |
| Canonical store         | entities, IDs, stable business/state records              |
| Artifact store          | raw files, documents, source text, generated outputs      |
| Index store             | discoverability, full-text/vector-ready lookup, metadata  |
| Event/provenance ledger | actions, links, mutations, receipts, lineage              |

The kernel can be thin. The UI can be primitive. The cluster cannot be fake.

## Acceptance Scenario (golden path)

1. Ingest a source artifact
2. Register one or more canonical entities
3. Link artifact evidence to those entities
4. Index the artifact/entity metadata
5. Ask the cluster for relevant truth
6. Return results with source ownership and provenance
7. Propose a mutation
8. Commit only through a typed command
9. Emit a ledger receipt
10. Trace the final answer/change back through the cluster

## Non-Negotiable Laws (become tests)

1. Index is never source of truth — can be deleted and rebuilt from owned stores
2. Every fact has an owner store — no orphan facts in model output or search metadata
3. Every mutation goes through a command — no raw write access from AI layer
4. Every answer is traceable — if the system cannot point back to lineage, the answer is incomplete
5. Artifact truth is immutable by default — corrections create versions or events, not silent overwrites
6. Kernel routes; cluster owns — kernel coordinates access but does not become the product center

## Build Waves

### Wave 1 — Identity + contracts
- Package naming lock (`db-cluster`)
- README with product thesis
- `docs/phase-0-doctrine.md`
- Store contract interfaces
- Cluster object model: Entity, Artifact, IndexRecord, ProvenanceEvent, Command, Receipt

Exit: A reader can tell this is a database cluster product, not AI middleware.

### Wave 2 — Store adapters
- Canonical store adapter
- Artifact/filesystem adapter
- Index adapter
- Ledger adapter
- Hard logical boundaries, rebuildability

Exit: Each store has a native responsibility; no store cheats by owning another's truth.

### Wave 3 — Kernel spine
- Typed verbs: ingest_artifact, create_entity, link_evidence, find_sources, inspect_entity, trace_provenance, propose_mutation, commit_mutation, list_receipts

Exit: Kernel can route across stores without letting AI touch raw state.

### Wave 4 — Golden-path CLI
- Full demo: init → ingest → entity → link → find → trace → propose → commit → receipts

Exit: Cluster can ingest, retrieve, trace, and mutate through commands.

### Wave 5 — Proof tests
- Index rebuild from source stores
- Mutation rejected without command
- Provenance required for answer output
- Artifact overwrite rejected or versioned
- Receipt emitted for every mutation
- Trace path survives restart

Exit: Phase 1 is not a prototype; it is a proven spine.

## First Interface

CLI first, MCP second. CLI proves the engine without UX drag.

## Drift Prevention

The product must not accidentally become:
- a vector search wrapper
- a metadata catalog
- an AI SQL assistant
- an MCP tool over SQLite
- a governance layer over arbitrary stores
- a generic document-ingestion app

db-cluster should feel like: "Here is the database substrate an AI agent can safely stand on."
