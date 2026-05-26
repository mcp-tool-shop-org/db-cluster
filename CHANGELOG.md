# Changelog

## Phase 4 — Provenance Graph and Trace Surface (2026-05-26)

### Wave 1 — Provenance Graph Type Model
- `ProvenanceGraph`, `ProvenanceNode`, `ProvenanceEdge` — machine-readable trace graph
- `TraceDirection` (backward/forward/bidirectional), `TraceOptions`
- `NodeType` (7 variants: entity, artifact, index_record, provenance_event, receipt, command, evidence_bundle)
- `EdgeType` (11 variants covering all store relationships)
- `TraceGap`, `TraceWarning`, `TraceSummary`

### Wave 2 — TraceBuilder
- `TraceBuilder` class: builds cross-store provenance graphs from any cluster URI
- Traces across all four stores + receipts (not just ledger parent chains)
- Surfaces gaps, stale projections, and missing owner truth honestly
- Deduplicates edges, avoids infinite loops via visited set

### Wave 3 — Kernel Trace Verbs
- `kernel.traceObject(uri, options)` → ProvenanceGraph
- `kernel.traceBundle(bundle, options)` → combined ProvenanceGraph
- `kernel.explainTrace(graph)` → human-readable multiline summary
- `kernel.why(uri)` → compact operator-facing explanation

### Wave 4 — CLI Trace Surface
- `db-cluster trace <uri> [--direction] [--depth] [--graph]`
- `db-cluster why <uri>`
- `db-cluster lineage <uri>` (bidirectional full trace)
- `db-cluster trace-bundle <query>` (retrieve + trace)

### Wave 5 — Proof Tests
- Cross-store trace: entity trace crosses canonical → ledger → artifact
- Derivative visibility: graph distinguishes source truth vs index projection
- Stale projection: stale index emits warning + stale_projection_of edge
- Missing truth: non-existent URI produces gap node, not crash
- Receipts connected: entity trace includes covering receipts
- Bundle trace: traceBundle covers all resolved evidence
- Cross-process: trace works across kernel instances (persistent state)
- Stable ordering: same trace produces same node/edge order
- Human-readable: explainTrace and why produce meaningful output
- Golden path: ingest → create → link → trace → explain lifecycle

**Phase 4 total: 12 new tests (149 cumulative), all passing.**

---

## Phase 3 — Retrieval Planner and Evidence Bundles (2026-05-26)

### Wave 1 — Evidence Bundle Type Model
- `EvidenceBundle` — structured retrieval output with query, resolved evidence, freshness, gaps, boundaries
- `ResolvedEvidence<T>` — owner-store object + URI + staleness + provenance event IDs
- `FreshnessAssessment`, `MissingContext`, `ConfidenceBoundary`

### Wave 2 — Retrieval Planner
- `RetrievalPlanner` class: query → index → resolve → attach provenance → classify freshness → compute confidence
- Returns `EvidenceBundle` (not search hits)
- Detects stale index records, missing provenance, missing owner truth
- Computes confidence boundaries: what the bundle can and cannot claim

### Wave 3 — Kernel Retrieval Verbs
- `kernel.retrieveBundle(query, options)` → EvidenceBundle
- `kernel.explainRetrieval(bundle)` → RetrievalExplanation

### Wave 4 — CLI Retrieval Surface
- `db-cluster retrieve <query> [--limit]`
- `db-cluster explain-retrieval <query> [--limit]`

### Wave 5 — Proof Tests
- Retrieval survives stale index
- Retrieval exposes missing provenance
- Retrieval confidence degrades honestly
- Bundle carries owner truth, not index projections
- Explain names specific gaps and boundaries

**Phase 3 total: 24 new tests (137 cumulative), all passing.**

---

## Phase 2 — Cross-Store Identity and Rebuildable Index (2026-05-26)

### Wave 1 — Cluster URI Model
- `cluster://<store>/<id>` URI scheme: canonical, artifact, index, ledger, receipt
- `parseClusterUri`, `formatClusterUri`, `isClusterUri`, `uriForObject`
- `ClusterUriError` for malformed/unknown store URIs
- 24 URI tests

### Wave 2 — Resolver Spine
- `ClusterResolver`: resolve, resolveAll, tryResolve
- Always resolves to owner store, never index
- `ResolveError` for missing objects
- 14 resolver tests

### Wave 3 — Index Rebuild
- `kernel.rebuildIndex()` — clear + re-derive from truth stores
- `kernel.indexStatus()` — count, per-store breakdown, staleness estimate
- CLI: `db-cluster index rebuild`, `db-cluster index status`
- 9 rebuild tests

### Wave 4 — Index Explain/Stale
- `kernel.explainIndex(recordId)` — why record exists, owner truth, freshness
- `kernel.listStaleRecords()` — detect all stale index records
- CLI: `db-cluster index explain <id>`, `db-cluster index stale`
- CLI: `db-cluster resolve <uri>`
- 7 explain tests

### Wave 5 — Proof Tests
- URI roundtrip: parse → format → resolve
- Resolver returns owner truth after index destruction
- Rebuild produces identical find results
- Stale detection catches mutations that bypass index
- Explain names specific owner truth
- Cross-store identity stable across restart
- 13 proof tests

**Phase 2 total: 67 new tests (113 cumulative), all passing.**

---

## Phase 1 — Cluster Spine (2026-05-26)

### Wave 1 — Identity + Contracts
- Package naming lock: `db-cluster`
- README with product thesis and architecture laws
- Phase 0 doctrine frozen in `docs/phase-0-doctrine.md`
- Store contract interfaces: CanonicalStore, ArtifactStore, IndexStore, LedgerStore
- Cluster object model: Entity, Artifact, IndexRecord, ProvenanceEvent, Command, Receipt
- 5 contract enforcement tests

### Wave 2 — Local Store Adapters
- File-backed LocalCanonicalStore (CRUD, owner enforcement)
- File-backed LocalArtifactStore (content-addressed, immutable, versioned)
- File-backed LocalIndexStore (rebuildable, clearable)
- File-backed LocalLedgerStore (append-only events + receipts)
- `createLocalCluster()` factory with physical directory separation
- 16 adapter tests

### Wave 3 — Kernel Spine
- ClusterKernel with 9 verbs: ingestArtifact, createEntity, linkEvidence, findSources, inspectEntity, traceProvenance, proposeMutation, commitMutation, listReceipts
- Command pattern: propose → validate → commit lifecycle
- Persistent CommandQueue (survives process restart)
- Typed errors: NotFoundError, ProvenanceMissingError, CommandNotValidatedError, CommandRejectedError
- 11 kernel tests

### Wave 4 — Golden-Path CLI
- Full CLI via Commander: init, ingest, entity create, link, find, inspect, trace, propose, commit, receipts
- `.db-cluster/` directory convention
- 3 CLI integration tests

### Wave 5 — Proof Tests
- Index rebuild: clear and rebuild from owned stores
- No mutation without command: propose writes nothing, commit is only path
- Artifact immutability: re-ingest creates versions, never overwrites
- Receipt completeness: every write operation has a receipt
- Trace survives restart: new kernel instance reads prior provenance
- Index is not truth: canonical/artifact survive index destruction
- Golden path regression: full lifecycle in one test
- 11 proof tests

**Total: 46 tests, all passing.**
