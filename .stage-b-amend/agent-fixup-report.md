# Dogfood Swarm Stage B Wave B1-Amend — Fix-Up Agent Report

**Repo:** `mcp-tool-shop-org/db-cluster`
**Working copy:** `E:/AI/db-cluster`
**Agent role:** Coordinator-applied fix-up (parallel to Wave A4 multi-domain pattern)
**Wave dispatch:** `.stage-b-amend/agent-fixup-report.md` (this file)
**Date:** 2026-05-27

---

## 1. Pre-fix-up baseline

- **Tests:** 887 passed / 55 skipped / 0 failed — deterministic across 3 vitest runs
- **Lint:** clean (`tsc --noEmit` + `npm run lint:examples`)
- **Release-gate:** 8/8 PASS

Verification gate (FAILING tests before fixes landed): 31 of 34 regression tests in `test/wave-b1-fixup-regression.test.ts` failed on the pre-fix-up HEAD; 3 passed (the JSDoc-shape assertions where the pre-fix wording was incidentally also acceptable). This satisfies the per-finding test-first gate.

## 2. Per-item status — 17 fix-up items

All 17 items closed.

### Tier 1 — Architectural integration (label-rendering boundary)

| ID | Status | Notes |
|---|---|---|
| **AGG-B1-1a** | closed | `src/provenance/trace-builder.ts` JSDoc rewritten on both `addStructuredNode` and `renderPublicLabel` + inline comment inside `addStructuredNode`. The doctrine documented: literal label at bare ClusterKernel, re-rendered via `renderProvenanceLabel(labelData, policyView)` at the PolicyEnforcedKernel boundary. The stale "ALREADY structurally stripped" wording is gone. |
| **AGG-B1-1b** | closed | `PolicyEnforcedKernel.traceObject` (line 506-515) AND `traceBundle` (line 826-835) now call a new private helper `rerenderLabelsWithPolicy(graph, policyView)` after `redactProvenanceActors`. The helper walks `graph.nodes` and for any node with `metadata.labelData` re-renders `node.label = renderProvenanceLabel(labelData, policyView)`. The `entity_name` and `artifact_filename` RedactionTargets now actually gate the rendered label string. End-to-end regression test (`AGG-B1-1b end-to-end`) confirms `[REDACTED]` appears in `node.label` under an entity_name-deny policy. |

### Tier 2 — `LedgerStore.rotate()` correctness (Stores)

| ID | Status | Notes |
|---|---|---|
| **AGG-B1-2a** | closed | `rotate()` now snapshots `this.events` + `this.receipts` BEFORE mutation. Persists run inside try; on any persist failure the snapshot is restored and the error rethrown. In-memory state and on-disk state stay consistent on failure. |
| **AGG-B1-2b** | closed | New typed `InvalidRotateTimestampError` in `src/adapters/local/errors.ts` (extends `Error`, `code: 'INVALID_ROTATE_TIMESTAMP'`). Thrown at top of `rotate()` via `Number.isNaN(Date.parse(beforeTimestamp))` check. |
| **AGG-B1-2c** | closed | Constructor now sweeps `<dataDir>/ledger-archive/` for orphan `<name>.<pid>-<rand>.tmp` files when the directory exists. Uses a tmp-pattern regex (`/\.\d+-[a-z0-9]+\.tmp$/`) and the same 5-minute orphan threshold as `cleanupOrphanTmpFiles`. Best-effort; failure to sweep is non-fatal. |
| **AGG-B1-2d** | closed | New typed `RotateBoundaryInFutureError` in `src/adapters/local/errors.ts` (`code: 'ROTATE_BOUNDARY_IN_FUTURE'`). Thrown when `beforeTimestamp > now`. Pre-fix this silently returned `{archived: 0}`. Existing `wave-b1-stores-regression` test updated to expect the throw. |

### Tier 3 — Cross-domain (family-probe misses)

| ID | Status | Notes |
|---|---|---|
| **AGG-B1-3** | closed | `scripts/release-gate.mjs` and `scripts/smoke-install.mjs` both now compute the tarball name from `package.json` (`PKG.name` + `PKG.version`). Hardcoded `db-cluster-0.1.0.tgz` literals removed from both files. |
| **AGG-B1-4** | closed | `LocalLedgerStore.loadArray` now accepts an out-param `tailOut: {discarded, file}`; constructor passes one per file (events + receipts), then calls a new private `recordTailCorruption()` post-load. The helper emits a `process.stderr.write` warning AND appends a `ledger_tail_corruption_recovered` ProvenanceEvent (action string with `subjectStore: 'ledger'`). Synchronous `appendOneEvent` is used so we don't recurse into the async append() path. |

### Tier 4 — Operator-surface fixes

| ID | Status | Notes |
|---|---|---|
| **AGG-B1-5** | closed | `dashboard/components/OperationsPanel.jsx` updated to read `opsData.overall` (not `.doctor.overall`), `opsData.stores` (not `.doctor.checks`), `provenanceHealth.totalReceipts` / `.totalEvents` (not `.receipts` / `.events`). Plus new render logic: `orphanEvents === null` → '?' badge with degraded styling. |
| **AGG-B1-6** | closed | CLI `doctor` command now constructs a `CommandQueue(CLUSTER_DIR)` and passes `{dataDir: CLUSTER_DIR, commandQueue}` to `doctor()`. `buildOpsModel` signature extended with optional `BuildOpsModelOptions` ({dataDir, commandQueue}) — forwarded to `doctor()`. The `no_orphan_staging` check now actually runs at the CLI surface. |
| **V1-B1-007 / V2-B1-011** | closed | `ProvenanceHealth.orphanEvents: number \| null` (interface change). When `countEvents` throws, ops-model sets `orphanEvents = null` + `degradedReason = 'orphan_count_unavailable'`. Overall health becomes 'degraded' when count is unavailable (not 'healthy'). A new repair-suggestion entry surfaces the error condition. |
| **V3-B1-005** | closed | The `typeof.*countEvents.*===.*function'` feature-detect removed from `src/dashboard/ops-model.ts`. `countEvents` is REQUIRED on the LedgerStore contract — call directly. The try/catch above still handles runtime errors (V1-B1-007). |

### Tier 5 — Small surgical

| ID | Status | Notes |
|---|---|---|
| **V1-B1-010** | closed | `src/kernel/cluster-kernel.ts:283` recordOrphanMutation stderr branch now applies `redactErrorMessage(orphanErr)` instead of writing `orphanErr.message` raw. Filesystem paths are scrubbed symmetrically (the persisted ledger detail was already scrubbed; stderr is now too). |
| **V2-B1-006** | closed | `src/mcp/sanitize.ts` BUILTIN_ERROR_CODES now maps `PolicyConfigError`, `InvalidRotateTimestampError`, `RotateBoundaryInFutureError` to their stable codes. |
| **V1-B1-006** | closed | NDJSON shape gate in `loadArray` now requires `id.length > 0` (not just `typeof id === 'string'`). A tampered file with `{"id":""}` line throws `CorruptStoreError`. |
| **AGG-B1-9a** | closed | `docs/store-contracts.md` LedgerStore section now documents `countEvents()`, `importEvent()`, `importReceipt()`, `rotate()` (with throws clauses for both new typed errors), plus the `RotateResult` shape. Updated ownership-law line ("never deleted or modified **except via {@link rotate}**"). |
| **AGG-B1-9b** | closed | `docs/policy-and-redaction.md` "What gets redacted" list extended with `entity_name` and `artifact_filename` entries (with the rendered-label semantics spelled out: `<kind>: [REDACTED]` and `[REDACTED] v<version>`). New "Label rendering boundary" subsection ratifies the doctrine: bare ClusterKernel renders literal, PolicyEnforcedKernel re-renders with policy view at the boundary. |

## 3. New regression tests

New file: `test/wave-b1-fixup-regression.test.ts` — 34 tests covering all 17 items.

Test IDs (per describe block):
- `AGG-B1-1a — trace-builder.ts JSDoc reflects post-fixup doctrine` (2 tests)
- `AGG-B1-1b — PolicyEnforcedKernel re-renders labels via renderProvenanceLabel` (2 tests)
- `AGG-B1-2a — rotate() atomicity (persist FIRST, mutate AFTER)` (1 test)
- `AGG-B1-2b — rotate() input validation` (3 tests)
- `AGG-B1-2c — Archive directory orphan-tmp sweep at constructor` (1 test)
- `AGG-B1-2d — Future-timestamp safeguard throws typed error` (2 tests)
- `AGG-B1-3 — scripts/ no longer hardcodes db-cluster-0.1.0.tgz` (3 tests)
- `AGG-B1-4 — NDJSON tail-corruption is loud (stderr + ledger event)` (1 test)
- `AGG-B1-5 — OperationsPanel reads correct OpsModel shape` (3 tests)
- `AGG-B1-6 — doctor() invoked with dataDir + commandQueue from CLI and ops-model` (2 tests)
- `V1-B1-007 / V2-B1-011 — ops-model distinguishes runtime-error from healthy` (2 tests)
- `V3-B1-005 — ops-model has no feature-detect on countEvents` (1 test)
- `V1-B1-010 — recordOrphanMutation stderr scrub` (1 test)
- `V2-B1-006 — BUILTIN_ERROR_CODES covers PolicyConfigError + new rotate errors` (3 tests)
- `V1-B1-006 — NDJSON shape gate rejects empty id` (1 test)
- `AGG-B1-9a — docs/store-contracts.md covers new LedgerStore methods` (3 tests)
- `AGG-B1-9b — docs/policy-and-redaction.md documents new RedactionTargets` (2 tests)
- `AGG-B1-1b end-to-end — entity_name policy gate is no longer inert` (1 test)

Total **34 regression tests**, all PASS post-fix.

## 4. Post-fix-up gate state

### 3× test stability

| Run | Tests | Skipped | Failed | Files | Duration |
|---|---|---|---|---|---|
| 1 | 921 | 55 | 0 | 68 | 48.49s |
| 2 | 921 | 55 | 0 | 68 | 50.27s |
| 3 | 921 | 55 | 0 | 68 | 48.78s |

**Deterministic 921/55/0.** Test count increased by 34 (the new regression net).

### Lint

`tsc --noEmit && npm run lint:examples` — clean.

### Release-gate

`node scripts/release-gate.mjs` — **8/8 PASS** (Verdict: ready for release).

## 5. Cross-domain breadcrumbs

The coordinator should be aware:

- **OpsModel shape change** (`orphanEvents: number → number | null`). Downstream consumers other than `dashboard/components/OperationsPanel.jsx` are not in the repo (no external callers); but this is a structural surface change that downstream agents would observe. The pre-existing tests for ops-model continue to pass because the value is `0` on the success path.
- **rotate() now throws** in scenarios it previously silently no-op'd. Updated `test/wave-b1-stores-regression.test.ts` line 280-310 (`rotate() with a future timestamp throws RotateBoundaryInFutureError`). No other in-repo callers depended on the silent-no-op behaviour. Operator-facing behavioural change worth flagging in CHANGELOG when the next release lands.
- **buildOpsModel signature change** (added third optional argument). Existing call sites that pass only `(stores, kernel)` continue to compile (third arg is optional). No call sites in the repo update the dashboard side; the `BuildOpsModelOptions` type is exported for downstream callers.
- **CLI doctor invocation** now instantiates a `CommandQueue` per invocation. Constructor cost is small (one mkdir + tmp sweep); not load-bearing for the doctor command itself.
- **New typed errors** in `src/adapters/local/errors.ts`. Both extend plain `Error` (not `ClusterError`) per the existing adapter-layer convention. The MCP boundary surfaces their stable codes via the BUILTIN_ERROR_CODES additions.
- **POLICY_KERNEL_EXTRAS allowlist update** in `test/verb-parity.test.ts` — the new private `rerenderLabelsWithPolicy` method shows up on the prototype (TS-private is compile-time only) so it had to be allowlisted with a comment explaining why ClusterKernel doesn't mirror it.

## 6. Pattern-fix self-assessment

Siblings probed and their disposition:

- **rotate() input validation (AGG-B1-2b)** — only one call site in the repo (`LocalLedgerStore.rotate`). No sibling adapters yet (the in-memory ledger adapter is a no-op for rotate). When a future PostgresLedgerStore is added, the constructor-level validation pattern should be mirrored.
- **Archive directory sweep (AGG-B1-2c)** — only one sibling (the regular `cleanupOrphanTmpFiles` for events.json / receipts.json) was already in place. The new archive sweep uses an inline pattern rather than promoting to a shared helper because the archive filenames carry their own per-archive random suffix (no single base name to pass to `cleanupOrphanTmpFiles`). If a third sweep site appears (e.g. backup-archive), it would justify a shared helper.
- **NDJSON tail-corruption signal (AGG-B1-4)** — Wave A4 closed the analogous gap for `CommandQueue.load()` via `CommandQueuePersistenceLostError`. The ledger pattern differs: the ledger has prior committed events worth keeping, so we don't throw — we audit. The two patterns now form a coherent family: **CommandQueue throws on persistence loss; LedgerStore audits on tail-corruption recovery.**
- **Hardcoded version literals in scripts/ (AGG-B1-3)** — both `release-gate.mjs` and `smoke-install.mjs` now read from `package.json`. I also probed `package.json` `files` field and the `bin` paths; both already use `dist/` paths that don't carry version literals.
- **OperationsPanel shape (AGG-B1-5)** — confirmed there are no other JSX/JS files in `dashboard/` reading from `opsData.doctor` (a grep over `dashboard/` came back clean post-fix).
- **`doctor()` invocation without options (AGG-B1-6)** — probed for other invocations: `src/cli.ts:1181` (fixed), `src/dashboard/ops-model.ts:83` (fixed), `src/ops/verify.ts` doesn't call doctor, test files don't call doctor in production paths. No other operator-facing surfaces with the gap.

Family-of-call-sites probe outcome for this fix-up: **no further siblings found beyond the dispatch's stated 17 items.** The family probe extended one layer beyond the dispatch (scripts/ → already in dispatch; dashboard/ → already in dispatch) without surfacing additional fix targets.

---

Wave B1-Amend fix-up complete. Test count: 921/55/0. Closed: 17/17. Deferred: 0/17.
