# Changelog

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
