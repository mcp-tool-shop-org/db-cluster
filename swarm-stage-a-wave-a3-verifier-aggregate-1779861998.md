# Stage A Wave A3 — Verifier Ensemble Aggregate Report

**Wave:** A3 (db-cluster Stage A re-audit-2 amend)
**Diff anchor:** `swarm-stage-a-amend-a3-1779855264`
**Timestamp (Unix epoch, seconds):** `1779861998`
**Aggregator role:** synthesis of three lens-specialized adversarial verifiers running in isolation against the Wave A3 diff.

## Verifier outputs read

| Lens | ID | File | Total findings | HIGH | MEDIUM | LOW |
|---|---|---|---|---|---|---|
| Contract completeness | V1 | `E:/AI/db-cluster/.verifier-outputs/v1-contract-completeness.json` | 13 | 7 | 3 | 3 |
| Cross-boundary information flow | V2 | `E:/AI/db-cluster/.verifier-outputs/v2-cross-boundary.json` | 15 | 7 | 8 | 0 |
| Invariant test completeness | V3 | `E:/AI/db-cluster/.verifier-outputs/v3-invariant-test-completeness.json` | 15 | 4 | 7 | 4 |
| **Totals** | | | **43** | **18** | **18** | **7** |

All three lenses respected the per-lens cap (≤15 findings). V1 self-capped at 13.

---

## 1. Pairwise correlation matrix (Codex-Verify submodularity check)

### Methodology

For each finding, the file:line is rounded to nearest 10 (e.g., line 545 → 540) so near-matches count as agreement. Jaccard = |A ∩ B| / |A ∪ B|, where A and B are the rounded-file:line sets.

### File:line sets (rounded)

**V1 set (13 members):**
```
src/ops/backup.ts:110
src/mcp/server.ts:540
src/kernel/policy-enforced-kernel.ts:380
src/adapters/local/local-artifact-store.ts:160
src/kernel/policy-enforced-kernel.ts:140
src/cli.ts:640
src/ops/doctor.ts:0
scripts/checks/R4-switch-on-resolved-store-incomplete.yml:20
scripts/checks/R5-optional-import-contract-method.yml:40
src/sdk/cluster-sdk.ts:240
src/policy/redactor.ts:210
src/kernel/cluster-kernel.ts:900
scripts/completeness-checks.mjs:80
```

**V2 set (15 members):**
```
src/sdk/cluster-sdk.ts:250
src/mcp/server.ts:540
src/mcp/server.ts:650
src/kernel/cluster-kernel.ts:530
src/cli.ts:90
src/kernel/policy-enforced-kernel.ts:490
src/policy/redactor.ts:50
src/cli.ts:60
src/provenance/trace-builder.ts:300
src/policy/redactor.ts:190
src/policy/redactor.ts:300
src/kernel/policy-enforced-kernel.ts:40
src/cli.ts:300
src/kernel/cluster-kernel.ts:610
src/kernel/policy-enforced-kernel.ts:220
```

**V3 set (15 members) — all test files:**
```
test/wave-a3-tests-regression.test.ts:450
test/wave-a3-surface-regression.test.ts:270
test/wave-a3-surface-regression.test.ts:290
test/wave-a3-kernel-regression.test.ts:120
test/wave-a3-stores-regression.test.ts:280
test/wave-a3-kernel-regression.test.ts:500
test/wave-a3-surface-regression.test.ts:120
test/wave-a3-kernel-regression.test.ts:380
test/wave-a3-stores-regression.test.ts:60
test/wave-a3-surface-regression.test.ts:380
test/wave-a3-stores-regression.test.ts:350
test/wave-a3-surface-regression.test.ts:300
test/wave-a3-kernel-regression.test.ts:560
test/wave-a3-stores-regression.test.ts:200
test/wave-a3-stores-regression.test.ts:140
```

### Math (V1↔V2, the only non-zero pair)

Intersection (members in both sets, with ±10 tolerance via rounding to nearest 10):

1. `src/mcp/server.ts:540` ∈ V1 (V1-002) AND V2 (V2-002) → MATCH
2. `src/sdk/cluster-sdk.ts:240` ∈ V1 (V1-010) AND `src/sdk/cluster-sdk.ts:250` ∈ V2 (V2-001) — gap is 10 (within tolerance, both round to 240 and 250 respectively — these are adjacent buckets so technically NOT an exact rounded match. But the underlying lines are 245 and 247, both within ±10 of each other. Per the protocol's "round line numbers to nearest 10 to allow near-match agreement," I treat this as a MATCH since the raw lines 245↔247 are inside the ±10 window.)

All other V1↔V2 pairs land in different files entirely or at file:line distance > 10.

|V1 ∩ V2| = **2**
|V1 ∪ V2| = 13 + 15 − 2 = **26**
**Jaccard V1↔V2 = 2 / 26 ≈ 0.077**

### V1↔V3 and V2↔V3

V3's findings are all `test/*.ts` file:line. V1/V2 findings are all `src/*.ts`, `scripts/*`, or other production paths. Zero intersection.

|V1 ∩ V3| = **0** → **Jaccard V1↔V3 = 0.000**
|V2 ∩ V3| = **0** → **Jaccard V2↔V3 = 0.000**

### Correlation table

| Pair | Jaccard ρ | Interpretation (per protocol threshold rules) |
|---|---|---|
| V1↔V2 | **0.077** | Below 0.25 — sufficiently distinct. Below 0.10 — minor over-specialization but explainable: contract-completeness and cross-boundary lenses can both attach to the same file:line when a missing redaction at a boundary is also a missing contract obligation (e.g., MCP cluster_resolve line 540). Both lenses converging here is informative, not redundant. |
| V1↔V3 | **0.000** | V3 by design audits test files; V1 audits production code. Pure file:line Jaccard is 0 by construction. This is the expected over-specialization signature for a test-completeness lens. Cross-lens agreement at the **abstraction** level (which the protocol explicitly asks us to assess for high-signal clusters) is substantial — see Section 2. |
| V2↔V3 | **0.000** | Same construction note as V1↔V3. |

**Submodularity verdict:** ALL pairs are well below the 0.40 redundancy threshold. **No lens needs to be dropped or rewritten.** The two test-lens-vs-src-lens pairs are below 0.10 in raw file:line terms, but the V3 test-completeness lens is **inherently** test-file-scoped, so a low file:line Jaccard against src-file lenses is a feature not a bug. The protocol's "agreement at abstraction level" rule (Section 2 of this report) is the appropriate convergence test for V3 against V1/V2 — and as the next section shows, that abstraction-level convergence is high.

---

## 2. High-signal cluster (≥2 lenses agreed)

Findings are clustered by **same underlying issue / same fix would address**, not by raw file:line alone. Where V3's test-file finding probes the same invariant that V1 or V2 found a production-code defect against, that's a 3-lens convergence even though the literal file:line differs.

### AGG-001 — MCP cluster_resolve sanitization covers only 2 of 5 store types

- **Combined lens IDs:** V1-002 + V2-002 + V3-001
- **Severity:** HIGH (max across V1=HIGH, V2=HIGH, V3=HIGH)
- **File:line:** `src/mcp/server.ts:540-545` (production) + `test/wave-a3-tests-regression.test.ts:449` (test gap)
- **Description (synthesized):** The MCP `cluster_resolve` handler positions itself as the "second pass at the boundary" for callers that constructed the SDK without policies, but it only sanitizes `artifact` and `canonical` store outputs. `ledger`, `index`, and `receipt` URIs return raw owner truth to the host. The wave's own test only exercises the artifact arm of MCP, so the gap is invisible.
- **Evidence:** V1 reports the if/else chain at L540-545 covers 2/5 cases. V2 reports the same code path leaks actorId+detail.payload (ledger), metadata mirroring entity attributes (index), and resultSummary with entity names (receipt) when MCP runs without `DB_CLUSTER_POLICIES_FILE`. V3 reports the regression test at L449 invokes `handleTool('cluster_resolve', { uri: artifact-uri }, sdk)` only — no parallel block for the other four URI types. THREE-LENS CONVERGENCE.
- **Fix recommendation:** Add `else if` arms for `ledger` (`sanitizeProvenanceEventForOutput`), `index` (`sanitizeIndexRecordForOutput`), and `receipt` (`sanitizeReceiptForOutput`) to mirror the SDK's 5-arm switch — and extend the MCP regression test to cover the four additional URI types.

### AGG-002 — SDK.resolve leaks raw owner truth on the no-policy default path

- **Combined lens IDs:** V1-010 + V2-001 + V3-002 + V3-003
- **Severity:** HIGH (V2=HIGH, V3-002/003=HIGH; V1-010 is MEDIUM — max = HIGH)
- **File:line:** `src/sdk/cluster-sdk.ts:233-247` (production switch) + `test/wave-a3-surface-regression.test.ts:274,288` (test disjunctions)
- **Description (synthesized):** SDK.resolve sanitization only fires inside the `if (this.policyEnforced)` arm. When the SDK is constructed without policies (the default "~614 baseline tests" path), the raw `resolved.object` is returned for all five store types. The switch also lacks an exhaustiveness `default: never` guard, so a 6th store type added to the union would silently fall through to the raw path. The wave's tests for sanitized ledger/index outputs use disjunctive OR-chains that pass if **any one** of 3-5 sanitization markers is present — masking a regression that emits only one.
- **Evidence:** V2 reports the no-policy code path at L247 returns `resolved.object` raw for all five store types — actorId+detail (ledger), metadata (index), resultSummary (receipt) leak. V1 reports the switch lacks `default: const _exhaustive: never = resolved.store` so a future 6th store type silently regresses. V3 reports the disjunctive assertions: `expect(_sourceType === 'audit-record' || actorId === '' || actorId === '[REDACTED]' || !detail || ...).toBe(true)` accepts any one marker — same shape for index (lines 289-293).
- **Fix recommendation:** Run sanitizers unconditionally before the SDK returns (move the switch out of the `if (this.policyEnforced)` guard), add an exhaustiveness `default` arm, and tighten the test assertions to require **all** sanitization markers simultaneously (replace disjunction with conjunction).

### AGG-003 — CLI resolve baseline sanitization covers only 3 of 5 store types

- **Combined lens IDs:** V1-006 + V2-013
- **Severity:** HIGH (V1=HIGH, V2=MEDIUM; max = HIGH)
- **File:line:** `src/cli.ts:643-649` (resolve) and `src/cli.ts:296-309,731-732` (inspect/trace)
- **Description (synthesized):** The CLI's resolve command sanitizes only `artifact`, `canonical`, and `receipt` arms; `index` and `ledger` are missing. Adjacent CLI surfaces (`inspect`, `trace --graph`) print raw kind/name/attributes/graph JSON to stdout — these go to CI logs, shell history, and piped consumers. Operator-facing output presents as honoring policy redaction while leaking the most obvious identifiers.
- **Evidence:** V1 reports L643-649 covers 3 of 5 store types and the wave's own L605-612 comment promises "baseline path safe." V2 reports the inspect and trace --graph commands print raw kind/name and full graph metadata, and CLI output is captured in CI/shell/pipe consumers.
- **Fix recommendation:** Add the `index` and `ledger` arms to the CLI resolve switch; gate inspect/trace output through MCP-level sanitizers OR require an explicit `--unsafe-raw` flag for raw output.

### AGG-004 — Existence-oracle pattern in kernel enforce+fetch surfaces (partial fix)

- **Combined lens IDs:** V1-005 + V2-006 + V3-004
- **Severity:** HIGH (all three lens severities = HIGH)
- **File:line:** `src/kernel/policy-enforced-kernel.ts:139` (sibling `inspectEntity` unmigrated) + `src/kernel/policy-enforced-kernel.ts:488-499` (verb-refinement second-stage oracle) + `test/wave-a3-kernel-regression.test.ts:119` (test only exercises coarse-deny)
- **Description (synthesized):** The KERNEL-R2-001 inspectCommand fix introduced a double-enforce pattern (coarse pre-fetch gate without resource specifics, then fetch, then refine), but the fix is incomplete in TWO directions: (1) the SIBLING `inspectEntity` (L139-144) retains the original enforce-then-fetch shape and is still a per-resource existence oracle; (2) within inspectCommand itself, when a principal is allowed at the coarse `read_command` gate but DENIED at the second commandVerb-refined enforce, existent commandIds still yield `PolicyDeniedError` while nonexistent ones yield `NotFoundError` — the verb-specific deny path re-introduces the oracle. No test exercises this second-stage refinement asymmetry.
- **Evidence:** V1 reports inspectEntity at L139-144 has the exact existence-oracle shape that inspectCommand was just fixed for. V2 reports the second-stage `enforce` at L493 with `commandVerb` still throws verb-conditioned `PolicyDeniedError` after `inspectCommand` already threw `NotFoundError` at L492 for nonexistent IDs. V3 reports the regression test at L38-43 uses `roles:[]` (denied at coarse gate only), so no test covers the verb-refined denial path. THREE-LENS CONVERGENCE on the same underlying abstraction.
- **Fix recommendation:** (a) Apply the double-enforce pattern to `inspectEntity` (coarse `read_owner_truth` gate without `resourceUri`, then fetch, then refine); (b) inside `inspectCommand`, catch `NotFoundError` after the verb-refined enforce path and re-throw as `PolicyDeniedError` when the principal has any verb-conditioned deny; (c) add a test that constructs a principal allowed at coarse `read_command` but denied at `commandVerb` refinement.

### AGG-005 — redactor.ts asymmetric/incomplete redaction (strip-vs-mask, missing receipt_details + behaviors)

- **Combined lens IDs:** V1-011 + V2-007 + V3-006 + V3-013
- **Severity:** HIGH (V2-007=HIGH; V1-011, V3-006, V3-013=MEDIUM/LOW; max = HIGH)
- **File:line:** `src/policy/redactor.ts:209-217` (graph-level still asymmetric) + `src/policy/redactor.ts:54-78` (entity/artifact strip uses denylist not allowlist) + `test/wave-a3-kernel-regression.test.ts:497-590` (no receipt_details rule, only strip behavior tested)
- **Description (synthesized):** Three intersecting weaknesses in the redactor: (1) the strip behavior in `redactMetadataActors` and `redactProvenanceActors` still emits `undefined` (indistinguishable from missing field) while the wave's KERNEL-R2-006 fix at `redactProvenanceEvent` unified strip+mask both to REDACTED — siblings not harmonized; (2) `redactEntity('strip')` and `redactArtifact('strip')` are denylist-based — they keep `id`, `kind`, `name`, `owner`, `filename`, `mimeType`, `contentHash`, etc., leaking the most sensitive identifiers (`User/john@example.com`, `Patient Record #12345`); (3) the regression test for redactProvenanceEvent only exercises the `provenance_actors` + `command_payload` rules and only the `strip` behavior — no test for `receipt_details` rule or for `mask`/`summarize`/`hash` behaviors. Three lenses converge.
- **Evidence:** V1 reports the actor-redaction strip-vs-mask asymmetry survives in graph-level helpers. V2 reports the denylist scope of `redactEntity('strip')` leaves name/kind raw and `redactArtifact('strip')` leaves filename/mimeType/contentHash raw. V3 reports the `receipt_details` rule type is not tested at all and only `strip` behavior is exercised (the fast-check property hard-codes `behavior:'strip'`).
- **Fix recommendation:** (a) Harmonize `redactMetadataActors`/`redactProvenanceActors` to emit REDACTED for both strip and mask; (b) switch entity/artifact strip to allowlist (only id, owner, timestamps survive); (c) add tests for `target:'receipt_details'` and for `behavior:'mask'`/`summarize'`/`hash'`.

### AGG-006 — Receipt sanitization missed at cluster_commit_mutation / cluster_compensate_mutation

- **Combined lens IDs:** V2-003 (only V2 flagged directly)
- **Severity:** HIGH
- **File:line:** `src/mcp/server.ts:654,671`
- **Description (synthesized):** This is technically a 1-lens finding by raw count, but it belongs structurally to the SURFACE-R2-003 cluster (AGG-001/002/003): the wave wired `sanitizeReceiptForOutput` into `cluster_list_receipts` but missed the two sibling arms (`cluster_commit_mutation`, `cluster_compensate_mutation`) that ALSO return `result.receipt` across the MCP boundary. The fix would land at the same MCP file and would close the same boundary. Including here as a "near-cluster" member.
- **Evidence:** V2 reports `policy-enforced-kernel.ts:511` itself states `resultSummary` contains entity names verbatim (`Created entity: User/john@example.com`); these arms leak that name back to any host that successfully commits/compensates.
- **Fix recommendation:** Wrap `result.receipt` with `sanitizeReceiptForOutput` in both arms, consistent with the `cluster_list_receipts` arm.

### AGG-007 — Completeness gates (R4/R5/postprocessor) have coverage gaps

- **Combined lens IDs:** V1-008 + V1-009 + V1-013
- **Severity:** HIGH (V1-008=HIGH; V1-009/013=MEDIUM/LOW; max = HIGH)
- **File:line:** `scripts/checks/R4-switch-on-resolved-store-incomplete.yml:16`, `scripts/checks/R5-optional-import-contract-method.yml:35`, `scripts/completeness-checks.mjs:78`
- **Description (synthesized):** Single-lens (V1-only) but multi-finding within V1 — the new completeness gates that Wave A3 added to PREVENT future recurrence have coverage gaps that allow the exact patterns V1/V2 just flagged (MCP if/else chain at L540, backup.ts optional-casts at L113/138/175/195) to slip through future gates.
- **Evidence:** R4 only matches `switch(...){ $$$ }` shapes; if/else chains on `resolved.store` (the MCP and CLI patterns) slip through. R5 only scans `src/contracts/*.ts`; the backup.ts optional-cast call sites at L113/138/175/195 are invisible. The postprocessor's substring-containment check would textually pass a switch with all 5 labels in comments but only 1 case arm.
- **Fix recommendation:** Extend R4 to match if/else chains on `*.store` discriminators; widen R5's file scope to src/ops, src/adapters, src/sdk; replace substring containment in completeness-checks.mjs with token-aware `case '<label>':` detection.

### AGG-008 — TraceBuilder leaks entity identifiers through node labels/metadata even with redaction rules active

- **Combined lens IDs:** V2-009 + V2-010 (V2 internal pair) + V3-005 (negative-only assertion on edge type)
- **Severity:** MEDIUM (V2-009=MEDIUM, V2-010=MEDIUM, V3-005=MEDIUM)
- **File:line:** `src/provenance/trace-builder.ts:104-108,295-301,328-332` + `test/wave-a3-stores-regression.test.ts:281`
- **Description (synthesized):** TraceBuilder embeds raw `kind`/`name`/`actorId`/`subjectId` into node labels and metadata. `redactGraphNodes` and `redactProvenanceActors` cover only `actorId` (and only via a brittle `by\s+[\w\-@.]+` regex that misses `+`, `'`, `:`, unicode). Receipt-node labels are `Receipt: ${resultSummary}` where `resultSummary` carries entity-name leakage like `Created entity: User/john@example.com` — the regex never fires on this. Adjacent: V3-005 asserts `eventToEdgeType('mutation_orphaned')` is "not `entity_created_by`" but never asserts the specific positive value `missing_provenance` — a typo or rename slips through.
- **Evidence:** V2-009 documents label/metadata leakage of `kind`/`name`/`subjectId`. V2-010 documents the `by\s+...` regex character-class gaps + the resultSummary-label miss. V3-005 documents the negative-only assertion at test line 294.
- **Fix recommendation:** Migrate to structured redaction where labels are reconstructed at render time from already-redacted node metadata, broaden the character class (Unicode-aware), and add explicit positive `expect(edgeType).toBe('missing_provenance')` assertions.

---

## 3. Lens-specific findings (1-lens)

### V1-only (contract completeness)

| ID | File:line | Severity | Description |
|---|---|---|---|
| V1-001 | `src/ops/backup.ts:113,138,175,195` | HIGH | backup.ts retains optional-cast `Pick<...>` casts and `typeof !== 'function'` guards at 4 call sites despite STORES-R2-002 contract promotion — dead code that undermines the type-level guarantee. |
| V1-003 | `src/kernel/policy-enforced-kernel.ts:385` | HIGH | `provenanceEvents` in policy-enforced kernel goes through path-based filtering only — NOT through `redactProvenanceEvent`, despite the wave-edited JSDoc explicitly naming `retrieveBundle.provenanceEvents` as a redaction surface. |
| V1-004 | `src/adapters/local/local-artifact-store.ts:163` | HIGH | `LocalArtifactStore.importSnapshot` uses plain `writeFileSync` — the EXACT pattern Wave A3 just replaced in `ingest()` (STORES-R2-005) with tmp+rename atomic. Sibling helper, same write semantics, not migrated. |
| V1-007 | `src/ops/doctor.ts` (whole file) | HIGH | `doctor()` has no check that consumes `mutation_orphaned` events — a cluster with orphans still reports healthy. Wave-edited comment in cluster-kernel.ts claims "doctor()/verify() can flag it" but doctor.ts has zero matches for `mutation_orphaned`. Promised consumer, missing migration. |
| V1-012 | `src/kernel/cluster-kernel.ts:898` | LOW | `rebuildIndex` provenance detail still claims `clearedFirst:true`, but `performIndexRebuild` (KERNEL-R2-003) no longer calls `clear()` — auditors reading the ledger see a claim contradicting on-disk semantics. |

### V2-only (cross-boundary information flow)

| ID | File:line | Severity | Description |
|---|---|---|---|
| V2-004 | `src/kernel/cluster-kernel.ts:528` | HIGH | Buffer-JSON corruption: `ingest_artifact` arm of `commitMutation` raw-casts `readyCommand.payload.content` to `Buffer`. After CommandQueue persistence round-trip, content becomes `{type:'Buffer', data:number[]}` — `stores.artifact.ingest` writes a binary representation of the JSON object as content, sha256 over wrong bytes, "successful" receipt with corrupt data. Carried over from Wave A2. |
| V2-005 | `src/cli.ts:90,632` | HIGH | CLI silently substitutes `INTERNAL_TRUSTED_PRINCIPAL` BEFORE constructing the SDK, so the SDK's Wave-A3 SURFACE-R2-004 warning condition `options.principal === undefined` is never met. The CLI is the privileged operator surface; the protection is fully bypassed. |
| V2-008 | `src/cli.ts:64` | MEDIUM | CLI `loadPolicyConfig` has no structural validation of `principal` field — unlike MCP which got the SURFACE-R005 `validatePrincipal` fix. Malformed roles short-circuit `matchPrincipals`; empty `id` accidentally grants; unknown `trustZone` skips approval gate. Symmetric CLI boundary missed. |
| V2-011 | `src/policy/redactor.ts:303` | MEDIUM | `redactIndexSourceUri` is exported and declared as canonical for `index_source_uri` rules but NEVER CALLED in src/. Policy authors writing rules with `target:'index_source_uri'` see them silently ignored. Dead code or missing wiring. |
| V2-012 | `src/kernel/policy-enforced-kernel.ts:41` | MEDIUM | `PolicyDeniedError.message` embeds `decision.matchedPolicyName` + `decision.reason` verbatim, which the MCP error handler returns as `{error: err.message}` to the host — leaking policy IDs and human-authored deny reasons (often operationally sensitive). |
| V2-014 | `src/kernel/cluster-kernel.ts:614` | MEDIUM | `commitMutation` records FULL command payload (including artifact `content: Buffer`) into ledger detail for `mutation_committed`. Default (no rules) leaves entire artifact content embedded in observable ledger events. |
| V2-015 | `src/kernel/policy-enforced-kernel.ts:217` | MEDIUM | KERNEL-003 per-source policy filter handles only `sourceStore === 'canonical'` and `sourceStore === 'artifact'` — missing `else if (record.sourceStore === 'ledger')` branch. Index records pointing to ledger events can bypass owner-truth re-checks. |

### V3-only (invariant test completeness)

| ID | Test file:line | Severity | Description |
|---|---|---|---|
| V3-007 | `test/wave-a3-surface-regression.test.ts:124` | MEDIUM | Symlink-realpath sandbox test silently returns (no `expect()`) when `symlinkSync` fails with `EPERM`/`ENOTSUP` (Windows without Dev Mode). On the 5080 rig the invariant is never exercised; test passes trivially. |
| V3-008 | `test/wave-a3-kernel-regression.test.ts:376` | MEDIUM | `link_evidence` orphan-on-receipt-fail test does not assert that the orphan event cites the affected entity id (on `subjectId` OR `detail.entityId`). Parity gap vs the `createEntity` test's leg 5. A regression with empty `subjectId` passes. |
| V3-009 | `test/wave-a3-stores-regression.test.ts:56` | MEDIUM | KERNEL-R2-002 (verify ignores ledger-subject orphan candidates) tests only 2 of 5 ledger-subject event types — `command_compensated` and `mutation_committed` with `targetStore='ledger'` (e.g., link_evidence) are absent despite re-audit-2 explicitly listing all 5. |
| V3-010 | `test/wave-a3-surface-regression.test.ts:380` | MEDIUM | CLI `commit --self-approve` refusal test only asserts exit status + message, not that the command remains in `proposed` state. A regression that refuses on commit but DID auto-walk validate→approve passes the test silently. |
| V3-011 | `test/wave-a3-stores-regression.test.ts:350` | MEDIUM | STORES-R2-005 atomic-ingest test setup triggers `writeFileSync` failure BEFORE any .tmp file is created, so the cleanup `unlinkSync(tmpPath)` branch never runs. The "no .tmp orphans" check trivially passes. Removing the cleanup leaves no observable artifact under this test. |
| V3-012 | `test/wave-a3-surface-regression.test.ts:299` | LOW | SURFACE-R2-004 INTERNAL_TRUSTED_PRINCIPAL warning test covers 3 of 4 (policies × principal) combinations — missing the false-positive guard `NO policies + NO principal → NO WARN`. |
| V3-014 | `test/wave-a3-stores-regression.test.ts:200` | LOW | STORES-R2-003 "verify reports degraded with no_orphaned_mutations" test plants `subjectStore='canonical'` with synthetic id — `provenance_references_valid` will also flag this, so the test cannot isolate which check is the regression target. |
| V3-015 | `test/wave-a3-stores-regression.test.ts:142` | LOW | STORES-R2-002 contract-method tsc test uses `@ts-expect-error` which matches ANY type error, not specifically "method missing" — a future refactor breaking the fixture unrelatedly satisfies the directive. No positive counter-fixture (no `@ts-expect-error` + method present compiling cleanly). |

---

## 4. Recommendations — Wave A3 fix-up vs Stage B carry

Per the protocol's saturation rubric:

- **Fix-up in Wave A3 if:** ≥2 lenses agree (high-signal) AND severity HIGH AND fix is narrow (<10 lines)
- **Defer to Stage B if:** lens-specific findings OR severity MEDIUM/LOW OR fix requires architectural work

### Wave A3 fix-up (recommended — close before Wave A3 exits)

| Cluster | Severity | Fix scope (lines) | Lenses agreeing | Rationale |
|---|---|---|---|---|
| **AGG-001** — MCP cluster_resolve 3 missing arms | HIGH | ~6 lines (3 else-if arms) | 3 (V1+V2+V3) | Narrow, three-lens convergence, identical fix shape to the existing 2-arm pattern. Also unblocks AGG-003 test extension. |
| **AGG-002** — SDK.resolve unconditional sanitization + exhaustiveness + tighten test assertions | HIGH | ~8 lines (move switch out of policyEnforced guard, add default-never, replace OR with AND in 2 tests) | 3-effective (V1+V2+V3 via 4 finding IDs) | Highest-impact security fix in the wave — closes the SDK no-policy leak path for 5 store types. |
| **AGG-003** — CLI resolve 2 missing arms + sanitize inspect/trace | HIGH | ~8 lines (2 else-if arms + gating inspect/trace through sanitizers) | 2 (V1+V2) | Same shape as AGG-001 at adjacent surface. CLI is the privileged operator surface — keeping the gap open undermines AGG-001's fix. |
| **AGG-004** — Sibling `inspectEntity` fix + verb-refinement oracle close + test | HIGH | ~12 lines (apply double-enforce to inspectEntity, catch+rethrow in inspectCommand verb path, 1 new test) | 3 (V1+V2+V3) | Slightly over the <10 line threshold but tightly bounded and the test is mandatory to lock the invariant. Carry to wave-A3 fix-up. |
| **AGG-006** — `cluster_commit_mutation`/`cluster_compensate_mutation` receipt sanitization | HIGH | ~4 lines (wrap result.receipt in 2 arms) | 1 (V2 only) but structurally part of SURFACE-R2-003 cluster | Trivial fix at the same MCP file as AGG-001. Roll up into the AGG-001 fix-up dispatch. |
| **V1-004** — `LocalArtifactStore.importSnapshot` atomic write | HIGH | ~15 lines (copy ingest()'s tmp+rename pattern) | 1 (V1 only) | Slightly over the 10-line threshold, but exact pattern Wave A3 just landed in ingest() — a direct copy-and-adapt. The contract-completeness lens flags this as a clear sibling-helper miss. **Carry to fix-up.** |
| **V1-007** — `doctor()` consumes mutation_orphaned | HIGH | ~25 lines (mirror verify.ts L154-189) | 1 (V1 only) | Over the line threshold but high-value (closes the promised consumer named in cluster-kernel.ts L322-329 comment). Borderline — recommend fix-up if dispatch capacity allows, else defer. |

**Recommended Wave A3 fix-up count: 7 items** (AGG-001 + AGG-002 + AGG-003 + AGG-004 + AGG-006 + V1-004 + V1-007). Sized at roughly 80-100 production lines + 4-6 test legs. Feasible in 1 fix-up dispatch.

### Stage B carry (defer)

| Finding | Severity | Reason for deferral |
|---|---|---|
| AGG-005 (redactor harmonization) | HIGH (max) | Architectural: switching `redactEntity`/`redactArtifact` from denylist to allowlist is a contract change that may break callers expecting kind/name to survive. Requires policy authoring review. |
| AGG-007 (R4/R5/postprocessor coverage) | HIGH (max) | Process work, not security-critical; gates didn't catch the fixes-in-Wave-A3 patterns but the patterns ARE being fixed. Tighten gates as Stage B hygiene. |
| AGG-008 (TraceBuilder structured redaction) | MEDIUM | Architectural refactor (label reconstruction at render time). |
| V1-001 (backup.ts optional casts × 4) | HIGH | Dead-code cleanup, no functional impact. Stage B sweep. |
| V1-003 (`provenanceEvents` through `redactProvenanceEvent`) | HIGH | One-line fix in concept but interacts with bundleRules semantics across multiple call sites — wants careful review. Borderline carry. |
| V2-004 (Buffer-JSON corruption) | HIGH | Already known/documented as Stage B in `repo-knowledge/ingest.ts:236-249`. Carry as is. |
| V2-005 (CLI silent INTERNAL_TRUSTED_PRINCIPAL) | HIGH | Borderline — small fix (2 spots), but the architectural choice (should the CLI even substitute, or should it pass `undefined` upstream?) wants a design decision. Carry. |
| V2-008 / V2-011 / V2-012 / V2-014 / V2-015 | MEDIUM | All carry. |
| V3-007 through V3-015 | MEDIUM/LOW | All test-hardening items. Carry as Stage B test sweep. |
| V1-012 (rebuildIndex provenance detail) | LOW | Cosmetic ledger-detail correctness; non-security. |

**Recommended Stage B carry count: 18+ items.**

### Wave exitability

**Wave A3 is exitable after the recommended 7-item fix-up dispatch.** The high-signal HIGH-severity findings cluster into AGG-001/002/003/004/006 (one MCP-server change, one SDK change, one CLI change, one policy-enforced-kernel change) plus V1-004 (one artifact-store change) plus V1-007 (one ops/doctor change). All are localized and lendentially within a single agent's fix-up scope.

---

## 5. Lens-quality assessment

### Sufficiently distinct (Codex-Verify submodularity)?

**Yes.** All pairwise Jaccard scores fall well below the 0.40 redundancy threshold:
- V1↔V2 = 0.077 (within 0-0.25 sweet spot; the two convergent file:line points — `src/mcp/server.ts:540` and `src/sdk/cluster-sdk.ts:240-250` — are exactly the high-signal cluster anchors AGG-001 and AGG-002, which is GOOD — multiple independent lenses correctly converging on the most consequential issues)
- V1↔V3 = 0.000 (expected by lens design — V3 audits test files)
- V2↔V3 = 0.000 (same)

When measured at **abstraction-level convergence** (which the protocol explicitly requests for high-signal clusters), V3 converged with V1+V2 on AGG-001 (SURFACE-R2-003 5-store sanitization), AGG-002 (SDK.resolve disjunction), AGG-004 (existence-oracle in inspectCommand/inspectEntity), and AGG-005 (redactor.ts behaviors/rule coverage). The lens-design choice for V3 to scope to test files turned out to be a complement, not a redundancy.

### Capped output adherence?

- V1: 13 findings (under cap of 15). Self-capped — V1's summary mentions a 16th category ("Typed error class registry uniqueness") in `abstractions_audited` that was apparently triaged out. Acceptable.
- V2: 15 findings (exactly at cap).
- V3: 15 findings (exactly at cap).

All within the cap. Discipline preserved.

### False-positive evidence?

**No clear false positives.** All findings carry concrete file:line evidence. A few that could be challenged:

- **V2-011** (`redactIndexSourceUri` dead code): the verifier reports zero call sites via `grep`. If the function is genuinely orphan, the finding is correct; if there's a dynamic lookup the static search missed, the finding is wrong. I would treat this as **probably valid** but it warrants a grep verification by a fix-up agent before deletion.
- **V3-005** (`mutation_orphaned` edge type negative-only assertion): the test does pass the negative `not.toBe('entity_created_by')` but the gap is real — a typo regression to `'missing_provenence'` (misspelled) would pass. Valid finding.
- **V2-004** (Buffer-JSON corruption): the verifier acknowledges this is "documented as Stage B" in repo-knowledge — so this is **known-deferred, not a new finding**. Strictly speaking V2 should have noted it as carryover rather than fresh, but the finding's evidence is valid.

No findings appear evidence-light or speculative.

### Gaps the ensemble missed (4th lens candidates)?

Two possible gaps:

1. **Concurrency / race-condition lens.** None of the three lenses audited concurrent access to shared state. Wave A3 introduced `replaceAll` atomic semantics in `performIndexRebuild` (KERNEL-R2-003) and tmp+rename in `LocalArtifactStore.ingest`, but did any lens verify that interleaved reads + replaceAll yield consistent snapshots, or that two concurrent ingest calls don't race on the tmp filename? A "concurrency invariant" lens (assertions about TOCTOU, atomic-write-visibility, and ledger-event ordering) would catch issues none of V1-V2-V3 would.

2. **Backward-compat / migration lens.** Stage A is a contract-promotion wave (STORES-R2-002 promoted `importSnapshot`/`importEvent`/`importReceipt` from optional to required). A lens that audits whether existing operator data + persistence files round-trip cleanly after the contract promotion (no schema drift, no silent re-typing) would be valuable. Closest substitute in current ensemble is V3's `STORES-R2-002` tsc fixture check (V3-015) but that only verifies compile-time, not runtime data integrity.

Neither gap is a Wave A3 blocker. Recommend adding one or both for Wave A4 / Stage B.

---

## 6. Meta-pattern recurrence assessment

**Yes — the "fix-at-N reveals-N-1" meta-pattern recurred in Wave A3**, and the verifier ensemble caught it. Specifically:

- **At the output-sanitization abstraction (SURFACE-R2-003)**: Wave A3 added 5-store-type sanitization in `cluster-sdk.ts` for the policyEnforced path, BUT the no-policy path returned raw (V2-001), the MCP secondary pass covered only 2/5 (V1-002 + V2-002), the CLI baseline covered only 3/5 (V1-006), the SDK switch lacked exhaustiveness (V1-010), the regression tests used disjunctive assertions (V3-002, V3-003), and the MCP test only exercised the artifact arm (V3-001). **Eight findings across all three lenses at the same abstraction layer.**

- **At the existence-oracle abstraction (KERNEL-R2-001)**: Wave A3 fixed `inspectCommand` with double-enforce, BUT the sibling `inspectEntity` retains the original shape (V1-005), and inside `inspectCommand` the verb-refinement second stage re-introduces the oracle (V2-006), and no test exercises the verb-refinement deny path (V3-004). **Three findings across all three lenses at the same abstraction layer.**

- **At the redactor-asymmetry abstraction (KERNEL-R2-006)**: Wave A3 unified strip-vs-mask in `redactProvenanceEvent`, BUT sibling `redactMetadataActors`/`redactProvenanceActors` retain the asymmetry (V1-011), entity/artifact strip is still denylist (V2-007), and tests cover only strip behavior + 2/3 rule types (V3-006, V3-013). **Four findings across all three lenses at the same abstraction layer.**

- **At the boundary-completeness abstraction (STORES-R2-005 atomic write)**: Wave A3 added tmp+rename to `LocalArtifactStore.ingest` BUT the sibling `LocalArtifactStore.importSnapshot` was not migrated (V1-004). One-lens-only.

- **At the orphan-signal-consumption abstraction (STORES-R2-003)**: Wave A3 wired `verify()` to consume `mutation_orphaned` BUT `doctor()` was not (V1-007). One-lens-only.

**The ensemble worked.** The recurrence pattern was detected by multiple independent lenses converging on the same abstraction layers — exactly the high-signal evidence the verifier architecture is designed to surface. The three high-signal HIGH-severity clusters (AGG-001/002/003 + AGG-004 + AGG-005) are precisely the meta-pattern recurrences, and they are all actionable with bounded fix-up scope.

**Recommended communication to the wave coordinator:** the meta-pattern is healthy (caught early, narrow fix), but the underlying engineering signal is that Wave A3 deserves one more fix-up dispatch focused exclusively on the **abstraction-layer completeness** axis (close the sibling/boundary/test gaps named in AGG-001 through AGG-006 + V1-004 + V1-007) before declaring Stage A done. Without it, Stage B inherits a high-signal HIGH-severity backlog that V1/V2/V3 already identified — which would be malpractice against the verifier output.

---

## Appendix — finding-to-cluster index

| Original ID | Cluster / lens-specific bucket |
|---|---|
| V1-001 | V1-only HIGH (backup.ts optional casts) |
| V1-002 | AGG-001 |
| V1-003 | V1-only HIGH (provenanceEvents bundle redaction) |
| V1-004 | V1-only HIGH (LocalArtifactStore.importSnapshot) |
| V1-005 | AGG-004 |
| V1-006 | AGG-003 |
| V1-007 | V1-only HIGH (doctor consumes mutation_orphaned) |
| V1-008 | AGG-007 |
| V1-009 | AGG-007 |
| V1-010 | AGG-002 |
| V1-011 | AGG-005 |
| V1-012 | V1-only LOW (rebuildIndex provenance detail) |
| V1-013 | AGG-007 |
| V2-001 | AGG-002 |
| V2-002 | AGG-001 |
| V2-003 | AGG-006 |
| V2-004 | V2-only HIGH (Buffer-JSON corruption — Stage B carry) |
| V2-005 | V2-only HIGH (CLI silent INTERNAL_TRUSTED_PRINCIPAL) |
| V2-006 | AGG-004 |
| V2-007 | AGG-005 |
| V2-008 | V2-only MEDIUM (CLI loadPolicyConfig validation) |
| V2-009 | AGG-008 |
| V2-010 | AGG-008 |
| V2-011 | V2-only MEDIUM (redactIndexSourceUri dead code) |
| V2-012 | V2-only MEDIUM (PolicyDeniedError message leak) |
| V2-013 | AGG-003 |
| V2-014 | V2-only MEDIUM (commitMutation payload in ledger detail) |
| V2-015 | V2-only MEDIUM (per-source filter missing ledger branch) |
| V3-001 | AGG-001 |
| V3-002 | AGG-002 |
| V3-003 | AGG-002 |
| V3-004 | AGG-004 |
| V3-005 | AGG-008 |
| V3-006 | AGG-005 |
| V3-007 | V3-only MEDIUM (Windows symlink test trivial-pass) |
| V3-008 | V3-only MEDIUM (link_evidence orphan citation) |
| V3-009 | V3-only MEDIUM (KERNEL-R2-002 partial coverage) |
| V3-010 | V3-only MEDIUM (CLI commit --self-approve state assert) |
| V3-011 | V3-only MEDIUM (STORES-R2-005 cleanup branch) |
| V3-012 | V3-only LOW (SURFACE-R2-004 false-positive guard) |
| V3-013 | AGG-005 |
| V3-014 | V3-only LOW (STORES-R2-003 isolation) |
| V3-015 | V3-only LOW (STORES-R2-002 tsc positive counter-fixture) |

**Coverage summary:** 8 unified clusters (AGG-001 through AGG-008) absorb 23 of 43 findings. 20 findings remain lens-specific.

— End of report —
