# Changelog

## Phase 14 — Repo-Knowledge Integration Gate (2026-05-26)

Proves db-cluster adds value as a backing substrate for repo-knowledge workflows — provenance, evidence bundles, mutation safety, and recovery — without replacing the existing system. **Verdict: PASS.**

### Integration adapter (`src/integrations/repo-knowledge/`)
- `mapping.ts` — 10 entity kinds, 7 artifact kinds, 7 provenance edge types
- `ingest.ts` — parallel ingest (read-only, source files untouched)
- `compare-retrieval.ts` — evidence bundle vs flat-file comparison
- `update-workflow.ts` — typed command lifecycle (propose/validate/approve/commit)

### Scripts
- `scripts/repo-knowledge-dashboard-snapshot.ts` — dashboard snapshot of imported memory
- `scripts/repo-knowledge-update-demo.ts` — mutation workflow demonstration
- `scripts/repo-knowledge-ops.ts` — operations/recovery demonstration

### Documentation
- `docs/phase-14-repo-knowledge-integration-gate.md` — doctrine + boundary
- `docs/repo-knowledge-mapping.md` — mapping reference
- `docs/phase-14-repo-knowledge-integration-report.md` — gate verdict + evidence matrix
- `docs/phase-14-closeout.md` — closeout summary

### Tests (+65)
- 12 mapping tests, 9 ingest tests, 8 retrieval tests
- 8 dashboard tests, 8 mutation tests, 8 ops tests
- 12 integration gate proofs (`test/phase14-proof.test.ts`)

## Phase 13 — Dashboard / Truth Inspector Integration (2026-05-27)

Turns the ClusterTruthInspector template into a real inspector over dogfood data. Dashboard consumes cluster state through kernel verbs only — never raw adapter access.

### New modules
- `src/dashboard/dashboard-model.ts` — DashboardObject type contract (URI, ownerStore, sourceType, freshness, provenance, receipts, warnings)
- `src/dashboard/inspector-data.ts` — maps kernel verbs → DashboardObject instances
- `src/dashboard/ops-model.ts` — operations health model from doctor/verify
- `scripts/dashboard-snapshot.ts` — generates static JSON from live cluster

### React components (CDN, no build step)
- `dashboard/ClusterTruthInspector.jsx` — main inspector (StoreLanesMap, ProvenanceTimeline, ExplainIndexPanel)
- `dashboard/components/OperationsPanel.jsx` — cluster health and integrity at a glance
- `dashboard/components/CommandPreviewPanel.jsx` — command lifecycle visualization (proposed ≠ truth)
- `dashboard/components/PolicyViewToggle.jsx` — view-as operator/agent/observer/external + applyRedaction

### Demo + data
- `dashboard/demo-data.js` — 6 shaped DashboardObject instances + policy views + ops status
- `dashboard/index.html` — demo host page
- `dashboard/README.md` — doctrine and usage

### Test files
- `test/dashboard-model.test.ts` — 14 tests
- `test/dashboard-snapshot.test.ts` — 8 tests
- `test/dashboard-ops.test.ts` — 6 tests
- `test/dashboard-command-preview.test.ts` — 6 tests
- `test/dashboard-policy-view.test.ts` — 8 tests
- `test/phase13-proof.test.ts` — 12 architecture proofs

### 12 proofs verified
1. Dashboard model never reads raw adapters directly
2. Every DashboardObject has URI, ownerStore, and sourceType
3. Index records labeled derivative
4. Canonical = owner-truth, artifact = source-truth
5. Provenance graph has nodes and edges from real cluster data
6. Receipts connected to command lifecycle
7. Command preview lives in ledger (append-only, non-editable)
8. Redaction returns new copy — source never mutated
9. Ops model uses doctor() and kernel verbs
10. Snapshot generates from live cluster
11. Template files exist and expose window globals
12. No dashboard copy positions product as CRUD/RAG/admin

### Stats
- 539 tests passing (48 skipped), 0 failures
- 47 test files

## Phase 12 — Dogfood Findings Repair (2026-05-27)

Converts Phase 11's PASS_WITH_CONDITIONS into a stronger product foundation by fixing the four gaps discovered through self-dogfood.

### Findings repaired
1. **restore() doesn't restore artifacts** — Backup now captures base64 content + SHA-256 checksum; restore verifies integrity and uses `importSnapshot()` to preserve original artifact IDs.
2. **Command state not shared across kernel instances** — CommandQueue rewritten to read from disk on every `get()` call; no stale in-memory cache.
3. **commitMutation(create_entity) doesn't auto-index** — `create_entity` and `update_entity` now auto-index in `commitMutation()`, matching `createEntity()` behavior.
4. **Index is name-based, not content-based** — New `src/indexing/` module (tokenizer + content-indexer) produces content-aware index text from artifact content (headings, key terms).

### New files
- `src/indexing/tokenizer.ts` — text tokenization, heading extraction, stop-word filtering
- `src/indexing/content-indexer.ts` — content-aware artifact indexing
- `test/restore-artifacts.test.ts` — 6 tests
- `test/command-persistence.test.ts` — 7 tests
- `test/command-index-consistency.test.ts` — 6 tests
- `test/content-index.test.ts` — 10 tests
- `test/dogfood-replay.test.ts` — 6 tests
- `test/phase12-proof.test.ts` — 14 proofs
- `scripts/dogfood-replay.ts` — end-to-end regression replay
- `docs/phase-12-dogfood-repair.md` — doctrine doc
- `docs/phase-12-repair-report.md` — value report (Verdict: PASS)

### Stats
- 485 tests passing (48 skipped), 0 failures
- 41 test files

## Phase 11 — Dogfood Gate (2026-05-27)

### Wave 1 — Schema + Overview
- `examples/dogfood-project-memory/schema.md` — entity kinds, artifact kinds, provenance edges, trust zones, invariants
- `examples/dogfood-project-memory/README.md` — dogfood overview

### Wave 2 — Dogfood Ingest
- `scripts/dogfood-ingest.ts` — 12 artifacts (README, CHANGELOG, 10 closeout docs), 22 canonical entities (1 project, 10 phases, 6 decisions, 2 milestones, 3 findings), 19 provenance links

### Wave 3 — Retrieval Tests
- `scripts/dogfood-query.ts` — 9 retrieval queries
- `test/dogfood-retrieval.test.ts` — 10 tests (evidence bundles, not flat hits)

### Wave 4 — Trace Tests
- `scripts/dogfood-trace.ts` — 5 object traces
- `test/dogfood-trace.test.ts` — 7 tests (provenance graph navigation, why() explanations)

### Wave 5 — Mutation Tests
- `scripts/dogfood-update.ts` — full command lifecycle demo
- `test/dogfood-mutation.test.ts` — 7 tests (propose→validate→approve→commit→receipt)

### Wave 6 — Policy Tests
- `scripts/dogfood-policy.ts` — 4 principals with extended policies
- `test/dogfood-policy.test.ts` — 7 tests (operator/agent/observer/external enforcement)

### Wave 7 — Operations Tests
- `scripts/dogfood-ops.ts` — doctor, rebuild, backup, restore demo
- `test/dogfood-ops.test.ts` — 7 tests (health, rebuild, backup/restore)

### Wave 8 — Proof Suite + Value Report
- `test/phase11-proof.test.ts` — 12 proofs: ingest completeness, URI resolution, evidence bundles, trace-to-source, command lifecycle, agent denied, operator approved, redaction shape, index rebuild, backup/restore, report existence, friction surfaced
- `docs/phase-11-dogfood-report.md` — structured value report with real product findings

### Product Findings
1. `restore()` does not restore artifacts — only entities/events/receipts + index rebuild
2. `commitMutation(create_entity)` does not auto-index — entities not discoverable until rebuild
3. In-memory command state not shared across PolicyEnforcedKernel instances
4. Index stores entity names, not artifact content — limits semantic retrieval

### Summary
484 tests passing across 35 files. db-cluster proves value as project-memory substrate — structured retrieval, safe mutation, inspectable provenance, enforceable policy. Verdict: PASS_WITH_CONDITIONS.

## Phase 10 — Developer Product Surface (2026-05-27)

### Wave 1 — Documentation Architecture
- 12 docs in `docs/`: quickstart, architecture, store-contracts, cluster-uris, retrieval-bundles, provenance-graphs, mutation-law, policy-and-redaction, mcp, sdk, cli, operations
- All lead with cluster thesis and name store ownership law
- No framing as RAG, vector DB, AI memory, or middleware

### Wave 2 — Quickstart Golden Path
- `examples/quickstart/` — evidence.md, commands.md, README.md
- Expected output for init, ingest, doctor commands
- Developer can follow the golden path without reading source

### Wave 3 — CLI Reference Test
- `test/cli-docs.test.ts` — 14 tests verifying docs/cli.md stays in sync with CLI

### Wave 4 — SDK Reference Examples
- 5 SDK examples: local-cluster, postgres-canonical, retrieval-bundle, mutation-lifecycle, policy-redaction
- All compile and demonstrate cluster thesis

### Wave 5 — MCP Integration Guide
- `examples/mcp/` — config.example.json, tool-catalog.md (16 tools), safety-model.md
- Artifact content boundary, lifecycle enforcement, trust zones documented

### Wave 6 — Example Applications
- `examples/research-evidence-cluster/` — papers + claims
- `examples/project-memory-cluster/` — docs + decisions
- `examples/agent-safe-app-db/` — uploaded records + app records, policy enforcement

### Wave 7 — Installation + Smoke Tests
- `test/install-smoke.test.ts` — 9 tests: build, dist, CLI, SDK imports, MCP module, Postgres error path

### Wave 8 — Phase 10 Proof Suite
- `test/phase10-proof.test.ts` — 12 proofs: README accuracy, CLI parity, compilation, MCP tool parity, quickstart, 4-store usage, no single-store examples, no middleware framing, mutation lifecycle, policy non-leakage, operations docs, install cleanliness

### Summary
434 tests passing across 29 files. The cluster is legible and runnable as a developer product.

## Phase 9 — Operations, Rebuild, and Recovery (2026-05-26)

### Wave 1 — Operations Doctrine + Health Model
- `HealthStatus`, `HealthCheck`, `ClusterHealth`, `StoreHealth` types
- Health is explicit — not inferred from absence of errors
- `buildClusterHealth()` computes worst-of status from individual checks
- `worstStatus()` priority ordering: corrupt > unreachable > missing > stale > degraded > unverified > healthy

### Wave 2 — Doctor and Verify
- `doctor()` — full cluster reachability assessment (canonical, artifact, index, ledger)
- Detects: empty index when data exists, missing Postgres migrations, unloadable policies
- `verify()` — proves data consistency invariants (index→source, provenance→subject, receipt→event)
- Both are read-only: they never mutate state

### Wave 3 — Index Rebuild and Stale Repair
- `rebuildIndex()` — reconstructs index from canonical + artifact truth
- `checkStale()` — detects orphan index records and missing index entries
- `clear()` + re-index cycle: index is always derivative, never authoritative
- Dry-run mode for safe preview

### Wave 4 — Provenance + Receipt Checks
- `checkProvenance()` — verifies provenance events reference valid subjects
- `checkReceipts()` — verifies receipts reference valid provenance events
- Both return structured `HealthCheck[]` results

### Wave 5 — Backup and Restore
- `backup()` — exports entities, artifacts, events, receipts as portable JSON
- `restore()` — imports cluster state, rebuilds index after import
- Restore is additive: duplicate restores don't corrupt state
- Backup version field for future format evolution

### Wave 6 — Migration Status + Schema Verify
- `checkMigrationStatus()` — reports whether Postgres tables exist
- `verifySchema()` — validates column structure matches expectations
- Both work against live Postgres pool

### Wave 7 — Operational CLI Surface
- `db-cluster doctor` — full health assessment (with `--json`)
- `db-cluster verify` — invariant proofs (with `--json`, `--sample`)
- `db-cluster rebuild index` — reconstruct from truth (with `--dry-run`)
- `db-cluster rebuild check` — report stale records
- `db-cluster backup` — export cluster state
- `db-cluster restore <file>` — import from backup
- `db-cluster migration-status` — Postgres schema state
- `db-cluster verify-schema` — validate physical schema structure

### Wave 8 — Phase 9 Proof Suite (12 tests)
- Doctor reports healthy after clean setup
- Doctor detects degraded state when index wiped
- Verify detects stale index after unindexed entity insert
- rebuildIndex restores full discoverability after clear
- checkStale detects orphan index records
- Provenance check verifies event integrity
- Receipt check verifies receipt→event links
- Backup captures all cluster state
- Restore recovers state into empty cluster
- Restore is additive (no corruption on repeat)
- worstStatus computes correct severity ordering
- Full cycle: damage → detect → rebuild → verify passes

## Phase 8 — Physical Store Expansion (2026-05-26)

### Wave 1 — Backend Adapter Doctrine
- Physical backends are implementations of store law, not new product centers
- Postgres canonical adapter is first target
- No vector DB, graph DB, or distributed behavior yet
- No schema drift from existing CanonicalStore contract

### Wave 2 — Postgres Canonical Schema
- `canonical_entities` table: id, kind, name, attributes (JSONB), owner, timestamps
- Idempotent migration with `CREATE TABLE IF NOT EXISTS`
- Indexes on kind and name for query performance

### Wave 3 — PostgresCanonicalStore Adapter
- Implements `CanonicalStore` interface exactly: create, get, list, update, exists
- Parameterized queries (SQL injection safe)
- Proper UUID handling, JSONB attributes roundtrip
- `migrate()` and `teardown()` lifecycle methods

### Wave 4 — Store Factory and Config
- `createCluster()` — explicit backend config, no silent fallback
- `createClusterFromEnv()` — environment variable driven
- Fail-fast: missing Postgres URL throws immediately
- Mixed mode: Postgres canonical + local artifact/index/ledger

### Wave 5 — Kernel Regression Against Postgres (9 tests)
- ingest artifact writes to local, not Postgres
- create entity writes to Postgres canonical
- find resolves owner truth from Postgres
- inspect reads Postgres canonical truth
- retrieve bundle includes Postgres-backed entity
- trace graph crosses Postgres canonical + local ledger
- mutation lifecycle updates Postgres canonical truth
- receipts remain in ledger
- policy denies Postgres-backed entity for restricted principal

### Wave 6 — CLI Support
- `db-cluster stores verify` — backend config, connection status, migration status
- `db-cluster stores migrate` — run pending Postgres migrations
- `db-cluster stores list` — list configured backends per store

### Wave 7 — Backend Parity Tests (10 tests)
- Equivalent entity shape across backends
- Kernel behavior unchanged when backend changes
- Index remains derivative
- Ledger remains append-only
- Artifact store remains immutable
- Policy enforcement identical
- Redaction identical
- Mutation receipts identical
- Cross-process persistence stronger with Postgres
- Factory refuses unsafe/missing config

### Wave 8 — Phase 8 Proof Suite (10 tests)
- Delete index, rebuild from Postgres canonical truth
- Mutate only through command lifecycle
- Direct adapter mutation detectable as drift (no receipt)
- Retrieve bundle resolves Postgres owner truth
- Trace graph crosses Postgres canonical + local ledger
- Policy denial prevents reading Postgres owner truth
- Redaction hides Postgres-backed entity attributes
- MCP cannot distinguish backend except via allowed metadata
- SDK observes Postgres-backed mutation consistently
- Local and Postgres pass shared contract suite

## Phase 7 — Policy, Permissions, and Trust Boundaries (2026-05-26)

### Wave 1 — Policy Type Model
- `Policy`, `Principal`, `TrustZone`, `VisibilityRule`, `RedactionRule` types
- Principal: identity + roles + trustZone binding
- Policy: verb + resource + effect (allow/deny) + conditions + redactionRules
- TrustZone: named boundary with default policies + zone-level redaction

### Wave 2 — Deterministic Policy Engine
- `evaluatePolicy(principal, verb, resource, policies)` — first-match deny-wins
- `checkVisibility(principal, resource, rules)` — existence + metadata visibility
- `matchPolicy(principal, policy)` — role + zone + condition matching
- `DEFAULT_POLICIES`, `DEFAULT_TRUST_ZONES`, `DEFAULT_VISIBILITY_RULES`

### Wave 3 — Kernel Enforcement
- `PolicyEnforcedKernel` wraps `ClusterKernel` with policy checks on every operation
- Read enforcement: `inspectEntity`, `findSources`, `retrieveBundle`, `traceObject`, `why`
- Command enforcement: `inspectCommand`, `listReceipts`
- Mutation enforcement: `proposeMutation`, `commitMutation`
- Visibility-aware: denied reads either throw AccessDenied or silently exclude based on existence visibility

### Wave 4 — MCP/SDK/CLI Policy Surface
- `cluster_policy_explain` MCP tool — surfaces effective policy for a principal
- `cluster_policy_test` MCP tool — tests a specific action against policy
- SDK methods: `policyExplain`, `policyTest`
- CLI subcommands: `policy explain`, `policy test`

### Wave 5 — Redaction and Existence Leakage
- `redactArtifact()` — strips/masks/summarizes/hashes artifact storagePath
- `redactEntity()` — masks/strips entity attributes preserving object shape
- `redactCommand()` — strips command payloads preserving lifecycle metadata
- `redactReceipt()` — strips receipt details preserving audit shape
- `redactProvenanceActors()` — strips actor identities from graph nodes/edges
- `redactGraphNodes()` — replaces hidden nodes with `[Access restricted]` placeholders
- `sanitizeWarnings()` — removes stale/gap warnings referencing hidden URIs
- PolicyEnforcedKernel applies redaction on every read path

### Wave 6 — Phase 7 Proof Suite (34 tests)
- Denied reads cannot access entity owner truth
- Index-only access cannot escalate to owner truth
- Hidden existence: denied entities invisible in find results
- Redacted provenance trace preserves graph structure
- Redacted receipts preserve audit shape with stripped payloads
- MCP/SDK policy parity: same enforcement through both surfaces
- CLI safety: policy explain/test work without elevation
- Proposer-only principal cannot approve or commit
- Approver-only principal cannot propose mutations
- Existing kernel law preserved: command lifecycle, receipt emission, provenance

## Phase 6 — AI-Facing Interface: MCP and SDK (2026-05-26)

### Wave 1 — SDK Surface
- `ClusterSDK` class — clean programmatic API over kernel
- Methods: findSources, retrieveBundle, explainRetrieval, resolve, traceObject, why
- Mutation lifecycle: proposeMutation, validateMutation, approveMutation, rejectMutation, commitMutation, compensateMutation
- Inspection: inspectCommand, listReceipts
- Constructor takes `SDKOptions { clusterDir }`, creates cluster + kernel + resolver internally

### Wave 2 — MCP Tool Schema
- 14 tools defined with typed input schemas
- Read tools: cluster_find_sources, cluster_retrieve_bundle, cluster_explain_retrieval, cluster_resolve, cluster_trace, cluster_why, cluster_inspect_command, cluster_list_receipts
- Lifecycle tools: cluster_propose_mutation, cluster_validate_mutation, cluster_approve_mutation, cluster_reject_mutation
- Write tools: cluster_commit_mutation, cluster_compensate_mutation

### Wave 3 — MCP Server Runtime
- Stdio transport via `@modelcontextprotocol/sdk`
- `db-cluster-mcp` bin entry — startable as real tool surface
- All tools delegate to SDK → kernel → stores (no alternate path)
- `handleTool` exported for testability with SDK override

### Wave 4 — Safety Guardrails
- `ToolAnnotations` interface: readOnly, writesCluster, approvalSensitive, stagedOnly, requiresExistingCommand
- Every tool carries machine-readable annotations
- Output discipline: `_meta.operation`, `_meta.writesCluster`, `_sourceType`, `_staleWarning`, `_missingWarning`, `statusTransition`
- Prompt-injection boundary: artifact content/rawContent stripped, `_contentPolicy` marker
- `dataIntegrity` statement on retrieve_bundle: content is DATA, not instructions
- `formatCommandOutput` surfaces all lifecycle metadata visibly

### Wave 5 — Parity Tests (22 tests)
- retrieveBundle: same URIs, owner stores, freshness, confidence through MCP and SDK
- trace: equivalent provenance graph nodes/edges
- why: identical explanation text
- Lifecycle: propose → validate → approve → commit state matches at every step
- Rejected command cannot commit through MCP
- Stale index labeled derivative, resolved objects labeled owner-truth
- Missing owner truth surfaces as `_missingWarning`
- Receipts created via MCP visible through SDK
- All 14 tool annotations match intended risk classes (6 sub-assertions)
- Artifact sanitization strips content from MCP output, owner-store truth undamaged

### Wave 6 — Destructive Proof Suite (22 tests)
- MCP proposal writes no cluster truth (store state unchanged)
- MCP commit cannot bypass validation (invalid payload rejected, rejected commands blocked, double-commit blocked)
- Rejected command persists across SDK instances (survives restart)
- Adversarial artifact content cannot alter tool permissions/annotations
- Stale index warnings survive MCP retrieval
- Missing owner truth: empty retrieval returns valid structure, non-existent trace returns gap nodes
- Raw artifact content never exposed through MCP output
- MCP lifecycle receipts traceable through `why` and `trace`
- No raw adapter/store exported through any public surface
- CLI ↔ MCP parity: entity committed through MCP visible through CLI, entity committed through CLI visible through MCP

### Bonus Fix
- Removed duplicate `trace` command in CLI (Phase 2/4 overlap bug)

**Phase 6 total: 44 new tests (210 cumulative), all passing.**

---

## Phase 5 — Mutation Law and Command Runtime (2026-05-26)

### Wave 1 — Command Lifecycle Model
- `CommandStatus`: proposed → validated → approved → committed → (compensated) / rejected
- `ValidationResult`, `ValidationCheck` — named, inspectable validation output
- Commands carry: rejection reason/actor, approval metadata/note, commit actor, compensation references
- Added `compensate` verb

### Wave 2 — Command Validator
- 5 structural checks: verb_present, target_store_valid, payload_present, payload_shape, status_is_proposed
- Verb-specific payload validation: create_entity (kind+name), update_entity (entityId+patch), link_evidence (artifactId+entityId), compensate (originalCommandId+reason)
- Validation failures produce named check results, not opaque errors

### Wave 3 — Approval/Rejection Runtime
- `kernel.validateMutation(id)` — validate without committing
- `kernel.approveMutation(id, actor, note)` — operator/policy gate
- `kernel.rejectMutation(id, actor, reason)` — explicit rejection
- `kernel.inspectCommand(id)` — full lifecycle state inspection
- All transitions emit provenance events to ledger

### Wave 4 — Compensation Path
- `kernel.compensateMutation(id, actor, reason)` — correct without erasing
- Creates compensating command with receipt; links back to original
- Original receipt preserved; original command marked `compensated`
- Cannot compensate non-committed commands

### Wave 5 — CLI Surface
- `db-cluster validate <id>` — validate with check output
- `db-cluster approve <id> [--note]` — approve validated command
- `db-cluster reject <id> --reason` — reject with reason
- `db-cluster compensate <id> --reason` — compensate committed command
- `db-cluster inspect-command <id>` — full lifecycle JSON

### Wave 6 — Proof Tests
- No commit without validation
- Rejected commands cannot commit
- Full approval lifecycle (proposed→validated→approved→committed)
- Compensation preserves original receipt
- Failed commands produce audit trail (rejection, approval, compensation events)
- Cross-process command lifecycle survives restart
- Validation produces detailed named checks
- Invalid status transitions are rejected

**Phase 5 total: 17 new tests (166 cumulative), all passing.**

---

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
