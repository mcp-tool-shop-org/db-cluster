# Changelog

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
