# Dogfood Swarm Stage A Wave A2 — Amend Report — db-cluster — 2026-05-27

**Repo:** `mcp-tool-shop-org/db-cluster`
**Working copy:** `E:/AI/db-cluster`
**Amend type:** Stage A Wave A2 — adversarial-audit follow-up; close 14 HIGH + 6 MEDIUM from re-audit
**Coordinator:** Dogfood Swarm Stage A Wave A2 (5 parallel domain amend agents)
**Amend date:** 2026-05-27 02:57 UTC

---

## 1. Baseline

| Field | Value |
|---|---|
| Pre-A2 HEAD SHA | `48d8063` (`Add Stage A audit + Wave A1 amend reports`) |
| Branch | `main` (2 commits ahead of `origin/main` — un-pushed) |
| Working tree | clean (only re-audit report untracked, expected) |
| Save points present | `swarm-stage-a-save-1779834974`, `swarm-stage-a-amend-1779837797`, `swarm-stage-a-reaudit-1779843973`, `swarm-stage-a-amend-a2-1779846139` (new) |
| Pre-A2 `npm run lint` | PASS (covers src/ + examples/) |
| Pre-A2 `npm test` | 623 passed / 53 skipped / 0 failed across 58 files |
| Pre-A2 `node scripts/release-gate.mjs` | PASS — 6/6 stages green |

Baseline drift from re-audit report: **none**. Wave A2 started from documented post-Wave-A1 state.

---

## 2. Wave A2 scope coverage

Wave A2 targets: 14 unique HIGH findings + 6 explicit MEDIUMs (KERNEL-R004/R005/R006/R007, SURFACE-R003, KERNEL-R008 ride-along) + additional mechanical MEDIUMs (STORES-R003/R005/R006, SURFACE-R005/R006/R010, TESTS-R005/R007/R008, CIDOCS-R005/R006/R007/R008).

### HIGH findings (14 unique) — all fixed

| ID | Domain | Status | Files | Note |
|---|---|---|---|---|
| **KERNEL-R001** | Kernel | fixed | `src/kernel/command-queue.ts`, `src/kernel/errors.ts`, `src/kernel/index.ts` | tmp+rename atomic write pattern; `load()` wrapped in try/catch; new typed `CommandQueueCorruptError` |
| **KERNEL-R002** | Surface | fixed | `src/sdk/cluster-sdk.ts`, `src/cli.ts` | SDK auto-walk REMOVED. CLI commit explicitly chains validate→approve→commit. SURFACE-005 self-approve guard still applies. |
| **KERNEL-R003 ≡ SURFACE-R001/R002** | Kernel + Surface | fixed | `src/kernel/policy-enforced-kernel.ts` (getter deletion), `src/cli.ts` (10 unwrap sites), `src/integrations/repo-knowledge/ingest.ts:240` (1 unwrap site) | `_kernel` getter DELETED from PolicyEnforcedKernel. All 11 unwrap call sites removed. Stale "KERNEL-001 — not wrapped" comments deleted. `grep -n _kernel src/` returns only 1 explanatory comment, no code uses. |
| **STORES-R001** | Tests | fixed | `test/phase12-proof.test.ts` | Proof 12 switched from `doctor()` to `verify()`. Positive entity-ID preservation assertion added. |
| **STORES-R002** | Stores | fixed | `src/adapters/local/errors.ts` | Duplicate `ImportSnapshotNotSupportedError` class deleted. Misleading "shared with surface-side code" JSDoc removed. Only canonical class remains at `src/ops/errors.ts:15`. |
| **TESTS-R001** | Tests | fixed | `test/wave6-proof.test.ts` | Replaced substring-against-source-text check with runtime `Object.keys(import('../src/index.js')).not.toContain('ClusterKernel')`. **Regression probe verified** (temporarily re-exported, test failed, reverted). |
| **TESTS-R002** | Tests | fixed | `test/policy-surface.test.ts` | 3 SDK e2e policy tests added: (1) restricted-principal filters findSources; (2) proposer-only throws on commit; (3) no-policy SDK uses raw kernel. |
| **TESTS-R003** | Tests | fixed | `test/phase10-proof.test.ts` | `execSync('npx tsx ...')` calls at lines 48 + 102 replaced with source-string regex (cli-docs.test.ts pattern). |
| **TESTS-R004** | Tests | fixed | `test/typed-error-regression.test.ts` (new) | 5 new regression tests for ReceiptFailedError/mutation_orphaned, CorruptStoreError, ImportSnapshotNotSupportedError, entity-ID preservation, importEvent/importReceipt idempotency. |
| **CIDOCS-R001** | Tests (owned) | fixed | `dashboard/lib/apply-redaction.d.ts`, `.js` | Type import changed from `'../../src/dashboard/dashboard-model.js'` to `'../../dist/dashboard/dashboard-model.js'` (dist/ ships; src/ does not). |
| **CIDOCS-R002** | CI/Docs | fixed | 5 doc files | ClusterKernel public-export claims removed from `docs/release-notes-v0.1.md:78`, `docs/package-boundary.md:9`, `docs/handbook.md:1050`, `docs/phase-15-closeout.md:34`, `docs/release-readiness.md:12`. Remaining hits are all in "internal" / "not exported" context. |
| **CIDOCS-R003** | CI/Docs | fixed | 4 files | Principal shape (`{id, name, roles, trustZone, metadata?}`) and the real 13-verb Capability union now reflected in `docs/policy-and-redaction.md`, `docs/handbook.md`, `docs/cli.md`, `examples/mcp/safety-model.md`. |
| **CIDOCS-R004** | CI/Docs | fixed | `examples/sdk/postgres-canonical.ts` (DELETED), `docs/phase-10-closeout.md` | Broken example deleted. Doc updated from 5→4 examples with explanatory note. |

### MEDIUMs in Wave A2 explicit scope (6 — all fixed)

| ID | Domain | Status | Note |
|---|---|---|---|
| **KERNEL-R004** | Kernel | fixed | `retrieveBundle` provenanceEvents now per-subject policy-gated for ledger/index subjects; opaque events strip `detail` |
| **KERNEL-R005** | Kernel | fixed | `explainIndex` ledger-source branch added; new `redactProvenanceEvent` helper in `src/policy/redactor.ts` |
| **KERNEL-R006** | Kernel | fixed | `inspectCommand` now passes `resourceUri`+`ownerStore`+`commandVerb` to enforce; redactCommand applied per decision |
| **KERNEL-R007** | Kernel | fixed | `listReceipts` two-stage gating: bundle-level enforce + per-receipt evaluatePolicy + redactReceipt |
| **SURFACE-R003** | Surface | fixed | `SDK.resolve()` now inline-sanitizes via `sanitizeArtifactForOutput`/`sanitizeEntityForOutput` when `policyEnforced===true` (Option B) |
| **KERNEL-R008** | Kernel | fixed | `commitMutation` `'reindex'` arm now calls `performIndexRebuild()`; single mutation_committed receipt path |

### Ride-along MEDIUMs (8 — all fixed)

| ID | Domain | Status | Note |
|---|---|---|---|
| **KERNEL-R009** | Kernel | fixed | `recordOrphanMutation` secondary catch logs to stderr + attaches `secondaryError` to cause |
| **STORES-R003** | Stores | fixed | `replaceAll` added as REQUIRED method on `IndexStore` contract; duck-typed cast removed from rebuild.ts |
| **STORES-R005** | Stores | fixed | `LocalArtifactStore.getContent()` validates contentHash regex before path.join; throws `InvalidContentHashError` |
| **STORES-R006** | Stores | fixed | Postgres `importSnapshot` switched to `INSERT … ON CONFLICT (id) DO NOTHING RETURNING *` |
| **SURFACE-R004** | Surface | fixed | `sanitizeEntityForOutput`/`sanitizeReceiptForOutput` wired into 3 MCP tools (cluster_find_sources, cluster_retrieve_bundle, cluster_resolve canonical branch, cluster_list_receipts) |
| **SURFACE-R005** | Surface | fixed | `DB_CLUSTER_PRINCIPAL` validated structurally (id/name/roles/trustZone); fails closed loudly via `process.exit(1)` |
| **SURFACE-R006** | Surface | fixed | `DB_CLUSTER_POLICIES_FILE` path sandboxed against `process.cwd()`; throws on traversal |
| **SURFACE-R010** | Surface | fixed | JSX `applyRedaction` inline function deleted; `dashboard/index.html` ESM-imports lib + assigns `window.applyRedaction` |
| **TESTS-R005** | Tests | fixed | 4 new policy-engine tests for SURFACE-004 default-deny + auto-derive |
| **TESTS-R006** | Tests | fixed | Either-OK assertions in repo-knowledge-ops + phase15-proof pinned to `'degraded'` + specific check name |
| **TESTS-R007** | Tests | fixed | verb-parity.test.ts: explicit allowlist for internal methods; `Object.getOwnPropertySymbols` added; `_kernel` removed from POLICY_KERNEL_EXTRAS |
| **TESTS-R008** | Tests | fixed | Drift-detection assertion in `proof.test.ts:449` pinned to specific check name with explicit other-checks-healthy assertion |
| **CIDOCS-R005** | CI/Docs | fixed | Test count refs updated (`README.md`, `docs/release-notes-v0.1.md`, `docs/phase-15-closeout.md`); TODO marker removed |
| **CIDOCS-R006** | CI/Docs | fixed | `permissions: contents: read` added to all 3 workflows; `concurrency:` added to ci.yml only |
| **CIDOCS-R007** | CI/Docs | fixed | `smoke-install.yml` adds `workflow_dispatch:` + `pull_request: paths: package.json` for pre-tag verification; release flow documented |
| **CIDOCS-R008** | CI/Docs | fixed | `release-gate.mjs scanForDrift` widened to walk `examples/` + `dashboard/lib/`; `.d.ts` extension included |
| **CIDOCS-R013** | CI/Docs | fixed | `docs/phase-15-closeout.md` "Next phase candidates" updated to reflect CI landed in Wave A1 |

**Rollup:** 14 of 14 HIGH fixed (100%). 6 of 6 explicit Wave-A2 MEDIUMs fixed. 13 additional MEDIUMs/LOWs rode along.

---

## 3. Build verification

| Check | Pre-A2 | Post-A2 |
|---|---|---|
| `npm run lint` | PASS | **PASS** |
| `npm run lint:examples` | PASS | **PASS** |
| `npm test` | 623 / 53 / 0 across 58 files | **640 passed / 53 skipped / 0 failed across 59 files** (+17 / +1 file) |
| `node scripts/release-gate.mjs` | PASS 6/6 | **PASS 6/6** |

Release-gate stage breakdown (post-A2):
- `[1/6] Build` — `tsc --noEmit` + `npm run build` — OK
- `[2/6] Tests` — `npx vitest run` (300s timeout) — OK
- `[3/6] Package` — `npm pack` — OK
- `[4/6] Fresh install smoke` — 9 tests pass; new explicit validate→approve→commit chain in quickstart works — OK
- `[5/6] Docs drift` — Node-native scan now walks `examples/` + `dashboard/lib/` — OK (no offenders)
- `[6/6] Export paths exist in dist` — all 5 entry points present — OK

---

## 4. Sweep verifications

The re-audit's dominant theme was "type/wrapper layer fixed, call sites not migrated." Wave A2's exit-gate requirements include explicit grep sweeps:

| Grep | Expected | Actual |
|---|---|---|
| `grep -rn '_kernel' src/` | 0 results | **1 result** — `src/kernel/policy-enforced-kernel.ts:692` (explanatory comment noting the getter was deleted). **Zero code uses.** |
| `grep -rn 'auto-walk\|autoWalk' src/` | 0 results | **2 results** — `src/cli.ts:352` (comment documenting new behavior), `src/sdk/cluster-sdk.ts:245` (comment noting what was removed). **Zero code uses.** |
| `grep -rn 'KERNEL-001 — not wrapped' src/` | 0 results | **0 results** ✓ |
| `grep -rn 'Fall back to the underlying ClusterKernel' src/` | 0 results | **0 results** ✓ |
| `grep -n applyRedaction dashboard/components/` | only doc references | 3 doc-block lines (83, 87, 109); 0 function definitions ✓ |
| `grep -rn ImportSnapshotNotSupportedError src/` | only `src/ops/errors.ts` + `src/ops/backup.ts` | confirmed — only canonical class + its consumer ✓ |
| `grep -rn ClusterKernel docs/` | only "internal" context | 11 hits, all in architecture diagrams or explicit "not exported" wording ✓ |
| `grep -rn '614 test\|612 test\|TODO.*test count' docs/ README.md` | 0 | 0 ✓ |

All sweep verifications pass.

---

## 5. Scope violations detected

**None requiring rework.** One small cross-scope edit, coordinated and additive:

- **Kernel agent edited `src/policy/redactor.ts`** (Surface domain) to add a `redactProvenanceEvent` helper needed by their KERNEL-R005 (`explainIndex` ledger redaction) fix. The Kernel agent flagged this in their report. The Surface agent did NOT touch `src/policy/redactor.ts`, so no collision occurred. The change is purely additive (new exported function) — does not modify existing redactor behavior. Acceptable per the same coordination pattern Wave A1 used for contract additions.

- **Stores agent edited `src/contracts/index-store.ts`** (Kernel domain) to add `replaceAll` as a required contract method. The coordinator's prompt explicitly authorized this ("Option A: Make this change yourself"), so this is intentional cross-scope, not a violation. Kernel agent did not also touch this file.

No two agents edited the same file. All other changes map cleanly to exactly one domain.

---

## 6. Cross-domain dependencies surfaced

Wave A2 was structurally three-way coordinated (Kernel deletes `_kernel`, Surface deletes call sites, Tests fixes cascading tests). Three intermediate states existed during agent execution:

### 6a. `_kernel` deletion cascade

- Kernel deleted the getter at `policy-enforced-kernel.ts` and the JSDoc that documented it as a backdoor.
- Surface deleted 11 unwrap sites in `cli.ts` + `ingest.ts` and stale comments.
- Tests removed `'_kernel'` from `POLICY_KERNEL_EXTRAS` in `verb-parity.test.ts` AND migrated ~14 tests in `policy-kernel.test.ts` + ~9 tests in `wave5-redaction.test.ts` that reached behind the wrapper via `pk._kernel.X` to seed fixtures. Tests' final test count (640) confirms the cascade is fully resolved.

### 6b. SDK auto-walk removal cascade

- Surface removed the auto-walk in `cluster-sdk.ts:commitMutation` and updated CLI commit subcommand to explicitly chain validate→approve→commit.
- ~30 tests in `wave6-proof.test.ts` + `wave6-policy-proof.test.ts` previously did `propose → commit` shorthand via SDK auto-walk; Tests migrated all of them to the explicit lifecycle.
- **CI/Docs cascade**: 7 example files + `scripts/smoke-install.mjs` also previously relied on the auto-walk in user-facing copy-pastable code. CI/Docs agent inserted explicit `approveMutation` calls in all 7 examples + the smoke script. **Without this, every example would error with `CommandNotValidatedError`.**

### 6c. Contract additions

- Stores added `replaceAll` to the `IndexStore` contract as a REQUIRED method. The Kernel agent did not touch this file. Postgres index store doesn't exist; the local store already implements `replaceAll` per Wave A1 — so the contract addition is enforceable today without breaking any adapter.

### 6d. `dashboard/lib` → `dist/` reference fix

- Tests fixed the path. CI/Docs widened the release-gate drift scan to cover `dashboard/lib/` so future regressions of the same shape are caught at gate time. Two findings cascaded from one missed scope; fix and gate are now both in place.

---

## 7. New findings surfaced during amend (Stage B candidates)

1. **SDK consumer ergonomics post-auto-walk removal.** With the auto-walk gone, callers must explicitly `proposeMutation` → `validateMutation` → `approveMutation` → `commitMutation`. The 7 cascading example fixes + the smoke-install quickstart show this is verbose for trivial paths. Stage B candidate: introduce a deliberately-named convenience like `sdk.proposeAndCommitTrusted(input, actorId)` for internal-use cases, gated behind a flag so it can't be the default path.

2. **Two-stage gating in `listReceipts` is a design pattern that should propagate.** Kernel agent kept bundle-level `enforce('read_receipts')` AND added per-receipt `evaluatePolicy` to satisfy both the existing typed-error contract (Proof 7) AND fine-grained filtering. Other PolicyEnforcedKernel methods that currently use single-stage gating (e.g. `findSources` indexRecords filter, `traceObject`) could adopt the same pattern. Stage B refactor candidate.

3. **`policyEnforced: boolean` SDK signal is still public.** SURFACE-R009 from re-audit was LOW and explicitly deferred. Stage B candidate: make it `@internal` or remove it entirely; expose via `policyExplain` only.

4. **CI workflow secrets posture.** Wave A2 added `permissions: contents: read`. If/when the project adds publish workflows that need write access, will need to per-job grant. Document the pattern in `docs/release-readiness.md`. Stage B housekeeping.

5. **Test fixture hygiene** (TESTS-007, deferred from Wave A1) — still present. Wave A2 didn't introduce new races (the new tests use per-test `mkdtempSync`), but the existing `beforeAll`/`afterAll` files (restore-artifacts.test.ts, dogfood-*.test.ts) remain. Stage B candidate: convert to `beforeEach`.

6. **`docs/sdk.md` SDK example field-name issues** (CIDOCS-R014 deferred from re-audit) — still present in Wave A2 by design (explicit "no scope creep" rule). Stage B sweep.

7. **Loose .txt files at repo root** (CIDOCS-R012 deferred from re-audit). Stage B housekeeping.

---

## 8. Per-domain summaries (verbatim from agents)

### Kernel

> All 8 assigned Kernel-domain findings (1 HIGH + 5 MEDIUMs + 2 ride-along MEDIUMs) addressed in src/kernel/, src/policy/redactor.ts, and src/kernel/errors.ts. Lint passes clean. Scoped test gate is partial: 3 of 5 test files green (kernel.test.ts 11/11, command-persistence.test.ts 7/7, proof.test.ts 12/12); the other 2 files fail with 23 failures, ALL of which are `_kernel`-getter references in test bodies that the Tests agent will sweep. The `_kernel` deletion at policy-enforced-kernel.ts plus the JSDoc backdoor rewrite are complete; grep returns zero code uses of `_kernel` in src/kernel/. listReceipts kept the bundle-level enforce on top of per-receipt scoping (two-stage) so the typed PolicyDeniedError contract that policy-kernel.test.ts Proof 7 asserts against remains intact.

### Stores

> STORES-R002: Deleted duplicate ImportSnapshotNotSupportedError class. STORES-R003: Added `replaceAll(records): Promise<void>` as a REQUIRED method on the IndexStore interface. LocalIndexStore.replaceAll already exists from Wave A1 and matches the new signature. Removed the duck-typed cast at src/ops/rebuild.ts:106 and the now-unreachable clear()+index() fallback branch. STORES-R005: Added contentHash regex validation inside LocalArtifactStore.getContent before path.join — throws InvalidContentHashError on tampered artifacts.json. Defense-in-depth symmetry with importSnapshot. STORES-R006: Replaced TOCTOU get-then-INSERT in PostgresCanonicalStore.importSnapshot with INSERT ... ON CONFLICT (id) DO NOTHING RETURNING * — idempotent under concurrent restores. Lint clean for Stores-owned files.

### Surface

> Wave A2 Surface scope: all 3 HIGH (KERNEL-R003 ≡ SURFACE-R001/R002, KERNEL-R002) and all 4 MEDIUMs (SURFACE-R003/R004/R005/R006/R010) addressed in 6 files. Lint passes clean. Sweep greps confirm zero _kernel callsites, zero auto-walk code, zero stale 'KERNEL-001 — not wrapped' comments. The 11 _kernel unwrap sites are gone; CLI calls wrappers directly. The SDK auto-walk is gone; CLI explicitly chains validate+approve+commit and the SDK is a thin pass-through. The dashboard JSX no longer carries a divergent inline applyRedaction; index.html ESM-imports the lib and assigns to window.applyRedaction so UI and tests exercise byte-identical logic. MCP server now fails closed on invalid principal JSON and sandboxes the policies-file path. SDK.resolve sanitizes inline when policyEnforced. The four sanitizer wirings in MCP cover find_sources, retrieve_bundle, resolve, and list_receipts.

### Tests

> Wave A2 Tests scope: 10 findings addressed (4 HIGH + STORES-R001 HIGH + CIDOCS-R001 HIGH + 4 MEDIUM). Final suite: 640 passed / 53 skipped / 0 failed across 59 test files (+17 tests, +1 file from 623/58 baseline). Lint clean. The most consequential change is TESTS-R001's switch from source-text substring matching to runtime export probing — the previous test was structurally identical to the original TESTS-001 anti-pattern. Multiple cascade fixes were required as the Surface agent's Wave A2 work (deleting `_kernel` getter, removing SDK auto-walk) broke ~30 pre-existing tests across 8 files: addressed by (a) replacing `adminK._kernel.X` with `adminK.X` (admin has full access in tests), (b) adding explicit `validateMutation + approveMutation` between `proposeMutation` and `commitMutation` calls, (c) refactoring makePolicyKernel and makeKernel helpers to share dataDir so multiple kernel instances against the same stores see a shared CommandQueue. New file `test/typed-error-regression.test.ts` provides the missing regression net for ReceiptFailedError + mutation_orphaned, CorruptStoreError, ImportSnapshotNotSupportedError, and importEvent/importReceipt idempotency (TESTS-R004). CIDOCS-R001 fixed: dashboard/lib/apply-redaction.{d.ts,js} now imports types from `../../dist/dashboard/dashboard-model.js`.

### CI/Docs

> CI/Docs Wave A2 closed the four prompt-required findings (CIDOCS-R002 ClusterKernel sweep, CIDOCS-R003 Principal shape sweep, CIDOCS-R004 postgres-canonical.ts deletion, CIDOCS-R005 test-count updates) plus the three CI hardening items (CIDOCS-R006 permissions/concurrency, CIDOCS-R007 smoke pre-tag workflow_dispatch, CIDOCS-R008 release-gate scanForDrift widening) and the ride-along CIDOCS-R013 'next phase candidates' update. Added a Wave A2 CHANGELOG entry mirroring Wave A1. Cascading fix: inserted explicit approveMutation calls in 7 example files + scripts/smoke-install.mjs to satisfy the Surface agent's SDK auto-walk removal (without it, every example errors with CommandNotValidatedError). All my release-gate stages (Build, Package, Fresh install smoke, Docs drift, Export paths) PASS. Lint passes clean.

---

## 9. Commit SHAs landed

| SHA | Subject | Contents |
|---|---|---|
| `7d13189` | Stage A Wave A2 amend: close 14 HIGH + 20 MEDIUMs from re-audit | 57 files: all code, tests, CI, docs, examples (+1 deletion: `examples/sdk/postgres-canonical.ts`; +1 new: `test/typed-error-regression.test.ts`) |
| (this commit) | Add Stage A re-audit + Wave A2 amend reports | 2 files: this report + the re-audit report (evidence). SHA discoverable via `git log --oneline`. |

Wave A2 starts at `48d8063` (Wave A1 evidence commit) and ends at this commit.
Save points retained: `swarm-stage-a-save-1779834974`, `swarm-stage-a-amend-1779837797`, `swarm-stage-a-reaudit-1779843973`, `swarm-stage-a-amend-a2-1779846139`.

---

## 10. Coordinator-applied fix-ups

None for Wave A2. All cascading fixes were handled by the agents themselves:
- Tests handled the `_kernel` deletion cascade in test files
- Tests handled the SDK auto-walk removal cascade in test files
- CI/Docs handled the SDK auto-walk removal cascade in example files + smoke-install.mjs

The Wave A1 coordinator-applied fix-ups (smoke-install.mjs ClusterKernel→ClusterSDK; release-gate.mjs timeout bump) carry forward and were extended in Wave A2 by CI/Docs (per CIDOCS-R007 + CIDOCS-R008).

---
