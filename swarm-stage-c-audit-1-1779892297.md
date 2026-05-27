# Dogfood Swarm Stage C — Wave C1-Audit — Behavioral Humanization — db-cluster — 2026-05-27

**Repo:** `mcp-tool-shop-org/db-cluster`
**Working copy:** `E:/AI/db-cluster`
**Audit type:** Stage C Wave C1-Audit — behavioral humanization across 4 user classes (AI / operator / developer / dashboard viewer); read-only; 5 parallel domain agents
**Coordinator:** Dogfood Swarm Stage C Wave C1-Audit coordinator
**Audit date:** 2026-05-27 14:31 UTC

---

## 1. Baseline

| Field | Value |
|---|---|
| Pre-audit HEAD SHA | `dea915f` (`Add Stage B Wave B1-Amend reports + verifier outputs`) |
| Branch | `main` (10 commits ahead of `origin/main` — un-pushed) |
| Working tree pre-audit | clean |
| Stage C save-point tag | `swarm-stage-c-audit-1-1779891499` (created at start of wave) |
| Save points present (all prior) | All 9 prior tags retained (`swarm-stage-a-save-*`, `swarm-stage-a-amend-{1,a2,a3,a4}`, `swarm-stage-a-reaudit{,2}`, `swarm-stage-b-{1,amend-1}`) + this new one |
| Pre-audit `npm run lint` | **PASS** (tsc --noEmit + lint:examples) |
| Pre-audit `npm test` 3-run stability | **3/3 PASS at 921/55/0 across 73 files** (direct run 1 + release-gate [2/8] vitest + direct run 2) |
| Pre-audit `node scripts/release-gate.mjs` | **8/8 PASS — ready for release** (Build / Tests / Package / Smoke / Docs-drift / Exports / Completeness / Doc-drift) |

The wave starts from Stage B's clean exit at Wave B1-Amend (32 + 4 architectural + 17 fix-up findings closed; 2 HIGH residuals deferred to v0.2; Stage B lens family validated; Stage A→B convergence verdict ratified). No drift in baseline since.

---

## 2. Wave C1-Audit dispatch — overview

Wave C1-Audit used the **Stage C behavioral-humanization lens** applied across **four user classes** with **5 parallel read-only domain auditors**:

| Domain | Agent ID | Focus |
|---|---|---|
| **Kernel** | a067b76536c06665d | typed-error shape, JSDoc, SDK contract |
| **Stores** | a25f01eab620de532 | doctor/verify output, long-running ops, contract JSDoc |
| **Surface** | af2abac3a267584d7 | CLI prose, MCP envelope, SDK methods, dashboard JSX (largest scope) |
| **Tests** | a678e960c7094f70f | user-facing-behavior coverage, render tests, exit-code assertions |
| **CI/Docs** | a4dcfaf8f68fe7b26 | README/CHANGELOG/handbook/examples/package metadata acquisition |

No code edits. No verifier ensemble or aggregator this wave — Audit phase only; advisor decides amend dispatch.

---

## 3. Severity rollup

### Per-domain

| Domain | HIGH | MEDIUM | LOW | Total | Should-have-been-A |
|---|---|---|---|---|---|
| Kernel | 4 | 8 | 0 | 12 | 1 (6 sites) |
| Stores | 5 | 6 | 1 | 12 | 1 |
| Surface | 8 | 13 | 2 | 23 | 5 |
| Tests | 4 | 6 | 1 | 11 | 0 |
| CI/Docs | 4 | 5 | 1 | 10 | 1 |
| **TOTAL** | **25** | **38** | **5** | **68** | **8** |

**Stage C is not "smaller" than Stage A/B as predicted.** Humanization debt accumulated through Phases 1-15 surfaces as 68 findings — the Surface domain alone carries 23 (CLI + MCP + SDK + dashboard JSX). This is expected when humanization is being explicitly audited for the first time on a substantial codebase; the bulk is JSDoc gaps + AI envelope poverty + operator-actionability gaps that exist as patterns, not localized bugs.

### By user class (the load-bearing Stage C view)

| User class | HIGH | MEDIUM | LOW | Total | % of findings |
|---|---|---|---|---|---|
| **Operator** | 12 | 9 | 1 | **22** | 32% |
| **Developer** | 5 | 11 | 1 | **17** | 25% |
| **AI agent** | 4 | 11 | 0 | **15** | 22% |
| **Dashboard viewer** | 4 | 4 | 0 | **8** | 12% |
| **Cross-cutting** | 0 | 5 | 1 | **6** | 9% |
| **TOTAL** | 25 | 40 | 3 | 68 | 100% |

**Operator findings dominate** — the gap between "typed errors / structured exit codes shipped in B1-Amend" and "operators know what to DO with them" is the largest single humanization debt. Developer findings (JSDoc + SDK exports + contract docs) are second largest. AI agent findings concentrate on envelope poverty (no `retryable` / `remediation_hint` / `context` / `next_valid_actions` enrichment of the `{code, message}` minimum the boundary sanitizer produces). Dashboard findings are the smallest — but four HIGH-severity items (empty-state, redaction-marker rendering, stub onClick handlers, RepairSuggestion not consumed by JSX) all live there.

---

## 4. Findings by user class

### 4a. AI-agent findings (15)

| ID | Sev | File:line | Headline |
|---|---|---|---|
| KERNEL-C-001 | HIGH | src/mcp/sanitize.ts:202 | `redactError()` strips `{code, message}` — no `retryable` / `remediation_hint` / `context` enrichment from typed-error subclass context (claimedHash, filePath, decision.capability, cause) |
| KERNEL-C-002 | HIGH | src/kernel/cluster-kernel.ts:590 | Command lifecycle responses (propose/validate/approve/commit) lack `nextValidActions: CommandStatus[]` — `validTransitions()` exists but isn't surfaced; AI reverse-engineers the lifecycle |
| KERNEL-C-003 | MEDIUM | src/kernel/cluster-kernel.ts:525 | `findSources` empty result carries no signal distinguishing "no index match" vs "all matches policy-filtered" vs "owner truth missing" — `PolicyEnforcedKernel.findSources` silently filters with no `_meta.filteredCount` |
| KERNEL-C-004 | MEDIUM | src/types/redaction.ts:76 | `RedactedMarker.reason='capability_denied'` doesn't name WHICH capability would unlock the field — AI can't request the right one (13-value Capability union) without trial-and-error |
| KERNEL-C-005 | MEDIUM | src/kernel/cluster-kernel.ts:654 | `commitMutation` collapses 3 distinct invalid-state cases (not found / not validated / already committed) into one `CommandNotValidatedError` — same code, same message, AI can't branch |
| SURFACE-C-001 | HIGH | src/mcp/server.ts:888 | MCP error envelope `{error, code, _meta:{operation:'error'}}` lacks `retryable`/`remediation_hint`/`context` — sibling success envelope DOES include `_meta.nextSteps` at server.ts:667 |
| SURFACE-C-002 | HIGH | src/mcp/server.ts:217 | Zero MCP tools front long-running ops (doctor/verify/rebuild/backup/restore) — no progress channel, no time-bound expectation in tool descriptions |
| SURFACE-C-003 | MEDIUM | src/mcp/server.ts:475 | `cluster_find_sources`/`cluster_retrieve_bundle`/`cluster_list_receipts` empty-result responses lack `_meta.empty_reason: 'no_data' \| 'no_match' \| 'all_filtered'` |
| SURFACE-C-004 | MEDIUM | src/mcp/server.ts:296 | `cluster_propose_mutation` tool description lists `verb` enum but no per-verb payload schema — AI guesses payload, learns via validation rejection |
| CIDOCS-C-006 | MEDIUM | docs/mcp.md:153 | MCP error envelope shape never documented — AI integrators have no schema to pattern-match on |
| CIDOCS-C-008 | MEDIUM | examples/agent-safe-app-db/index.ts:92 | No failure-path AI-agent example (denied propose, validate-fail, retry on CORRUPT_STORE, rejected-terminal) — only happy path |
| TESTS-C-001 | HIGH | test/wave-a4-surface-regression.test.ts:230 | No test asserts the wrapped MCP error envelope (`isError: true`, `_meta.operation: 'error'`, JSON-stringified body) — regression would ship silently to every AI consumer |
| TESTS-C-002 | MEDIUM | test/wave5-parity.test.ts:204 | MCP success-path `_meta.nextSteps`/`_meta.warning` operator-facing remediation strings never asserted — `_meta.statusTransition` IS asserted but the hint strings are load-bearing for AI consumers |
| TESTS-C-003 | MEDIUM | test/wave6-proof.test.ts:241 | Only ONE MCP tool empty-state test exists (cluster_retrieve_bundle on nonexistent query); sibling read tools (find_sources, list_receipts, inspect_command, trace, why, lineage) untested for empty-state envelope shape |

The AI-agent findings concentrate on a single architectural pattern: every typed error subclass in `src/kernel/errors.ts` (11 classes with rich public-readonly fields) gets collapsed to `{code, message}` at the sanitizer/envelope boundaries. The recovery prose lives in JSDoc; it never reaches the consumer.

### 4b. Operator findings (22)

| ID | Sev | File:line | Headline |
|---|---|---|---|
| STORES-C-001 | HIGH | src/ops/doctor.ts:283 | `mutation_orphaned > 0` health check has no `suggestedCommand` and no `nextSteps` — operator told "uninspectable state" with no remediation path |
| STORES-C-002 | HIGH | src/ops/rebuild.ts:40 | `rebuildIndex()` (+ verify, backup-with-content, restore) walks all records serially with no progress callback — operator stares at blank for 30+ seconds |
| STORES-C-003 | HIGH | src/ops/backup.ts:196 | `restore()` silently rebuilds index, swallows entity.errors[] in CLI output (`Entities: 0 created, 47 skipped` while 47 ImportConflictErrors are buried); no `--dry-run`, no preview |
| STORES-C-004 | HIGH | src/ops/migrations.ts:26 | doctor suggests `db-cluster stores migrate` but the command does NOT exist in cli.ts (only `migration-status` and `verify-schema`) — phantom remediation path |
| STORES-C-006 | MEDIUM | src/ops/backup.ts:122 | `db-cluster backup -o existing.json` silently overwrites prior backup — no `--force`, no checksum |
| STORES-C-007 | MEDIUM | src/adapters/local/local-ledger-store.ts:134 | Ledger tail-corruption recovery emits one-time stderr at constructor + records `ledger_tail_corruption_recovered` event — but doctor/verify NEVER query it; operators investigating ledger weirdness see no persistent surface |
| STORES-C-008 | MEDIUM | src/ops/rebuild.ts:116 | `rebuild check` lists stale records but doesn't append `→ fix: db-cluster rebuild index` — operator told problem, not solution |
| STORES-C-009 | MEDIUM | src/adapters/local/errors.ts:20 | Typed-error messages (CorruptStoreError, InvalidContentHashError, ImportConflictError, ImportSnapshotNotSupportedError, LedgerCycleDetectedError) describe failure but rarely name a CLI command — operator forced to know surface by heart |
| SURFACE-C-005 | HIGH | src/cli.ts:145 | CLI error messages end at "WHAT failed" not "WHAT TO DO" — POLICY_DENIED tells which rule matched but not how to fix; CommandQueueCorruptError IS exemplary (errors.ts:82-87 spells out 3 recovery paths) — that pattern hasn't propagated |
| SURFACE-C-006 | HIGH | src/cli.ts:528 | `--self-approve --accept-soft-duty-bypass` dual-flag is non-obvious and not explained in --help text — operator hits the warning but doesn't understand the separation-of-duties rationale |
| SURFACE-C-007 | HIGH | src/cli.ts:1226 | `restore` and `backup` have NO `--dry-run`, NO confirmation, NO `--yes`, NO automatic pre-mutation snapshot — operator at wrong backup corrupts cluster with no warning + no undo |
| SURFACE-C-008 | HIGH | src/cli.ts:260 | Exit codes (77 EX_NOPERM, 70 EX_SOFTWARE, 65 EX_DATAERR, 78 EX_CONFIG) documented in source only — NOT in docs/cli.md, NOT in --help; operator CI scripts can't branch on them without source-reading |
| SURFACE-C-009 | MEDIUM | src/cli.ts:1001 | `policy explain` shows matched rule + reason but NOT which clause fired, NOT the closest alternative that would have allowed — operator iterates by guessing |
| SURFACE-C-010 | MEDIUM | src/cli.ts:1366 | Zero shell completion (bash/zsh/pwsh) — 30+ subcommands × flags = operator memorizes everything |
| SURFACE-C-011 | MEDIUM | src/cli.ts:23 | CLI hardcodes `CLUSTER_DIR = cwd/.db-cluster` — no `DB_CLUSTER_DIR` env (MCP surface HAS it — asymmetry), no persisted `~/.db-cluster/config.json` for actor/cluster-dir defaults |
| SURFACE-C-012 | MEDIUM | src/cli.ts:1192 | `doctor` output isn't sorted by severity, no footer with "Top fix: ...", no docs-URL links per failed check; only renders `→ fix:` when `suggestedCommand` is set (most checks don't) |
| TESTS-C-004 | HIGH | test/wave-b1-surface-regression.test.ts:95 | typedErrorToExitCode verified only by source-string presence — no test spawns CLI and asserts live `result.status === 77` (or 65/70/78); regression collapsing all codes to 1 would ship silently |
| TESTS-C-005 | HIGH | test/dashboard-ops.test.ts:45 | No CLI snapshot test asserts `→ fix: ${suggestedCommand}` appears in doctor stdout — load-bearing operator remediation hint is untested at the surface |
| TESTS-C-006 | MEDIUM | test/cli-docs.test.ts:107 | 8 `--json` flag sites are never `JSON.parse`d in tests — regression where opts.json branched off wrong shape would silently break operator pipelines |
| CIDOCS-C-002 | HIGH | docs/operations.md:14 | NO runbooks: `mutation_orphaned` never named in any user-facing doc; degraded/corrupt/unreachable states documented as commands not as recovery procedures |
| CIDOCS-C-003 | HIGH | docs/cli.md:328 | Exit-code → typed-error mapping completely undocumented — operators scripting against db-cluster have no map |
| CIDOCS-C-009 | MEDIUM | docs/handbook.md:539 | Handbook §9.6 Common damage scenarios = 2-column table with 1-3 word "recovery" cells; no verify-symptom / verify-recovery / escalate columns |

### 4c. Developer findings (17)

| ID | Sev | File:line | Headline |
|---|---|---|---|
| KERNEL-C-006 | HIGH | src/kernel/index.ts:16 | kernel/index.ts re-exports 6 of 11 typed errors; misses CommandQueuePersistenceLostError, ContentHashMismatchError, StagedContentTamperedError, InvalidContentShapeError, BufferSideChannelNotSupportedError, PolicyDeniedError — plus PolicyEnforcedKernel + command-lifecycle helpers (approveCommand, rejectCommand, markCommitted, markRejected, markCompensated, isValidTransition, validTransitions). Developers can't `if (err instanceof ...)` without deep imports |
| KERNEL-C-007 | HIGH | src/kernel/cluster-kernel.ts:88 | Every public method on ClusterKernel + PolicyEnforcedKernel lacks @param/@returns/@throws — ingestArtifact, createEntity, linkEvidence, commitMutation, compensateMutation can throw ReceiptFailedError but no @throws documents it |
| KERNEL-C-008 | MEDIUM | src/kernel/cluster-kernel-interface.ts:17 | ClusterKernelInterface has 30 method members, zero JSDoc each — the interface IS the contract; that's where descriptions should live |
| KERNEL-C-009 | MEDIUM | src/kernel/policy-enforced-kernel.ts:73 | PolicyEnforcedKernel constructor's load-bearing side-effect (constructs its OWN ClusterKernel with forwarded options including dataDir → disk writes) is undocumented; every wrapped method can throw PolicyDeniedError, none @throws it |
| KERNEL-C-010 | MEDIUM | src/kernel/errors.ts:1 | ClusterError base class has zero JSDoc, no contract description, no `ClusterErrorCode` union for type-narrowed switch arms; subclass JSDoc inconsistent (some have Recovery: bullet, some don't); BufferSideChannelNotSupportedError "reserved for future use" but no @experimental marker |
| KERNEL-C-011 | MEDIUM | src/kernel/cluster-kernel.ts:39 | `KernelOptions.dataDir` JSDoc is one line — implications (recursive mkdir, CommandQueue persistence, marker file, staging dir, orphan-tmp sweep at construction) buried in implementation |
| STORES-C-010 | HIGH | src/ops/doctor.ts:36 | ZERO `@throws`/`@param`/`@returns` across all of `src/ops/*.ts` (verified by grep). Public exports doctor/verify/backup/restore/rebuildIndex/checkStale/checkReceipts/checkProvenance/checkMigrationStatus/verifySchema — developers source-dive to discover throws/returns/options |
| STORES-C-011 | MEDIUM | src/contracts/ledger-store.ts:9 | Contract interfaces have heavy interface-level JSDoc but most methods (`append`, `update`, `ingest`) lack per-method semantic preconditions a custom-adapter author would need |
| SURFACE-C-013 | MEDIUM | src/sdk/cluster-sdk.ts:223 | 11 of ~15 public ClusterSDK methods lack JSDoc — pattern inconsistent (`commitMutation`/`retrieveBundle`/`policyExplain` ARE documented as exemplars; findSources/explainRetrieval/traceObject/why/proposeMutation/validateMutation/approveMutation/rejectMutation/compensateMutation/inspectCommand/listReceipts are not) |
| SURFACE-C-014 | MEDIUM | src/sdk/cluster-sdk.ts:143 | ClusterSDK constructor has no JSDoc — policy-vs-raw branch, principal-fallback warning behavior buried in inline `// SURFACE-R2-004 fix:` comments |
| SURFACE-C-015 | MEDIUM | src/kernel/errors.ts:1 | (overlaps KERNEL-C-010) — `code` union type + `CLUSTER_ERROR_CODES` const missing; cli.ts:260-282 and mcp/sanitize.ts:137-168 BOTH duplicate the enumeration with no shared type |
| SURFACE-C-016 | LOW | src/integrations/repo-knowledge/ingest.ts:152 | ingestRepoKnowledge JSDoc lacks @example, inferEntityKind heuristic undocumented for external override |
| TESTS-C-007 | MEDIUM | src/sdk/cluster-sdk.ts:1 | doc-drift.mjs typechecks docs/**/*.md typescript blocks but NOT JSDoc @example blocks in src/ — no automated proof SDK prose examples still work after refactors. Grep `@example` in src/ returns 0 real JSDoc blocks |
| CIDOCS-C-001 | HIGH | README.md:9 | README has "What this is/not" + "Architecture laws" + "CLI" but no "When you'd use db-cluster" / "Who is this for" — fails the 30-second test for a developer landing from npm/GitHub |
| CIDOCS-C-004 | HIGH | CHANGELOG.md:3 | CHANGELOG organized by internal swarm-finding IDs (AGG-005, STORES-B-013, SURFACE-B-004, CIDOCS-B-001); no per-version "User-visible changes" / "Breaking changes" / "Migration notes" audience-tagged sections |
| CIDOCS-C-005 | MEDIUM | examples/agent-safe-app-db/index.ts:1 | 4 of 7 example subdirectories (agent-safe-app-db, project-memory-cluster, research-evidence-cluster, sdk) have NO README; bar is examples/quickstart/README.md quality |
| CIDOCS-C-010 | LOW | package.json:56 | `keywords` sparse (7 terms); `description` is the same architecture poetry as README — npm-search tile won't tell a scrolling developer what problem db-cluster solves |

### 4d. Dashboard-viewer findings (8)

| ID | Sev | File:line | Headline |
|---|---|---|---|
| SURFACE-C-017 | HIGH | dashboard/components/OperationsPanel.jsx:9 | Panels return `null` on null/undefined `opsData` — no skeleton, no "loading...", no "no data yet"; viewer can't distinguish loading from broken from healthy-empty; same in CommandPreviewPanel.jsx:13 |
| SURFACE-C-018 | HIGH | dashboard/components/OperationsPanel.jsx:121 | When `orphanEvents > 0` warning text fires, the suggestedActions list below is a STATIC 4-item list unrelated to the failing condition; `repairSuggestions` built by ops-model.ts is NEVER consumed by JSX |
| SURFACE-C-019 | MEDIUM | dashboard/components/PolicyViewToggle.jsx:99 | Renderer-adapter contract documented (object marker `{_redacted: true}` vs string `'[REDACTED]'`) but NO consumer panel actually applies the adapter — `_redacted` markers would JSON.stringify to `{"_redacted":true}` literal text |
| SURFACE-C-020 | MEDIUM | dashboard/ClusterTruthInspector.jsx:605 | Action buttons "resolve" and "rebuild index" have `onClick={() => {}}` — non-functional stubs that look clickable; correct disabled+tooltip pattern at line 556-562 ("stage for commit") never propagated to siblings |
| TESTS-C-008 | HIGH | test/dashboard-snapshot.test.ts:9 | Zero render-the-component tests — only JSX source files string-grepped; panels' loading/empty/redaction-marker states untested; regression removing `if (!opsData) return null` would crash dashboard at boot |
| TESTS-C-009 | MEDIUM | test/dashboard-model.test.ts:60 | inspector-data.ts inspectEntity/inspectCommandObject NotFoundError-rejection on unknown ID is untested at the dashboard wrapper layer (kernel layer IS tested in explain.test.ts:76-78) |
| TESTS-C-010 | MEDIUM | test/dashboard-policy-view.test.ts:144 | applyRedaction transformation tested but the RESULTING DOM rendering of redaction markers (the operator-visible signal) is untested — regression rendering raw `[object Object]` would pass current tests |
| CIDOCS-C-007 | MEDIUM | dashboard/README.md:1 | dashboard/README.md (45 lines, ships in npm tarball) doesn't document per-component props/inputs/mount-in-host-app pattern; screenshots/ has 4 PNGs with no captions |

### 4e. Cross-cutting findings (6)

| ID | Sev | File:line | Headline |
|---|---|---|---|
| KERNEL-C-012 | MEDIUM | src/kernel/cluster-kernel.ts:284 | Single stderr write in kernel (`recordOrphanMutation` failure path) is a black hole for non-interactive consumers — no `OperatorSignal` channel, no typed-event seam for SDK/MCP/dashboard to subscribe |
| STORES-C-012 | LOW | src/adapters/local/local-ledger-store.ts:140 | Ledger constructor hard-codes `process.stderr.write` at module-load time — embedded SDK consumers calling `backup()` programmatically get unexpected stderr; no env-var opt-out |
| SURFACE-C-021 | MEDIUM | src/cli.ts:220 | `safeJsonParse` errors echo V8's "Unexpected token } at position 42" — operator counts characters into a multi-line CLI argument; no input echo + caret like jq |
| SURFACE-C-022 | MEDIUM | src/cli.ts:1095 | CLI mixes `console.log` / `console.error` / `process.stderr.write` non-uniformly; warnings can leak to stdout (`db-cluster doctor --json \| jq` may fail); no `--quiet` / `--log-level` |
| SURFACE-C-023 | LOW | src/cli.ts:461 | `--limit` defaults vary across sibling commands (10 for find, 20 for receipts/retrieve/explain-retrieval/trace-bundle); MCP tool descriptions inconsistently echo defaults |

---

## 5. Findings by severity

### HIGH (25)

**AI-agent envelope poverty (4):**
- KERNEL-C-001 redactError() strips typed-error context
- KERNEL-C-002 no nextValidActions on command lifecycle
- SURFACE-C-001 MCP error envelope missing retryable/remediation_hint
- SURFACE-C-002 zero MCP tools for long-running ops

**Operator actionability (12):**
- STORES-C-001 mutation_orphaned no remediation
- STORES-C-002 rebuild/backup/restore no progress
- STORES-C-003 restore silently swallows errors + no --dry-run
- STORES-C-004 phantom `stores migrate` command
- SURFACE-C-005 CLI POLICY_DENIED tells operator what failed, not what to do
- SURFACE-C-006 --self-approve --accept-soft-duty-bypass undocumented rationale
- SURFACE-C-007 restore/backup no --dry-run, no confirm, no undo, no snapshot
- SURFACE-C-008 exit codes undocumented in user-facing surfaces
- TESTS-C-004 typedErrorToExitCode untested at CLI surface
- TESTS-C-005 doctor `→ fix:` line untested
- CIDOCS-C-002 NO operator runbooks for any degraded state
- CIDOCS-C-003 exit-code mapping undocumented

**Developer onboarding (5):**
- KERNEL-C-006 5 of 11 typed errors not exported from index
- KERNEL-C-007 every public kernel method lacks @param/@returns/@throws
- STORES-C-010 0 @throws across `src/ops/*` (verified by grep)
- CIDOCS-C-001 README fails 30-second "who is this for" test
- CIDOCS-C-004 CHANGELOG organized by internal swarm IDs

**Dashboard empty-state + render (4):**
- SURFACE-C-017 panels return null on null data (no skeleton/loading)
- SURFACE-C-018 OperationsPanel orphan warning not linked to action (repairSuggestions built but not consumed)
- TESTS-C-001 MCP error envelope shape never asserted end-to-end
- TESTS-C-008 zero component-render tests; JSX source files string-grepped only

### MEDIUM (38)

Concentrate on: kernel typed-error context (5), SDK JSDoc completeness (8), CLI operator polish (8), dashboard rendering parity (4), test coverage of user-facing invariants (6), docs runbook depth (5), package metadata (2).

### LOW (5)

- KERNEL: none
- STORES-C-012 ledger stderr no opt-out
- SURFACE-C-016 repo-knowledge JSDoc lacks @example
- SURFACE-C-023 --limit default inconsistency
- TESTS-C-011 no test/README.md or testing-conventions guide
- CIDOCS-C-010 package.json keywords sparse

---

## 6. Cross-cutting humanization themes

The 68 findings cluster into **eight load-bearing themes**. Each theme spans multiple domains and represents a humanization pattern rather than a localized fix.

### Theme 1 — Actionability gap (the largest theme; 12 HIGH + 8 MEDIUM)

Across CLI, MCP, stores, and docs, the same pattern: errors and warnings explain WHAT failed, never WHAT TO DO. Examples:
- SURFACE-C-005 (POLICY_DENIED), KERNEL-C-001 (typed-error context stripped at MCP), STORES-C-001 (mutation_orphaned), CIDOCS-C-002 (no operator runbooks), CIDOCS-C-003 (exit codes undocumented), SURFACE-C-008 (exit codes), SURFACE-C-009 (policy explain), SURFACE-C-012 (doctor footer), SURFACE-C-021 (JSON parse errors), STORES-C-008 (stale records), STORES-C-009 (typed-error messages don't name CLI commands).

`CommandQueueCorruptError` (errors.ts:82-87) is the **exemplar** — 3 recovery paths spelled out in the message. That pattern hasn't propagated to the other ~10 typed errors or to CLI/MCP surfaces.

### Theme 2 — AI envelope poverty (4 HIGH + 7 MEDIUM)

The MCP/SDK boundary sanitizes to `{code, message}` and stops. The rich subclass context (claimedHash, actualHash, filePath, decision.capability, cause.name) — designed to be read by callers via `instanceof` branches — is collapsed to prose. No `retryable: boolean`, no `remediation_hint: string`, no `context: Record`, no `next_valid_actions: CommandStatus[]`, no `_meta.empty_reason: 'no_data' | 'no_match' | 'all_filtered'`, no per-verb payload schema.

The structure is in place to fix this (Wave B1-Amend landed BUILTIN_ERROR_CODES + RedactedMarker + nextSteps on success path) — but the error path didn't get the enrichment.

### Theme 3 — Long-running ops + destructive-op safety (3 HIGH + 2 MEDIUM)

`rebuildIndex`, `backup`, `restore` all walk records serially with no progress callback (STORES-C-002). `restore` silently rebuilds index + swallows entity errors (STORES-C-003). `backup -o existing.json` silently overwrites (STORES-C-006). `restore` has no `--dry-run`, no confirmation, no automatic pre-mutation snapshot, no undo (SURFACE-C-007). MCP has no long-running-op tools at all (SURFACE-C-002).

### Theme 4 — Empty/edge-state and contract-implementation parity (4 HIGH + 4 MEDIUM)

Dashboard panels return `null` instead of skeletons (SURFACE-C-017). The `_redacted` renderer-adapter contract documented in PolicyViewToggle.jsx is **not implemented** at any consumer panel (SURFACE-C-019). `repairSuggestions` built by ops-model.ts is **never consumed** by OperationsPanel JSX (SURFACE-C-018). Stub onClick handlers look clickable (SURFACE-C-020). Render-state coverage absent (TESTS-C-008, TESTS-C-009, TESTS-C-010).

This theme also intersects with **silent zero-value reads from wrong field names** (5 should-have-been-A items in Surface) — ops-model.ts reads `indexStatus.totalRecords`/`missingRecords` against an actual shape of `total`/`byStore`/`expectedTotal`/`possiblyStale`.

### Theme 5 — Developer JSDoc + export completeness (5 HIGH + 8 MEDIUM)

Inconsistent JSDoc discipline across the package: `commitMutation`/`retrieveBundle`/`policyExplain` are exemplars (rich JSDoc + recovery prose); 11 of ~15 SDK methods + every kernel public method + all of `src/ops/` (0 @throws) are not. Five typed errors not re-exported from `kernel/index.ts`. No `ClusterErrorCode` union — cli.ts and mcp/sanitize.ts duplicate the enumeration with no shared type. ClusterKernelInterface has 30 method members and zero JSDoc each.

### Theme 6 — Operator first-touchpoint discoverability (3 HIGH + 2 MEDIUM)

README fails the 30-second "who is this for" test (CIDOCS-C-001). CHANGELOG written for internal coordinator audience (CIDOCS-C-004). Four examples lack READMEs (CIDOCS-C-005). dashboard/README.md doesn't document component props (CIDOCS-C-007). package.json keywords sparse (CIDOCS-C-010).

### Theme 7 — Tests-as-spec for user-facing behavior (4 HIGH + 6 MEDIUM)

The 921 test count is overwhelmingly weighted toward INTERNAL correctness (right typed-error class thrown, right kernel state after mutation, right index state after rebuild). USER-VISIBLE behavior is largely uncovered:
- TESTS-C-001 MCP error envelope shape not asserted
- TESTS-C-004 exit codes not asserted (only source-string presence)
- TESTS-C-005 doctor `→ fix:` line not asserted
- TESTS-C-006 8 `--json` flag sites never `JSON.parse`d
- TESTS-C-008 zero render-the-component tests

### Theme 8 — Operator-stdout / debug-stderr / structured-log discipline (3 MEDIUM)

CLI mixes `console.log`, `console.error`, `process.stderr.write` non-uniformly — warnings can leak to stdout, breaking `db-cluster doctor --json | jq` (SURFACE-C-022). No `--quiet` / `--log-level`. Kernel + ledger emit stderr unconditionally with no embedder hook (KERNEL-C-012, STORES-C-012). No shell completion (SURFACE-C-010). No persisted CLI config (SURFACE-C-011 — also asymmetry with MCP surface which honors DB_CLUSTER_DIR).

---

## 7. Audit confidence gaps (acknowledged)

Stage C is read-only; the 5 auditors did not interactively exercise the surfaces they audited. The following are gaps in audit confidence:

- **Tests agent** verified test coverage by grep + read, not by simulating regressions to see if they'd be caught. The "would ship silently" claims are deductive from source reading.
- **Surface agent** identified `onClick={() => {}}` stubs by code-read; "looks clickable" is a UX claim that wasn't verified in a browser. Dashboard JSX wasn't rendered — claims about rendering pathology are deductive.
- **Kernel agent** identified `_meta.error` envelope shape gaps by source-reading `redactError` + `server.ts` catch arm; didn't perform an MCP-host roundtrip to confirm the actual AI consumer experience.
- **Stores agent** flagged `db-cluster stores migrate` as phantom command by grepping cli.ts; didn't verify Postgres-side whether the underlying `PostgresCanonicalStore.migrate()` method works (Stage B B1-Amend deferred Postgres applied_migrations registry to v0.2).
- **CI/Docs agent** estimated package.json keyword + description quality by reading peer tools' docs (not by querying npm-search rankings).

These confidence gaps are appropriate for an Audit phase. The Wave C1-Amend dispatch should account for them: where the audit says "regression would ship silently," the amend wave's test-first gate should write a failing-against-HEAD test that confirms the claim.

---

## 8. Per-domain summaries

### Kernel (12 findings + 1 should-have-been-A)

Structurally sound after Stage B. The Stage C gap is wide on TWO fronts:

1. **AI-agent envelope poverty:** MCP `_meta.error` strips every typed error to `{code, message}` — none of the rich subclass context reaches the AI; no `retryable`; no `remediation_hint`; no `nextValidActions` on command-lifecycle responses; no `_meta.filteredCount` distinguishing empty-from-no-match vs empty-from-policy-filtered. The AI is forced to parse prose.

2. **Developer onboarding:** `kernel/index.ts` is missing exports for 5 of 11 typed errors, PolicyEnforcedKernel + PolicyDeniedError, and the command-lifecycle helpers. Public-method JSDoc lacks @param/@returns/@throws on every verb. ClusterKernelInterface members carry zero JSDoc. RedactedMarker doesn't name the gated capability so AI can't request the right one.

**should-have-been-A**: six bare-`new Error()` throws on lifecycle state-transition paths (commands.ts:77 validateCommand, plus 5 sibling sites) defeat the typed-error contract.

### Stores (12 findings + 1 should-have-been-A)

Plumbing is solid (typed errors + content-hash validation + NDJSON ledger with archive-sweep + mutation_orphaned signal). The gap concentrates in two places:

1. **Operator-facing surface stops at "told you the problem":** orphans, tail corruption, restore errors, and stale-record output all leave the operator looking up the next command rather than seeing it inline.

2. **Long-running operations are opaque:** rebuild/backup/restore give zero progress feedback, with no destructive-op confirmation, no `--dry-run` on restore, silent backup-file overwrite.

Developer class also under-served: zero @throws/@param/@returns across all of `src/ops/`, despite heavy interface-level prose.

**should-have-been-A**: `doctor.ts:202` references `db-cluster stores migrate` — command does not exist in cli.ts. Phantom remediation.

### Surface (23 findings + 5 should-have-been-A)

The highest-volume Stage C domain as predicted. Stage B remediation closed all structural surface gaps; what remains is:

- **CLI:** typed errors are mapped to exit codes, but messages tell operators WHAT failed not WHAT TO DO; exit codes are documented only in source; restore has no dry-run/confirm/undo; no shell completion; no persisted config (CLI also doesn't honor DB_CLUSTER_DIR — asymmetry with MCP surface).
- **MCP:** error envelope is the bare-minimum {code, message}; no long-running-op tools at all; per-verb payload schemas absent; success-path nextSteps strings present but error path has no parallel.
- **SDK:** 11 of 15 public methods lack JSDoc; constructor side-effects buried in inline comments.
- **Dashboard:** panels return null on null data; documented renderer-adapter contract not implemented at call sites; stub onClick handlers look clickable; RepairSuggestion contextual-action list built by ops-model.ts is NEVER consumed by JSX.

**should-have-been-A items (5):** dashboard ops-model wrong field names (`totalRecords`/`missingRecords` vs actual `total`/`byStore`/`expectedTotal`/`possiblyStale`) — silent zero counts; `compare-retrieval.ts` reads `r.object.owner` field that doesn't exist on Entity; `provenanceHealth.totalEvents: 0` hardcoded TODO; dashboard `index.html` hardcoded `v0.1.0` version drift; validate render hole when `cmd.validation` undefined.

### Tests (11 findings, 0 should-have-been-A)

The 921 test count is structurally strong but largely covers INTERNAL correctness. User-visible behavior is uncovered:
- MCP error envelope shape never asserted end-to-end
- typedErrorToExitCode verified only by source-string presence (no test asserts live `result.status === 77`)
- doctor `→ fix:` line never asserted
- 8 `--json` flag sites never `JSON.parse`d
- MCP success-path `_meta.nextSteps`/`_meta.warning` strings never asserted
- Only ONE MCP empty-state test (cluster_retrieve_bundle); 6 sibling read tools uncovered
- Zero render-the-component tests (JSX source files string-grepped only)
- No test/README.md or testing-conventions guide

### CI/Docs (10 findings + 1 should-have-been-A)

Repo has 40+ docs but the gap is between "docs exist comprehensively" and "docs help the user who needs them":

1. **Developer first-touchpoint:** README passes structural-clarity but fails the 30-second test; CHANGELOG organized by internal swarm-finding IDs; 4 of 7 examples lack READMEs.
2. **Operator runbook depth:** docs document what doctor/verify report but not what to do when they report it; `mutation_orphaned` never named in user-facing docs; CLI exit codes completely undocumented.
3. **AI-agent integration:** MCP error envelope shape undocumented; agent-safe example shows only happy path.

**should-have-been-A**: `examples/quickstart/README.md:37` says "Node.js 18+" while all other Node-20+ surfaces (README, docs/quickstart.md, package.json engines, CI matrix) require 20+. Wave B1-Amend CIDOCS-B-003 sweep missed this file.

---

## 9. Stage C lens family proposal for Wave C1-Amend verifier ensemble

Per the canonical dogfood-swarm protocol v2 (saturation-based exit, submodularity precondition ρ < 0.25, family-of-call-sites probe), the Wave C1-Amend verifier ensemble needs three adversarial lenses with low pairwise correlation. The audit surfaced 8 cross-cutting themes; three orthogonal lenses cover them with minimal overlap:

### Lens C-V1 — Actionability-envelope lens

**Adversarial mindset:** "find any user-facing response (error envelope, warning, status report, log line) that lacks an actionable next-step field for its consumer class."

**Probes per user class:**
- AI: every MCP/SDK error response surface — does it carry `retryable: boolean` + `remediation_hint: string` + `context: Record` + (for state-transition tools) `next_valid_actions: CommandStatus[]`?
- Operator: every CLI message that surfaces a failure — does it name the next command? Every doctor/verify check — does it set `suggestedCommand`?
- Developer: every public method JSDoc — does it carry @throws + @param + at least one `@example`?
- All: typed-error messages — do they name a CLI command the consumer can run?

**Catches:** Theme 1 (actionability gap), Theme 2 (AI envelope poverty), Theme 5 (JSDoc completeness), Theme 6 (first-touchpoint), most of Theme 8 (operator-stdout discipline).

### Lens C-V2 — Operator-progress and destructive-op safety lens

**Adversarial mindset:** "find any long-running or destructive operation, on any surface, that lacks progress feedback, a dry-run/confirmation gate, or an undo path; find any operator-pipeline-corruption risk (stderr/stdout mixing)."

**Probes:**
- Every kernel/SDK method that walks ALL records of any store → progress callback on the contract?
- Every CLI command marked destructive → `--dry-run` AND (`--yes` OR interactive prompt) AND pre-mutation snapshot?
- Every MCP tool description → time-bound expectation when it could be long-running?
- Every CLI subcommand's stdout vs stderr discipline — does a piping operator get clean payload?
- Every backup/output-file path → overwrite protection?

**Catches:** Theme 3 (long-running ops + destructive-op safety), Theme 8 (stdout/stderr discipline) where it intersects with destructive operations.

### Lens C-V3 — Edge-state and contract-implementation-parity lens

**Adversarial mindset:** "find any component, method, or test that fails to handle an edge input (empty / loading / unknown / error / redacted); find any documented contract that isn't actually wired at the call site; find any consumer of a typed shape that reads the wrong field names."

**Probes:**
- Every dashboard component → empty/loading/error/redacted render states explicit?
- Every documented renderer-adapter / model-built data structure → actually consumed by the JSX/CLI/MCP it was built for?
- Every consumer of a documented shape → field names match the producer? (Catches the ops-model.ts `totalRecords` vs `total` class.)
- Every test surface — does it actually RENDER components / spawn the CLI / roundtrip MCP envelopes? Or only string-grep source / unit-test functions in isolation?
- Every documented invariant (in README/handbook/JSDoc) → at least one regression test that demonstrates the FULL invariant?

**Catches:** Theme 4 (empty/edge-state and contract-parity), Theme 7 (tests-as-spec for user-facing behavior). Also catches the should-have-been-A class of ops-model field-name bugs (Surface 5 items).

### Expected pairwise submodularity

- C-V1 (Actionability) ↔ C-V2 (Op-progress) — overlap mostly on CLI destructive-op messages where actionability AND safety apply; expected ρ ≈ 0.15.
- C-V1 ↔ C-V3 (Edge-state) — overlap on empty-state envelopes for AI consumers (actionable field for empty AND no-crash on empty); expected ρ ≈ 0.10.
- C-V2 ↔ C-V3 — overlap on long-running-op-progress vs dashboard-rendering-loading-state (different surfaces, similar shape); expected ρ ≈ 0.10.

All pairs expected < 0.25 (Codex-Verify 2025 submodularity precondition). The Wave C1-Amend dispatch should measure actual ρ post-verifier-pass and rewrite lenses if any pair > 0.25.

### Family-of-call-sites probe instruction (carry forward — canonical)

Every verifier prompt MUST include: "For every fix in this wave, after probing the named site, probe the family-of-call-sites for the same pattern. Example: if a fix adds remediation_hint to ContentHashMismatchError surfacing, check every OTHER typed error subclass; if any still surfaces with bare {code, message}, flag. If a fix renders a loading skeleton on OperationsPanel, check every sibling component; if any still returns null, flag. If a fix adds @throws to ingestArtifact, check every public kernel method; if any still lacks it, flag."

Audit surfaced multiple "exemplary site + sibling-pattern misses" already: `CommandQueueCorruptError` is the exemplary error message but the pattern hasn't propagated to ~10 sibling typed errors; `commitMutation`/`retrieveBundle`/`policyExplain` are exemplary JSDoc but 11 sibling SDK methods aren't; the dashboard `stage for commit` button at line 556-562 is the exemplary disabled+tooltip pattern but `resolve` and `rebuild index` siblings have no-op stubs.

---

## 10. Should-have-been-Stage-A findings (8 items)

These are bugs surfaced during the humanization audit that are NOT humanization issues. Per protocol, they go to a small A5 wave OR fold into Wave C1-Amend with explicit "should-have-been-A" notation.

| ID | Domain | Sev | File:line | Issue |
|---|---|---|---|---|
| SHA-KERNEL-C-001 | Kernel | MEDIUM | src/kernel/commands.ts:77 (+ 5 siblings) | 6 bare `new Error()` throws on kernel state-transition paths — defeats typed-error `instanceof` branches the hierarchy is designed for |
| SHA-STORES-PHANTOM-CMD | Stores | MEDIUM | src/ops/doctor.ts:202 | doctor's `suggestedCommand: 'db-cluster stores migrate'` references a command that doesn't exist in cli.ts |
| SHA-SURFACE-LEAK-1 | Surface | MEDIUM | src/dashboard/ops-model.ts:150 | `buildOpsModel` reads `indexStatus.totalRecords` / `missingRecords` — actual shape is `total`/`byStore`/`expectedTotal`/`possiblyStale`. Dashboard IndexHealth always shows 0 |
| SHA-SURFACE-LEAK-2 | Surface | LOW | src/integrations/repo-knowledge/compare-retrieval.ts:78 | `compareRetrieval` reads `r.object.owner` — Entity has no owner field; `resolvesToOwnerTruth` always false |
| SHA-SURFACE-LEAK-3 | Surface | LOW | src/dashboard/ops-model.ts:234 | `provenanceHealth.totalEvents: 0` hardcoded TODO; dashboard always shows 0 events |
| SHA-SURFACE-LEAK-4 | Surface | LOW | dashboard/index.html:129 | Header text hardcoded `v0.1.0 · phase-1` — version drift; same fix as SURFACE-B-013 closed for CLI/MCP |
| SHA-SURFACE-LEAK-5 | Surface | LOW | src/cli.ts:596 | `db-cluster validate <id>` silently renders empty when `cmd.validation` undefined on a 'validated' status |
| SHA-CIDOCS-C-SHBA-001 | CI/Docs | HIGH | examples/quickstart/README.md:37 | Says "Node.js 18+" while all other surfaces require 20+ — Wave B1-Amend CIDOCS-B-003 sweep missed this file. User-facing factual contradiction. |

**Coordinator recommendation:** the 8 should-have-been-A items split into:
- 2 HIGH/MEDIUM that should be fixed in Wave C1-Amend as standalone test-first items (SHA-KERNEL-C-001 typed-error coverage, SHA-CIDOCS-C-SHBA-001 one-line README fix)
- 3 MEDIUM/LOW silent-zero dashboard bugs (SHA-SURFACE-LEAK-1, -3, -5) folded into Wave C1-Amend's Surface domain alongside SURFACE-C-017/018/019/020 (dashboard humanization cluster) — they share the same files and the same fix discipline
- 2 LOW leftovers (SHA-SURFACE-LEAK-2, -4) — defer to a future A5 sweep OR coordinator surgical fix

The phantom `db-cluster stores migrate` command (SHA-STORES-PHANTOM-CMD) is intentionally NOT classified should-have-been-A in isolation — Stage B B1-Amend explicitly deferred the Postgres applied_migrations registry work to v0.2 (AGG-B1-7). Either fix in C1-Amend by dropping the suggestedCommand promise OR keep deferred and let it land with v0.2 — coordinator decision.

---

## 11. Audit deliverables manifest

This Stage C audit produced:

- `swarm-stage-c-audit-1-1779892297.md` — this consolidated report
- 5 agent JSON deliverables (printed inline within agent return blocks; coordinator preserved in this report's findings tables)
- Save-point tag `swarm-stage-c-audit-1-1779891499` retained for revert capability

No code changes. No file writes outside this report. Baseline (lint + 3/3 deterministic 921/55/0 + release-gate 8/8) unchanged from B1-Amend close.

---

## 12. What hands to the advisor next

### Wave C1-Audit summary

- **68 humanization findings** across 5 domains and 4 user classes
- **25 HIGH** (concentrated on operator-actionability, AI-envelope poverty, dashboard empty-state, developer onboarding)
- **38 MEDIUM** (JSDoc gaps, CLI polish, test coverage of user-facing invariants, docs runbook depth)
- **5 LOW** (cosmetic / convention)
- **8 should-have-been-A** items (1 HIGH README contradiction, 1 phantom CLI command, 1 typed-error bypass, 5 dashboard silent-zero / hardcoded-value items)

### Proposed Stage C lens family (for Wave C1-Amend verifier ensemble)

1. **Actionability-envelope** — next-step / remediation_hint / @throws coverage across all consumer classes
2. **Operator-progress and destructive-op safety** — progress callbacks + dry-run/confirm/undo + stdout/stderr discipline
3. **Edge-state and contract-implementation-parity** — empty/loading/error/redacted rendering + documented-contract-actually-wired + producer/consumer field-name parity

Expected pairwise Jaccard ρ < 0.25 (submodularity precondition). Family-of-call-sites probe instruction carries forward as canonical-protocol load-bearing.

### Pre-amend baseline

- HEAD `dea915f`, branch `main` (10 ahead of `origin/main`)
- `npm run lint`: PASS
- `npm test`: 3/3 deterministic at **921/55/0 across 73 files**
- `node scripts/release-gate.mjs`: **8/8 PASS — ready for release**
- Save-point tag created: `swarm-stage-c-audit-1-1779891499`

### Hand to advisor

**Wave C1-Audit complete. Hand to advisor for Stage C amend dispatch decision.**

---

*End of Stage C Wave C1-Audit audit report. Hand to advisor for Stage C amend dispatch decision.*
