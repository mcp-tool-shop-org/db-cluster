# Dogfood Swarm Stage B Wave B1-Amend — Verifier Ensemble Aggregate — db-cluster — 2026-05-27

**Repo:** `mcp-tool-shop-org/db-cluster`
**Working copy:** `E:/AI/db-cluster`
**Aggregate type:** Wave B1-Amend verifier ensemble synthesis (V1+V2+V3 → ranked clusters + judgment)
**Coordinator:** Wave B1-Amend coordinator-as-judge
**Aggregate date:** 2026-05-27

---

## 1. Inputs

| Verifier | Lens | Output | Findings |
|---|---|---|---|
| V1 | Resilience under stress | `.verifier-outputs-b1/v1-wave-b1-resilience.json` | 15 |
| V2 | Operational visibility | `.verifier-outputs-b1/v2-wave-b1-operational-visibility.json` | 15 |
| V3 | Migration safety + forward compatibility | `.verifier-outputs-b1/v3-wave-b1-migration-safety.json` | 15 |
| **Total raw** | | | **45** |

All three lenses received the **family-of-call-sites probe instruction** (canonical v2 protocol). All three also received this wave's load-bearing question: V3 was asked to specifically probe the label-rendering pattern bifurcation introduced by the coordinator fix-up (renderPublicLabel → renderProvenanceLabel(labelData, [])).

## 2. Severity rollup

| Severity | V1 | V2 | V3 | Total |
|---|---:|---:|---:|---:|
| CRITICAL | 0 | 0 | 0 | **0** |
| HIGH | 3 | 4 | 7 | **14** |
| MEDIUM | 8 | 6 | 5 | **19** |
| LOW | 4 | 5 | 3 | **12** |
| **TOTAL** | **15** | **15** | **15** | **45** |

All three lenses respected their 15-finding caps.

## 3. Pairwise correlation (Jaccard ρ)

| Pair | file:line Jaccard | Abstraction-level convergence | Interpretation |
|---|---|---|---|
| V1 ↔ V2 | **~0.07** (2 of ~28 unique sites) | High: V1-B1-007/V2-B1-011 ops-model defensive-zero, V1-B1-011/V2-B1-005 labelData unused | Below 0.25 threshold. Sufficiently distinct. |
| V1 ↔ V3 | **~0.10** (2-3 of ~27 sites) | High: V1-B1-011/V3-B1-001/V3-B1-002 boundary-unenforced cluster, V1-B1-012/V3-B1-010 PATH_REGEX area | Below 0.25. |
| V2 ↔ V3 | **~0.13** (3-4 of ~28 sites) | High: V2-B1-005/V3-B1-001/V3-B1-002 labelData-unused convergence, V2-B1-003/V3-B1-012 rotate-no-surface, V2-B1-014/V3-B1-004 docs-not-updated | Below 0.25. |

**Submodularity verdict:** All pairs at or below 0.25 threshold per Codex-Verify 2025 (arXiv:2511.16708). The 3-lens ensemble continues to satisfy the submodularity precondition; Stage B's chosen lenses (resilience / operational-visibility / migration-safety) are sufficiently distinct.

## 4. High-signal clusters (≥2 lenses agreed OR severity ≥ HIGH single-lens)

Nine clusters surface. Each one's column "Disposition" marks the coordinator-as-judge call.

### AGG-B1-1 — Label-rendering boundary unenforced (LOAD-BEARING — 5 findings across 3 lenses)

| Lens | Finding | Severity |
|---|---|---|
| V1 | V1-B1-011 — renderProvenanceLabel has 0 production callers outside trace-builder.ts; PolicyEnforcedKernel.traceObject doesn't call it | HIGH |
| V2 | V2-B1-005 — MCP sanitizeProvenanceNodeForOutput emits opaque `[type in store]` placeholder; drops metadata.labelData | MEDIUM |
| V3 | V3-B1-001 — dashboard/inspector-data.ts accepts bare ClusterKernel and surfaces literal `node.label` to AI-facing surface | HIGH |
| V3 | V3-B1-002 — trace-builder.ts:578-583 JSDoc claims "structurally stripped" — post-coordinator-fixup code returns literal | HIGH |
| V3 | V3-B1-014 — inspector signatures use concrete ClusterKernel, not the parity interface | LOW |

**V3's special-probe verdict:** `flagged-as-finding` — the bifurcation IS the load-bearing migration-safety gap. JSDoc and code disagree; PolicyEnforcedKernel doesn't bridge; dashboard-snapshot script actively violates the doctrine by instantiating bare ClusterKernel.

**Disposition:** **Fix-up now.** Three sub-fixes:
1. Update the stale JSDoc in `src/provenance/trace-builder.ts:566-602` to match the new "literal at bare kernel, policy-aware at boundary" doctrine (the immediate consequence of the coordinator fix-up).
2. Wire `renderProvenanceLabel` into `PolicyEnforcedKernel.traceObject` + `traceBundle` so policy-aware redaction actually applies labels per the policy view. Without this, the AGG-008 machinery (entity_name / artifact_filename RedactionTargets) is dead config.
3. Document the doctrine in `docs/policy-and-redaction.md` (or similar): bare ClusterKernel = trusted internal; AI-facing must use PolicyEnforcedKernel. (Promoting the boundary upstream via branded types is B2 architectural; doctrine ratification is sufficient for B1-Amend.)

### AGG-B1-2 — `LedgerStore.rotate()` correctness + operator-surface cluster (6 findings)

| Lens | Finding | Severity |
|---|---|---|
| V1 | V1-B1-001 — rotate() mutates this.events = retainEvents BEFORE persist; split-brain on mid-write failure | HIGH |
| V1 | V1-B1-002 — rotate() no input validation; empty string / non-ISO silently no-ops or unpredictable | HIGH |
| V1 | V1-B1-003 — archive directory's orphan .tmp files never swept | HIGH |
| V2 | V2-B1-003 — rotate() has no CLI / MCP / SDK exposure; operators with unbounded growth have no recovery path | HIGH |
| V2 | V2-B1-010 — future-timestamp safeguard indistinguishable from nothing-to-archive | MEDIUM |
| V3 | V3-B1-012 — adding REQUIRED method to published contract with no migration story | MEDIUM |

**Disposition:** **Fix-up now (correctness items)** + **defer (architectural)**:
- V1-B1-001 atomicity: fix-up. Persist FIRST, mutate in-memory AFTER both persist calls succeed. Snapshot for rollback.
- V1-B1-002 input validation: fix-up. `Date.parse(beforeTimestamp)` check; throw typed `InvalidRotateTimestampError`.
- V1-B1-003 archive orphan sweep: fix-up. Sweep `<dataDir>/ledger-archive/` at constructor.
- V2-B1-003 operator surface: **defer to B2** — needs CLI/MCP design pass (approval-sensitive); breadcrumb in fix-up report.
- V2-B1-010 safeguard signal: fix-up. Throw on future timestamp (typed `RotateBoundaryInFutureError`) — simpler than RotateResult discriminator.
- V3-B1-012 deprecation: **defer to B2** — pairs with SURFACE-B-018 (deprecation policy).

### AGG-B1-3 — Hardcoded `db-cluster-0.1.0.tgz` in scripts/ (SURFACE-B-013 family-probe miss)

| Lens | Finding | Severity |
|---|---|---|
| V3 | V3-B1-003 — scripts/release-gate.mjs:111 | HIGH |
| V3 | V3-B1-013 — scripts/smoke-install.mjs:16 | MEDIUM |

**Disposition:** **Fix-up now.** SURFACE-B-013's family probe stopped at src/ (Surface domain); scripts/ is CI/Docs ownership. Cross-domain family-probe miss. ~5-line fix per site: read package.json version.

### AGG-B1-4 — NDJSON ledger silent tail-corruption (asymmetric with CommandQueuePersistenceLostError)

| Lens | Finding | Severity |
|---|---|---|
| V2 | V2-B1-004 — NDJSON loader at loadArray() silently discards bad-tail lines; no signal | HIGH |

**Disposition:** **Fix-up now.** Wave A4 made `CommandQueue.load()` loud-on-loss; the parallel ledger pattern is silent. Same family. Add stderr warn + record a `ledger_tail_corruption_recovered` ledger event so doctor/verify can later surface.

### AGG-B1-5 — Dashboard OperationsPanel shape mismatch + not mounted

| Lens | Finding | Severity |
|---|---|---|
| V2 | V2-B1-001 — Panel reads `opsData.doctor.overall`, `provenanceHealth.receipts`, `provenanceHealth.events` — fields that don't exist on OpsModel | HIGH |

**Disposition:** **Fix-up now (shape mismatches).** The panel reads fields that don't exist. Fix the shape mismatches. (Mounting in demo is Stage D Visual Polish scope, not B1.)

### AGG-B1-6 — `doctor()` CLI doesn't pass dataDir → no_orphan_staging skipped

| Lens | Finding | Severity |
|---|---|---|
| V2 | V2-B1-002 — `db-cluster doctor` CLI and dashboard's ops-model both call `doctor(stores)` without dataDir/commandQueue options | HIGH |

**Disposition:** **Fix-up now.** Trivial. 2 lines per site to pass dataDir + commandQueue. The new staging health check is otherwise dead at every operator-facing surface.

### AGG-B1-7 — Postgres applied_migrations registry not closed (STORES-B-005)

| Lens | Finding | Severity |
|---|---|---|
| V3 | V3-B1-006 — Postgres has no applied_migrations table | HIGH |
| V3 | V3-B1-008 — verifySchema hardcoded column list (missing 'owner' column) | MEDIUM |

**Disposition:** **DEFER to v0.2 design pass** per explicit audit §9.5 framing. STORES-B-005 was in the audit but NOT in the wave dispatch §3 fix scope — it requires a migrations architecture design pass. Document the deferral; V3-B1-008 hardcoded column list pairs with this work.

### AGG-B1-8 — No @deprecated / no MIGRATION.md (SURFACE-B-018)

| Lens | Finding | Severity |
|---|---|---|
| V3 | V3-B1-007 — Zero @deprecated markers on SDK/MCP/CLI | HIGH |
| V3 | V3-B1-012 — rotate() REQUIRED is structural break with no migration choreography | MEDIUM (covered in AGG-B1-2) |

**Disposition:** **DEFER to B2** per Surface agent's explicit §7 self-assessment. The wave dispatch deferred SURFACE-B-018 to B2 architectural pack. Document the deferral.

### AGG-B1-9 — Stale documentation for new wave-B1 contract surfaces

| Lens | Finding | Severity |
|---|---|---|
| V2 | V2-B1-009 — NDJSON format change undocumented | MEDIUM |
| V2 | V2-B1-014 — docs/operations.md doesn't mention new surfaces | LOW |
| V3 | V3-B1-004 — docs/store-contracts.md not updated for rotate/countEvents/importEvent/importReceipt | HIGH |
| V3 | V3-B1-009 — new RedactionTargets (entity_name, artifact_filename) undocumented | MEDIUM |
| V3 | V3-B1-011 — events.json misleading filename for NDJSON content | MEDIUM |

**Disposition:** **Fix-up now (V3-B1-004 + V3-B1-009).** docs/store-contracts.md is the highest-leverage update (consumed by adapter implementers). docs/policy-and-redaction.md: add note about the new targets. **Defer** the events.json filename rename (operator-visible breaking change; pair with v0.2). **Defer** the broader docs/operations.md sweep (B2).

### Other single-lens findings — disposition

| ID | Severity | Disposition |
|---|---|---|
| V1-B1-004 (backup hash recompute at backup-time) | MEDIUM | **Defer** — restore-side check exists; backup-time recompute is defense-in-depth |
| V1-B1-005 (backup staging race) | MEDIUM | **Defer** — narrow race window; document |
| V1-B1-006 (NDJSON empty-id pass-through) | MEDIUM | **Fix-up now** — small (3-line tighten of shape gate) |
| V1-B1-007 + V2-B1-011 (ops-model defensive-zero collapses degraded → healthy) | MEDIUM × 2 | **Fix-up now** — distinguish feature-not-supported from runtime-error |
| V1-B1-008 (doctor TOCTOU on no_orphan_staging) | MEDIUM | **Defer** — narrow race; documented as best-effort |
| V1-B1-009 (Windows fsync no-op on read-only handle) | MEDIUM | **Defer** — Windows-specific durability; document |
| V1-B1-010 (recordOrphanMutation stderr scrub asymmetric) | MEDIUM | **Fix-up now** — 1-line scrub |
| V1-B1-012 (PATH_REGEX missing relative-path arm) | LOW | **Defer** — operator-supplied; not a leak vector |
| V1-B1-013 (dashboard ESM readiness diagnostics) | LOW | **Defer** — UX polish; Stage D |
| V1-B1-014 (process.exit drops microtasks) | LOW | **Defer** — broader CLI HOF design; B2 |
| V1-B1-015 (backup restore mkdir error surfacing) | LOW | **Defer** — defensive polish |
| V2-B1-006 (PolicyConfigError missing from BUILTIN_ERROR_CODES) | MEDIUM | **Fix-up now** — 1-line addition |
| V2-B1-007 (PATH_REGEX duplicated) | MEDIUM | **Defer** — consolidation; B2 |
| V2-B1-008 (verify other checks silent-capped) | MEDIUM | **Defer** — apply STORES-B-014 pattern in B2 |
| V2-B1-012 (trace-builder warning placeholder no detail) | LOW | **Defer** — pairs with V2-B1-005 |
| V2-B1-013 (backup/restore emits no ledger event) | LOW | **Defer** — audit-trail design pass |
| V2-B1-015 (typed-error structured fields invisible to operator) | LOW | **Defer** — operator-facing structured-error design pass |
| V3-B1-005 (ops-model.ts feature-detects countEvents despite REQUIRED) | HIGH | **Fix-up now** — drop the feature-detect; call directly |
| V3-B1-010 (regex band-aid still in place after structural fix) | MEDIUM | **Defer** — pairs with B-1 doctrine ratification |
| V3-B1-015 (release-notes filename convention) | LOW | **Defer** — low priority |

## 5. Fix-up dispatch — 14 items consolidated

The coordinator dispatches a single fix-up agent (parallel to Wave A4 pattern). Items, in dependency order:

### Tier 1 — Architectural integration (label-rendering boundary)
1. **AGG-B1-1a** — Update stale JSDoc in `src/provenance/trace-builder.ts:566-602`
2. **AGG-B1-1b** — Wire `renderProvenanceLabel(metadata.labelData, policyView)` into `PolicyEnforcedKernel.traceObject` + `traceBundle` (`src/kernel/policy-enforced-kernel.ts:491-511, 810`)

### Tier 2 — rotate() correctness (Stores)
3. **AGG-B1-2a** — Fix rotate() atomicity: persist FIRST, mutate AFTER both persist calls succeed
4. **AGG-B1-2b** — Add input validation: Date.parse + typed `InvalidRotateTimestampError`
5. **AGG-B1-2c** — Sweep `<dataDir>/ledger-archive/` at constructor for orphan tmps
6. **AGG-B1-2d** — Future-timestamp safeguard: throw typed `RotateBoundaryInFutureError`

### Tier 3 — Cross-domain (family-probe misses)
7. **AGG-B1-3** — Replace hardcoded `db-cluster-0.1.0.tgz` in `scripts/release-gate.mjs:111` + `scripts/smoke-install.mjs:16` with `package.json` lookup
8. **AGG-B1-4** — NDJSON tail-corruption signal: stderr warn + `ledger_tail_corruption_recovered` event in `LocalLedgerStore.loadArray`

### Tier 4 — Operator-surface fixes
9. **AGG-B1-5** — Fix OperationsPanel shape mismatches (3 fields: `opsData.overall`, `provenanceHealth.totalReceipts`, `provenanceHealth.totalEvents`)
10. **AGG-B1-6** — Thread dataDir + commandQueue to `doctor()` from CLI + ops-model
11. **V1-B1-007 / V2-B1-011** — ops-model defensive-zero distinguishes feature-not-supported from runtime-error
12. **V3-B1-005** — Drop ops-model feature-detect on countEvents (call directly per REQUIRED contract)

### Tier 5 — Small surgical (single line or single doc)
13. **V1-B1-010** — Apply `redactErrorMessage` in `recordOrphanMutation` stderr path
14. **V2-B1-006** — Add `PolicyConfigError: 'INVALID_POLICY_CONFIG'` to `BUILTIN_ERROR_CODES`
15. **V1-B1-006** — Tighten NDJSON shape gate to require `id.length > 0`
16. **AGG-B1-9a** — Update `docs/store-contracts.md` for LedgerStore.rotate, countEvents, importEvent, importReceipt
17. **AGG-B1-9b** — Add new RedactionTargets (entity_name, artifact_filename) to `docs/policy-and-redaction.md`

Total: 17 items across 5 tiers.

## 6. Deferred to B2 (with explicit rationale)

| ID | Severity | Defer rationale |
|---|---|---|
| AGG-B1-7 (Postgres migrations registry) | HIGH | Architectural — explicit audit §9.5 v0.2 design |
| AGG-B1-8 (deprecation policy + MIGRATION.md) | HIGH | Architectural — Surface explicit §7 defer |
| V2-B1-003 (rotate operator-surface CLI/MCP) | HIGH | Architectural — needs approval-sensitive design pass |
| V3-B1-008 (verifySchema column registry) | MEDIUM | Pairs with Postgres migrations work |
| V2-B1-007 (PATH_REGEX consolidation) | MEDIUM | Cross-domain refactor; B2 |
| V2-B1-008 (verify other checks silent-capped) | MEDIUM | Apply STORES-B-014 pattern in B2 |
| V2-B1-013/V2-B1-015 (audit trail design, structured-error surfacing) | LOW | Design pass for operator-facing error/audit surfaces |
| V3-B1-010 (regex band-aid post structural fix) | MEDIUM | Pairs with full doctrine ratification |
| V3-B1-011 (events.json filename mislead) | MEDIUM | Operator-visible breaking; pair with v0.2 |
| V1-B1-004/005/008/009/012/013/014/015 (defensive polish) | LOW/MEDIUM | Defense-in-depth; B2 |
| V3-B1-015 (release-notes filename) | LOW | Low priority |

## 7. v2 protocol — family-of-call-sites probe validation (load-bearing addition since Wave A4)

Wave B1-Amend's verifier ensemble re-validates the family-of-call-sites probe instruction. Direct wins this wave:

- **V3-B1-003**: scripts/release-gate.mjs:111 hardcoded tgz — Surface's SURFACE-B-013 family probe stopped at src/, missed scripts/. V3 caught it via cross-domain family probe.
- **V1-B1-003**: archive-dir orphan tmps — STORES-B-001's family probe extended `cleanupOrphanTmpFiles` to events/receipts but missed the new archive/ subdirectory.
- **V3-B1-001**: dashboard inspector accepts bare kernel — KERNEL-B-006's family probe didn't extend to dashboard inspector call sites.
- **V2-B1-005**: MCP boundary's sanitizeProvenanceNodeForOutput still opaque — KERNEL-B-006's family probe missed the MCP-side consumer.

**Family-of-call-sites probe IS still load-bearing.** Recommend continued canonical-protocol status. No lens-design change needed.

## 8. Lens-quality assessment

All three lenses produced 15 capped findings — they all had material work. No lens is starving (which would indicate lens redundancy or wave-internal completeness).

**Lens convergence on the AGG-B1-1 boundary cluster** (5 findings across 3 lenses, with V3 's special-probe verdict `flagged-as-finding`) demonstrates the lens-design soundness for Stage B. The resilience lens caught the inert state (renderProvenanceLabel has 0 callers); the operational-visibility lens caught the MCP boundary opaque-stub; the migration-safety lens caught the dashboard's direct-bare-kernel violation + the stale JSDoc.

## 9. Coordinator recommendation

**Wave B1-Amend is fix-uppable but NOT exitable until the 17 fix-up items land.**

The relaxed exit gate requires HIGH residuals to be architectural/process with explicit defer rationale. Of the 14 HIGH findings, 12 are direct fix items (not architectural). After fix-up, the residual HIGH count is ≤2 (only AGG-B1-7 Postgres + AGG-B1-8 deprecation, both explicitly deferred).

**Dispatch a single fix-up agent for the 17 items in tier order.** After fix-up + 3× test stability + lint + release-gate 8/8 PASS, the wave is exitable.

---

*End of Wave B1-Amend verifier aggregate. Hand to coordinator for fix-up dispatch.*
