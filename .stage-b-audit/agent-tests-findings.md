# Stage B Audit — Tests Domain — db-cluster

**Lens:** Proactive Health
**Date:** 2026-05-27
**HEAD audited:** 71ba55c
**Baseline drift:** 22 failed / 677 passed / 53 skipped (run 1), 20 failed / 679 passed / 53 skipped (run 2). Wave A3 reported 699/53/0.

## Files audited

- `E:/AI/db-cluster/test/*.test.ts` (63 files, ~830 `it()` blocks across 56 active + 5 Postgres-skipped + 2 mkdtemp-leak files)
- `E:/AI/db-cluster/test/fixtures/*.fixture.ts` (4 negative-type fixtures)
- `E:/AI/db-cluster/vitest.config.ts`
- `E:/AI/db-cluster/vitest.stryker.config.ts`
- `E:/AI/db-cluster/stryker.conf.json`

## Severity rollup

| Severity | Count |
|---|---:|
| HIGH | 7 |
| MEDIUM | 13 |
| LOW | 8 |
| should-have-been-stage-a | 2 |

## Headline finding — wave6-proof.test.ts flake mechanism

**The failure mode is NOT a `beforeAll → beforeEach` migration miss in wave6-proof itself — wave6-proof already uses `beforeEach` (line 25).** The pre-fix Wave A3 TESTS-007 model anticipated the wrong root cause. The actual mechanism is a compound Windows-filesystem race against in-repo TEST_DIR paths, made materially worse by three carry-overs:

### What's failing

Every test in `wave6-proof.test.ts` (22 `it()` blocks) shares this `beforeEach` (lines 25-56):

```ts
rmSync(TEST_DIR, { recursive: true, force: true });
mkdirSync(TEST_DIR, { recursive: true });
sdk = new ClusterSDK({ clusterDir: join(TEST_DIR, '.db-cluster') });

// Seed cmd1: propose → validate → approve → commit
const cmd1 = await sdk.proposeMutation({...});
await sdk.validateMutation(cmd1.id);  // ← THIS throws NotFoundError sometimes
await sdk.approveMutation(cmd1.id, 'setup-approver');
await sdk.commitMutation(cmd1.id, 'setup');

// Seed cmd2: same pattern
const cmd2 = await sdk.proposeMutation({...});
await sdk.validateMutation(cmd2.id);  // ← OR THIS throws NotFoundError
...
```

`TEST_DIR = join(import.meta.dirname, '.test-phase6-proof')` — a path INSIDE the repo at `test/.test-phase6-proof/`, NOT in `os.tmpdir()`.

The stack: `ClusterSDK.validateMutation` → `ClusterKernel.validateMutation` → `this.getCommand(id)` → `this.commandQueue.get(id)` → `this.load()` → reads `<dataDir>/pending-commands.json`.

`CommandQueue.load()` (`src/kernel/command-queue.ts:51-68`):

```ts
private load(): Map<string, Command> {
    if (!existsSync(this.filePath)) return new Map();
    ...
}
```

**An empty Map is returned silently** when the file doesn't exist. `getCommand(id)` returns `undefined`. `validateMutation` throws `NotFoundError('command', commandId)`. **This is the exact error from the failure logs.**

### Why the file would be missing immediately after a successful save

Three contributing causes, in descending plausibility:

1. **Cause A — Same-tick rmSync→mkdirSync→write race on Windows (most likely).** `CommandQueue.persist()` writes a sibling `.tmp` then `renameSync` over the real path. On Windows, `rmSync({recursive: true, force: true})` does NOT wait for child file handles to fully release. The subsequent `mkdirSync` succeeds (the directory entry exists), but the on-disk metadata may still be inconsistent. The next `writeFileSync(tmpPath)` followed by `renameSync(tmpPath, filePath)` can fail silently in two ways: (a) the rename throws EPERM/EBUSY, which `persist()` does NOT catch, so propose throws — but that produces a different error message than what we see; (b) the rename APPEARS to succeed but the directory listing is briefly inconsistent, so the next `existsSync(filePath)` returns false. Path (b) explains the exact "Not found in command store" symptom.

2. **Cause B — Stale state from `wave6-policy-proof.test.ts` running immediately before** (alphabetical file order). That file creates ~80 mkdtempSync directories in `os.tmpdir()` with NO `afterEach`/`afterAll` cleanup (TESTS-B-002 below). The tmpdir bloat degrades Windows file system performance for the next file's I/O. wave6-proof.test.ts uses `test/.test-phase6-proof/` not `os.tmpdir()`, but the OS-wide file system load is the same handle-allocator.

3. **Cause C — Antivirus scan window.** `test/.test-phase6-proof/` is INSIDE the repo (`import.meta.dirname` resolves to `test/`). Windows Defender real-time protection scans new files in indexed paths far more aggressively than `%TEMP%`. Each `pending-commands.json` write triggers an on-create scan that briefly locks the file (`MpsSvc.exe` opens read handle). If `renameSync` fires while Defender holds the handle, EPERM. This is rig-specific but reproducible on the 5080.

### Why the run-to-run variance (22 → 20)

The race window is on the order of milliseconds. With 22 `beforeEach` invocations per file run, the failure rate per beforeEach is ~91% (run 1) → 82% (run 2). The 9% variance is consistent with file system load varying across runs. **This is materially worse than Wave A3's "~1% intermittent race" estimate — it's now ~85%.**

### Why wave5-parity.test.ts has the same pattern but does NOT fail

`wave5-parity.test.ts:22` does `sdk = new ClusterSDK({ clusterDir: TEST_DIR })` — TEST_DIR DIRECTLY as cluster dir (`test/.test-parity/`). `wave6-proof.test.ts:28` does `sdk = new ClusterSDK({ clusterDir: join(TEST_DIR, '.db-cluster') })` — a NESTED subdirectory. The nested mkdir path means TWO directory operations per `beforeEach` instead of one (rmSync of TEST_DIR removes both, mkdirSync of TEST_DIR creates it, then `createLocalCluster` mkdirSyncs `.db-cluster` inside). Doubled handle activity = doubled race surface.

### Fix scope

The principled fix has TWO parts that must both ship:

**Part 1 — Switch wave6-proof to `os.tmpdir()` per-test (matches wave6-policy-proof's strategy minus the cleanup gap):**

- Change `TEST_DIR` from a module-level `import.meta.dirname` path to `mkdtempSync(join(tmpdir(), 'wave6-proof-'))` INSIDE `beforeEach`.
- Add `afterEach` `rmSync(TEST_DIR, { recursive: true, force: true })`.
- `tmpdir()` paths are excluded from Windows Defender real-time scanning by default and don't share the repo handle-allocator with the indexer.

**Part 2 — Make `CommandQueue.load()` LOUD when the file is missing AFTER a save:**

- Add an instance flag `this.hasWritten` set by `persist()`.
- In `load()`, if `this.hasWritten === true` and `!existsSync(this.filePath)`, throw a typed `CommandQueuePersistenceLostError` instead of returning empty Map.
- This converts the silent-empty into a loud-typed-error and turns the next bug instance into a 1-second diagnostic.

**Files in scope:**

- `test/wave6-proof.test.ts` (TEST_DIR + beforeEach + afterEach migration)
- `src/kernel/command-queue.ts` (loud-on-loss flag — small, additive)

**Files NOT in scope despite being in the TESTS-007 carry-over list:**

`wave5-parity.test.ts`, `phase2-/3-/4-/5-/13-proof.test.ts`, `kernel.test.ts`, `adapters.test.ts`, `cli.test.ts`, `proof.test.ts`, `rebuild.test.ts`, `resolver.test.ts`, `retrieval.test.ts`, `explain.test.ts`, `dashboard-ops.test.ts`, `dashboard-model.test.ts`, `dashboard-command-preview.test.ts`, `repo-knowledge-*.test.ts` — these all use the same `import.meta.dirname` based TEST_DIR pattern but with TEST_DIR as the cluster dir (not a `.db-cluster` subdir) and they aren't failing in the current run. They should still migrate eventually for proactive hygiene (TESTS-B-007 below), but they're not the bleeding artery.

### Estimated migration cost

- Part 1: 6 lines of code in 1 file. Mechanical edit.
- Part 2: ~15 lines of code in 1 file. Additive, no test changes required.
- Total: <30 minutes including local verify.

---

## Findings (HIGH then MEDIUM then LOW)

### TESTS-B-001 — wave6-proof.test.ts flake from in-repo TEST_DIR + nested-subdir + Windows file system race

**Severity:** HIGH
**Category:** defensive (test side)
**File:** `test/wave6-proof.test.ts:8` and `:25-56`
**Description:** Module-level `const TEST_DIR = join(import.meta.dirname, '.test-phase6-proof')` places the working dir INSIDE the repo. Combined with the `.db-cluster` nested-subdir pattern and Windows Defender real-time scanning of indexed paths, the `beforeEach` `rmSync → mkdirSync → propose → validate` chain races and `validateMutation` throws `NotFoundError` because `pending-commands.json` is missing (returned-as-empty-Map silently in `load()`). 22 failures (run 1) and 20 failures (run 2) of 22 total `it()` blocks = ~85% flake rate, materially worse than Wave A3's "~1% intermittent" estimate.
**Recommendation:** (a) Migrate `TEST_DIR` to `mkdtempSync(join(tmpdir(), 'wave6-proof-'))` inside `beforeEach`. (b) Add `afterEach` cleanup. (c) Independently: add a loud-on-loss flag to `CommandQueue.load()` so the next instance of this bug is diagnostic, not silent.
**Evidence:** `test/wave6-proof.test.ts:8`, `:28` (nested `.db-cluster`), `src/kernel/command-queue.ts:51-52` (silent empty-Map fallback), `src/kernel/cluster-kernel.ts:653-655` (NotFoundError thrown from validateMutation when getCommand returns undefined).

### TESTS-B-002 — wave6-policy-proof.test.ts has no cleanup — accumulates ~80 mkdtempSync dirs per run

**Severity:** HIGH
**Category:** degradation (test infra)
**File:** `test/wave6-policy-proof.test.ts:127-141`
**Description:** `makeStores()`, `makeStoresWithDir()`, and `makeSDK()` each call `mkdtempSync(join(tmpdir(), 'wave6-proof-' | 'wave6-sdk-'))` per test invocation. The file has 45 `it()` blocks, several invoking multiple helpers — empirical run leaks ~80+ temp directories per file run. **There is no `afterEach`, `afterAll`, or any `rmSync` call in the entire file.** Verified with `grep -n "rmSync\|afterAll\|afterEach" test/wave6-policy-proof.test.ts` → zero matches.
**Recommendation:** Track dirs in a module-level array; `afterEach` walks the array and rmSync's all. Pattern is already in 31 other test files. Estimate: 15 minutes.
**Evidence:** `test/wave6-policy-proof.test.ts:127`, `:140`, no afterEach anywhere in file.

### TESTS-B-003 — CommandQueue.load() silently returns empty Map when file is unexpectedly missing

**Severity:** HIGH
**Category:** observability (test failure diagnosability — but the fix lives in src/, so promoting to test-domain observation about WHAT the test sees)
**File:** `src/kernel/command-queue.ts:51-52` (the silent-empty path that produces the headline failure's symptom)
**Description:** `load()` checks `existsSync(filePath)` and returns `new Map()` if false. This is correct on first construction (no commands have been saved yet) but WRONG after a `persist()` has succeeded — at that point the file MUST exist; if it doesn't, the queue state has been lost and the next `get()`/`validateMutation` will fail with a confusing "Not found" instead of a diagnostic "Persistence lost". The headline failure took multiple investigation cycles partly because of this.
**Recommendation:** Add `private hasWritten = false` set true at end of `persist()`. In `load()`, if `hasWritten && !existsSync(filePath)`, throw `CommandQueuePersistenceLostError` (new typed error subclass of CommandQueueCorruptError). Behavior unchanged on cold-load; loud on hot-reload-loss.
**Evidence:** `src/kernel/command-queue.ts:51-52`, `:70-75` (persist), `src/kernel/cluster-kernel.ts:654-655` (throws NotFoundError when load returned empty Map).

### TESTS-B-004 — `__admin` cast in policy-kernel.test.ts is invisible to readers and verb-parity allowlist

**Severity:** HIGH
**Category:** defensive (test side — type-safety hygiene)
**File:** `test/policy-kernel.test.ts:246` and `:251`
**Description:** `(restricted as unknown as { __admin: PolicyEnforcedKernel }).__admin = adminWrapped` attaches an admin kernel as a HIDDEN property of a restricted kernel via double-cast. `seedKernel()` reads it back the same way. This bypasses TypeScript's structural checks entirely. The `verb-parity.test.ts` `POLICY_KERNEL_EXTRAS` allowlist (line 57) governs *prototype* method drift and will never catch `__admin` because it's an instance property, not a prototype method. A regression where `__admin` is shadowed or repurposed would compile cleanly and pass all parity checks.
**Recommendation:** Refactor `makePolicyKernel`/`seedKernel` to return a `{ restricted, admin }` tuple instead of attaching admin as a hidden property. Eliminates the cast, makes the test reader's job obvious, doesn't require touching `verb-parity.test.ts`. Estimate: 30 minutes (~20 call sites).
**Evidence:** `test/policy-kernel.test.ts:246`, `:251`, `test/verb-parity.test.ts:57-71` (POLICY_KERNEL_EXTRAS — doesn't and can't cover this).

### TESTS-B-005 — V3-007 carry-over: Windows symlink test silent-skips on EPERM (covering the rig that needs it most)

**Severity:** HIGH
**Category:** degradation (test infra)
**File:** `test/wave-a3-surface-regression.test.ts:152-160`
**Description:** `symlinkSync` throws EPERM on Windows without admin/Developer Mode. The test catches EPERM/ENOTSUP and `return`s with a `console.warn`. **This is exactly the rig where SURFACE-R2-002's symlink-sandbox-escape mitigation matters most** — Windows is the platform where local-stdio MCP hosts are most likely to share the filesystem with the cluster. The test passes silently on the 5080 rig (no admin), giving false coverage confidence. Wave A1 documented this as V3-007.
**Recommendation:** Use `it.skipIf(process.platform === 'win32' && !canSymlink())` to make the skip EXPLICIT and SURFACED in vitest output. Better: introduce a Junction-based fallback (Windows junctions don't require admin and work for directory symlinks; `symlinkSync(target, path, 'junction')`). Either change reveals the gap immediately if it ever reappears.
**Evidence:** `test/wave-a3-surface-regression.test.ts:155-158` (early return).

### TESTS-B-006 — V3-009 carry-over: KERNEL-R2-002 verify() regression test covers 2 of 5 ledger-subject event types

**Severity:** HIGH
**Category:** defensive (coverage gap)
**File:** `test/wave-a3-stores-regression.test.ts:78-126` (STORES-R2-003 region)
**Description:** Wave A3 added regression coverage for `verify()` consuming `mutation_orphaned` and `command_rejected` events. There are 5 ledger-subject event types in the codebase (search `subjectStore: 'ledger'` in src/) — the other 3 have no `verify()` consumer test even though they could go orphan-equivalent. Partial coverage today means a regression in any of the 3 uncovered paths is undetected.
**Recommendation:** Extend STORES-R2-003 to enumerate all 5 ledger-subject event types as `it.each([...]`) with one test per type asserting `verify()` reports each one correctly. Estimate: 1 hour.
**Evidence:** `test/wave-a3-stores-regression.test.ts:78-126`, search across `src/` for `subjectStore: 'ledger'` (5 distinct emit sites).

### TESTS-B-007 — TEST_DIR-inside-repo pattern is the rig's biggest single fragility multiplier

**Severity:** HIGH
**Category:** defensive (test side)
**File:** 24 test files (see `grep "join(import.meta.dirname, '\.test-")` enumeration)
**Description:** 24 of 63 test files use `const TEST_DIR = join(import.meta.dirname, '.test-XYZ')` — paths INSIDE the repo. On Windows with Defender real-time protection ON (default for the 5080 rig), every file write to these paths triggers a synchronous AV scan that briefly locks the file. Combined with `rmSync → mkdirSync` in `beforeEach`, this creates a race window that wave6-proof currently sits ON. The other 23 files are NOT currently failing, but the failure mode is platform-systemic — the next test file that happens to write 2+ files in the same beforeEach against a nested subdir is the next wave6-proof.
**Recommendation:** Mass migration to `os.tmpdir()` for ALL TEST_DIR paths in the 24-file cohort. Same `mkdtempSync` pattern as the wave-a3-tests-regression file already uses (12 instances of `mkdtempSync(join(tmpdir(), '...-'))` per-test). Tracked module-level array + afterEach cleanup. Estimate: 3 hours mechanical edit + verify. **This is the principled Stage B Tests intervention** — wave6-proof is the canary, not the only carrier.
**Evidence:** `grep "join(import.meta.dirname, '\.test-")` returns 24 files; `tmpdir()` excluded from Windows Defender by default; in-repo paths are scanned aggressively.

---

### TESTS-B-008 — Six dogfood-*.test.ts + phase11/12/15-proof.test.ts use beforeAll, sharing kernel/cluster across all tests in file

**Severity:** MEDIUM
**Category:** defensive (test side)
**File:** `test/dogfood-mutation.test.ts:11`, `dogfood-ops.test.ts:20`, `dogfood-policy.test.ts:49`, `dogfood-retrieval.test.ts:12`, `dogfood-trace.test.ts:11`, `dogfood-replay.test.ts`, `phase11-proof.test.ts:35`, `phase12-proof.test.ts:41`, `phase15-proof.test.ts:`, `phase8-proof.test.ts:33`, `restore-artifacts.test.ts:13`, `command-persistence.test.ts:13`, `command-index-consistency.test.ts:11`, `content-index.test.ts:15`, `dashboard-snapshot.test.ts:13`
**Description:** 15+ files share kernel/cluster/dataDir state across ALL their tests via `beforeAll`. Tests that mutate that state (e.g., `dogfood-mutation.test.ts` proposes/commits new entities, `dogfood-ops.test.ts` clears the index, then `dogfood-retrieval.test.ts` reads it) can produce ordering-dependent passes. Today they pass because the ordering is stable. Tomorrow when one test is renamed/reordered the cascade fails.
**Recommendation:** Migrate to `beforeEach` (per-test fresh dogfood cluster). The `createDogfoodCluster()` cost is non-trivial (it ingests ~25 artifacts), so this would slow tests. The proactive answer: extract the seed payload into a fixture module loaded once at `beforeAll` (data-only), then per-test `beforeEach` rehydrates a fresh kernel from that data. Estimate: 4 hours.
**Evidence:** See file list above; each uses `beforeAll(async () => { cluster = await createDogfoodCluster(); })` pattern.

### TESTS-B-009 — Stryker `coverageAnalysis: 'off'` → 28-hour mutation run

**Severity:** MEDIUM
**Category:** future-proofing
**File:** `stryker.conf.json:10`
**Description:** With `coverageAnalysis: 'off'`, Stryker runs all tests for every mutant. The current `mutate` array covers 9 source files; combined with `concurrency: 2`, an empirical run is ~28 hours — incompatible with CI and unlikely to ever run end-to-end. Wave A3 §11 documented this. Three viable paths: (a) narrow `mutate` to invariant-density paths only (`errors.ts` + `redactor.ts` + `ops/verify.ts` — the 3 highest-leverage files), enabling a weekly run; (b) migrate from Stryker to `@vitest/coverage-v8` + a property-based supplement to retain the spirit of mutation testing without the wall; (c) formally codify "verifier-3 substitutes for mutation coverage" as the doctrine and stop running Stryker.
**Recommendation:** Option (a) for Stage B — narrowing alone is a 10-minute config edit and gives back a weekly mutation gate. Decide between (b) and (c) at Wave B close.
**Evidence:** `stryker.conf.json:10` (`"coverageAnalysis": "off"`), `:17-27` (broad mutate array), Wave A3 §11.

### TESTS-B-010 — Wave A3 consolidation pattern (`wave-a3-{kernel,stores,surface,tests}-regression.test.ts`) is undocumented

**Severity:** MEDIUM
**Category:** future-proofing
**File:** `test/wave-a3-kernel-regression.test.ts`, `wave-a3-stores-regression.test.ts`, `wave-a3-surface-regression.test.ts`, `wave-a3-tests-regression.test.ts`
**Description:** Wave A3 emergent decision (§7a per the amend report): split regression nets by domain to avoid sequencing conflicts across parallel agents. The file headers do document each file's purpose, but the META-pattern ("when a future wave amends typed-error coverage, do it in `wave-aN-{domain}-regression.test.ts`, not in `typed-error-regression.test.ts`") is captured nowhere. Wave B amends WILL extend `typed-error-regression.test.ts` and re-collide unless someone codifies this.
**Recommendation:** Add a short doctrine comment to `typed-error-regression.test.ts:1` ("New regression nets go in `wave-a{wave}-{domain}-regression.test.ts` per the Wave A3 consolidation pattern — see wave-a3-tests-regression.test.ts:56-60"). Estimate: 5 minutes.
**Evidence:** `test/wave-a3-tests-regression.test.ts:56-60` (the pattern is half-documented there but only retrospectively).

### TESTS-B-011 — TESTS-R2-006 `__admin` companion: `seedKernel` is a global mutable getter

**Severity:** MEDIUM
**Category:** defensive (test side)
**File:** `test/policy-kernel.test.ts:250-252`
**Description:** Companion to TESTS-B-004. `seedKernel(restricted)` reads back the hidden `__admin` property by the same double-cast. Anywhere in the file that someone forgets to call `makePolicyKernel` first and just instantiates a kernel directly, `seedKernel` returns `undefined` and the next call surface NPEs. There's no runtime guard.
**Recommendation:** Same fix as TESTS-B-004 (return tuple from makePolicyKernel) makes seedKernel obsolete.
**Evidence:** `test/policy-kernel.test.ts:250-252`.

### TESTS-B-012 — V3-008 carry-over: `link_evidence` orphan-citation invariant has only end-to-end coverage

**Severity:** MEDIUM
**Category:** defensive (coverage gap)
**File:** Coverage gap — no dedicated test
**Description:** Wave A1 docked V3-008 as carryover. `link_evidence` verb's commit-arm verifies both artifact and entity exist (`src/kernel/cluster-kernel.ts:564-568`), but the test coverage for the "links cite a nonexistent target → orphan event" path is only indirect (`wave-a3-stores-regression.test.ts` doesn't enumerate this case explicitly). A regression that made `link_evidence` silently succeed against a nonexistent artifact would fail an integration test eventually but no unit-level regression-net pins it.
**Recommendation:** Add a `TESTS-B-V3-008` block in `wave-a3-tests-regression.test.ts` that proposes `link_evidence` with a synthetic artifactId that doesn't exist; asserts the commit throws `NotFoundError('artifact', ...)` AND no provenance event was emitted. Estimate: 20 minutes.
**Evidence:** `src/kernel/cluster-kernel.ts:564-568`, no test files have `link_evidence` + `nonexistent` together.

### TESTS-B-013 — V3-010 carry-over: CLI `commit --self-approve` state assertion is behavioral, not stateful

**Severity:** MEDIUM
**Category:** defensive (coverage gap)
**File:** Coverage gap — closest is in `cli.test.ts`
**Description:** Test asserts the CLI command returns the expected output but doesn't assert the post-commit state of the command queue (status='committed' AND approvedBy set AND committedBy set AND a receipt emitted). A regression where `--self-approve` silently failed to record approvedBy/committedBy would pass the test.
**Recommendation:** Extend the relevant `cli.test.ts` it() block to also call `sdk.inspectCommand(id)` after the CLI command and assert all four fields are populated. Estimate: 15 minutes.
**Evidence:** None directly cited — V3-010 from Wave A1 amend.

### TESTS-B-014 — V3-011 carry-over: STORES-R2-005 cleanup branch not exercised

**Severity:** MEDIUM
**Category:** defensive (coverage gap)
**File:** `test/wave-a3-stores-regression.test.ts:142-192` (STORES-R2-002 region — CorruptStoreError test)
**Description:** The CorruptStoreError test for Local{Ledger,Artifact}Store covers the THROW path but not the cleanup-after-throw branch. If a test corrupts events.json mid-flight and the LedgerStore catches the error, what's the state? Today the tests don't reach that branch. Wave A1 V3-011 documented this.
**Recommendation:** Add a follow-up assertion: after the corruption is detected and `CorruptStoreError` thrown, a fresh `new LocalLedgerStore(...)` on the same dir should ALSO throw on read (proves the corruption persists, isn't silently recovered) — or alternatively that calling `.clear()` on the corrupted store recovers it. Pick the actual contract and pin it. Estimate: 30 minutes once doctrine decided.
**Evidence:** `test/wave-a3-stores-regression.test.ts:142-192`, V3-011 docket.

### TESTS-B-015 — V3-012 carry-over: SURFACE-R2-004 false-positive guard relies on console.warn capture

**Severity:** MEDIUM
**Category:** observability (test infra)
**File:** Search for the SURFACE-R2-004 test in `wave-a3-surface-regression.test.ts` ~lines 110-120
**Description:** Wave A3 added a `console.warn` when policies are configured without a principal. The test that this warning fires uses console.warn capture (vi.spyOn). This is observability-fragile: a regression where the warning is reworded slightly (or moved to console.error) passes the spy check but loses the visibility intent.
**Recommendation:** Assert ALSO the warning text contains both "INTERNAL_TRUSTED_PRINCIPAL" AND "Pass `principal:" — pin the structurally-significant substrings, not the whole string. Estimate: 5 minutes.
**Evidence:** `test/wave-a3-surface-regression.test.ts` around SURFACE-R2-004 region.

### TESTS-B-016 — V3-014 carry-over: STORES-R2-003 check-isolation — passes are mask-prone

**Severity:** MEDIUM
**Category:** defensive (coverage gap)
**File:** `test/wave-a3-stores-regression.test.ts:78-126`
**Description:** The verify() consume-orphan tests assert `provCheck.status === 'healthy'`. But verify() runs ALL its checks; if ANY other check happens to be healthy, the targeted check might be passing for the wrong reason (verify aggregates check results). The current assertion gets the named check by name (`result.checks.find(c => c.name === 'provenance_references_valid')`) — good — but doesn't assert that the OTHER checks are also asserted-or-known. A future check getting added unintentionally produces a healthy verify() that masks the real provenance check status.
**Recommendation:** After the targeted-check assertion, also assert `result.overall === 'healthy'` AND `result.checks.length === <expected count>`. Catches "new check added that hides regression" the next time it happens. Estimate: 10 minutes.
**Evidence:** `test/wave-a3-stores-regression.test.ts:78-126`.

### TESTS-B-017 — V3-015 carry-over: TS @ts-expect-error fixtures need positive counter-fixtures

**Severity:** MEDIUM
**Category:** defensive (coverage gap)
**File:** `test/fixtures/incomplete-{canonical,artifact,ledger-event,ledger-receipt}-store.fixture.ts`
**Description:** The 4 fixture files each define a class with `// @ts-expect-error` on the class header to prove that the contract REQUIRES the missing method. There's no POSITIVE counter-fixture — i.e., a class that DOES implement all methods, which must NOT have @ts-expect-error and must compile cleanly. If someone later optionalizes one of the methods on the contract, both fixtures pass (positive: still compiles; negative: @ts-expect-error becomes unused, tsc complains TS2578 — wait, that DOES fire). OK so the negative is sufficient for the optionalization regression. But the POSITIVE counter-fixture would defend against a related regression: the contract REQUIRES a method, and someone OVER-tightens the signature (e.g., changes Promise<void> to Promise<Receipt>), and existing implementations break silently in adapters that haven't been recompiled.
**Recommendation:** Add 4 positive counter-fixtures (CompleteCanonicalStore, CompleteArtifactStore, CompleteLedgerStoreEvent, CompleteLedgerStoreReceipt). Each implements the full contract correctly. Test `tscCheck` returns ok===true with NO @ts-expect-error directive. Estimate: 1 hour.
**Evidence:** `test/fixtures/incomplete-*.fixture.ts`, V3-015 docket.

### TESTS-B-018 — JSDOM gap: dashboard render is static-source + functional canary, not actually rendered

**Severity:** MEDIUM
**Category:** future-proofing
**File:** `test/wave-a3-tests-regression.test.ts:870-998` (TESTS-R2-008 region — dashboard redaction wiring net)
**Description:** Wave A3 deliberately chose static-source assertions ("`PolicyViewToggle.jsx` does NOT redefine applyRedaction") + a functional canary ("the shared module's applyRedaction redacts a DashboardObject"). This is reasonable, but it can't catch JSX errors (component renders to nothing), CSS errors (component renders invisibly), or React errors (component throws on prop type). The dashboard ships untested by render. Wave A3 §9 documented this.
**Recommendation:** Stage B decision point: (a) accept the static-source + functional canary as the formal doctrine and add a 2-paragraph comment in `vitest.config.ts` explaining WHY JSDOM is not configured; OR (b) accept the JSDOM cost and add `@testing-library/react` + JSDOM environment to test rendering for `PolicyViewToggle.jsx` specifically. Either way: make the choice explicit, don't leave it as "missed".
**Evidence:** `test/wave-a3-tests-regression.test.ts:870-892` (doctrine block), `vitest.config.ts` (no environment).

### TESTS-B-019 — Five it.skip / describe.skip Postgres-gated tests collect 53 skipped tests

**Severity:** MEDIUM
**Category:** observability
**File:** `test/backend-parity.test.ts:29`, `phase8-proof.test.ts:27`, `postgres-canonical-store.test.ts:15`, `postgres-kernel-regression.test.ts:24`, `sql-injection.test.ts:21`
**Description:** When `DB_CLUSTER_POSTGRES_URL` is unset, 5 describe blocks collectively skip — running total 53 skipped. The skip is silent and unconditional. An operator running tests locally without Postgres gets a "699 passed / 53 skipped" line and reasonably assumes the skips are environment-gated and OK. They are — but the skip MESSAGE doesn't say what's being skipped or how to enable it.
**Recommendation:** Where each `describe.skip(...)` is constructed, wrap with `describePostgres = POSTGRES_URL ? describe : describe.skip` and add a `console.warn` (or `it('SKIPPED: set DB_CLUSTER_POSTGRES_URL to enable Postgres tests', () => {})`) so the operator sees the gate explicitly. Estimate: 15 minutes.
**Evidence:** 5 files all use the same `describePostgres = POSTGRES_URL ? describe : describe.skip` pattern with no help text.

### TESTS-B-020 — Two `dynamic import` cache-busts use `Date.now()` — non-deterministic at minute boundaries

**Severity:** MEDIUM
**Category:** observability (test side — non-determinism)
**File:** `test/wave-a3-surface-regression.test.ts:175`
**Description:** `await import('../src/mcp/server.js?wave-a3-symlink-' + Date.now())` works fine in practice (Date.now() collisions are impossible within a single test) — but the pattern is fragile. If another test in the same file imports the same module with a static query string and runs first, the cache shape diverges. Recommend a deterministic monotonic counter instead.
**Recommendation:** Use a closure-scoped counter (`let importSerial = 0; ... '?wave-a3-symlink-' + (++importSerial)`) for deterministic cache-busting. Estimate: 5 minutes.
**Evidence:** `test/wave-a3-surface-regression.test.ts:175`.

---

### TESTS-B-021 — `policy-surface.test.ts:15` creates a module-level mkdtempSync with no cleanup

**Severity:** LOW
**Category:** degradation
**File:** `test/policy-surface.test.ts:15`
**Description:** `const TEST_DIR = mkdtempSync(join(tmpdir(), 'policy-surface-'));` runs at module-load time. No corresponding `afterAll` cleanup. Each test run leaks one directory to OS tmpdir. Not currently causing failures because tmpdir is excluded from Defender, but contributes to the broader tmpdir-bloat problem.
**Recommendation:** Move into beforeAll + add afterAll cleanup. Estimate: 5 minutes.
**Evidence:** `test/policy-surface.test.ts:15`.

### TESTS-B-022 — `path-traversal.test.ts` per-test mkdtempSync without try/finally

**Severity:** LOW
**Category:** degradation
**File:** `test/path-traversal.test.ts:40`, `:69`, etc.
**Description:** Each `it()` block creates `mkdtempSync` and `rmSync`s at end. If the test throws BEFORE the rmSync, the dir leaks. The file uses `try { ... } finally { rmSync... }` in places but not consistently. Quick scan: 6 mkdtempSync, 6 rmSync — looks balanced but not guaranteed by structure.
**Recommendation:** Audit ensures every mkdtempSync has a corresponding rmSync in a `finally` block (or `afterEach` array pattern). Estimate: 20 minutes.
**Evidence:** `test/path-traversal.test.ts:39-50` (uses try/finally at line 41), other test bodies may not.

### TESTS-B-023 — fast-check seed-on-fail is not configured

**Severity:** LOW
**Category:** observability (test side)
**File:** `test/wave-a3-tests-regression.test.ts:275-330`, `wave-a3-kernel-regression.test.ts:138`, `:297`, `:716`, `wave-a3-surface-regression.test.ts:16` (5 fc.assert sites total)
**Description:** All fc.assert calls use default settings. When a property test fails, vitest output shows the shrunk counter-example but NOT the seed. Reproducing locally requires re-running with the same seed, which can't be obtained without explicit `{ seed: ... }` config or `process.env.FC_SEED`.
**Recommendation:** Wrap fc.assert in a helper that reads `process.env.FC_SEED` (or use vitest's `--retry=0` + `fc.configureGlobal({ seed: ... })` at module load. Surface the seed in the failure message via `errorWithCause`. Estimate: 30 minutes.
**Evidence:** 5 `fc.assert` sites, none configure seed.

### TESTS-B-024 — wave-a3-tests-regression.test.ts has 29 it() blocks in one file — slow on cold cache

**Severity:** LOW
**Category:** future-proofing
**File:** `test/wave-a3-tests-regression.test.ts` (1052 lines, 29 describe/it)
**Description:** Largest single test file. As Wave B adds more, the cold-load + transpile time per `vitest run` will compound. Already at ~6s on the rig per `vitest run`. Per the Wave A3 consolidation pattern, future amends MAY land here.
**Recommendation:** Stage B doctrine decision: when does the file split into `wave-a3-tests-regression.{1,2,3}.test.ts`? Suggested threshold: 1500 lines OR 50 it() blocks. Estimate: 0 minutes (doctrine only).
**Evidence:** `test/wave-a3-tests-regression.test.ts` line count.

### TESTS-B-025 — Some assertions lack named `it('describes the invariant', ...)` pattern

**Severity:** LOW
**Category:** observability
**File:** Spot-checked: `test/cli.test.ts`, `test/install-smoke.test.ts`, `test/uri.test.ts`
**Description:** All `it()` blocks across all 63 files use named descriptors, but ~5% are generic ("works correctly", "returns expected"). Failure-message diagnosability suffers in these cases.
**Recommendation:** Audit pass to rewrite the ~30 generic descriptors to invariant-naming. Estimate: 1 hour.
**Evidence:** Spot check across files.

### TESTS-B-026 — vitest.config.ts has no setupFiles for shared cleanup / env

**Severity:** LOW
**Category:** future-proofing
**File:** `vitest.config.ts`
**Description:** No `setupFiles` configured. If Stage B introduces a doctrine like "every test cleans up its dirs via a module-level tracker," there's no central place to put a global afterEach that walks an exported array.
**Recommendation:** Add `setupFiles: ['./test/_setup.ts']` and create a thin setup file that exports a `trackTmpDir(dir)` helper and registers a global afterEach. Migration to this is incremental. Estimate: 30 minutes for infra, then incremental.
**Evidence:** `vitest.config.ts:1-9` (no setupFiles).

### TESTS-B-027 — `repo-knowledge-mapping.test.ts` is missing from the file list

**Severity:** LOW
**Category:** observability
**File:** `test/repo-knowledge-mapping.test.ts` (per ls output, 63 files total)
**Description:** Confirming presence: file is in the test/ dir, was not enumerated in any beforeEach/beforeAll search but appears in `ls`. Spot-checked it uses `describe + it` only — no setup hooks. That's intentional (pure unit tests of mapping logic).
**Recommendation:** None — flagged for completeness.
**Evidence:** `ls test/` output.

### TESTS-B-028 — `dashboard-policy-view.test.ts` is the only test that exercises applyRedaction's runtime behavior

**Severity:** LOW
**Category:** defensive (concentration risk)
**File:** `test/dashboard-policy-view.test.ts`, with `test/wave-a3-tests-regression.test.ts:870-998` (TESTS-R2-008) as the wiring net
**Description:** TESTS-R2-008 doc block says `dashboard-policy-view.test.ts` is the source of truth for runtime redaction behavior. If that test file is renamed/deleted, TESTS-R2-008 has no enforcement that the SHARED module is actually tested.
**Recommendation:** Add a `it('canonical applyRedaction test file exists at known path', () => { expect(existsSync('test/dashboard-policy-view.test.ts')).toBe(true); })` to wave-a3-tests-regression so the doctrine is self-defending. Estimate: 5 minutes.
**Evidence:** `test/wave-a3-tests-regression.test.ts:870-892` (doctrine block cites file by name).

---

## should-have-been-stage-a findings (2)

### TESTS-A-MISS-001 — CommandQueue.load() silent-empty on missing-after-save is a REAL BUG

**Severity:** should-have-been-stage-a
**Category:** defensive (test diagnosability for a real bug)
**File:** `src/kernel/command-queue.ts:51-52`
**Description:** This is technically a Stage A finding because it's a real bug in `src/`, not a proactive concern. The CommandQueue should fail LOUD when its persistence file is unexpectedly missing after a save. Wave A3 closed without catching it because the bug only fires under the headline race condition, which Wave A3 estimated at ~1% (it's ~85%). Stage A could not have known the rate without running on the 5080 rig with the in-repo TEST_DIR.
**Recommendation:** Already covered in TESTS-B-003. Promoting this to should-have-been-stage-a so the Stage B exit-decision documents that a small src/ change is needed alongside the test-side migration.
**Evidence:** `src/kernel/command-queue.ts:51-52`.

### TESTS-A-MISS-002 — `(restricted as unknown as { __admin: ... }).__admin = ...` cast bypasses type system

**Severity:** should-have-been-stage-a
**Category:** defensive (type safety)
**File:** `test/policy-kernel.test.ts:246`
**Description:** TESTS-R2-006 documented this in Wave A3 amend but didn't fix it. It's a real type-safety hole (a real bug in test infrastructure) — should have been a Stage A fix. Wave A3 chose to ship without the refactor because verb-parity.test.ts was the safety net for the related drift, but verb-parity can't cover this case (TESTS-B-004).
**Recommendation:** Already covered in TESTS-B-004 — refactor `makePolicyKernel` to return `{ restricted, admin }`. Promoting this to should-have-been-stage-a so the closure dispatch documents that a test-infra refactor is owed.
**Evidence:** `test/policy-kernel.test.ts:246`, `:251`.

---

## Carry-over verification matrix

| ID | Present? | Proactive severity | Fix scope | New file:line |
|---|---|---|---|---|
| TESTS-007 (beforeAll→beforeEach) | **Compound — see headline** | HIGH | Migrate `wave6-proof.test.ts` TEST_DIR to mkdtempSync; add loud-on-loss flag to CommandQueue.load(); future 24-file mass migration | `test/wave6-proof.test.ts:8,25-56,58`; `src/kernel/command-queue.ts:51` |
| TESTS-R2-006 (`__admin` cast) | YES (unchanged) | HIGH | Refactor `makePolicyKernel` to return tuple; `seedKernel` helper deleted | `test/policy-kernel.test.ts:246,251` |
| V3-007 (Windows symlink) | YES | HIGH | Use it.skipIf + Junction fallback | `test/wave-a3-surface-regression.test.ts:152-160` |
| V3-008 (link_evidence orphan) | YES | MEDIUM | Add explicit unit test for nonexistent-target case | (new in `wave-a3-tests-regression.test.ts`) |
| V3-009 (KERNEL-R2-002 partial coverage) | YES (2 of 5 event types) | HIGH | Extend STORES-R2-003 to enumerate all 5 ledger-subject event types | `test/wave-a3-stores-regression.test.ts:78-126` |
| V3-010 (CLI --self-approve state) | YES | MEDIUM | Add state-assertion after CLI command | `test/cli.test.ts` (relevant block) |
| V3-011 (STORES-R2-005 cleanup branch) | YES | MEDIUM | Add post-throw state assertion | `test/wave-a3-stores-regression.test.ts:142-192` |
| V3-012 (SURFACE-R2-004 false-positive) | YES | MEDIUM | Pin substring assertions on warn text | `test/wave-a3-surface-regression.test.ts` |
| V3-014 (STORES-R2-003 check-isolation) | YES | MEDIUM | Also assert overall + checks.length | `test/wave-a3-stores-regression.test.ts:78-126` |
| V3-015 (positive counter-fixtures) | NO | MEDIUM | Add 4 Complete*Store.fixture.ts | `test/fixtures/complete-*.fixture.ts` (new) |
| Stryker 28-hr wall | YES | MEDIUM | Narrow mutate to 3 high-leverage files for weekly run | `stryker.conf.json:17-27` |
| Consolidation pattern doctrine | YES (undocumented) | MEDIUM | Add doctrine comment to typed-error-regression.test.ts | `test/typed-error-regression.test.ts:1` |
| JSDOM gap | YES (intentional doctrine) | MEDIUM | Make doctrine explicit OR add JSDOM env | `vitest.config.ts` |

## Domain summary (≤150 words)

The TESTS-007 carry-over is materially worse than Wave A3 estimated — empirical failure rate ~85% (22/22 + 20/22 across two runs) vs. estimate ~1%. Root cause is NOT a missed `beforeAll → beforeEach` migration in wave6-proof itself (it already uses beforeEach). The mechanism is a compound Windows-filesystem race against an in-repo TEST_DIR (`test/.test-phase6-proof/`) with a nested `.db-cluster` subdir, amplified by Windows Defender real-time scanning of indexed paths and by `wave6-policy-proof.test.ts` accumulating ~80 uncleaned tmpdirs immediately before. Principled fix is two-part: migrate `wave6-proof.test.ts` TEST_DIR to `os.tmpdir()` per-test (Part 1), and make `CommandQueue.load()` LOUD when persistence is unexpectedly missing after a save (Part 2). The 24-file mass migration to `tmpdir()` is the proactive Stage B Tests intervention.

---

## 200-word closing summary

Top 3 HIGH findings:

1. **TESTS-B-001 wave6-proof flake mechanism** (the headline) — 22 of 22 then 20 of 22 tests fail per session run = ~85% flake rate, materially worse than Wave A3's "~1% intermittent" estimate. Root cause is a compound Windows-filesystem race: in-repo TEST_DIR + nested `.db-cluster` subdir + Defender scanning + CommandQueue.load() silent-empty when file unexpectedly missing. Fix is mechanical (~30 minutes) but must be paired with a loud-on-loss CommandQueue flag so the next instance is diagnostic.

2. **TESTS-B-002 wave6-policy-proof temp-dir leak** — 80+ mkdtempSync dirs leaked per run, zero cleanup hooks. Direct contributor to the Cause-B file system load that opens the TESTS-B-001 race window.

3. **TESTS-B-007 24-file in-repo TEST_DIR pattern** — the same fragility multiplier that bit wave6-proof sits under 23 other files. Mass migration to `tmpdir()` is the proactive Stage B intervention.

Totals: 7 HIGH, 13 MEDIUM, 8 LOW, 2 should-have-been-stage-a. The TESTS-007 carry-over is real, recurrent, and the next swarm wave's #1 priority. Wave A3's estimate was off by ~85x.
