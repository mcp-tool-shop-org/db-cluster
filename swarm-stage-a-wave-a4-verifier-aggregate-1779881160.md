# Dogfood Swarm Stage A Wave A4 — Verifier Ensemble Aggregate — db-cluster — 2026-05-27

**Repo:** `mcp-tool-shop-org/db-cluster`
**Working copy:** `E:/AI/db-cluster`
**Aggregate type:** Wave A4 verifier ensemble synthesis (V1+V2+V3 → ranked clusters + judgment)
**Coordinator:** Wave A4 coordinator-as-judge
**Aggregate date:** 2026-05-27 11:26 UTC

---

## 1. Inputs

| Verifier | Lens | Output | Findings |
|---|---|---|---|
| V1 | Contract completeness | `.verifier-outputs/v1-wave-a4-contract-completeness.json` | 12 |
| V2 | Cross-boundary information flow | `.verifier-outputs/v2-wave-a4-cross-boundary.json` | 12 |
| V3 | Invariant test completeness | `.verifier-outputs/v3-wave-a4-invariant-test-completeness.json` | 15 |
| **Total raw** | | | **39** |

All three lenses received the dispatch's **family-of-call-sites probe instruction** (Stage B audit Theme 1) — for every Wave A4 fix, probe siblings sharing the same pattern.

---

## 2. Severity rollup

| Severity | V1 | V2 | V3 | Total |
|---|---:|---:|---:|---:|
| CRITICAL | 2 | 0 | 0 | **2** |
| HIGH | 5 | 3 | 5 | **13** |
| MEDIUM | 4 | 4 | 6 | **14** |
| LOW | 1 | 5 | 4 | **10** |
| **TOTAL** | **12** | **12** | **15** | **39** |

All three lenses respected their 15-finding caps (V1=12, V2=12, V3=15).

---

## 3. Pairwise correlation (Jaccard ρ)

| Pair | file:line Jaccard | Abstraction-level convergence | Interpretation |
|---|---|---|---|
| V1 ↔ V2 | **~0.18** (~5 of ~24 unique sites) | High: AGG-A4-1 (adapter errors), AGG-A4-3 (cluster_trace/why), V1-A4-011/V2-A4-012 (lifecycle payload), V1-A4-008/V2-A4-005 (command-queue marker) | Below 0.25 threshold per Codex-Verify submodularity. Sufficiently distinct. |
| V1 ↔ V3 | **0.000** (by construction — V3 audits test files, V1 audits src) | High: AGG-A4-2 (staging dir — V1-A4-005 + V3-A4-002/003), AGG-A4-4 (CommandQueue.persist — V3 only this wave but V1 framing is consistent) | Same lens-design distinction as Wave A3. Test-file scope is a feature. |
| V2 ↔ V3 | **0.000** (same reason) | High: AGG-A4-2 staging (V2-A4-004/009 + V3-A4-002/003) | Same. |

**Submodularity verdict:** All pairs at or below 0.25 threshold. **No lens needs to be dropped or rewritten.** The 3-lens ensemble continues to satisfy the Wave A3 submodularity precondition.

---

## 4. High-signal clusters (≥2 lenses agreed OR severity ≥ HIGH single-lens)

Eight clusters surface. Each one's column "Closed in coordinator fix-up" marks the disposition.

### AGG-A4-1 — Adapter-side typed errors extend `Error`, not `ClusterError`

| Lens | Finding | Severity |
|---|---|---|
| V1 | V1-A4-003 | HIGH |
| V2 | V2-A4-003 | HIGH |
| V2 | V2-A4-008 | LOW (paired with V2-A4-003) |

**Synthesis:** `ImportConflictError`, `LedgerCycleDetectedError`, `CorruptStoreError`, `InvalidContentHashError`, `ImportSnapshotNotSupportedError`, `ResolveError`, `ClusterUriError` all extend plain `Error`. Pass through `redactError`'s `instanceof ClusterError` branch → fall to `BUILTIN_ERROR_CODES` lookup → not in map → collapse to `INTERNAL_ERROR`. Hosts can't branch on the new typed errors despite SURFACE-B-003 wiring redactError. Also V2-A4-003 separately notes `ImportConflictError.message` embeds 120-char JSON of conflicting records.

**Closed in fix-up:** ✓ — `BUILTIN_ERROR_CODES` extended with 7 adapter-tier class names (`CorruptStoreError → CORRUPT_STORE`, `InvalidContentHashError → INVALID_CONTENT_HASH`, `ImportConflictError → IMPORT_CONFLICT`, `LedgerCycleDetectedError → LEDGER_CYCLE_DETECTED`, `ImportSnapshotNotSupportedError → IMPORT_SNAPSHOT_NOT_SUPPORTED`, `ResolveError → RESOLVE_NOT_FOUND`, `ClusterUriError → INVALID_CLUSTER_URI`). Architectural decision (promote adapter errors to `ClusterError`) explicitly deferred to B1-Amend per no-back-edge rule.

### AGG-A4-2 — Kernel `.db-cluster/pending-content/` staging dir lifecycle gap

| Lens | Finding | Severity |
|---|---|---|
| V1 | V1-A4-005 (doctor/verify check missing) | HIGH |
| V1 | V1-A4-004 (backup excludes staging) | HIGH |
| V2 | V2-A4-004 (no orphan sweep + suffix-shape mismatch) | MEDIUM |
| V2 | V2-A4-009 (deleteStagingFile misses tmp leftovers) | LOW |
| V3 | V3-A4-002 (no orphan-sweep test) | HIGH |
| V3 | V3-A4-003 (tmp suffix shape incompatible with sweep regex) | HIGH |

**Synthesis:** Highest-converging cluster. KERNEL-B-007's staging area is a new persistence boundary with three distinct gaps: (a) no sweep wired on construction → orphans accumulate; (b) kernel tmp suffix is `randomBytes(8).toString('hex')` = 16 hex chars vs adapter sweep regex `[a-z0-9]{1,6}` = 1-6 chars (regex mismatch); (c) doctor/verify/backup all unaware of the dir.

**Closed in fix-up:** **Partial.** Suffix shape aligned (kernel now uses `randomBytes(3)` = 6 hex chars matching the sweep regex). One-shot orphan sweep wired inline in `getStagingDir()` with `stagingSwept` guard. Tests in `wave-a4-fixup-regression.test.ts` cover orphan-cleanup behavior. **Deferred to B1-Amend:** backup() including staging files (V1-A4-004) + doctor/verify `no_orphan_staging` check (V1-A4-005) — both are larger contract changes requiring design review.

### AGG-A4-3 — `cluster_trace` + `cluster_why` MCP arms leak ProvenanceGraph identifiers (sibling-of SURFACE-B-001)

| Lens | Finding | Severity |
|---|---|---|
| V1 | V1-A4-006 | HIGH |
| V2 | V2-A4-001 (cluster_trace) | HIGH |
| V2 | V2-A4-002 (cluster_why) | HIGH |
| V3 | V3-A4-005 (cluster_resolve index arm untested — adjacent test gap) | HIGH |

**Synthesis:** SURFACE-B-001 fix closed find_sources LIST sanitization. cluster_trace + cluster_why share the same kernel→MCP boundary but spread raw ProvenanceGraph. TraceBuilder bakes `${entity.kind}: ${entity.name}`, `${event.action} by ${event.actorId}`, `Receipt: ${receipt.resultSummary}` into node labels — all surface across the boundary unchanged. Without policies (the ~614-test baseline path), these arms leak owner-truth.

**Closed in fix-up:** ✓ — new `sanitizeProvenanceGraphForOutput` helper in `src/policy/store-output-sanitizers.ts` strips node labels + metadata + opaque-marks edge reasons. Wired into `cluster_trace` AND `cluster_why` MCP arms (server.ts). `wave5-parity` Parity 3 test updated to assert structural-equivalence rather than byte-equal text (MCP why now intentionally diverges from SDK why text content — operator-clarity tradeoff captured in test). V3-A4-005 (cluster_resolve index arm test) included in fixup regression tests. **Note:** AGG-008 TraceBuilder structured-redaction architectural refactor remains deferred to B1-Amend; this fix is a tactical MCP-side sanitization mirroring the SURFACE-B-001 pattern, not an in-trace-builder refactor.

### AGG-A4-4 — `CommandQueue.persist` still uses fixed `.tmp` suffix (sibling-of STORES-B-001)

| Lens | Finding | Severity |
|---|---|---|
| V3 | V3-A4-004 | HIGH |

**Synthesis:** Single-lens but pure family-of-call-sites win — V3 explicitly probed siblings of the STORES-B-001 fix and found `src/kernel/command-queue.ts:117` still has the fixed-suffix race the wave was supposed to retire. The STORES-B-001 audit + fix scoped to `src/adapters/local/` missed the kernel-side sibling.

**Closed in fix-up:** ✓ — `CommandQueue.persist` now uses inline `buildRandomTmpPath` + `cleanupOrphanTmpFiles` (inlined to honor the no-back-edge rule between kernel and adapters). Constructor now sweeps orphan tmp files at startup.

### V1-A4-001 (CRITICAL, V1-only) — 5 shipped examples broken

**Synthesis:** Every example in `examples/sdk/`, `examples/research-evidence-cluster/`, `examples/agent-safe-app-db/`, `examples/project-memory-cluster/` calls `proposeMutation({verb: 'ingest_artifact', payload: {content: Buffer, ...}})` without supplying `contentHash`. KERNEL-B-007's new contract requires the hash; throws `ContentHashMismatchError('<missing>', actualHash)` on first run. Examples ship in npm tarball per `package.json files` — first-user-experience-killer.

**Closed in fix-up:** ✓ — all 5 examples now compute `createHash('sha256').update(buf).digest('hex')` and include `contentHash` in payload. Lint clean.

### V1-A4-002 (CRITICAL, V1-only) — `ImportConflictError` unreachable via `restore()`

**Synthesis:** STORES-B-003 added content-compare in 4 import* methods to throw `ImportConflictError` on byte-mismatch. But `src/ops/backup.ts` `restore()` short-circuits with `exists(id)` BEFORE calling any import* method. Tampered backup with matching id → silently skipped, `result.<store>.skipped++` increments, operator believes restore succeeded. Unit-level fix never reaches the integration consumer.

**Closed in fix-up:** ✓ — all 4 restore arms (entities/artifacts/events/receipts) now fetch the existing record via `get(id)` / `listEvents` / `listReceipts` when `exists(id)` is true, then call `assertContentMatch(storeKind, id, existing, incoming)` from `src/adapters/local/errors.ts`. Mismatches throw `ImportConflictError` which gets pushed to `result.<store>.errors[]` by the existing try/catch. `stableArtifactFields` helper excludes `storagePath` from comparison (it's per-cluster, not content-bearing). Integration test in `wave-a4-fixup-regression.test.ts`.

### V3-A4-001 — Compensate-path staging cleanup untested

**Synthesis:** `cluster-kernel.ts::compensateMutation` calls `this.deleteStagingFile()` as belt-and-suspenders, but only `rejectMutation` cleanup is tested. A regression removing the compensate-arm cleanup would slip through.

**Closed in fix-up:** ✓ — regression test added to `wave-a4-fixup-regression.test.ts`.

### Other single-lens findings

| ID | Severity | Disposition |
|---|---|---|
| V1-A4-007 (compareRetrieval propagates LedgerCycleDetectedError raw) | HIGH | **Deferred to B1-Amend** (integration boundary, design pass for partial-result semantics) |
| V1-A4-008 (CommandQueuePersistenceLost lazy throw) | MEDIUM | **Deferred to B1-Amend** (doctor() check is the right surface; pair with V1-A4-005) |
| V1-A4-009 (CLI lacks try/catch for new typed errors) | MEDIUM | **Deferred to B1-Amend** (broader SURFACE-B-004 work) |
| V1-A4-010 (CLI lacks structured error formatter) | MEDIUM | **Deferred to B1-Amend** (pair with V1-A4-009) |
| V1-A4-011 (in-memory mode payload bypass) | MEDIUM | **Deferred to B1-Amend** (design choice — either document or hash-even-in-memory) |
| V1-A4-012 (mediaType→mimeType typo) | LOW | **Deferred** (cosmetic, no functional impact) |
| V2-A4-005 (CommandQueue marker dropped from backup) | MEDIUM | **Deferred to B1-Amend** (paired with V1-A4-004 backup-includes-staging design) |
| V2-A4-006 (ReceiptFailedError inlines cause.message) | MEDIUM | **Deferred to B1-Amend** (no-cause-walk design tension; needs design pass) |
| V2-A4-007 (PATH_REGEX gaps) | LOW | **Deferred** (theoretical; production paths are all absolute) |
| V2-A4-010 (CLI dry-run/runtime substitution drift) | MEDIUM | **Deferred to B1-Amend** (paired with broader CLI work) |
| V2-A4-011 (redactProvenanceActors regex ASCII-only) | LOW | **Deferred to B1-Amend** (AGG-008 architectural area) |
| V2-A4-012 (lifecycle payload formatCommandOutput unsanitized) | LOW | **Deferred to B1-Amend** (paired with broader inspect-command sanitization design) |
| V3-A4-006 (property test under-asserts staging-file deletion) | MEDIUM | **Deferred** — coverage already strong via single-example tests + new fix-up regression tests cover staging-file lifecycle |
| V3-A4-007–015 | MEDIUM/LOW | All sentinel-strengthening; deferred to B1-Amend |

---

## 5. Lens-quality assessment

### Family-of-call-sites probe — load-bearing this wave

The dispatch added the explicit instruction: "for every fix in this wave, after probing the named site, probe the **family-of-call-sites** for the same pattern." Direct hits:

- **V3-A4-004** (CommandQueue.persist sibling of STORES-B-001) — pure new finding the probe surfaced. The audit + fix scoped to `src/adapters/local/` would never have surfaced this without the probe.
- **V1-A4-006 + V2-A4-001/002** (cluster_trace/why siblings of SURFACE-B-001 find_sources) — the AGG-A4-3 cluster.
- **V1-A4-001** (examples as siblings of test call-site updates) — the probe explicitly enumerated examples/ when checking ingest_artifact propose sites.
- **AGG-A4-2 staging sweep** — V2 + V3 both surfaced the sibling tmp-suffix shape gap.

The probe validates as a v2 ensemble enhancement. Worth promoting to canonical v2 protocol.

### Coverage gaps the ensemble missed (4th-lens candidates)

- **Concurrency/TOCTOU lens** — still not in the ensemble. The kernel staging dir has multi-process concurrency questions (two processes proposing same contentHash race on writeFileSync → renameSync) that no lens probed (V2's self-assessment acknowledges this).
- **Backward-compat / migration lens** — Wave A4 changed the propose contract for `ingest_artifact` (now requires contentHash). V1 caught the examples breaking but did not formally audit the migration story for v0.1.0 → v0.1.1 callers.

Recommend tracking these as candidate lenses for B1-Amend or a future Wave A5.

---

## 6. Fix-up dispatch summary

The coordinator dispatched a single fix-up agent to close 6 items:

| Item | Source cluster | Severity | Status |
|---|---|---|---|
| 1. Fix 5 examples (Buffer + contentHash) | V1-A4-001 | CRITICAL | ✓ Closed |
| 2. restore() ImportConflict reachability (4 arms) | V1-A4-002 | CRITICAL | ✓ Closed |
| 3. redactError BUILTIN_ERROR_CODES extension (7 codes) | AGG-A4-1 | HIGH | ✓ Closed |
| 4. Kernel staging sweep + suffix alignment | AGG-A4-2 partial | HIGH | ✓ Closed |
| 5. CommandQueue.persist buildRandomTmpPath | AGG-A4-4 | HIGH | ✓ Closed |
| 6. cluster_trace + cluster_why sanitization | AGG-A4-3 | HIGH | ✓ Closed |
| **Total** | | | **6/6 closed** |

Plus 1 cascading test fix (wave5-parity Parity 3 updated for sanitized MCP why).

**13 lower-priority items deferred to B1-Amend** with explicit reasoning tied to architectural/design considerations.

---

## 7. Post-fix-up verification

| Check | Result |
|---|---|
| `npm run lint` | PASS (tsc --noEmit + lint:examples) |
| `npx vitest run test/wave-a4-fixup-regression.test.ts` | 25/25 PASS |
| Adjacent cohort (10 files: wave-a4-{kernel,stores,surface,tests}-regression + wave6-proof + wave5-parity + wave-a3-{stores,tests}-regression + phase15-proof + verb-parity) | 149 PASS, 2 skipped, 0 failed |
| `npm test` (3 deterministic runs) | **778 / 55 / 0 across 3 runs** (baseline 753/55/0 + 25 new regression tests) |
| `node scripts/release-gate.mjs` | **7/7 PASS — ready for release** |

---

## 8. Recommendation to the advisor

**Wave A4 is exitable.** The 2 CRITICAL findings (broken examples + restore-unreachable-ImportConflictError) are closed end-to-end with regression tests. The 4 HIGH-signal clusters are closed at the boundary the fix-up scope addressed; the architectural follow-ups (adapter→ClusterError promotion, staging-in-backup, doctor orphan-staging check, CLI uniform safeAction, in-memory payload hashing, AGG-008 trace-builder structured redaction) are well-bounded B1-Amend work with reasoned defer rationale.

The Wave A4 saturation indicators:
- 0 CRITICAL post-fix-up
- 0 regressions-of-A3
- HIGH residuals all DEFERRED-to-B1-Amend with explicit reasoning
- New finding rate: 4 distinct architectural domains (staging-in-backup, CLI uniform safeAction, trace-builder structured-redaction, adapter→ClusterError) — bounded
- Test suite deterministic 3/3 at 778/55/0

The family-of-call-sites probe instruction was load-bearing — caught 4 sibling-miss bugs the prior 3 lenses missed at scope. Promote to canonical v2 protocol.

---

*End of Wave A4 verifier aggregate. Hand to advisor for Wave A4 close decision + B1-Amend dispatch design (with the 13 deferred items + the architectural decisions table from the user's prior message).*
