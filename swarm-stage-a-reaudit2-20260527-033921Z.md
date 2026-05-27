# Dogfood Swarm Stage A Re-Audit-2 — db-cluster — 2026-05-27

**Repo:** `mcp-tool-shop-org/db-cluster`
**Working copy:** `E:/AI/db-cluster`
**Audit type:** Stage A Re-Audit (pass 3) — adversarial verification of Wave A2 corrections + standard Stage A lens
**Coordinator:** Dogfood Swarm Stage A Re-Audit-2 (5 parallel domain auditors)
**Audit date:** 2026-05-27 03:39 UTC
**Audit pass:** 3 (post-Wave A2)

---

## 1. Baseline

| Field | Value |
|---|---|
| Pre-reaudit-2 HEAD SHA | `d1c4e1e` (`Add Stage A re-audit + Wave A2 amend reports`) |
| Branch | `main` (4 commits ahead of `origin/main` — un-pushed) |
| Working tree | clean |
| Save points present | `swarm-stage-a-save-1779834974` (pre-audit), `swarm-stage-a-amend-1779837797` (pre-Wave-A1), `swarm-stage-a-reaudit-1779843973` (pre-reaudit-1), `swarm-stage-a-amend-a2-1779846139` (pre-Wave-A2), `swarm-stage-a-reaudit2-1779851320` (pre-reaudit-2, new) |
| `npm run lint` | PASS — 0 errors (src/ + examples/) |
| `node scripts/release-gate.mjs` | **PASS — all 6 stages green** |
| Test suite (per release-gate stage 2) | PASS (post-A2 documented count: 640 passed / 53 skipped / 0 failed across 59 files) |

Baseline drift from Wave A2 amend report: **none.** Re-audit-2 started from the documented post-A2 state.

---

## 2. Severity rollup

### Raw (per-domain)

| Domain | CRITICAL | HIGH | MEDIUM | LOW | Total |
|---|---:|---:|---:|---:|---:|
| Kernel | 0 | 3 | 5 | 3 | 11 |
| Stores | 0 | 2 | 2 | 6 | 10 |
| Surface | 0 | 3 | 6 | 4 | 13 |
| Tests | 0 | 0 | 4 | 4 | 8 |
| CI/Docs | 0 | 0 | 3 | 8 | 11 |
| **TOTAL (raw)** | **0** | **8** | **20** | **25** | **53** |

### De-duplication

| Pair | Action |
|---|---|
| `KERNEL-R2-003` ≡ `STORES-R2-001` (performIndexRebuild non-atomic) | merge to 1 HIGH |
| `TESTS-R2-003` (MEDIUM) ≡ `SURFACE-R2-012` (LOW) (no cluster_resolve sanitization test) | merge — drop SURFACE-R2-012 LOW |
| `STORES-R2-003` (MEDIUM) ≡ `KERNEL-R2-009` (LOW) (verify() lacks mutation_orphaned check) | merge — drop KERNEL-R2-009 LOW |

### Unique (after de-dup)

| Severity | Count | Change vs re-audit-1 |
|---|---:|---|
| CRITICAL | **0** | flat (re-audit-1 was 0) |
| HIGH | **7** | down from 14 (50% reduction) |
| MEDIUM | **20** | down from 23 |
| LOW | **23** | down from 29 |
| **TOTAL** | **50** | down from 67 (-25%) |

**Regressions-of-A2:** **1** (`KERNEL-R2-003` ≡ `STORES-R2-001`)

**Stage A exit gate (0 CRITICAL + 0 HIGH + 0 regressions-of-A2): NOT MET.**

Continued convergence trend (audit-1: 28 CRITICAL+HIGH → re-audit-1: 15 unique HIGH → re-audit-2: 7 unique HIGH). Diminishing returns as expected from a corrective wave.

---

## 3. Invariant assessment matrix (post-Wave-A2)

| # | Invariant | Audit-1 | Re-audit-1 | Re-audit-2 | Change |
|---|---|---|---|---|---|
| 1 | No mutation without command | BYPASSED | PARTIAL (CLI `_kernel` bypass) | **PARTIAL — `ingest_artifact` via `proposeMutation`+`commitMutation` silently corrupts content (Buffer JSON round-trip) — KERNEL-R2-007** | CLI bypass closed; lifecycle write-path corruption surfaces |
| 2 | Index is derivative, never authoritative — atomic swap | HOLDS (partial) | HOLDS (improved) | **PARTIAL — ops/rebuild.ts atomic; `ClusterKernel.performIndexRebuild()` (used by commitMutation `'reindex'` AND `rebuildIndex` helper) still uses `clear()+index()` loop — empty-window survives — KERNEL-R2-003 / STORES-R2-001** | Regression — A2 wired reindex arm to the stale helper |
| 3 | Redaction applied on every read path | SEVERELY BYPASSED | PARTIAL (4 new policy-layer leaks) | **PARTIAL — `traceProvenance` returns un-redacted actorIds (KERNEL-R2-004); SDK.resolve sanitizes only 2 of 5 store types (SURFACE-R2-003); CLI `resolve` bypasses policy entirely (SURFACE-R2-001); `inspectCommand` existence oracle (KERNEL-R2-001)** | Headline closed; perimeter holes remain |
| 4 | Artifact content boundary in MCP | BYPASSED | PARTIAL (sanitizeEntity/Receipt DEAD CODE) | **PARTIAL — CLI `resolve` returns raw artifact with `storagePath` (SURFACE-R2-001); MCP `cluster_resolve` ledger/receipt branches return raw (SURFACE-R2-003)** | sanitizers wired in MCP; CLI + non-artifact paths still leak |
| 5 | SQL parameterized | HOLDS (no test net) | HOLDS (Postgres-gated tests added) | HOLDS (Postgres adapter still static-read only — §9) | flat |
| 6 | Artifact storagePath sandboxed | BYPASSED via importSnapshot | HOLDS (`getContent()` skip — STORES-R005) | HOLDS (importSnapshot validated, `getContent()` validates) | improved |
| 7 | Backup/restore integrity | BYPASSED | PARTIAL (Phase 12 Proof 12 used `doctor()` — STORES-R001) | **PARTIAL — Proof 12 fixed (uses `verify()` + ID round-trip); but `importSnapshot`/`importEvent`/`importReceipt` still OPTIONAL on contracts (runtime-mandatory, compile-time-optional — STORES-R2-002)** | Headline closed; type-safety gap newly surfaced |
| 8 | Receipt completeness | PARTIAL (orphan-mutation window) | PARTIAL (try/catch in place, `link_evidence` partial state) | **PARTIAL — `link_evidence` evidence_linked write OUTSIDE outer try/catch creates irrecoverable partial-orphan state (KERNEL-R2-005); no `ops/` consumer of `mutation_orphaned` (STORES-R2-003); ReceiptFailedError test does not assert dirty-store side (TESTS-R2-001)** | Observability + test gaps remain |
| 9 | Command lifecycle invalid transitions | PARTIAL (SDK auto-walk defeats) | PARTIAL (KERNEL-R002) | **PARTIAL — SDK auto-walk REMOVED (KERNEL-R002 closed); CLI commit still auto-walks under `--self-approve` flag using same actor (SURFACE-R2-006)** | SDK fixed; CLI flag reintroduces same shape |
| 10 | CommandQueue freshness vs atomicity | PARTIAL | REGRESSION (KERNEL-R001 elevated to HIGH) | **HOLDS — `command-queue.ts` now atomic tmp+rename + `CommandQueueCorruptError`** | Closed |
| 11 (new) | `verify()` accurately reports cluster health | n/a | n/a | **BROKEN — counts command_approved/rejected/mutation_committed (subjectStore='ledger') events as orphan subjects → any production cluster with approved commands reports `stale` falsely (KERNEL-R2-002). Phase 12 Proof 12 escapes because test uses helper paths (no approveMutation)** | Newly probed; fails |

---

## 4. CRITICAL findings (0)

**None.** Re-audit-2 found no new CRITICALs. Wave A1 closed all 8 Audit-1 CRITICALs; Wave A2 introduced no new ones.

---

## 5. HIGH findings (7 unique)

### KERNEL-R2-001 — `inspectCommand` is a command-existence oracle for denied principals
**File:** `src/kernel/policy-enforced-kernel.ts:465`
**Regression class:** new
**Description:** `inspectCommand` fetches the command via `this.kernel.inspectCommand(commandId)` BEFORE calling `enforce()`. If the command does not exist, `NotFoundError` is thrown before the policy gate runs. A policy-denied principal who supplies a valid commandId receives `PolicyDeniedError`; for a nonexistent commandId they receive `NotFoundError`. Denied principals can enumerate which commandIds exist vs do not exist by observing the error type. By contrast, `inspectEntity` (line 139) correctly calls `enforce()` first. The ordering was introduced in the KERNEL-R006 fix which needed the command's verb to populate the policy context — the fix chose fetch-then-enforce but this leaks existence.
**Recommendation:** Enforce first with ownerStore-only context, then fetch, then optionally refine with commandVerb for per-verb scoping. Or: catch `NotFoundError` from `kernel.inspectCommand` and convert to `PolicyDeniedError` when policy denies, collapsing the two observable error states.
**Evidence:** `policy-enforced-kernel.ts:465` — `this.kernel.inspectCommand(commandId)` throws `NotFoundError` before `enforce()` at line 466. `cluster-kernel.ts:794-797` — `inspectCommand` throws `NotFoundError` on miss. `policy-enforced-kernel.ts:139-143` — `inspectEntity` calls `enforce()` before `kernel.inspectEntity()`.

### KERNEL-R2-002 — `verify()` false-flags every production cluster with approved commands as degraded
**File:** `src/ops/verify.ts:97`
**Regression class:** new
**Description:** `verify()`'s `provenance_references_valid` check iterates ALL ledger events and checks `canonical.exists(subjectId) || artifact.exists(subjectId)` for each, without filtering by `subjectStore`. Events with `subjectStore='ledger'` — `command_approved`, `command_rejected`, `mutation_committed` (when `targetStore='ledger'`), `mutation_orphaned`, `command_compensated` — have `subjectId` = a commandId UUID not stored in canonical or artifact. These are always counted as orphans, causing `verify()` to report `status:'stale'` for any cluster that has used `approveMutation`, `rejectMutation`, or `compensateMutation`. Phase 12 Proof 12 escapes this because the test setup uses helper paths (`ingestArtifact`, `createEntity`) that never call `approveMutation` — so no `command_approved` events exist and the test passes. In any real production cluster `verify()` will return falsely degraded.
**Recommendation:** Filter the orphan check to events where `event.subjectStore === 'canonical' || event.subjectStore === 'artifact'`. Events with `subjectStore='ledger'` or `'index'` reference command/index IDs by design — their reachability is not verifiable via `canonical.exists()` or `artifact.exists()`. Add a comment documenting this exclusion. Add a regression test that approves a command and asserts `verify()` returns `healthy`.
**Evidence:** `verify.ts:97-104` — loops all events, no `subjectStore` filter. `cluster-kernel.ts:673-679` — `approveMutation` writes `recordProvenance` with `subjectStore='ledger'`, `subjectId=commandId`. `cluster-kernel.ts:604-611` — `mutation_committed` uses `subjectStore=readyCommand.targetStore` (can be `'ledger'` for compensate). `phase12-proof.test.ts:47-63` — setup uses `kernel.ingestArtifact` + `kernel.createEntity` (helpers), never `approveMutation`.

### KERNEL-R2-003 ≡ STORES-R2-001 — `ClusterKernel.performIndexRebuild()` still uses non-atomic `clear()+index()` loop (REGRESSION-OF-A2)
**Files:** `src/kernel/cluster-kernel.ts:821`
**Regression class:** **regression-of-A2**
**Description:** Wave A2 added `replaceAll()` as a REQUIRED method on the `IndexStore` contract (STORES-R003) and `ops/rebuild.ts` correctly uses it. KERNEL-R008 wired the `'reindex'` commitMutation arm to call `performIndexRebuild()` — but that helper was not updated to use `replaceAll()`. The helper still calls `this.stores.index.clear()` then loops `index()` calls. As a result: (a) `commitMutation('reindex')` — now enabled by KERNEL-R008 — uses the non-atomic empty-window path. (b) `ClusterKernel.rebuildIndex()` helper (used in Phase 12 tests and exposed via `PolicyEnforcedKernel`) also uses the non-atomic path. The STORES-008 empty-window bug effectively survives for the kernel rebuild path. The KERNEL-R008 amend description claimed "single mutation_committed receipt path" but introduced the empty-window regression by routing through the stale helper. `ops/rebuild.ts` is now dead code for the kernel-triggered rebuild path.
**Recommendation:** Update `performIndexRebuild()` to mirror `ops/rebuild.ts`: (1) stage all records in memory (entities loop + artifacts loop), (2) call `this.stores.index.replaceAll(staged)` as a single atomic operation. The contract guarantees `replaceAll` exists, so no duck-typed check is needed. Delete the JSDoc "out of scope for the kernel agent" caveat that flagged STORES-008 as out-of-scope.
**Evidence:** `cluster-kernel.ts:817-855` — `performIndexRebuild()` calls `this.stores.index.clear()` at line 821 then loops `index()` at lines 828 + 840. `ops/rebuild.ts:104-108` — correct pattern: `await stores.index.replaceAll(staged)`. `contracts/index-store.ts:25` — `replaceAll` is required (no `?`). Wave A2 amend report §2 KERNEL-R008 — "commitMutation reindex arm now calls performIndexRebuild()" — `performIndexRebuild` itself not audited for the old pattern.

### STORES-R2-002 — `importSnapshot` / `importEvent` / `importReceipt` are runtime-mandatory but compile-time-optional
**Files:** `src/contracts/artifact-store.ts:17`, `src/contracts/canonical-store.ts:25`, `src/contracts/ledger-store.ts:25`, `src/contracts/ledger-store.ts:31`
**Regression class:** new
**Description:** Wave A2 promoted `IndexStore.replaceAll` to a REQUIRED contract method (STORES-R003) — the same promotion was NOT applied to the three backup-critical import hooks. `backup.ts::restore()` treats all four as mandatory at runtime (throws `ImportSnapshotNotSupportedError` when missing), but the contract interfaces declare them OPTIONAL (with `?`). Any developer implementing a new `ArtifactStore`, `CanonicalStore`, or `LedgerStore` compiles cleanly without implementing any import hook — TypeScript emits no error. The first `restore()` attempt on their store then fails at runtime with an unexpected exception. This is the same duck-typed fragility that STORES-R003 was supposed to eliminate, reproduced across three contracts. The `canonical-store.ts:14` JSDoc even says "Optional on the contract because not every adapter must support it today" — but `backup.ts` has already decided it is mandatory.
**Recommendation:** Promote `importSnapshot` on `ArtifactStore` and `CanonicalStore` to required (remove `?`). Promote `importEvent` and `importReceipt` on `LedgerStore` to required (remove `?`). Update JSDoc on `canonical-store.ts:14` to remove the "optional" framing. If there is a genuine need for read-only adapters, introduce a separate `RestorableStore` interface rather than silently allowing the omission.
**Evidence:** `src/contracts/artifact-store.ts:17` — `importSnapshot?(metadata: Artifact, content: Buffer): Promise<Artifact>`. `src/contracts/canonical-store.ts:25` — `importSnapshot?(entity: Entity): Promise<Entity>`. `src/contracts/ledger-store.ts:25` — `importEvent?(event: ProvenanceEvent): Promise<ProvenanceEvent>`. `src/contracts/ledger-store.ts:31` — `importReceipt?(receipt: Receipt): Promise<Receipt>`. `src/contracts/index-store.ts:25` — `replaceAll(...): Promise<void>` (correctly required). `src/ops/backup.ts:113-115` — runtime duck-type check + throw.

### SURFACE-R2-001 — CLI `resolve` command bypasses policy enforcement entirely (re-introduces SURFACE-001 leak at CLI)
**File:** `src/cli.ts:575`
**Regression class:** new
**Description:** The CLI `resolve` subcommand constructs a raw `ClusterResolver` (`new ClusterResolver(stores)`) at lines 583-596 and outputs `resolved.object` via `JSON.stringify` with no sanitization. For artifact URIs, `storagePath` (absolute filesystem path to the content blob) is printed verbatim. For canonical URIs, the raw `Entity` with all attributes is printed. For ledger URIs, the full `ProvenanceEvent` including `detail.payload` is printed. No policy enforcement, no redaction, no sanitizer. This path is completely independent of `getKernel()` — even when `.db-cluster/policies.json` is configured and `getKernel()` would return `PolicyEnforcedKernel`, this command silently uses raw stores. This reintroduces the SURFACE-001 `storagePath` leak at the CLI surface, which Wave A1/A2 closed only at the MCP and SDK surfaces.
**Recommendation:** Route `cli.ts resolve` through `getKernel().resolve()` (or `sdk.resolve()`) which applies policy enforcement and sanitization. Alternatively, apply `sanitizeArtifactForOutput` and `sanitizeEntityForOutput` before `JSON.stringify` output. The command needs to respect the same policy wrapper the rest of the CLI uses.
**Evidence:** `src/cli.ts:583-596` — `const stores = createLocalCluster(CLUSTER_DIR); const resolver = new ClusterResolver(stores); const resolved = await resolver.resolve(uri); console.log(JSON.stringify(resolved.object, null, 2))`. No call to `getKernel()`, no sanitizer, no policy check. Contrast with every other CLI command that calls `getKernel()`.

### SURFACE-R2-002 — `DB_CLUSTER_POLICIES_FILE` path sandbox blocks dotdot but not symlinks
**File:** `src/mcp/server.ts:95`
**Regression class:** partial-of-known (re-audit-1 SURFACE-R006 closure incomplete)
**Description:** `DB_CLUSTER_POLICIES_FILE` path sandbox uses string-prefix check but does not use `realpath()` — symlink traversal escapes the sandbox. Line 95-96: `const resolvedPath = resolve(allowedRoot, policiesFile); if (!resolvedPath.startsWith(allowedRoot + sep))`. Node's `resolve()` lexically resolves path segments (collapses `..`) but does NOT dereference symlinks. A symlink at `<cwd>/policies.json` pointing to `/etc/passwd` would produce `resolvedPath = <cwd>/policies.json` which passes the `startsWith` check. The MCP server then reads the arbitrary file. SURFACE-R006 was marked "fixed" in Wave A2 but the fix is incomplete — it blocks traversal-via-dotdot but not traversal-via-symlink. Re-audit-1 specifically noted "path-traversal primitive into any readable file"; symlink is a path-traversal primitive.
**Recommendation:** Apply `fs.realpathSync(resolvedPath)` after the lexical resolve, and then repeat the `startsWith(allowedRoot + sep)` check against the real (dereferenced) path. Handle `ENOENT` from `realpathSync` (file doesn't exist yet). This two-step approach blocks both dotdot traversal and symlink traversal.
**Evidence:** `src/mcp/server.ts:94-96` — `const resolvedPath = resolve(allowedRoot, policiesFile); if (resolvedPath !== allowedRoot && !resolvedPath.startsWith(allowedRoot + sep))`. No import of `realpathSync` or `realpath` anywhere in `server.ts`. `import { resolve, sep } from 'node:path'` — path module only, no fs for realpath.

### SURFACE-R2-003 — SDK.resolve sanitization covers only 2 of 5 store types
**File:** `src/sdk/cluster-sdk.ts:194`
**Regression class:** partial-of-known (re-audit-1 SURFACE-R003 closure incomplete)
**Description:** SDK.resolve() sanitization covers only `artifact` and `canonical` store types — `ledger` (ProvenanceEvent), `index` (IndexRecord), and `receipt` store objects are returned raw even when `policyEnforced===true`. The resolver can return 5 store types: `canonical`, `artifact`, `index`, `ledger`, `receipt` (see `cluster-resolver.ts:13-18`). SDK.resolve at lines 196-203 only branches on `resolved.store === 'artifact'` and `resolved.store === 'canonical'`. A ledger-URI resolve (`cluster://ledger/<id>`) returns a raw `ProvenanceEvent` with `actorId`, `detail.commandVerb`, `detail.payload` — leaking command internals. A receipt-URI resolve returns a raw `Receipt` with `resultSummary` (which can contain entity names — the same issue KERNEL-R007 fixed for `listReceipts`). MCP `server.ts:509-531` `cluster_resolve` has the same incomplete coverage. SURFACE-R003 was marked "fixed" in Wave A2 but the fix is incomplete — only 2 of 5 store types are covered.
**Recommendation:** Add sanitization branches for `ledger` (apply `redactProvenanceEvent` or strip `detail`), `receipt` (apply `sanitizeReceiptForOutput` or equivalent), and `index` (strip `metadata` that mirrors entity content). MCP server.ts `cluster_resolve` handler needs the same additions. Cross-check with KERNEL-R007 / KERNEL-R004 for consistency.
**Evidence:** `src/sdk/cluster-sdk.ts:196-204` — only `artifact` and `canonical` branches in `policyEnforced` block. `src/resolver/cluster-resolver.ts:71-99` — `resolveFromParsed` has 5 cases. `src/mcp/server.ts:519-530` — MCP `cluster_resolve` also only sanitizes `artifact` and `canonical`.

---

## 6. MEDIUM findings (20 unique) — one-line each

### Kernel (5)

- **KERNEL-R2-004** — `traceProvenance` returns raw `ProvenanceEvent[]` without per-event redaction; `provenance_actors` rules fire on `traceObject` graph but NOT on the flat event list — `src/kernel/policy-enforced-kernel.ts:645`.
- **KERNEL-R2-005** — `link_evidence` switch arm writes `recordProvenance('evidence_linked')` OUTSIDE the outer try/catch; post-switch failure produces `evidence_linked` event without receipt — irrecoverable partial-orphan state TraceBuilder sees as linked but verify() can't detect — `src/kernel/cluster-kernel.ts:560`.
- **KERNEL-R2-006** — `redactProvenanceEvent` strip behavior emits `actorId=''` (empty string, falsy) instead of `REDACTED`; `command_payload` branch only deletes `payload`/`commandId`, leaks entity-identifying `detail.kind`/`detail.entityId`/`detail.name` — `src/policy/redactor.ts:154`.
- **KERNEL-R2-007** — `ingest_artifact` commitMutation arm casts `payload.content as Buffer`; Buffer doesn't survive CommandQueue JSON round-trip → silently corrupts content on `proposeMutation`+`commitMutation` lifecycle path — `src/kernel/cluster-kernel.ts:518`.
- **KERNEL-R2-008** — `detail.targetStore` cast in `retrieveBundle` provenanceEvents filter (KERNEL-R004 fix) has no value validation — attacker-controlled string passes type check, may misfire `matchStores` default-allow — `src/kernel/policy-enforced-kernel.ts:337`.

### Stores (2)

- **STORES-R2-003** (≡ KERNEL-R2-009 LOW) — `verify()`/`doctor()`/`provenance-check`/`receipt-check` have ZERO consumers of `mutation_orphaned` events; clusters with N orphaned mutations report `healthy` — health model blind to KERNEL-R009 fix's primary observability signal — `src/ops/verify.ts:94`.
- **STORES-R2-004** — `TraceBuilder.eventToEdgeType` has no case for `'mutation_orphaned'` action → falls through to `'entity_created_by'` default. Trace consumers see misleading "entity created by X" for actual orphan events. KERNEL-R012 from re-audit-1 unfixed — `src/provenance/trace-builder.ts:425`.

### Surface (6)

- **SURFACE-R2-004** — `INTERNAL_TRUSTED_PRINCIPAL` silent fallback (SDK constructor with `policies` but no `principal`) — no warning, deployment ships policies but forgets a principal → silent cluster-admin. SURFACE-R012 from re-audit-1 still applies — `src/sdk/cluster-sdk.ts:136`.
- **SURFACE-R2-005** — `ingestRepoKnowledge` artifact write still uses `kernel.ingestArtifact()` (helper); `warnIfNoPolicy` is soft (console.warn only), does not fail closed when caller passes raw `ClusterKernel` — same shape as KERNEL-R003/SURFACE-R001 regression — `src/integrations/repo-knowledge/ingest.ts:101`.
- **SURFACE-R2-006** — CLI `commit` subcommand still auto-walks `validate→approve→commit` under `--self-approve` flag using single actor — reintroduces the KERNEL-R002 separation-of-duties bypass at the CLI layer that the SDK auto-walk removal closed — `src/cli.ts:356`.
- **SURFACE-R2-007** — `DB_CLUSTER_PRINCIPAL` `validatePrincipal` does not check `roles.length > 0`; empty roles array accepted, produces silently no-match principal. Also no allowed-value check on role strings — `src/mcp/server.ts:48`.
- **SURFACE-R2-008** — `policyEnforced: boolean` is `public readonly` on `ClusterSDK` — SURFACE-R009 from re-audit-1 still public. Probing signal + risk of conditional code paths that bypass enforcement — `src/sdk/cluster-sdk.ts:117`.
- **SURFACE-R2-009** — `dashboard/index.html` ESM-imports `./lib/apply-redaction.js` async; Babel-transformed components load synchronously and may call `window.applyRedaction` before the ESM resolves → undefined function race — `dashboard/index.html:188`.

### Tests (4)

- **TESTS-R2-001** — `ReceiptFailedError` test in new `typed-error-regression.test.ts` proves error type + orphan event emission but does NOT assert `canonical.list()` contains the orphaned entity — the "store is dirty" half of KERNEL-005 invariant unproven — `test/typed-error-regression.test.ts:44`.
- **TESTS-R2-002** — No unit test for `LocalCanonicalStore.importSnapshot` entity-ID preservation. Only end-to-end via phase12-proof. Regression to randomized IDs caught only if backup/restore runs — `test/typed-error-regression.test.ts:14`.
- **TESTS-R2-003** (≡ SURFACE-R2-012 LOW) — No test calls `handleTool('cluster_resolve', artifact-uri)` and asserts `result.object.storagePath === undefined`. wave6-proof:245 only exercises error path. SURFACE-R008 from re-audit-1 unfixed for MCP artifact-resolve path — `test/wave6-proof.test.ts:245`.
- **TESTS-R2-004** — Restricted-principal SDK e2e test (`policy-surface.test.ts:371`) does not assert seeding succeeded before asserting filtering. If seeding fails silently, the "filters to 0 entities" assertion trivially passes false-positive — `test/policy-surface.test.ts:376`.

### CI/Docs (3)

- **CIDOCS-R2-001** — `docs/sdk.md:76-79` shows `bundle.confidence`/`bundle.gaps`/`bundle.staleRecords` — none exist on `EvidenceBundle` (actual: `confidenceBoundaries`/`missingContext`/`freshness.staleCount`). CIDOCS-R014 from re-audit-1 unfixed — `docs/sdk.md:76`.
- **CIDOCS-R2-002** — `README.md:58`, `docs/release-notes-v0.1.md:94`, `docs/phase-15-closeout.md:44` claim `623+` tests across 58 files; actual post-A2 is `640 / 59 files`. A2 amend report's own §3 documents 640 but docs were updated to pre-A2 number — `README.md:58`.
- **CIDOCS-R2-003** — `docs/sdk.md:222, 233` policyExplain/policyTest examples pass `principal: {..., capabilities: ['read']}` — `capabilities` field does not exist on `Principal` interface. CIDOCS-R003 sweep fixed prose but missed code-example blocks — `docs/sdk.md:222`.

---

## 7. LOW findings (23 unique) — one-line each

### Kernel (2)

- **KERNEL-R2-010** — `CommandQueueCorruptError.message` and `ReceiptFailedError.message` (which chains `cause.message`) embed full filesystem paths verbatim — log/error-boundary leaks filesystem layout. KERNEL-R010 from re-audit-1 unchanged — `src/kernel/errors.ts:83`.
- **KERNEL-R2-011** — `CommandVerb` union includes `'propose_mutation'`; `commitMutation` switch has no case → silent auto-reject via `'Unknown verb'` default arm. KERNEL-R016 from re-audit-1 unchanged — `src/types/command.ts:62`.

### Stores (6)

- **STORES-R2-005** — `LocalArtifactStore.ingest()` writes content via plain `writeFileSync(contentPath, input.content)` at line 99 — no atomic tmp+rename and no error handling. Asymmetric with metadata persist (atomic). Crash mid-write leaves orphan content file unreferenced — `src/adapters/local/local-artifact-store.ts:99`.
- **STORES-R2-006** — Tokenizer strips Unicode combining marks (`\p{M}`) → NFD-decomposed `café` tokenizes to `cafe`. STORES-R010 from re-audit-1 unfixed — `src/indexing/tokenizer.ts:21`.
- **STORES-R2-007** — All local adapters use fixed `${filePath}.tmp` suffix → multi-process race; no startup cleanup of orphan .tmp files. STORES-R009 from re-audit-1 unchanged — `src/adapters/local/local-*-store.ts`.
- **STORES-R2-008** — `importEvent`/`importReceipt` silent first-write-wins on duplicate ID; content not compared — tampered backup with matching ID hidden silently. STORES-R011 from re-audit-1 unchanged; new `typed-error-regression` tests idempotency but not differing-content conflict — `src/adapters/local/local-ledger-store.ts:117`.
- **STORES-R2-009** — No test exercises `kernel.rebuildIndex()` empty-window invariant. Would have caught STORES-R2-001/KERNEL-R2-003 — `src/kernel/cluster-kernel.ts:862`.
- **STORES-R2-010** — No test verifies `verify()` reports degraded after `mutation_orphaned` events exist. Would catch STORES-R2-003 regression — `src/ops/verify.ts:94`.

### Surface (3 — SURFACE-R2-012 absorbed into TESTS-R2-003)

- **SURFACE-R2-010** — `dashboard/lib/apply-redaction.d.ts` imports from `'../../dist/dashboard/dashboard-model.js'`. Resolves for npm consumers (dist/ ships) but not for contributors before `npm run build`. Partial CIDOCS-R001 fix — `dashboard/lib/apply-redaction.d.ts:8`.
- **SURFACE-R2-011** — `KernelLike` Pick on SDK exposes only 12 of ~22 `ClusterKernelInterface` verbs (no `ingestArtifact`, `createEntity`, `traceBundle`, etc. via SDK) — SDK is not a complete facade — `src/sdk/cluster-sdk.ts:40`.
- **SURFACE-R2-013** — Inaccurate comment at `src/integrations/repo-knowledge/ingest.ts:239` claims "policy gate fires for both ClusterKernel and PolicyEnforcedKernel callers" — false for raw `ClusterKernel` — `src/integrations/repo-knowledge/ingest.ts:239`.

### Tests (4)

- **TESTS-R2-005** — `typed-error-regression.test.ts` `CorruptStoreError` tests cover only `LocalCanonicalStore` + `LocalIndexStore`; missing `LocalLedgerStore` + `LocalArtifactStore`. Regression to those try/catch blocks invisible — `test/typed-error-regression.test.ts:99`.
- **TESTS-R2-006** — `makePolicyKernel`/`seedKernel` pattern attaches admin kernel as `__admin` hidden property via `(restricted as unknown as ...)` cast — bypasses TypeScript, invisible to readers, `verb-parity.test.ts POLICY_KERNEL_EXTRAS` allowlist won't catch — `test/policy-kernel.test.ts:246`.
- **TESTS-R2-007** — `wave6-policy-proof.test.ts:687` index-derivation test pivoted from `adminK._kernel.findSources()` to `stores.index.search()` — now only proves doctrine, not admin-visible surface behavior — `test/wave6-policy-proof.test.ts:687`.
- **TESTS-R2-008** — Re-audit-1 §9 gap "Dashboard React not rendered in JSDOM" — Wave A2 closed SURFACE-R010 (inline JSX deleted) but no JSDOM render test added. Static-read confidence only — `test/(multiple)`.

### CI/Docs (8)

- **CIDOCS-R2-004** — `docs/sdk.md:19-21` "When `policies` is omitted the SDK uses a raw `ClusterKernel`" — technically correct but compounds CIDOCS-R2-001/R2-003 content errors — `docs/sdk.md:19`.
- **CIDOCS-R2-005** — `smoke-install.yml` `pull_request: paths: ['package.json']` only fires when package.json changes; src/ regressions without version bump not pre-tag-tested. Documented limitation — `.github/workflows/smoke-install.yml:5`.
- **CIDOCS-R2-006** — `scripts/release-gate.mjs:69` uses `readdirSync(dir, {recursive: true})` — Node 18.17+ only; `package.json` has no `engines` field — would TypeError on Node 18.0-18.16 — `scripts/release-gate.mjs:64`.
- **CIDOCS-R2-007** — CI matrix has no `macos-latest`, no Node 24 — CIDOCS-R010 from re-audit-1 unfixed — `.github/workflows/ci.yml:12`.
- **CIDOCS-R2-008** — Three loose `.txt` files at repo root: `AI Safe Data Control Plane over Fed.txt`, `Is it true that AI has a hard time.txt`, `phase map.txt`. CIDOCS-R012 from re-audit-1 + CIDOCS-009 from Audit-1 still present.
- **CIDOCS-R2-009** — `package.json` has no `prepublishOnly` script — `npm publish` not gated on `release-gate.mjs`. CIDOCS-R011 from re-audit-1 + CIDOCS-011 from Audit-1 still present — `package.json:43`.
- **CIDOCS-R2-010** — `docs/release-readiness.md:70-74` "tag is already published, roll back by publishing a patch" — imprecise; tag can be deleted before `npm publish`. Two cases conflated — `docs/release-readiness.md:54`.
- **CIDOCS-R2-011** — Observation only: all 3 workflows have correct `permissions: contents: read` posture; no action needed. Closure note — `.github/workflows/ci.yml:3`.

---

## 8. Cross-cutting themes

1. **The Wave A2 meta-pattern recurs at a lower abstraction level.** Re-audit-1 surfaced "fix landed at type/wrapper layer; call sites not migrated." Wave A2 closed those, but reproduced the pattern one level down: (a) KERNEL-R008 routed `commitMutation('reindex')` through `performIndexRebuild()` — but the helper itself was not updated to use the newly-required `replaceAll()` contract method (KERNEL-R2-003 / STORES-R2-001). (b) STORES-R003 promoted `IndexStore.replaceAll` to required — but the three other backup-critical contract methods (`importSnapshot` × 2, `importEvent`, `importReceipt`) were not promoted (STORES-R2-002). (c) SURFACE-R003 added `SDK.resolve` sanitization — but only for 2 of 5 store types (SURFACE-R2-003). (d) SURFACE-R004 wired sanitizers at MCP boundaries — but CLI `resolve` constructs raw `ClusterResolver`, bypassing the entire policy stack (SURFACE-R2-001). The dominant theme is identical to re-audit-1; the layer is one rung lower.

2. **`verify()` is the load-bearing health signal — and it is now structurally wrong.** KERNEL-R2-002 shows `verify()`'s `provenance_references_valid` check counts `command_approved`/`mutation_committed` events with `subjectStore='ledger'` as orphan subjects (since they reference commandIds not stored in canonical/artifact). Any production cluster with approved commands reports `stale`. Phase 12 Proof 12 escapes only because the test uses helper paths that skip `approveMutation`. Combined with STORES-R2-003 (`verify()` has no signal for `mutation_orphaned`), the central health-status API is both falsely degraded for normal clusters AND blind to the most critical degradation mode. This is a regression-level concern, not a polish concern.

3. **Edge cases in the policy-layer per-object scoping cluster (Wave A2's headline fix area) survive in three places.** KERNEL-R004 closed `retrieveBundle` provenance event filtering — but introduced KERNEL-R2-008 (unvalidated `detail.targetStore` cast). KERNEL-R005 added `redactProvenanceEvent` — but it has KERNEL-R2-006 issues (empty-string actorId, missed entity-identifying detail fields). KERNEL-R006 wired `inspectCommand` with context — but introduced KERNEL-R2-001 (fetch-before-enforce existence oracle). Each fix is structurally correct but exposed a new gap one step away.

4. **The CLI surface is now the relative weak link.** SURFACE-R2-001 (CLI `resolve` bypass) and SURFACE-R2-006 (CLI `commit --self-approve` auto-walk) show the CLI received less rigorous treatment than the SDK and MCP. The CLI is the operator-facing surface; these gaps are user-visible. The auto-walk gap effectively reintroduces what KERNEL-R002 closed at the SDK layer.

5. **Path-traversal defense is structurally incomplete.** SURFACE-R2-002 shows `DB_CLUSTER_POLICIES_FILE` sandbox blocks dotdot via lexical `resolve()` but does not use `realpath()` — symlinks escape. SURFACE-R006 was marked closed in Wave A2; this is the half-fix shape (closed one threat model, not the canonical one).

6. **5 typed errors now have regression tests — but one of the most important (`ReceiptFailedError`) only proves half the invariant.** TESTS-R2-001 notes the `typed-error-regression.test.ts` `ReceiptFailedError` test confirms error type + orphan event emission but does not assert `canonical.list()` contains the orphaned entity. The "store retains the change while no receipt is emitted" invariant is half-tested. A regression that rolls back the store write before throwing would silently pass. TESTS-R2-005 separately notes `CorruptStoreError` coverage is 2 of 4 local stores.

7. **`mutation_orphaned` is the load-bearing observability signal — and nothing consumes it.** KERNEL-R009 fix emits these events on receipt failure. STORES-R2-003 confirms: `ops/verify.ts`, `ops/doctor.ts`, `ops/provenance-check.ts`, `ops/receipt-check.ts` have zero references to `mutation_orphaned`. STORES-R2-010 confirms no test asserts `verify()` flags degraded after orphan emission. The fix emits a signal that nothing listens to.

8. **Doc-drift accumulated despite the Wave A2 sweeps.** CIDOCS-R2-002 shows README/release-notes/phase-15-closeout document `623+` tests; actual is `640`. CIDOCS-R2-001/R2-003 show `docs/sdk.md` examples reference fields that don't exist on `EvidenceBundle` and use invented `capabilities` field on `Principal`. The CIDOCS-R002/R003 sweep fixed prose but missed example code blocks.

9. **The fork-PR / runtime fuzz / JSDOM render gaps from re-audit-1 §9 remain unaddressed.** Wave A2 added defense-in-depth (permissions blocks, sanitize wiring) but no live-test infrastructure. Confidence on Postgres concurrent restore (STORES-R006), MCP server fuzz (SURFACE-R2-002), dashboard JSX rendering (TESTS-R2-008) is static-read only.

---

## 9. Audit confidence gaps

| Gap (from re-audit-1 §9) | Status after Wave A2 |
|---|---|
| Postgres adapter — no live pool | **still gap** — STORES-R006 (TOCTOU) reasoned from code; ON CONFLICT correctness static-read confidence only |
| MCP server runtime not exhaustively fuzzed | **still gap** — SURFACE-R2-002 (symlink) reasoned from code; no live test |
| Dashboard React not rendered in JSDOM | **still gap** — SURFACE-R2-009 (ESM race) + SURFACE-R010 fix verification static-read only |
| CI workflows not run against fork-PR scenario | **still gap** — CIDOCS-R006 closed via permissions block addition, but fork-PR threat model untested |
| 12 cascading test fixes spot-checked, not exhaustively re-read | **partially closed** — Wave A2 spawned ~30 new cascading fixes; spot-checked again, no semantic break found, but not exhaustive |

### New confidence gaps (from re-audit-2)

- **`verify()` not exercised against a real lifecycle** — KERNEL-R2-002 inferred from code; no test exists that runs a full propose→validate→approve→commit lifecycle then calls `verify()` and asserts `healthy`. Either the bug was always there and tests didn't probe it, or Wave A2's KERNEL-R007 fix exposed it. Either way, no test catches it.
- **`performIndexRebuild` empty window not exercised** — STORES-R2-009 notes no test concurrently reads the index during rebuild. The empty-window bug (STORES-R2-001 / KERNEL-R2-003) is functionally invisible to the suite.

---

## 10. Per-domain summaries (verbatim from agents)

### Kernel

> Wave A2 closed all 14 re-audit-1 HIGHs at the targeted layer — `_kernel` getter deleted (grep confirms 0 code uses), stale comments gone, CommandQueue atomic, auto-walk removed. Three new HIGHs found: (1) KERNEL-R2-001: `inspectCommand` fetches before `enforce()`, creating a command-existence oracle for denied principals — inconsistent with `inspectEntity` which enforces first. (2) KERNEL-R2-002: `verify()`'s `provenance_references_valid` check counts all ledger events regardless of `subjectStore` — `command_approved`/`rejected` events (`subjectStore='ledger'`, `subjectId=commandId`) are always false-orphans, causing degraded `verify()` status in any real production cluster. Phase 12 Proof 12 escapes because it uses helper paths with no `approveMutation`. (3) KERNEL-R2-003: `ClusterKernel.performIndexRebuild()` still uses old non-atomic `clear()+index()` loop — KERNEL-R008 wired the reindex arm to this helper, but the helper itself was not updated to use the now-required `replaceAll()`. `ops/rebuild.ts` is correct; the kernel helper diverges. Four MEDIUMs: `traceProvenance` actor-ID leakage under active redaction rules (KERNEL-R2-004); `link_evidence` switch arm writes `evidence_linked` provenance outside the outer try/catch creating irrecoverable partial orphan state (KERNEL-R2-005); `redactProvenanceEvent` strip behavior emits empty-string actorId and misses entity-identifying detail fields under command_payload rule (KERNEL-R2-006); `ingest_artifact` commitMutation arm corrupts content on CommandQueue JSON round-trip (KERNEL-R2-007); `detail.targetStore` cast lacks value validation (KERNEL-R2-008). The dominant meta-pattern of this wave: the fix lands at the announced layer but the adjacent call site (`performIndexRebuild`, `verify`) or the helper invoked by the fixed code was not audited for the same flaw — reproducing the re-audit-1 cross-cutting theme #1 ('type/wrapper fixed but call sites not migrated') at a lower abstraction level.

### Stores

> Pass 3 found 2 HIGH + 2 MEDIUM + 6 LOW findings, with 0 CRITICAL. The most severe finding (STORES-R2-001 HIGH) is a direct regression from Wave A2's own fix: STORES-R003 correctly updated `ops/rebuild.ts` to use the new required `IndexStore.replaceAll`, and correctly added `replaceAll` to the contract — but `ClusterKernel.performIndexRebuild()` (the implementation behind both the public `kernel.rebuildIndex()` API and the `'reindex'` `commitMutation` arm) still uses the old `clear()+loop` pattern. The kernel's JSDoc explicitly acknowledges the STORES-008 hazard and declares it 'out of scope for the kernel agent' — but it is now in scope because the contract has been promoted and the ops path is fixed. The second HIGH (STORES-R2-002) is a contract/runtime mismatch: `importSnapshot`, `importEvent`, and `importReceipt` are runtime-mandatory (`backup.ts` throws if missing) but TypeScript-optional on their contracts, meaning new adapters get no compile-time error for omitting them — the same duck-typing fragility STORES-R003 eliminated for `replaceAll`. The two MEDIUMs (STORES-R2-003, STORES-R2-004) are carryovers from re-audit-1 that Wave A2 did not address: `mutation_orphaned` events are invisible to the health model (`verify()` and `doctor()` neither detect nor surface them as degraded), and `trace-builder.ts` still falls through to `'entity_created_by'` for `mutation_orphaned` action. All four baseline checks (duplicate error deleted, `replaceAll` in contract, `getContent` validates hash, Postgres `ON CONFLICT` applied) confirmed passing.

### Surface

> Pass 3 (post-Wave A2) Surface audit. Wave A2 closed the `_kernel` unwrap regression, removed the SDK auto-walk, wired sanitizers at 4 MCP boundaries, sandboxed the policies-file path, and extracted the dashboard `applyRedaction` function into a shared lib. The corrections are real and structurally sound at the layer they target. However, three HIGH findings survive or are newly introduced: (1) CLI `resolve` command (SURFACE-R2-001) constructs a raw `ClusterResolver` independently of `getKernel()`, bypassing all policy enforcement and sanitization — `storagePath` leaks verbatim for artifact URIs, full `ProvenanceEvent` detail for ledger URIs; (2) `DB_CLUSTER_POLICIES_FILE` sandbox does not use `realpath()` (SURFACE-R2-002) — symlink traversal escapes the prefix check; (3) `SDK.resolve` sanitization covers only `artifact` and `canonical` store types (SURFACE-R2-003) — `ledger`/`receipt`/`index` URIs return raw unsanitized objects even when `policyEnforced=true`, and the MCP `cluster_resolve` handler has the same gap. The dominant meta-pattern from re-audit-1 continues: fixes landed at the layer the agent owned, but adjacent code paths that should have been migrated were not. CLI `resolve` is the clearest instance — every other CLI command routes through `getKernel()` but `resolve` was factored separately and escaped the Wave A2 sweep.

### Tests

> Pass 3 confirms that Wave A2 correctly resolved all 7 re-audit-1 HIGH findings in the Tests domain. The baseline checks are green: `wave6-proof:350` now uses runtime `Object.keys()` probing (not source-text substring match); phase12 Proof 12 calls `verify()` with full entity-ID equality assertion; phase10 has zero `npx tsx/tsc` shell-outs; either-OK assertions are pinned to `'degraded'` + specific check name; verb-parity uses explicit allowlist + `Object.getOwnPropertySymbols`; drift-detection is pinned to the specific check with other-checks-healthy assertion. The three new SDK e2e policy tests in `policy-surface.test.ts` Proof 8 are substantive: they seed, query, and assert filtering/denial behavior, not just dry-run `policyExplain`. The `_kernel` cascade migrations in `policy-kernel.test.ts` and `wave5-redaction.test.ts` are meaningful — tests now seed via the admin-wrapped kernel which routes through the policy layer (full access), semantically equivalent to the old kernel bypass and preserving test intent. Four findings survive at MEDIUM severity and four at LOW. The most important is TESTS-R2-001: the `ReceiptFailedError` test does not assert the canonical store is dirty after failure, so the 'store retains the mutation while receipt fails' half of KERNEL-005 is unproven. TESTS-R2-002 notes the absence of a `LocalCanonicalStore.importSnapshot` unit-level id-preservation test (deferred to end-to-end only). TESTS-R2-003 is the persistent SURFACE-R008 gap: no test calls `cluster_resolve` on a real artifact URI and asserts `storagePath === undefined`. TESTS-R2-004 flags a false-pass risk in the restricted-principal e2e test. No regressions of prior fixes were found. No new trivial-assertion anti-patterns were introduced. Stage A exit gate (0 CRITICAL + 0 HIGH) is MET for the Tests domain in this pass.

### CI/Docs

> Wave A2 closed all 14 HIGH and 20 MEDIUM findings from re-audit-1 for the CI/Docs domain. Seven of the seven baseline checks pass at a structural level. No regressions of closed HIGH findings are present. Three MEDIUM findings survive: (1) `docs/sdk.md` has two unfixed CIDOCS-R014 content errors — `policyExplain`/`policyTest` examples pass a `capabilities` field that does not exist on the `Principal` interface, and the `retrieveBundle` example references `bundle.confidence`/`bundle.gaps`/`bundle.staleRecords` which do not exist on `EvidenceBundle` (actual fields: `confidenceBoundaries`, `missingContext`, `freshness.staleCount`); (2) `README.md` and two docs files still claim `623+` tests across 58 files when the actual post-A2 count is 640 across 59 files — the Wave A2 amend report's own §3 documents this number but the docs were updated to the pre-A2 count; (3) the Principal shape sweep (CIDOCS-R003) fixed prose interface declarations but missed `policyExplain`/`policyTest` code example blocks in `sdk.md` which still show the wrong `capabilities` field. The CI infrastructure is sound: permissions blocks present on all three workflows, drift scan correctly walks `examples/` and `dashboard/lib/` with `.d.ts` extension, smoke-install has `workflow_dispatch` and `pull_request:paths:package.json` triggers, `concurrency` on `ci.yml` only. `dashboard/lib/apply-redaction.d.ts` correctly references `dist/` not `src/`. All four example SDK files have explicit `validateMutation + approveMutation` chains. `postgres-canonical.ts` is deleted with no orphan references. Six LOW findings are new observations: `readdirSync recursive` compatibility on Node < 18.17, missing macos runner, missing `prepublishOnly` gate, loose `.txt` files (deferred from A2), `smoke-install` path-filter limitation, and a `release-readiness` doc clarification.

---

## 11. Regression vs new split (re-audit-2 specific)

### Regressions-of-A2 (Wave A2 broke or weakened something Wave A1 had clean) — 1

| ID | Description | Severity |
|---|---|---|
| **KERNEL-R2-003 ≡ STORES-R2-001** | Wave A2 added `IndexStore.replaceAll` as required AND wired `commitMutation('reindex')` → `performIndexRebuild()` (KERNEL-R008) — but the helper itself still uses the pre-A2 `clear()+index()` loop. The reindex arm now routes through the empty-window code path that A2 was supposed to eliminate. `ops/rebuild.ts` correctly uses `replaceAll`; the kernel helper diverges. | HIGH |

### Partial-of-known (Wave A2 fixed at the announced layer; gap remains at adjacent layer) — 14

| ID | Description | Severity |
|---|---|---|
| **SURFACE-R2-002** | SURFACE-R006 marked "fixed" — `DB_CLUSTER_POLICIES_FILE` path sandbox blocks dotdot but not symlinks | HIGH |
| **SURFACE-R2-003** | SURFACE-R003 marked "fixed" — `SDK.resolve` sanitizes only 2 of 5 store types | HIGH |
| **STORES-R2-003** | KERNEL-R009 fix emits `mutation_orphaned` events; no `ops/` consumer surfaces them in health model | MEDIUM |
| **STORES-R2-004** | KERNEL-R012 from re-audit-1; `trace-builder.ts` falls through to `'entity_created_by'` for `mutation_orphaned` | MEDIUM |
| **SURFACE-R2-004** | SURFACE-R012 from re-audit-1; `INTERNAL_TRUSTED_PRINCIPAL` silent fallback unchanged | MEDIUM |
| **SURFACE-R2-008** | SURFACE-R009 from re-audit-1; `policyEnforced: boolean` still public | MEDIUM |
| **KERNEL-R2-007** | SURFACE-003 partial in A2 report acknowledged Buffer issue; commit-arm not guarded | MEDIUM |
| **STORES-R2-006** | STORES-R010 from re-audit-1 (NFD tokenizer) unfixed | LOW |
| **STORES-R2-007** | STORES-R009 from re-audit-1 (.tmp race) unfixed | LOW |
| **STORES-R2-008** | STORES-R011 from re-audit-1 (silent duplicate-drop) unfixed | LOW |
| **KERNEL-R2-010** | KERNEL-R010 from re-audit-1 (error message embeds filesystem path) unfixed | LOW |
| **KERNEL-R2-011** | KERNEL-R016 from re-audit-1 (`'propose_mutation'` verb dead) unfixed | LOW |
| **TESTS-R2-001** | KERNEL-005 invariant test only proves one half (error type, not dirty-store) | MEDIUM |
| **TESTS-R2-008** | Re-audit-1 §9 gap "Dashboard JSDOM" unfixed | LOW |

### New (not previously probed) — 35

All other R2-findings (KERNEL-R2-001, R2-002, R2-004, R2-005, R2-006, R2-008; STORES-R2-002, R2-005, R2-009, R2-010; SURFACE-R2-001, R2-005, R2-006, R2-007, R2-009, R2-011, R2-013; TESTS-R2-002, R2-003, R2-004, R2-005, R2-006, R2-007; CIDOCS-R2-001 through R2-011).

The largest "new" cluster is **Wave A2's own corrections creating new edge cases**: KERNEL-R2-001 (KERNEL-R006 fix-ordering oracle), KERNEL-R2-002 (`verify()` exposed by KERNEL-R007 path), KERNEL-R2-005 (KERNEL-R007 reindex arm + helper divergence), KERNEL-R2-006 (KERNEL-R005 redactor scope), KERNEL-R2-008 (KERNEL-R004 cast validation), SURFACE-R2-005 (SURFACE-R003 ingest soft-warn), SURFACE-R2-006 (KERNEL-R002 CLI flag bypass), SURFACE-R2-009 (SURFACE-R010 ESM race), CIDOCS-R2-002 (CIDOCS-R005 sweep stale by 17 tests). Each corrective patch exposed a new flaw one step away.

---

## 12. Audit-confidence-gap status (re-audit-1 §9 closure)

| Gap | Status | Notes |
|---|---|---|
| Postgres adapter — only statically read | **still gap** | STORES-R006 (ON CONFLICT) static-read confidence only; no live pool exercised |
| MCP server runtime not exhaustively fuzzed | **still gap** | SURFACE-R2-002 (symlink) found via code review; SURFACE-R005/R006 static |
| Dashboard React not rendered in JSDOM | **still gap** | SURFACE-R010 fix + SURFACE-R2-009 ESM race static-read only |
| CI workflows not run against fork-PR scenario | **still gap** | CIDOCS-R006 closed structurally (permissions block); fork-PR untested |
| 12 cascading test fixes — not exhaustively re-read | **closed (partial)** | Re-read sampled in this pass; ~30 NEW cascading fixes from A2 spot-checked; semantic break not found |

### New gaps from re-audit-2

- **`verify()` not exercised against a real lifecycle** — KERNEL-R2-002 inferred from code; no test runs full propose→validate→approve→commit then calls `verify()` and asserts `healthy`.
- **`performIndexRebuild` empty-window not exercised** — STORES-R2-009. No concurrent-reader test during rebuild.
- **`cluster_resolve` artifact-URI sanitization not tested** — TESTS-R2-003 (≡ SURFACE-R008 from re-audit-1, still open).

---

## 13. Pattern-recurrence assessment

The dominant re-audit-1 meta-pattern was: **abstraction added at the type/wrapper layer; call sites not migrated.**

Wave A2 explicitly addressed this pattern with sweep verifications (§4 of A2 amend report). The sweeps confirmed zero code uses of `_kernel`, zero `auto-walk`, etc. But **the meta-pattern recurs at a lower abstraction level** in three places:

1. **Wave A2 added a required contract method (`replaceAll`)** — but missed promoting the three other backup-critical methods that have the same runtime-mandatory / type-optional shape (STORES-R2-002).

2. **Wave A2 added a wrapper (`SDK.resolve` sanitization)** — but covered only 2 of 5 store types (SURFACE-R2-003).

3. **Wave A2 wired a new code path (`commitMutation('reindex')` → `performIndexRebuild()`)** — but the helper itself was not updated to use the new contract method that the same wave required (KERNEL-R2-003 / STORES-R2-001).

Plus a fourth variant of the pattern:

4. **The CLI surface was treated as already-covered** — but `cli.ts resolve` constructs a raw `ClusterResolver`, bypassing the policy stack entirely. The CLI received less rigorous sweep treatment than the SDK and MCP (SURFACE-R2-001).

The pattern is now **harder to grep for** because the abstraction layer is the helper-method / contract-method level rather than the import-statement / class-instantiation level. A future wave that wants to close this should add **mechanical-grep verifications at the helper / contract level**, not just at the import level.

---

## 14. Exit gate verdict

**Stage A is NOT exitable.**

- **7 unique HIGH findings** (after de-duplication of `KERNEL-R2-003` ≡ `STORES-R2-001`)
- **0 CRITICAL**
- **1 regression-of-A2** (`KERNEL-R2-003`)

Required for exit: 0 CRITICAL + 0 HIGH + 0 regressions-of-A2.

### Recommendation: dispatch Wave A3 with narrow scope

The 7 HIGH findings cluster into 5 small fix groups, mapping cleanly to existing domains:

1. **`performIndexRebuild` atomicity** (Kernel) — update the helper to stage records in memory then call `replaceAll()`. Mirror `ops/rebuild.ts` pattern. Delete the "out of scope" JSDoc caveat. **Resolves KERNEL-R2-003 / STORES-R2-001.**

2. **`verify()` correctness for ledger-subject events** (Stores or Kernel) — filter the orphan check to `subjectStore in ['canonical', 'artifact']`. Add a regression test that approves a command then asserts `verify()` returns `healthy`. **Resolves KERNEL-R2-002.**

3. **`inspectCommand` ordering** (Kernel) — enforce first with ownerStore-only context, then fetch, then optionally refine with commandVerb. Or catch `NotFoundError` and convert to `PolicyDeniedError` when denied. **Resolves KERNEL-R2-001.**

4. **Import contract promotions** (Stores) — promote `importSnapshot` × 2, `importEvent`, `importReceipt` from optional to required on their respective contracts. Update JSDoc. **Resolves STORES-R2-002.**

5. **CLI `resolve` bypass + path sandbox symlink + SDK.resolve coverage** (Surface) — route CLI `resolve` through `getKernel()`. Apply `realpathSync()` after lexical resolve in MCP path sandbox. Add sanitization branches for `ledger`/`receipt`/`index` in `SDK.resolve` and MCP `cluster_resolve`. **Resolves SURFACE-R2-001 / R2-002 / R2-003.**

Wave A3 is materially smaller than A2 (5 files in Kernel, 4 in Stores contract, 3 in Surface) — convergence is real. The **policy-layer per-object scoping cluster** has now had two full rounds; recommend including the 5 MEDIUMs (KERNEL-R2-004/R2-005/R2-006/R2-008, SURFACE-R2-003 / R2-004) as ride-along if Wave A3 scope allows, since their fix patterns mirror Wave A2 work.

**Stage B preconditions** carry forward unchanged: TESTS-007 fixture hygiene; SURFACE-R009 `policyEnforced` privacy; CIDOCS-R012 `.txt` files; CIDOCS-R011 `prepublishOnly`; `docs/sdk.md` content errors (CIDOCS-R2-001 / R2-003).

---

*End of Stage A re-audit-2 report. Hand to advisor for Wave A3 dispatch decision.*
