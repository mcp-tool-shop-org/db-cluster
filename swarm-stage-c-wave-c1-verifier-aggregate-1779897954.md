# Stage C Wave C1-Amend — Verifier Aggregator + Coordinator-as-Judge

**Wave:** C1-Amend (Stage C — Behavioral Humanization)
**Repo:** `mcp-tool-shop-org/db-cluster`
**Aggregator date:** 2026-05-27 (timestamp 1779897954)
**Inputs:**
- `swarm-stage-c-wave-c1-verifier-actionability-OUTPUT.json` (C-V1, 15 findings)
- `swarm-stage-c-wave-c1-verifier-op-progress-OUTPUT.json` (C-V2, 14 findings)
- `swarm-stage-c-wave-c1-verifier-edge-state-OUTPUT.json` (C-V3, 15 findings)
- Total raw: **44 evidence-bearing verifier findings**

---

## 1. Pairwise correlation (Jaccard ρ on file:line agreement)

Stage C lens family is a **single data point**. Measurement informs whether the family is canonical-quality (all pairs < 0.25 per Codex-Verify 2025 submodularity precondition).

| Pair | ρ | Same-site overlaps | Theme overlaps |
|---|---|---|---|
| **C-V1 ↔ C-V2** | **~0.07** | 1 (cli.ts:762-763 — `--quiet` / `--log-level` declared but unwired, flagged HIGH by both) | V1-C1-011 (5 console.error+exit(1) sites bypass cliCommand) thematically adjacent to V2-C1-004 (adapter errors not caught) |
| **C-V1 ↔ C-V3** | **~0.27** ⚠ | 4 (component-state.ts:69 + error-formatter.ts:55 + PolicyViewToggle.jsx:117 + sanitize.ts:122) | Contract-drift + not-wired theme is shared across both lenses |
| **C-V2 ↔ C-V3** | **~0.07** | 1 (cli.ts:478 — cliCommand adapter-error catch arm — V2-C1-004 + V3-C1-005 cross-confirm; also independently flagged by Tests agent) | Mostly disjoint |

**Verdict:** **C-V1↔C-V3 ρ ≈ 0.27 is slightly above the 0.25 submodularity threshold.** Two of three pairs satisfy the precondition; one is in the borderline region.

**Recommendation for Stage C lens family canonicalization:** the contract-drift-vs-not-wired distinction overlaps between V1's actionability-envelope lens and V3's contract-implementation-parity lens. A future Stage C wave should consider either:
- (a) Refining V3 to focus ONLY on edge-state (empty/loading/error/redacted) + test-coverage, dropping the "documented contract not wired" probe (which V1 implicitly catches via the actionability-envelope lens)
- (b) Refining V1 to focus ONLY on next-step / remediation_hint *presence*, leaving the "contract drift between producer and consumer" probe to V3
- (c) Accepting the 0.27 overlap as the cost of capturing this important class with two lenses (defense-in-depth interpretation)

**This wave's decision:** treat the family as *probationary-canonical* — promote pending second data point. The 4 cross-confirmed findings are LOAD-BEARING signals (independent agreement is itself evidence of importance).

---

## 2. High-signal convergence clusters (multi-lens agreement)

**Cluster A — `formatForUser` / `errorToAiEnvelope` not wired** (V1-C1-007 HIGH + V3-C1-001 HIGH + V3-C1-013 MEDIUM)
- 3 lenses converge on the same architectural gap: §2b ships the helper, exports it, documents it as canonical — but every consumer surface (CLI cliCommand catch arm, MCP redactError, dashboard StateBoundary) re-implements inline.
- Multi-lens agreement = highest priority.

**Cluster B — Two parallel `AiErrorEnvelope` declarations** (V1-C1-010 HIGH + V3-C1-006 HIGH)
- `src/types/ai-envelope.ts` canonical (required fields); `src/mcp/sanitize.ts:122-159` local parallel (optional fields). MCP runtime can produce envelopes missing the canonical-required fields.
- 2-lens HIGH agreement.

**Cluster C — `ComponentState.empty.reason` vs `EmptyResultMeta.empty_reason`** (V1-C1-003 HIGH + V3-C1-002 HIGH)
- Three vocabularies coexist: `'all_filtered'`, `'all_filtered_by_policy'`, and a missing arm in MCP. StateBoundary's switch silently falls through to "No data." losing the policy-filter signal.
- 2-lens HIGH agreement.

**Cluster D — `cliCommand` catch arm doesn't handle adapter errors** (V2-C1-004 HIGH + V3-C1-005 HIGH + Tests agent gap-flag)
- 3 independent flags: cliCommand only branches `ClusterError | PolicyConfigError`. Adapter typed errors (CorruptStoreError, BackupTargetExistsError, ImportConflictError, etc.) extend plain `Error` not `ClusterError`, so their `code` field is never consulted. Reproducible: corrupt store → exit 1 instead of 70.
- Tests agent's wave-c1-tests-exit-codes.test.ts:158-166 documents this gap with soft assertion (`if status === 70`); verifiers independently confirm.

**Cluster E — `renderRedactionMarkers` documented but no consumer panel calls it** (V1-C1-009 HIGH + V3-C1-003 HIGH)
- PolicyViewToggle.jsx defines + globalizes the helper; JSDoc says siblings consume it. Grep confirms zero consumer panels invoke it. Same documented-contract-not-wired class as Cluster A.
- 2-lens HIGH agreement.

**Cluster F — `--quiet` / `--log-level` dead options** (V1-C1-008 + V2-C1-006 both HIGH)
- Declared at cli.ts:762-763, never read. Reproduced empirically (`--quiet doctor` byte-identical to `doctor`). Operators piping `--json --quiet | jq` see stderr warnings interleave.
- 2-lens HIGH agreement.

**Single-lens HIGH (no cross-lens agreement but architectural):**
- V1-C1-001 — `CommandValidationFailedError` missing from EVERY enrichment map (BUILTIN_ERROR_CODES, TYPED_ERROR_ENRICHMENT, CLUSTER_ERROR_CODES, typedErrorToExitCode, remediationForCode). Single typed-error class entirely absent from the boundary.
- V1-C1-002 — `lifecycleNextValidActions` only handles 3 of 7 lifecycle error codes (misses 4 new typed errors KERNEL-C-005 introduced).
- V1-C1-004 — `ops-model.ts` repair suggestions reference phantom CLI commands (`db-cluster reindex`, `db-cluster doctor --repair`). Same class as SHA-STORES-PHANTOM-CMD.
- V2-C1-001 — `db-cluster index rebuild` bypasses destructiveCommand entirely (parallel duplicate path of `rebuild index`).
- V2-C1-002 — `compensate` uses plain cliCommand, no safety scaffolding for a destructive terminal write.
- V2-C1-003 — `restore` silently buries entity errors on human surface AND returns exit 0. STORES-C-003 partially closed.
- V2-C1-005 — `onProgress` callbacks added to 4 ops contracts but ZERO CLI commands subscribe. Operator stares at blank for 30+ seconds.
- V2-C1-009 — Zero MCP tools for doctor/verify/rebuild/backup/restore. SURFACE-C-002 not addressed (but advisor disposition allowed docs-only — verify intent).
- V3-C1-004 — `nextValidActions` only on commit success path; SDK/MCP/CLI strip from all other 5 lifecycle success arms.

---

## 3. Coordinator-as-judge decisions

Per the v2 protocol's saturation criterion:

| Indicator | Current state | Threshold | Verdict |
|---|---|---|---|
| CRITICAL findings | 0 | 0 | ✓ |
| Regressions-of-this-wave | 0 | 0 | ✓ |
| HIGH findings (open) | 13-14 unique HIGHs across verifiers | ≤2 with explicit defer | ✗ — fix-up required |
| Test suite determinism | 3/3 at 1211/55/0 | 3/3 | ✓ |
| Release-gate clean | 9/9 PASS | 9/9 | ✓ |
| New meta-pattern depth | "Documented contract not wired" — new family-of-call-sites pattern; the wave landed structural contracts, missed half the consumer wiring | No new depth post-fix-up | ✗ — must close in fix-up |

**Wave NOT exitable at saturation gate without fix-up.** A single coordinator fix-up dispatch closes Clusters A-F + named single-lens HIGHs.

### Tier 1 — Mandatory close in fix-up (multi-lens HIGH + architectural)

1. **Cluster A** — Wire `formatForUser` + `errorToAiEnvelope` at every consumer surface (CLI cliCommand, MCP redactError, dashboard StateBoundary). Delete duplicate `remediationForCode` in cli.ts + duplicate `extractTypedErrorContext` in sanitize.ts. Closes V1-C1-007 + V3-C1-001 + V3-C1-013 + V1-C1-014.
2. **Cluster B** — Delete `AiErrorEnvelope` interface in sanitize.ts:122-159. Re-export canonical type. Populate defaults so all required fields non-undefined. Closes V1-C1-010 + V3-C1-006.
3. **Cluster C** — Unify on `'all_filtered_by_policy'`. Update `ComponentState.empty.reason` union in component-state.ts:69. Update state-boundary.jsx:62 switch arm. Add `'all_filtered_by_policy'` case to mcp/server.ts read-tool empty arms. Closes V1-C1-003 + V3-C1-002.
4. **Cluster D** — Extend cliCommand catch arm to handle adapter typed errors via duck-type check (`'code' in err && typeof err.code === 'string'`) before generic-Error fall-through. Map via typedErrorToExitCode + emit `→ try:` via err.remediationHint. Closes V2-C1-004 + V3-C1-005 + Tests-agent gap.
5. **Cluster E** — Wire `renderRedactionMarkers` at CommandPreviewPanel.jsx:178 + ClusterTruthInspector.jsx:500 + OperationsPanel where applicable. Closes V1-C1-009 + V3-C1-003.
6. **Cluster F** — Wire `--quiet` + `--log-level` OR remove the declarations. (Prefer wire — operators expect them to work.) Closes V1-C1-008 + V2-C1-006.

### Tier 2 — Strong close in fix-up (single-lens HIGH, operator-pipeline-corruption class)

7. **V1-C1-001** — Add `CommandValidationFailedError` code 'COMMAND_VALIDATION_FAILED' to CLUSTER_ERROR_CODES + BUILTIN_ERROR_CODES + TYPED_ERROR_ENRICHMENT + typedErrorToExitCode + remediationForCode (until Cluster A wiring eliminates the duplicate maps).
8. **V1-C1-002** — Extend `lifecycleNextValidActions` for COMMAND_NOT_FOUND, COMMAND_ALREADY_TERMINAL, INVALID_STATE_TRANSITION, COMMAND_VALIDATION_FAILED.
9. **V1-C1-004** — Fix ops-model.ts:207 (`reindex` → `rebuild index`) + line 238 (drop `--repair` phantom or use check.suggestedCommand).
10. **V2-C1-001** — Route `db-cluster index rebuild` through destructiveCommand (or remove the duplicate verb if `rebuild index` is the canonical path).
11. **V2-C1-002** — Wrap `compensate` in destructiveCommand.
12. **V2-C1-003** — `restore` non-JSON branch renders `result.summary` + iterates errors[]; process.exit(1) when any error count > 0.
13. **V2-C1-005** — Wire default progress renderer at cli.ts. Pass `onProgress` to rebuildIndex/verify/doctor/backup CLI consumer calls.
14. **V3-C1-004** — Either narrow CommandLifecycleEnvelope claim to commit-only OR have all 6 lifecycle methods return the envelope. (Recommend: narrow the claim — closer to current implementation.)

### Tier 3 — Stretch (if bandwidth permits; otherwise defer to next Stage C wave / v0.2)

15. **V3-C1-008** — Extend dashboard mount-loop to check 4 new C1 globals.
16. **V3-C1-010** — Wrap 4 ClusterTruthInspector sub-panels in StateBoundary.
17. **V3-C1-011** — Change ProvenanceHealth.totalEvents to `number | null`; surface degraded signal in UI.
18. **V1-C1-006** — Add compensate verb to cluster_propose_mutation per-verb schema + verb enum.
19. **V1-C1-005** — Set suggestedCommand on 4 missing HealthCheck producers (verify provenance/receipts).
20. **V2-C1-010** — Random suffix on auto-snapshot dir names; replace space in operation names with `-`.
21. **V2-C1-011** — Replace `<file>` placeholder in undoHint.
22. **V2-C1-013** — Move backup -o success message from stdout to stderr.
23. **V1-C1-013** — Time-bound docs on cluster_explain_retrieval + cluster_why.

### Defer (out of fix-up scope)

- **V1-C1-011 + V1-C1-015** (5 inline console.error+exit(1) sites bypass cliCommand) — wave-scope expansion; refactor multiple commands; defer to next Stage C wave or v0.2.
- **V1-C1-012** (RedactedMarker capability probe across redactor sites) — narrow improvement; defer.
- **V2-C1-007 + V2-C1-008** (granular progress, receipt-check/provenance-check onProgress) — polish; defer.
- **V2-C1-009** (MCP tools for long-running ops) — per audit advisor disposition (SURFACE-C-002 docs-only OK acceptable); defer with explicit rationale.
- **V2-C1-012** (backup --force silent overwrite) — design call; defer.
- **V2-C1-014** (MCP time-bound docs inconsistent) — polish; defer (overlaps Tier 3 V1-C1-013).
- **V3-C1-007** (_meta.empty_reason on 3 more read tools) — extension of existing pattern; defer if Tier 3 already lands the helper.
- **V3-C1-009 + V3-C1-014** (test refactors — JSDOM mount; production extraction) — test-infra refactor; defer.
- **V3-C1-012** (jsdoc-gate @example execution) — architectural extension; defer.
- **V3-C1-015** (typedErrorToExitCode 9 missing codes) — extensive list; partial close in Tier 2 (V1-C1-001 + V1-C1-002 add several); rest defer.

---

## 4. Saturation indicators (post fix-up — target state)

| Indicator | Pre-fix-up | Post-fix-up target | Threshold |
|---|---|---|---|
| CRITICAL findings | 0 | 0 | 0 |
| Regressions-of-this-wave | 0 | 0 | 0 |
| HIGH findings (open) | 13-14 | ≤2 (explicit defer: V2-C1-009 MCP long-running ops; any single residual) | ≤2 with explicit defer |
| Test suite determinism | 3/3 at 1211/55/0 | 3/3 at ~1250+/55/0 | 3/3 deterministic |
| Release-gate clean | 9/9 PASS | 9/9 PASS | 9/9 |
| New meta-pattern depth | "Documented contract not wired" — 4 clusters | Closed by Tier 1 wiring | No new depth post-fix-up |

If fix-up closes Tier 1 + Tier 2 (14 of 14-15 HIGH items), residuals are ≤2 with explicit defer.

---

## 5. Stage C lens family validation (single data point)

Per dispatch §7 — first data point for Stage C family. Findings:

- **Pairwise ρ:** V1↔V2 ≈ 0.07, V1↔V3 ≈ **0.27**, V2↔V3 ≈ 0.07.
- **Submodularity precondition:** met for 2 of 3 pairs; V1↔V3 borderline.
- **Cross-lens convergence value:** 4 clusters (A, B, C, D, E, F = 6 multi-lens clusters in §2). Each cluster represents a load-bearing architectural gap. The lens overlap on Cluster A + C + E suggests both lenses CORRECTLY catch the same class — and the convergence amplifies signal strength.

**Verdict:** Stage C lens family is **probationary-canonical**. Promote to canonical pending second data point (next Stage C wave on db-cluster OR Stage C on another codebase).

For the second data point, consider:
- Refining V3 to explicitly defer "documented contract not wired" probe to V1, focusing V3 purely on edge-state + test-coverage
- OR accepting the 0.27 overlap as load-bearing (defense-in-depth for the most-important class)

---

## 6. Family-of-call-sites probe — validation

The canonical probe instruction continued to load-bear this wave. Verifiers caught:
- V1-C1-002 — lifecycleNextValidActions missing 4 of 7 codes (sibling-pattern from KERNEL-C-005)
- V1-C1-004 — ops-model.ts phantom commands (sibling-pattern from SHA-STORES-PHANTOM-CMD)
- V2-C1-001 — `index rebuild` bypasses destructiveCommand (sibling-of `rebuild index`)
- V2-C1-002 — compensate bypasses destructiveCommand (sibling-of mutation commands)
- V2-C1-005 — onProgress declared but no consumer (sibling-pattern from STORES-C-002)
- V3-C1-007 — 3 read tools missing empty_reason (sibling-pattern from SURFACE-C-003)
- V3-C1-010 — 4 ClusterTruthInspector sub-panels not wrapped (sibling-pattern from SURFACE-C-017)
- V3-C1-008 — mount-loop missing 4 new globals (sibling-pattern from SURFACE-B-015 race fix)

**8 explicit family-probe wins this wave.** Probe instruction remains canonical-protocol load-bearing.

---

## 7. Coordinator decision

**Single fix-up agent dispatch.** Tier 1 + Tier 2 mandatory (14 items). Tier 3 stretch (9 items). Tier-defer documented above.

After fix-up: 3× test stability + release-gate 9/9 + saturation indicators. Then commit + report.

---

*Aggregator complete. Coordinator dispatching fix-up agent.*
