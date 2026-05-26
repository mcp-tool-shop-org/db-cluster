# Phase 11 — Dogfood Report

## 1. Dogfood target

db-cluster managing its own project memory — phases, decisions, milestones, and findings backed by real repo artifacts (README, CHANGELOG, 10 phase closeout docs).

## 2. Data ingested

- **12 artifacts**: README.md, CHANGELOG.md, 10 phase closeout docs
- **22 canonical entities**: 1 project, 10 phases, 6 decisions, 2 milestones, 3 findings
- **19 provenance links**: 10 phase→closeout, 6 decision→artifact, 3 finding→artifact

## 3. Canonical entities created

| Kind | Count | Examples |
|------|-------|----------|
| project | 1 | db-cluster |
| phase | 10 | Phase 1–10 |
| decision | 6 | "Cluster is the product", "Index is derivative", "AI proposes, command runtime disposes" |
| milestone | 2 | "434 tests across 29 files", "399 tests across 26 files" |
| finding | 3 | "Index is always rebuildable", "MCP tools expose cluster thesis", "Policy sits above cluster law" |

## 4. Retrieval tasks tested

- Query "MCP" → resolves Phase 6 entity from canonical store
- Query "Mutation Law" → resolves Phase 5 entity
- Query "decision" → resolves all 6 decisions
- Query "closeout" → resolves closeout artifacts
- Query "milestone" → resolves milestone entities
- Empty/nonsense queries return structured empty bundles (no errors)

All results return `EvidenceBundle` with freshness, confidence boundaries, and missing context — not flat search hits.

## 5. Trace tasks tested

- Phase entities trace back to creation and evidence_linked events
- Decisions trace to supporting artifacts via provenance
- `why()` returns non-empty explanations for all traced objects
- Artifacts trace to ingestion events

## 6. Mutation workflow tested

- `proposeMutation()` writes zero truth (verified)
- `validateMutation()` checks payload without writing
- `approveMutation()` records gate without writing
- `commitMutation()` writes truth and produces receipt
- Receipt connects command ID to affected entity IDs
- Full lifecycle: propose → validate → approve → commit works end-to-end

## 7. Policy/redaction tested

- **Operator** (cluster-admin, internal zone): full read/propose/commit access
- **Agent** (proposer, ai-facing zone): can discover, propose, trace; DENIED on commit
- **Observer** (observer, internal zone): can read; DENIED on propose/commit
- **External** (no roles, external zone): DENIED on all access
- Graph shape preserved under agent redaction
- Policy errors do not leak store content

## 8. Operations/recovery tested

- Doctor reports healthy on fresh cluster
- Doctor detects degraded state when index wiped
- `rebuildIndex()` restores discoverability
- `backup()` captures entities, events, receipts
- `restore()` recovers state into empty cluster
- Provenance and receipts survive restore
- Policy still enforces correctly after restore

## 9. Value observed

**What db-cluster made easier:**
- Structured retrieval that returns entities + artifacts + provenance together (not search hits)
- Tracing any decision back to its source document with `why()`
- Verifying cluster health after destructive operations
- Preventing AI from writing truth directly (command lifecycle)
- Trust zone enforcement without application-layer auth code

**What it caught:**
- Policy violations (agent cannot commit, external cannot read)
- Degraded state after index deletion (doctor detects immediately)
- Stale provenance (evidence_linked events prove the link, not just text proximity)

**What it made inspectable:**
- Every entity has a known creation provenance event
- Every decision has a named supporting artifact
- Every mutation has a receipt
- The index can be destroyed and rebuilt without data loss

## 10. Friction observed

1. **Artifact restore is not implemented** — `backup()` exports artifacts but `restore()` does not re-ingest them. A full restore requires re-ingestion from source files. This is a gap.

2. **commitMutation with create_entity does not auto-index** — entities created via the command lifecycle are not discoverable through `findSources()` until a rebuild. The direct `createEntity()` method does auto-index. This inconsistency is confusing.

3. **In-memory command state is not shared across PolicyEnforcedKernel instances** — each kernel gets its own command map. Commands proposed in one kernel cannot be inspected from another. This means multi-principal workflows (agent proposes, operator commits) require the same kernel instance.

4. **Index search is basic text matching** — queries like "RAG drift" or "safety boundaries" return zero results because the index stores `"kind: name"` text, not semantic content. Full-text search over artifact content would significantly improve retrieval.

5. **No automatic provenance for commitMutation → index** — when a commit creates an entity, it records `mutation_committed` provenance but doesn't automatically create an index record or link the provenance to the entity's existing index.

## 11. Product changes recommended

1. **Implement artifact restore** — `restore()` should re-ingest artifact content from backup data, not just metadata.
2. **Auto-index on commitMutation** — when `commitMutation` creates/updates an entity, it should write an index record like `createEntity()` does.
3. **Content-aware indexing** — index artifact content (not just filename), enabling retrieval of "what docs mention mutation law" without exact entity-name matching.
4. **Shared command state for multi-principal workflows** — either persist commands to disk by default or allow a command store to be passed into PolicyEnforcedKernel.
5. **Backup v2 with content** — include base64 artifact content in backup by default (opt-out for large clusters).

## 12. Verdict

**PASS_WITH_CONDITIONS**

db-cluster proves value as a project-memory substrate. It makes retrieval structured, mutation safe, provenance inspectable, and policy enforceable. The dogfood target (managing its own project memory) works end-to-end without flattening into search or bypassing cluster law.

**Conditions for full PASS:**
- Implement artifact restore (item 1)
- Auto-index on commitMutation (item 2)
- These are the two friction points that would block a real multi-session workflow

The remaining items (3–5) are quality-of-life improvements, not blockers.
