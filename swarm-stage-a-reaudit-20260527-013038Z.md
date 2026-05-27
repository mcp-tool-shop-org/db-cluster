# Dogfood Swarm Stage A Re-Audit — db-cluster — 2026-05-27

**Repo:** `mcp-tool-shop-org/db-cluster`
**Working copy:** `E:/AI/db-cluster`
**Audit type:** Stage A Re-Audit — adversarial probing of Wave A1 fixes + standard Stage A lens
**Coordinator:** Dogfood Swarm Stage A Re-Audit (5 parallel domain auditors)
**Audit date:** 2026-05-27 01:30 UTC
**Audit pass:** 2 (post-Wave A1)

---

## 1. Baseline

| Field | Value |
|---|---|
| Pre-reaudit HEAD SHA | `48d8063` (`Add Stage A audit + Wave A1 amend reports`) |
| Branch | `main` (2 commits ahead of origin/main — un-pushed) |
| Working tree | clean |
| Save points present | `swarm-stage-a-save-1779834974` (pre-audit), `swarm-stage-a-amend-1779837797` (pre-amend), `swarm-stage-a-reaudit-1779843973` (pre-reaudit) |
| `npm run lint` | PASS — 0 errors (covers `tsc --noEmit` on src/ AND `tsc -p tsconfig.examples.json`) |
| `npm test` | **623 passed / 53 skipped across 58 test files** — exact match with amend report |
| `node scripts/release-gate.mjs` | **PASS — all 6 stages green** |
| Suite duration | 124.9s |

Baseline drift from Wave A1 amend report: **none.** Re-audit started from the documented post-amend state.

---

## 2. Severity rollup

| Domain | CRITICAL | HIGH | MEDIUM | LOW | Total |
|---|---:|---:|---:|---:|---:|
| Kernel | 0 | **3** | 6 | 7 | **16** |
| Stores | 0 | **2** | 4 | 7 | **13** |
| Surface | 0 | **2** | 4 | 6 | **12** |
| Tests | 0 | **4** | 4 | 4 | **12** |
| CI/Docs | 0 | **4** | 5 | 5 | **14** |
| **TOTAL (raw)** | **0** | **15** | **23** | **29** | **67** |

**De-duplication:** Kernel `KERNEL-R003` and Surface `SURFACE-R001` are the same finding (CLI `_kernel` bypass). After de-dup: **14 unique HIGH**.

**Regressions:** 4 (clean in Audit 1, now broken — see §11).
**Stage A exit gate (0 CRITICAL + 0 HIGH + no regressions):** **NOT MET.**

---

## 3. Invariant assessment matrix (post-amend)

| # | Invariant | Audit 1 | Re-audit | Change | Confidence |
|---|---|---|---|---|---|
| 1 | No mutation without command | BYPASSED | **PARTIAL — helper path fixed; CLI `_kernel` + ingest.ts artifact path re-introduce bypass** | Improved at type level; defeated at call sites | High |
| 2 | Index is derivative | HOLDS (partial) | HOLDS (improved) | `replaceAll` collapses empty-window; not in contract (`STORES-R003`) | High |
| 3 | Redaction on every read | SEVERELY BYPASSED | **PARTIAL — wrappers exist but: CLI `_kernel` bypass; SDK.resolve() unwrapped; 4 new policy-layer leaks (R004/R005/R006/R007)** | Headline closed; structural gaps remain | High |
| 4 | Artifact content boundary in MCP | BYPASSED | **PARTIAL — `storagePath` stripped; `sanitizeEntityForOutput` + `sanitizeReceiptForOutput` are DEAD CODE** | Artifact closed; entity/receipt still leak | High |
| 5 | SQL parameterized | HOLDS (no test net) | HOLDS (Postgres-gated tests added — local equivalent missing for prototype pollution) | Improved | High |
| 6 | Artifact storagePath sandboxed | BYPASSED via importSnapshot | HOLDS for importSnapshot; **`getContent()` skips contentHash validation on the load path** (STORES-R005) | Headline closed; defense-in-depth gap | High |
| 7 | Backup/restore integrity | BYPASSED | **PARTIAL — code fix landed; Phase 12 Proof 12 still calls `doctor()` not `verify()` so STORES-001 has no test net** (STORES-R001) | Code fixed; test gap = invisible regression risk | High |
| 8 | Receipt completeness | PARTIAL | **PARTIAL — try/catch in place; nested catch silently swallows; no `ops/` consumer of `mutation_orphaned`** (KERNEL-R009) | Improved; observability gap remains | High |
| 9 | Command lifecycle | PARTIAL | **PARTIAL — kernel tightened (`['validated','approved']`); SDK + CLI silently auto-walk proposed→validated→approved with same actor** (KERNEL-R002) | Kernel tightened; surface layer reverts | High |
| 10 | CommandQueue freshness vs atomicity | PARTIAL (HOLDS for freshness) | **REGRESSION — Stores raised the bar with atomic tmp+rename; CommandQueue still `writeFileSync` → relative outlier, single point of corruption** (KERNEL-R001) | Stage B candidate elevated to HIGH | High |

---

## 4. CRITICAL findings (0)

**None.** Wave A1 closed all 8 Audit-1 CRITICALs. The re-audit found no new CRITICALs.

---

## 5. HIGH findings (14 unique)

### Cross-domain (1 finding — flagged by both Kernel and Surface domains)

#### KERNEL-R003 ≡ SURFACE-R001 — CLI unwraps `PolicyEnforcedKernel._kernel` at 10 call sites, defeating the new wrappers
**Files:** `src/cli.ts:202, 232, 256, 305, 353, 415, 532, 683, 712, 726`
**Description:** Although KERNEL-001 added wrappers for all 7 missing verbs (`ingestArtifact`, `createEntity`, `linkEvidence`, `inspectEntity`, `inspectCommand`, `traceBundle`, `explainTrace`, `indexStatus`), the CLI obtains the underlying ClusterKernel via `kernel instanceof PolicyEnforcedKernel ? kernel._kernel : kernel` and invokes write helpers directly. Stale comments at cli.ts:200 (`PolicyEnforcedKernel does not expose ingestArtifact today (KERNEL-001). Fall back to the underlying ClusterKernel...`) and cli.ts:304 (`inspectEntity is on the underlying kernel (KERNEL-001 — not wrapped)`) DIRECTLY CONTRADICT the Wave A1 fix. `src/integrations/repo-knowledge/ingest.ts:240` does the same `_kernel` unwrap for artifact ingest with an inline comment falsely claiming 'policy layer still fires.' Net effect: when an operator configures `.db-cluster/policies.json` for least-privilege, the CLI silently routes around the policy layer for the most write-heavy verbs. This is a direct regression of SURFACE-002 (`SDK/CLI/MCP never instantiate PolicyEnforcedKernel`) — the CLI now instantiates PolicyEnforcedKernel AND discards it.
**Recommendation:** Delete every `kernel._kernel` unwrap from `cli.ts` and `repo-knowledge/ingest.ts:240`. Call the wrappers directly (they exist for all 7 verbs because of ClusterKernelInterface). Delete the stale 'KERNEL-001 — not wrapped' comments at cli.ts:200, 304. Restrict the `_kernel` getter on PolicyEnforcedKernel to test-only via a runtime marker, or remove it entirely.
**Evidence:** 10 call sites in cli.ts. PolicyEnforcedKernel wrappers verified to exist at policy-enforced-kernel.ts:138 (inspectEntity), :418 (inspectCommand), :494 (indexStatus), :510 (ingestArtifact), :522 (createEntity), :534 (linkEvidence), :560 (traceBundle), :585 (explainTrace).

### Kernel domain (2 additional HIGH)

#### KERNEL-R001 — CommandQueue still uses plain `writeFileSync`; relative outlier after Stores atomic-write upgrade
**File:** `src/kernel/command-queue.ts:46`
**Description:** All four local Stores adapters now use atomic `tmp+rename` + typed `CorruptStoreError` per STORES-005. CommandQueue did not get the same treatment — it persists via `writeFileSync(filePath, JSON.stringify(arr, null, 2))` with no atomic guarantee, and `load()` has no try/catch around `JSON.parse`. Worse: every helper-method write path now calls `saveCommand` (KERNEL-002 fix) inside the post-mutation try/catch — so a CommandQueue write failure (corrupt JSON, concurrent writer race) now triggers the `mutation_orphaned` path AND leaves a corrupt commands file that breaks every subsequent `inspectCommand`/`commitMutation` in the process. The amend report §6 item 5 acknowledged this as a Stage B candidate; the re-audit elevates severity from LOW (Audit-1 KERNEL-021) to HIGH because the symmetry break is now load-bearing.
**Recommendation:** Apply the same `tmp+rename` pattern. Wrap `load()` in try/catch around `JSON.parse` and throw a typed error (mirror `CorruptStoreError`).

#### KERNEL-R002 — SDK + CLI auto-walk lifecycle defeats KERNEL-006 separation-of-duties tightening
**File:** `src/sdk/cluster-sdk.ts:224-235`; `src/cli.ts:363-368`
**Description:** KERNEL-006 correctly tightened `committableStatuses` to `['validated','approved']`. But `ClusterSDK.commitMutation` inspects the command and, if status==='proposed', sequentially calls `validateMutation` then `approveMutation` using the supplied actorId, then `commitMutation`. The same actor 'approves' its own proposal. CLI.commit does the same walk. The amend report framed this as 'auto-walk for backward compat' — but the backward-compat preserves the security-bypass behavior. KERNEL-006 holds only at the raw-kernel layer; every product surface that uses the SDK or CLI reverts to the pre-fix behavior.
**Recommendation:** Either (a) remove the SDK auto-walk and require callers to explicitly `validateMutation` + `approveMutation`, (b) auto-walk only `validated → approved` (force callers to explicitly validate), or (c) require a distinct `approver` actor that must differ from `committer`. Update the amend report's KERNEL-006 verdict accordingly.

### Stores domain (2 HIGH)

#### STORES-R001 — Phase 12 Proof 12 still calls `doctor()` not `verify()` — STORES-001 entity-ID preservation fix is invisible to the test suite
**File:** `test/phase12-proof.test.ts:283`
**Description:** Audit-1's STORES-009 (MEDIUM) flagged that Proof 12 calls `doctor()` (reachability) instead of `verify()` (orphan-subject detection). The Wave A1 amend did NOT explicitly fix STORES-009. STORES-001 (entity ID preservation) IS fixed in code (`LocalCanonicalStore.importSnapshot` + `PostgresCanonicalStore.importSnapshot`) but has NO positive assertion in any test. If the fix ever regresses (entity IDs randomized on restore), every restored entity's provenance chain shreds AND Proof 12 still passes green because `doctor()` only checks reachability, not provenance integrity. Re-audit escalates from MEDIUM (Audit-1 STORES-009) to HIGH because this test gap means the entire STORES-001 fix has no regression net.
**Recommendation:** Replace `expect(health.status).toBe('healthy')` at phase12-proof.test.ts:284 with `const v = await verify(freshStores); expect(v.status).toBe('healthy');`. Additionally add a positive assertion: `expect((await freshStores.canonical.list()).map(e => e.id).sort()).toEqual(originalIds.sort())`.

#### STORES-R002 — Two `ImportSnapshotNotSupportedError` classes with different signatures; one is dead code
**File:** `src/adapters/local/errors.ts:49` + `src/ops/errors.ts:15`
**Description:** Duplicate class name declared in TWO files with DIFFERENT signatures: `src/adapters/local/errors.ts:49` (takes `storeName: string`) and `src/ops/errors.ts:15` (takes `storeKind: 'canonical'|'artifact'|'ledger', missingMethod: string`). The `adapters/local` copy is DEAD CODE — never imported anywhere. `backup.ts:13` imports from `'./errors.js'` which resolves to `src/ops/errors.ts`. The docstring in `src/adapters/local/errors.ts:9-11` claims the class is shared with surface-side code — explicitly false. Any consumer who imports `ImportSnapshotNotSupportedError` from the adapters/local path would get a DIFFERENT class than what backup.ts throws. `instanceof ImportSnapshotNotSupportedError` checks could fail silently depending on import path. Mild correctness risk; high confusion risk; trivial fix.
**Recommendation:** Delete `src/adapters/local/errors.ts:49-60` and its misleading comment. Keep only the `src/ops/errors.ts` version.

### Tests domain (4 HIGH)

#### TESTS-R001 — `wave6-proof.test.ts:350` is structural test theatre (passes via comment substring match)
**File:** `test/wave6-proof.test.ts:350`
**Description:** Proof 9 'main package index exports only deliberate public API' asserts `expect(indexContent).toContain('ClusterKernel');` against the SOURCE TEXT of `src/index.ts`. After KERNEL-013 the file no longer exports ClusterKernel — but the test still passes because the symbol name appears in JSDoc comments (`'Raw ClusterKernel class (KERNEL-013): exporting this publicly bypassed...'`). The test directly CONTRADICTS the parallel `phase15-proof.test.ts:49` (`expect(keys).not.toContain('ClusterKernel')` against `Object.keys(mainExports)`). Both pass green; one is provably wrong. **This is the same anti-pattern as the original Audit-1 TESTS-001** — structurally trivial probe of an invariant via substring/prototype-name match.
**Recommendation:** Switch wave6-proof:350 to `import('../src/index.js')` + `Object.keys()` + `.not.toContain('ClusterKernel')` to align with phase15-proof:49 and post-KERNEL-013 reality. **Regression class — same bug pattern Audit 1 flagged.**

#### TESTS-R002 — SURFACE-002 SDK wiring has ZERO end-to-end test coverage
**File:** `test/policy-surface.test.ts:22`
**Description:** SURFACE-002 fix made the SDK opt-in wrap PolicyEnforcedKernel when policies are supplied. `policy-surface.test.ts:25-30` constructs an SDK with `policies: DEFAULT_POLICIES` — but the assertions only exercise `sdk.policyExplain()` / `sdk.policyTest()` (dry-run surfaces). No test exercises `sdk.findSources`, `sdk.commitMutation`, `sdk.retrieveBundle` after the wrap. If the SDK regresses to ignoring `policies` and silently falling back to raw ClusterKernel (the pre-fix behavior), no test catches it.
**Recommendation:** Add ≥3 integration tests: (1) restricted-principal SDK + policies → `sdk.findSources` filters canonical-backed records; (2) proposer-only principal → `sdk.commitMutation` throws PolicyDeniedError; (3) SDK without policies → `sdk.commitMutation` succeeds.

#### TESTS-R003 — TESTS-006 sweep missed `npx tsx` in `phase10-proof.test.ts`
**File:** `test/phase10-proof.test.ts:48, :102`
**Description:** TESTS-006 was supposed to remove ALL `npx tsc` and `npx tsx` shell-outs from inside vitest. The amend report's table claims `phase10-proof.test.ts` is fixed — but Proof 2 (line 48) and Proof 5 (line 102) still call `execSync('npx tsx src/cli.ts --help', ...)`. tsx spins up a full TS compilation for every test, and the test then asserts on stdout of a sub-process. The sweep correctly removed `npx tsc` at line 66 but missed `npx tsx`.
**Recommendation:** Replace lines 48 and 102 with either source-string command-declaration regex (like cli-docs.test.ts) or `node dist/cli.js --help` (like wave6-proof.test.ts). **Regression class — the sweep claimed to be complete but missed a sibling pattern.**

#### TESTS-R004 — Five new typed errors / write-path mechanisms have zero regression nets
**File:** (none — coverage gap)
**Description:** Wave A1 added five new typed errors / write-path mechanisms; only two have regression tests. Covered: `InvalidContentHashError` (path-traversal.test.ts), `CommandNotValidatedError` (phase5-proof.test.ts:47, kernel.test.ts:230). **NOT covered:** (a) `ReceiptFailedError` + `mutation_orphaned` event (KERNEL-005 fix); (b) `CorruptStoreError` (STORES-005 fix); (c) `ImportSnapshotNotSupportedError` (STORES-003 fix); (d) `LocalCanonicalStore.importSnapshot` entity-ID preservation (STORES-001 fix — only artifact-ID preservation is tested at phase12-proof:90); (e) `LedgerStore.importEvent / importReceipt` idempotency (STORES-002 fix — no double-restore test). If any of these mechanisms is removed or regressed, no test fires.
**Recommendation:** Add 5 small tests — see Tests agent report for specific recommendations.

### CI/Docs domain (4 HIGH)

#### CIDOCS-R001 — `dashboard/lib/apply-redaction.{d.ts,js}` imports from `../../src/...` — breaks at install time for TypeScript consumers
**File:** `dashboard/lib/apply-redaction.d.ts:8`; `dashboard/lib/apply-redaction.js:23` (JSDoc)
**Description:** The new lib file extracted by TESTS-004 imports its `DashboardObject` type from `'../../src/dashboard/dashboard-model.js'`. The `src/` tree is NOT in package.json `files` (only `dist/` ships). After `npm install db-cluster`, the type reference is dangling — TypeScript users importing from `db-cluster/dashboard/lib/apply-redaction.js` get a 'Cannot find module' error. Runtime is fine; the typed boundary is broken at install time. This is a NEW regression introduced by Wave A1.
**Recommendation:** Reference `'../../dist/dashboard/dashboard-model.js'` OR re-export `DashboardObject` from `db-cluster/types` and reference that subpath. Also extend `release-gate.mjs` `scanForDrift` to walk `dashboard/lib/` (CIDOCS-R008).

#### CIDOCS-R002 — 5 docs still claim `ClusterKernel` is exported from `'db-cluster'`
**Files:** `docs/release-notes-v0.1.md:78`, `docs/package-boundary.md:9`, `docs/handbook.md:1050`, `docs/phase-15-closeout.md:34`, `docs/release-readiness.md:12`
**Description:** KERNEL-013 removed `ClusterKernel` from public exports — confirmed in `src/index.ts:19-24` ('NOT PUBLIC: Raw ClusterKernel class'). Five docs still claim it IS exported. Copy-pastable code examples that fail immediately. Worst offender: `docs/release-readiness.md:12` says 'SDK import works ✓ — smoke-install.mjs: `import { ClusterKernel }` succeeds' — false; smoke-install was updated by the coordinator to use ClusterSDK.
**Recommendation:** Five-file sweep + add a release-gate stage that does `import * as pkg from db-cluster` and asserts expected named exports.

#### CIDOCS-R003 — Principal interface shape is wrong in 4 doc files
**Files:** `docs/policy-and-redaction.md:10-17`, `docs/handbook.md:419-424`, `docs/cli.md:216`, `examples/mcp/safety-model.md:99`
**Description:** Docs show `Principal = { id, trustZone, capabilities }` and `Capability = 'read'|'write'|'propose'|'approve'|'admin'`. The actual Principal type (`src/types/policy.ts:15-21`) is `{ id, name, roles, trustZone, metadata? }` — the docs invent a `capabilities` field and omit required `name` and `roles`. The actual `Capability` union has 13 specific verbs ('discover_existence', 'read_owner_truth', 'read_derivative', 'commit_command', etc.) — the docs' 5 invented values are not any of them. Wave A1 fixed examples but not prose docs.
**Recommendation:** Three-file doc sweep. Consider extracting Principal/Capability/Policy types into a single canonical source-of-truth doc that the others link to.

#### CIDOCS-R004 — `examples/sdk/postgres-canonical.ts` is structurally broken — silently uses local store
**File:** `examples/sdk/postgres-canonical.ts:29-31`
**Description:** Example sets `process.env.DB_CLUSTER_CANONICAL_BACKEND = 'postgres'` and constructs `new ClusterSDK({ clusterDir: dataDir })`. Implication: env var routes canonical to Postgres. Reality: `ClusterSDK` unconditionally calls `createLocalCluster(options.clusterDir)` — `createLocalCluster` does NOT read `DB_CLUSTER_CANONICAL_BACKEND`. Only `createClusterFromEnv` reads it, and the SDK never calls it. The example silently runs against the LOCAL canonical store; the 'Entity created in Postgres' log on line 48 is a lie. Compounds CIDOCS-005 nominal fix — docs were rewritten to remove 'Postgres-via-SDK' but this example remained as a contradiction.
**Recommendation:** Delete the file OR extend `SDKOptions` with a `stores: ClusterStores` injection seam.

---

## 6. MEDIUM findings (23) — one-line each

### Kernel (6)

- **KERNEL-R004** — `retrieveBundle` provenanceEvents filter defaults `return true` for `subjectStore='ledger'|'index'` — command_approved/rejected events with detail.commandVerb / detail.payload still surface — `src/kernel/policy-enforced-kernel.ts:317-321`.
- **KERNEL-R005** — `explainIndex` ledger source-store has no redactor — full ProvenanceEvent including `detail` returned unredacted — `src/kernel/policy-enforced-kernel.ts:460`.
- **KERNEL-R006** — `inspectCommand` wrapper calls enforce('read_command') with NO context; synthetic-command payloads leak `kind`+`name`+`entityId` to read_command-permitted principals — `src/kernel/policy-enforced-kernel.ts:418`.
- **KERNEL-R007** — `listReceipts` has no per-receipt scoping; resultSummary leaks entity names verbatim ('Created entity: User/john@example.com') — `src/kernel/policy-enforced-kernel.ts:425`.
- **KERNEL-R008** — `commitMutation` switch arm for `'reindex'` is a NO-OP (same defect KERNEL-007 fixed for link_evidence) — `src/kernel/cluster-kernel.ts:548`.
- **KERNEL-R009** — `recordOrphanMutation` secondary catch silently swallows; no `ops/` consumer of `mutation_orphaned` action — `src/kernel/cluster-kernel.ts:129`.

### Stores (4)

- **STORES-R003** — `replaceAll` is duck-typed at `rebuild.ts:106` not declared on `IndexStore` contract — future adapters silently fall through to unsafe path — `src/contracts/index-store.ts:8`.
- **STORES-R004** — Zero direct tests for CorruptStoreError, replaceAll atomicity, LocalCanonical.importSnapshot, LocalLedger.importEvent/importReceipt, ImportSnapshotNotSupportedError, or entity-ID preservation — coverage gap.
- **STORES-R005** — `LocalArtifactStore.getContent()` skips contentHash regex validation on load path — defense-in-depth asymmetry vs `importSnapshot` — `src/adapters/local/local-artifact-store.ts:42`.
- **STORES-R006** — `PostgresCanonicalStore.importSnapshot` uses TOCTOU `get` then unguarded `INSERT` — concurrent restores fail noisily instead of de-duping via `ON CONFLICT` — `src/adapters/postgres/postgres-canonical-store.ts:115`.

### Surface (4)

- **SURFACE-R003** — `SDK.resolve()` routes through `ClusterResolver` directly (never policy-enforced); SDK consumers (not MCP) get unsanitized artifacts with `storagePath` — `src/sdk/cluster-sdk.ts:175`.
- **SURFACE-R005** — `DB_CLUSTER_PRINCIPAL` env JSON.parsed with NO schema validation — malformed roles type / missing fields bypass policy via trust-zone-not-found branch — `src/mcp/server.ts:37`.
- **SURFACE-R006** — `DB_CLUSTER_POLICIES_FILE` resolves against `process.cwd()` with no sandbox — path-traversal primitive into any readable file — `src/mcp/server.ts:45`.
- **SURFACE-R010** — Dashboard JSX `applyRedaction` still has inline copy with DIVERGENT semantics from `dashboard/lib/apply-redaction.js` (string `'[REDACTED]'` vs `{_redacted: true}` object marker, plus 3 other shape differences) — `dashboard/components/PolicyViewToggle.jsx:87`.

### Tests (4)

- **TESTS-R005** — SURFACE-004 (default-deny on underspecified allow + auto-derive ownerStore from URI) has zero tests in `test/policy-engine.test.ts`.
- **TESTS-R006** — Either-OK `expect(['healthy','degraded']).toContain(status)` count GREW from 6 to 8 across Wave A1 (`repo-knowledge-ops.test.ts:65` + `phase15-proof.test.ts:250`) to wallpaper the SURFACE-003 partial verify-degraded side effect. **Regression of known anti-pattern (Audit-1 TESTS-018).**
- **TESTS-R007** — `verb-parity.test.ts:50` filters by `!startsWith('_')` (won't catch `internalFoo`-style methods) and uses `Object.getOwnPropertyNames` (skips Symbol-keyed methods).
- **TESTS-R008** — Drift-detection assertion `hasUnhealthyCheck = checks.some(...)` accepts ANY non-healthy check on ANY of 3 verify probes — 9 acceptable outcomes; future regression that flips an unrelated check still passes — `test/proof.test.ts:449`.

### CI/Docs (5)

- **CIDOCS-R005** — Test count `<!-- TODO -->` marker still in `docs/release-notes-v0.1.md:90`; `README.md:58` still says '614 tests across 51 files' (actual: 623 / 58); `docs/phase-15-closeout.md:44` says '612+ tests' — `multiple files`.
- **CIDOCS-R006** — 3 new GitHub workflows have no `permissions:` block (defense-in-depth: declare `contents: read`) and no `concurrency:` block (CI minutes / cache race) — `.github/workflows/*.yml`.
- **CIDOCS-R007** — `smoke-install.yml` triggers only AFTER tag exists; failing smoke can't revert the tag — `.github/workflows/smoke-install.yml:4`.
- **CIDOCS-R008** — `release-gate.mjs scanForDrift` walks only `examples/` — misses `dashboard/lib/` which now ships and contains `../../src/...` references (see CIDOCS-R001) — `scripts/release-gate.mjs:78`.
- **CIDOCS-R009** — `test/install-smoke.test.ts:17` describe block is named 'Installation smoke tests' but tests source-tree shape and imports from `'../src/kernel/cluster-kernel.js'` — Audit-1 CIDOCS-004 unfixed — name/scope mismatch.

---

## 7. LOW findings (29) — one-line each

### Kernel (7)

- **KERNEL-R010** — `ReceiptFailedError.message` embeds `cause.message` which can include `CorruptStoreError`'s absolute filesystem path — `src/kernel/errors.ts:59`.
- **KERNEL-R011** — New `as any` cast at `proposeMutation` wrapper — `src/kernel/policy-enforced-kernel.ts:380`.
- **KERNEL-R012** — `TraceBuilder.actionToEdgeType` falls through to 'entity_created_by' for new `mutation_orphaned` action — confusing for trace consumers — `src/provenance/trace-builder.ts:426`.
- **KERNEL-R013** — `KERNEL-012` deferred: `update_entity` rebuild fanout uses `{text:'', metadata:{}}` no limit — strictly worse than the deferred `limit:100000` pattern — `src/kernel/cluster-kernel.ts:460`.
- **KERNEL-R014** — `KERNEL-019` deferred: `src/kernel/index.ts:12-15` still re-exports kernel internals (CommandQueue, proposeCommand, validateCommand, etc.) — internal-vs-public boundary unclear — `src/kernel/index.ts:12`.
- **KERNEL-R015** — `KERNEL-018` deferred: URI_REGEX still `/^cluster:\/\/([a-z]+)\/(.+)$/` — store charset blocks digits/hyphens, ID `.+` matches path traversal substrings.
- **KERNEL-R016** — `CommandVerb` union includes `'propose_mutation'` but `commitMutation` has no case → fall-through to `markRejected` with `Unknown verb` — type-vs-runtime inconsistency — `src/types/command.ts:62`.

### Stores (7)

- **STORES-R007** — `CorruptStoreError.message` embeds full filesystem path; `InvalidContentHashError.message` echoes raw attacker-controlled value with no truncation — `src/adapters/local/errors.ts:20, 36`.
- **STORES-R008** — `LocalIndexStore.replaceAll` (and all four stores' mutation methods) mutate in-memory state BEFORE persist — persist failure leaves in-memory state ahead of disk — `src/adapters/local/local-index-store.ts:101`.
- **STORES-R009** — `.tmp` files use fixed `${filePath}.tmp` suffix — multi-process race, no cleanup of orphan .tmp on crash — `src/adapters/local/local-*-store.ts`.
- **STORES-R010** — Tokenizer regex strips `\p{M}` (combining marks) — NFD-decomposed input (`'café'`) loses the diacritic; search misses for NFD-sourced content — `src/indexing/tokenizer.ts:21`.
- **STORES-R011** — `importEvent` / `importReceipt` / `importSnapshot` are silently first-write-wins on duplicate-ID conflict — a tampered backup can hide events by adding earlier duplicates with same ID — `src/adapters/local/local-ledger-store.ts:118`.
- **STORES-R012** — `LocalArtifactStore.importSnapshot` does NOT verify `sha256(content) === metadata.contentHash` — verification lives only in `backup.ts`; direct callers bypass — `src/adapters/local/local-artifact-store.ts:117`.
- **STORES-R013** — No always-on `__proto__` / prototype-pollution test for `importSnapshot` payloads — Postgres-only sql-injection test doesn't cover this — `test/(missing)`.

### Surface (6)

- **SURFACE-R004** — `sanitizeEntityForOutput` and `sanitizeReceiptForOutput` exported from `src/mcp/sanitize.ts:74, 86` but NEVER imported or called — dead code — entities + receipts flow through MCP unredacted — `src/mcp/sanitize.ts:74`.
- **SURFACE-R007** — Empty `{}` policies.json file triggers hard-reject on self-approve but configures NO policy — file existence ≠ policy-configured — `src/cli.ts:130`.
- **SURFACE-R008** — No test calls `handleTool('cluster_resolve', {artifact-uri})` and asserts `result.object.storagePath === undefined` — the test that would have caught SURFACE-001 and would catch any regression — `test/(missing)`.
- **SURFACE-R009** — `policyEnforced: boolean` is `public readonly` on SDK — exposes a signal an attacker could use to time capability probes — `src/sdk/cluster-sdk.ts:111`.
- **SURFACE-R011** — `SURFACE-011` unchanged: `(indexStatus.totalRecords ?? 0) - staleRecords.length` can be negative — `src/dashboard/ops-model.ts:78`.
- **SURFACE-R012** — `INTERNAL_TRUSTED_PRINCIPAL` is the silent fallback at `cluster-sdk.ts:130`, `cli.ts:91`, `server.ts:65` — deployment ships policies but forgets a principal → silent cluster-admin — `src/policy/index.ts:44`.

### Tests (4)

- **TESTS-R009** — Path-traversal test 4 uses `||` chain with `includes('contentHash')` fallback — too general; any error mentioning 'contentHash' passes — `test/path-traversal.test.ts:152`.
- **TESTS-R010** — `kernel.test.ts:227` name says 'rejects unknown command IDs' but body asserts `CommandNotValidatedError` (which fires before existence check) — name/body mismatch.
- **TESTS-R011** — `install-smoke.test.ts:28` only verifies shebang line — does NOT actually run `dist/cli.js` — weaker safety net than pre-amend version which exec'd the binary.
- **TESTS-R012** — `TESTS-007` status check: deferred fixture hygiene. Audit-1 LOW; re-audit bumps to MEDIUM-class concern given new CI matrix (Node 20/22 × ubuntu/windows = 4× exposure) compounds the ~1% race window — `test/restore-artifacts.test.ts:13`.

### CI/Docs (5)

- **CIDOCS-R010** — CI matrix missing `macos-latest` and Node 24 (upcoming LTS) — `.github/workflows/ci.yml:8`.
- **CIDOCS-R011** — `package.json` has no `prepublishOnly` script; no `test:smoke` wrapper — Audit-1 CIDOCS-011 unfixed — `package.json:43`.
- **CIDOCS-R012** — 3 loose `.txt` files at repo root (`AI Safe Data Control Plane over Fed.txt`, `Is it true that AI has a hard time.txt`, `phase map.txt`) — Audit-1 CIDOCS-009 unfixed.
- **CIDOCS-R013** — `docs/phase-15-closeout.md:58` 'Next phase candidates' still lists 'CI pipeline (GitHub Actions)' as future — CI was added in Wave A1.
- **CIDOCS-R014** — `docs/sdk.md:76-80` shows `bundle.confidence`/`bundle.gaps`/`bundle.staleRecords` — none of these fields exist on `EvidenceBundle`; `:218-241` shows wrong Principal + PolicyTestInput.actions shape — `docs/sdk.md:76`.

---

## 8. Cross-cutting themes

1. **The headline fixes landed at the type-and-wrapper level — but the call sites that should USE them were not migrated.** KERNEL-001 added 7 wrappers; the CLI bypasses them via `_kernel` (10 sites) and `repo-knowledge/ingest.ts` artifact ingest bypasses too. KERNEL-006 tightened committableStatuses; SDK + CLI auto-walk reverts it. SURFACE-002 made SDK opt-in policy-aware; SDK.resolve() bypasses entirely. Pattern: amend agents fixed the layer they OWNED, but the next layer up was someone else's scope and still bypasses. The interfaces are now correct; the callers aren't.

2. **5 new typed errors + new write mechanisms shipped without regression tests.** ReceiptFailedError, CorruptStoreError, ImportSnapshotNotSupportedError, entity-ID preservation, importEvent/importReceipt idempotency — five load-bearing safety mechanisms with zero failing-test that would catch a regression. The entire 'every committed command produces a receipt' invariant (Audit-1 invariant 8) is now untested at its new gate. Same shape as Audit-1's cross-cutting theme #4 ('Safety invariants lack adversarial test coverage'); Wave A1 added the code without the tests.

3. **The policy/redaction layer has 4 new bypass paths surfaced in re-audit.** KERNEL-R004 (provenanceEvents with subjectStore='ledger'|'index'), KERNEL-R005 (explainIndex on ledger source), KERNEL-R006 (inspectCommand no context), KERNEL-R007 (listReceipts no per-receipt scope). Plus SURFACE-R003 (SDK.resolve unwrapped) and SURFACE-R004 (sanitizeEntity/Receipt dead code). The wrappers landed; the surfaces between them have gaps. Per-object scoping (the Audit-1 pattern that KERNEL-003/-004 closed for findSources/retrieveBundle) needs another pass for receipts, commands, explainIndex, and provenance.

4. **Test theatre regression.** TESTS-R001 (`wave6-proof.test.ts:350`) asserts `toContain('ClusterKernel')` against the source text — passes only because the symbol name appears in JSDoc comments. This is structurally identical to the Audit-1 TESTS-001 (prototype-name check) finding the wave was supposed to eliminate. The test claims to prove KERNEL-013 enforcement but passes by matching a comment string. Either-OK assertions also grew from 6 to 8 (TESTS-R006) — Wave A1 added two new instances to wallpaper a side-effect.

5. **Doc drift accumulated.** Five docs still claim ClusterKernel is exported (CIDOCS-R002). Four docs show wrong Principal shape (CIDOCS-R003). One example silently does the wrong thing (CIDOCS-R004 — postgres-canonical.ts uses local store). Test count outdated in three places (CIDOCS-R005). docs/sdk.md uses wrong field names on EvidenceBundle (CIDOCS-R014). The fix-the-examples-but-not-the-prose-docs pattern from Audit-1 CIDOCS-005/006 re-emerges.

6. **`dashboard/lib/` shipped with a broken type import.** TESTS-004 extracted `apply-redaction.js` + `.d.ts` into `dashboard/lib/`, but the `.d.ts` references `'../../src/...'` (CIDOCS-R001). The `src/` tree is not shipped; the type reference is dangling at install time. The release-gate drift scan misses this because it only walks `examples/` (CIDOCS-R008). Two findings cascade from one missed scope.

7. **CommandQueue is now the relative weak link.** Stores raised the bar with atomic tmp+rename + CorruptStoreError. CommandQueue (Kernel domain) still uses plain writeFileSync. Concurrent writes race; crash mid-write corrupts JSON; `load()` throws SyntaxError. KERNEL-021 was LOW in Audit-1 only because all stores had the same flaw — that symmetry is gone, so KERNEL-R001 escalates to HIGH.

8. **Self-approval is structurally re-introduced through the SDK.** KERNEL-006 tightened the kernel's committableStatuses. The SDK auto-walk uses a single actorId for both approve and commit (KERNEL-R002). CLI does the same. The separation-of-duties guarantee survives only for direct ClusterKernel callers (which now don't exist in production, since the kernel is no longer publicly exported — KERNEL-013).

9. **CI workflows are clean structurally but lack defense-in-depth.** No `permissions:` block (CIDOCS-R006), no `concurrency:` (cancels prior in-flight runs), no macOS row (CIDOCS-R010), smoke-install runs only AFTER tag publish (CIDOCS-R007). These are LOW-MEDIUM additions for a v0.1.0 release-ready posture.

---

## 9. Audit confidence gaps

- **Postgres adapter still only statically read.** Same as Audit-1: no live `pool` exercised. STORES-R006 (TOCTOU concurrent restore) reasoned from code. Confidence is HIGH on local; MEDIUM-HIGH on Postgres.
- **MCP server runtime not exhaustively fuzzed.** SURFACE-R005 (env-var principal) + SURFACE-R006 (policies-file path) are static reads. Concrete prototype-pollution / path-traversal attempts were not run.
- **Dashboard React not rendered in JSDOM.** SURFACE-R010 (JSX divergent applyRedaction) reasoned from static diff of inline-vs-lib.
- **CI workflows not run against a fork-PR scenario.** CIDOCS-R006 (no permissions block) reasoned from yaml read.
- **The 12 cascading test fixes spot-checked by Tests agent (not exhaustively re-read).** A subtler issue in one of the 12 files (changed assertion semantics post-validateMutation insertion) might be present and uncaught — verb-parity test + drift-detection test sampled.

---

## 10. Per-domain summaries (verbatim)

### Kernel

> Wave A1 closed every CRITICAL+HIGH the kernel-domain audit identified and the verb-parity test plus ClusterKernelInterface compile-time check are real improvements. Three structural concerns remain. (1) KERNEL-006's tightening of committableStatuses to ['validated','approved'] is undone above the kernel layer: the SDK and CLI both auto-walk proposed→validated→approved→committed using a single actorId, so any product surface that uses ClusterSDK or db-cluster CLI can still propose+commit in one breath with no separation of duties. (2) KERNEL-001's seven new PolicyEnforcedKernel wrappers are bypassed at the CLI by 10+ call sites using `kernel._kernel` to grab the raw ClusterKernel — accompanied by stale comments that claim 'KERNEL-001 — not wrapped' and contradict the fix. Repo-knowledge ingest does the same. (3) KERNEL-021 (CommandQueue non-atomic writes) is unchanged while the Stores domain converted all four local stores to atomic tmp+rename + CorruptStoreError — escalating CommandQueue from LOW to HIGH because it's now the only persistence file in the cluster that can corrupt mid-write and break every subsequent inspectCommand call. Five MEDIUMs surface new policy-layer gaps: provenance events with subjectStore='ledger'|'index' bypass per-entity filtering in retrieveBundle (R004); explainIndex skips ledger source-store redaction (R005); inspectCommand passes no context and leaks synthetic-command payloads (R006); listReceipts has no per-receipt scoping and resultSummary leaks entity names verbatim (R007); commitMutation's 'reindex' arm is a NO-OP (R008, parallel to the fixed KERNEL-007 link_evidence regression). Plus an orphan-mutation observability gap (R009 — secondary catch swallows silently, no ops/ consumer of mutation_orphaned events).

### Stores

> Wave A1 landed most of the Stores-domain code-level fixes correctly: atomic tmp+rename writes across all four local stores with typed CorruptStoreError on load; LocalCanonicalStore.importSnapshot + LocalLedgerStore.importEvent/importReceipt preserve original IDs and timestamps; PostgresCanonicalStore.importSnapshot mirrors the local; LocalArtifactStore.importSnapshot validates contentHash via /^[a-f0-9]{64}$/ before path.join (STORES-006 closed for the documented restore path); LocalIndexStore.replaceAll collapses the rebuild empty-window to a single filesystem rename (STORES-008 closed for the LocalIndexStore path); tokenizer fixed for Unicode via \p{L}\p{N}\s_- with /u flag (STORES-004 closed for non-NFD content). However, the audit surfaces THREE regressions / unfinished work that the amend report does NOT acknowledge: (1) STORES-R001 (HIGH) — Phase 12 Proof 12 still calls doctor() not verify(), so the STORES-001 entity-ID-preservation fix has no test that would catch a regression — and the original audit's STORES-009 is essentially unfixed; (2) STORES-R002 (HIGH) — TWO classes named ImportSnapshotNotSupportedError exist in different files with different signatures, one is dead code, the other is the one actually used — a name collision that breaks `instanceof` checks; (3) STORES-R003 (MEDIUM) — replaceAll is duck-typed in rebuild.ts rather than declared on the IndexStore contract.

### Surface

> Wave A1 made real progress on the four Surface CRITICAL/HIGH invariants — `PolicyEnforcedKernel` now wraps all 7 previously-missing verbs, MCP boundary strips `storagePath` and removes the `_contentAccess` escape hatch, policy underspecification now defaults-deny for allow + still matches for deny, CLI resolves a real operator identity with a self-approve guard, and policy-engine auto-derives `ownerStore` from URIs. But the audit surfaces three regressions/new issues that materially weaken the fixes: (1) **SURFACE-R001 HIGH** — `src/cli.ts` unwraps `PolicyEnforcedKernel` at 10 sites, defeating the new wrappers — stale comments lie ('KERNEL-001 — not wrapped'); (2) **SURFACE-R002 HIGH** — `src/integrations/repo-knowledge/ingest.ts:240` does the same `_kernel` unwrap for artifact ingest with a comment falsely claiming 'policy layer still fires'; (3) **SURFACE-R003 MEDIUM** — `SDK.resolve()` goes through `ClusterResolver` directly (never policy-enforced); MCP sanitizes after the fact, SDK callers don't. Plus: SURFACE-R004 (sanitizeEntity/Receipt dead code), SURFACE-R005/R006 (env-var principal/policies-file lack schema/path validation), SURFACE-R010 (dashboard JSX inline applyRedaction diverges from lib). Headline: the fix landed at the type-and-wrapper level, but the call sites that should USE the new wrappers were not migrated.

### Tests

> Audit pass 2 on Wave A1's test changes. The big-ticket fixes are real: sql-injection.test.ts (5 strict cases, Postgres-gated), path-traversal.test.ts (5 cases, per-test mkdtempSync), proof.test.ts TESTS-001 replacement (real inspectCommand on all 4 helpers), drift detection (real direct-adapter write + verify() check), and the 12-file validateMutation cascade. New test files have clean fixture hygiene. BUT the audit surfaces 12 net-new or regression-of-known findings: (1) wave6-proof.test.ts:350 still asserts `toContain('ClusterKernel')` against the SOURCE TEXT — passes only because the string appears in JSDoc; directly contradicts phase15-proof.test.ts:49 (HIGH, structurally identical to the original TESTS-001 anti-pattern). (2) SURFACE-002 SDK wiring fix has ZERO end-to-end coverage. (3) phase10-proof.test.ts:48 + :102 still shell out to `npx tsx`. (4) Five new typed errors have ZERO regression nets. Plus: TESTS-018 either-OK count GREW from 6 → 8; verb-parity.test.ts has design gaps; drift detection assertion is loose. Net: 4 HIGH findings block Stage A exit. The meta-pattern: amend agents added code without adding tests that would catch regressions.

### CI/Docs

> Wave A1 closed all 8 CRITICALs and 19 of 20 HIGHs from audit-1, but the CI/Docs domain still has 14 second-pass findings — 4 HIGH, 5 MEDIUM, 5 LOW. The biggest cluster is doc drift: KERNEL-013 hid ClusterKernel from public exports but five docs still claim it's exported (CIDOCS-R002), the Principal type shape was fixed in examples but four prose docs and the MCP example still show the wrong shape (CIDOCS-R003), the SDK postgres-canonical example is structurally broken in a way the doc rewrite did not catch (CIDOCS-R004), test counts and dist-tree references are stale (CIDOCS-R005, CIDOCS-R013). The most consequential new regression is CIDOCS-R001 — the TESTS-004 lib extraction created `dashboard/lib/apply-redaction.{d.ts,js}` with `../../src/...` references in a directory that ships to npm. The release-gate drift scan would catch this if it scanned `dashboard/` (CIDOCS-R008). CI workflows themselves are clean (no secret leakage, action versions pinned to v4 majors) but lack defense-in-depth `permissions:` blocks (CIDOCS-R006) and the smoke-install runs only AFTER tag creation (CIDOCS-R007).

---

## 11. Regression vs new split (re-audit-specific)

### Regressions (was clean in Audit 1; broken or worse post-amend) — 4

| ID | What broke | Severity | Why |
|---|---|---|---|
| **TESTS-R001** | `wave6-proof.test.ts:350` asserts `toContain('ClusterKernel')` against source text — passes via JSDoc comment | HIGH | Same anti-pattern Audit-1 TESTS-001 surfaced; the fix wave introduced a new instance |
| **TESTS-R006** | Either-OK assertion count grew from 6 to 8 (`repo-knowledge-ops.test.ts:65`, `phase15-proof.test.ts:250`) | MEDIUM | Wave A1 added these to wallpaper a verify-degraded side effect rather than fixing the root cause |
| **TESTS-R003** | `phase10-proof.test.ts:48, :102` still call `npx tsx` — sweep removed `npx tsc` but missed sibling | HIGH | Amend report's CIDOCS table claims phase10-proof.test.ts is fixed; only partially true |
| **CIDOCS-R001** | `dashboard/lib/apply-redaction.{d.ts,js}` references `'../../src/...'` in a shipped directory — broken at install time for TS consumers | HIGH | Wave A1 created the lib but did not check that its import paths survive `npm install` (src/ doesn't ship) |

### Partial-of-known (Wave A1 partial fixes; advisor was aware) — 6

| ID | What's partial |
|---|---|
| **KERNEL-R002** ≡ **(SDK auto-walk defeats KERNEL-006)** | Kernel layer tightened; SDK + CLI silently auto-walk. Amend report framed as 'auto-walk for backward compat' — re-audit flags this as a security regression that should be documented or removed. |
| **KERNEL-R003 ≡ SURFACE-R001** | KERNEL-001 wrappers exist; CLI bypasses them at 10 sites + repo-knowledge artifact ingest |
| **STORES-R001** | STORES-001 fix landed in code; STORES-009 (Phase 12 Proof 12 calls doctor not verify) unfixed → no test net for the fix |
| **SURFACE-R010** | TESTS-004 lib extracted + tests updated; JSX inline `applyRedaction` still has divergent semantics |
| **CIDOCS-R005** | CIDOCS-006 nominally fixed; README + release-notes still show '614 / 51 files'; TODO marker still in shipped docs |
| **CIDOCS-R008** | CIDOCS-003 fix correctly addressed `findstr` → Node-native; scan scope narrower than needed (misses dashboard/lib/) |

### New (Audit 1 didn't probe this area) — ~50

All other R-findings (KERNEL-R004 through R010, KERNEL-R011/R012; STORES-R002 through R013; SURFACE-R002, R003, R004, R005, R006, R007, R008, R009, R012; TESTS-R002, R004, R005, R007, R008, R009, R010, R011; CIDOCS-R002, R003, R004, R006, R007, R009, R010, R011, R012, R013, R014).

The largest "new" cluster is **policy-layer-per-object-scoping** (KERNEL-R004/R005/R006/R007 + SURFACE-R003/R004): the wrappers landed in Wave A1 but the per-object scoping pattern that closed KERNEL-003/-004 was not extended to receipts, commands, explainIndex(ledger), provenanceEvents-with-ledger-subject, or SDK.resolve. Each of these is a fresh leak path that the wave-A1 lens missed.

The second largest "new" cluster is **typed-error and write-path regression nets** (TESTS-R004, STORES-R004): five new mechanisms shipped without tests.

---

## 12. Partial-of-known status (the two amend-report-acknowledged partials)

### SURFACE-003 (artifact ingest bypasses propose+commit due to Buffer payload)

**Status:** **Confirmed + worsened.** The amend report described the partial as 'artifact ingest stays on the direct helper because Buffer payloads don't survive CommandQueue JSON persistence.' Re-audit confirms: `src/integrations/repo-knowledge/ingest.ts:240` STILL calls `underlying.ingestArtifact` (helper) not `proposeMutation` (lifecycle). The inline comment at lines 235-239 falsely claims the policy layer still fires — the `_kernel` unwrap defeats it. Plus: the same pattern exists in `src/cli.ts` for non-artifact verbs (SURFACE-R001 / KERNEL-R003). Combined, `ingestArtifact` has ZERO in-repo production callers that go through the new wrapper.

**Scope expanded:** beyond just artifact-ingest's Buffer issue, the `_kernel` unwrap is now the canonical pattern at 11 call sites (10 in cli.ts + 1 in ingest.ts).

### TESTS-004 (JSX inline copy divergent from extracted lib)

**Status:** **Confirmed + worsened beyond amend report.** The amend report acknowledged: "JSX uses `'[REDACTED]'` strings vs lib's `{_redacted: true}` objects." Re-audit confirms PLUS surfaces additional divergences (SURFACE-R010): JSX writes `warnings = ['store not visible...']` (plain strings) vs lib writes `[{type: 'redacted', message: '...'}]` (structured warnings); JSX iterates `policyView.redacted` unconditionally (throws on undefined) vs lib uses `policyView.redacted || []`; JSX pollutes `window.applyRedaction` global. Net: at least 4 semantic divergences, not 1.

Plus new dependent finding **CIDOCS-R001** — the lib's `.d.ts` references `'../../src/...'` which doesn't exist after npm install.

---

## 13. Exit gate verdict

**Stage A is NOT exitable.**

- **15 unique HIGH findings** (after KERNEL-R003 ≡ SURFACE-R001 de-dup: **14 HIGH**)
- **0 CRITICAL**
- **4 regressions** (TESTS-R001, TESTS-R003, TESTS-R006, CIDOCS-R001)

Required for exit: 0 CRITICAL + 0 HIGH + 0 regressions.

**Recommendation: dispatch Wave A2 with targeted scope.** The HIGH findings cluster as follows:

1. **Surface-level cleanup of KERNEL-001 / SURFACE-002 wins** (cross-domain Surface): delete `_kernel` unwraps from `cli.ts` (10 sites) and `repo-knowledge/ingest.ts:240`. Remove stale `KERNEL-001 — not wrapped` comments. Restrict or remove `_kernel` getter. **Resolves KERNEL-R003 ≡ SURFACE-R001 + SURFACE-R002.**
2. **Kernel/SDK lifecycle integrity** (Surface or Kernel): redesign or remove the SDK auto-walk so propose→commit doesn't trivially self-approve. **Resolves KERNEL-R002.**
3. **CommandQueue atomicity** (Kernel): apply tmp+rename + try/catch around load(). **Resolves KERNEL-R001.**
4. **STORES-001 test net** (Stores or Tests): fix Phase 12 Proof 12 to use `verify()`; add entity-ID round-trip assertion. **Resolves STORES-R001.**
5. **Duplicate ImportSnapshotNotSupportedError** (Stores): delete the dead copy in `src/adapters/local/errors.ts`. **Resolves STORES-R002.**
6. **dashboard/lib import path** (CI/Docs): change `../../src/...` to `../../dist/...` or `db-cluster/types`. **Resolves CIDOCS-R001.**
7. **wave6-proof.test.ts:350 test theatre** (Tests): rewrite to assert against `Object.keys(import('...'))` like phase15-proof. **Resolves TESTS-R001.**
8. **phase10-proof npx tsx sweep finish** (Tests): replace lines 48 and 102. **Resolves TESTS-R003.**
9. **Either-OK assertion rollback** (Tests): pin the verify status to 'degraded' with a specific check name. **Resolves TESTS-R006.**
10. **Doc-drift sweep** (CI/Docs): 5 files for CIDOCS-R002, 4 files for CIDOCS-R003, delete or replace postgres-canonical.ts for CIDOCS-R004. **Resolves CIDOCS-R002/R003/R004.**
11. **5 new-error regression nets** (Tests): add tests for ReceiptFailedError + mutation_orphaned, CorruptStoreError, ImportSnapshotNotSupportedError, entity-ID preservation, importEvent/importReceipt idempotency. **Resolves TESTS-R004.**
12. **SDK end-to-end policy wiring test** (Tests): construct SDK with policies, call findSources/commitMutation, assert policy fires. **Resolves TESTS-R002.**

These 12 work items map cleanly to the 5 amend domains. Wave A2 should be smaller in scope than Wave A1 (~30 files, vs Wave A1's 73), but the **policy-layer per-object scoping cluster** (MEDIUMs KERNEL-R004 through R007 + SURFACE-R003/R004) is worth addressing too if scope allows, since it's structurally similar to the KERNEL-003/-004 fixes Wave A1 already landed.

---

*End of Stage A re-audit report. Hand to advisor for review before Wave A2 dispatch.*
