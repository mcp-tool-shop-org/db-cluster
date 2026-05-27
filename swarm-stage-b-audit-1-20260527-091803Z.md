# Dogfood Swarm Stage B — Proactive Health Audit (Wave B1) — db-cluster — 2026-05-27

**Repo:** `mcp-tool-shop-org/db-cluster`
**Working copy:** `E:/AI/db-cluster`
**Audit type:** Stage B Wave B1 — proactive-health lens (defensive coding / observability / graceful degradation / future-proofing), 5 parallel domain auditors
**Coordinator:** Dogfood Swarm Stage B Wave B1 (5 parallel domain auditors)
**Audit date:** 2026-05-27 09:18 UTC
**Audit pass:** 1 (post-Stage-A exit at Wave A3)

---

## 1. Baseline

| Field | Value |
|---|---|
| Pre-audit HEAD SHA | `71ba55c` (`Add Stage A re-audit-2 + Wave A3 amend reports + verifier ensemble outputs`) |
| Branch | `main` (6 commits ahead of `origin/main` — un-pushed) |
| Working tree | clean |
| Save points present | All 7 (`swarm-stage-a-save-1779834974` … `swarm-stage-a-amend-a3-1779855264`, plus this wave's `swarm-stage-b-1-1779871813`) |
| `npm run lint` | **PASS** (tsc --noEmit + lint:examples) |
| `npm test` run 1 (this session) | **FAIL — 22 failed / 677 passed / 53 skipped across 5 failed files** (target wave6-proof.test.ts) |
| `npm test` run 2 (this session, via release-gate) | **FAIL — 20 failed / 679 passed / 53 skipped** (same flake) |
| `npm test` run 3 (this session, re-run) | **PASS — 699 passed / 53 skipped / 0 failed across 63 files** |
| `node scripts/release-gate.mjs` | **FAIL — Stage 2 (tests)** on this run (release-gate stage 1/3/4/5/6/7 all green) |

**Baseline drift from Wave A3 amend report:** material. The amend report claimed `699/53/0` as a stable post-A3 result. Two of three full-suite runs this session show 20–22 failures concentrated in `test/wave6-proof.test.ts` with `NotFoundError: Not found in command store: <UUID>` from `ClusterKernel.validateMutation` at `src/kernel/cluster-kernel.ts:655`. The third run passed cleanly. **This is the TESTS-007 carry-over surfacing at an empirical ~67% per-run failure rate this session, not the "~1% intermittent" rate Wave A3 estimated.** The Tests-domain headline finding ([TESTS-B-001](.stage-b-audit/agent-tests-findings.md)) reframes this not as a `beforeAll → beforeEach` migration miss (the file already uses `beforeEach`) but as a compound Windows-filesystem race against an in-repo `TEST_DIR` with a nested `.db-cluster` subdir, amplified by Windows Defender real-time scanning + `CommandQueue.load()` silently returning empty Map when the persistence file goes missing after a save.

---

## 2. Severity rollup

### Per-domain (after each agent's report)

| Domain | HIGH | MEDIUM | LOW | Total | Should-have-been-A (tag) | Report |
|---|---:|---:|---:|---:|---:|---|
| Kernel | 6 | 10 | 7 | 23 | 3 | [agent-kernel-findings.md](.stage-b-audit/agent-kernel-findings.md) |
| Stores | 8 | 11 | 9 | 28 | 3 | [agent-stores-findings.md](.stage-b-audit/agent-stores-findings.md) |
| Surface | 5 | 13 | 9 | 27 | 3 | [agent-surface-findings.md](.stage-b-audit/agent-surface-findings.md) |
| Tests | 7 | 13 | 8 | 28 | 2 | [agent-tests-findings.md](.stage-b-audit/agent-tests-findings.md) |
| CI/Docs | 6 | 14 | 7 | 27 | 4 | [agent-cidocs-findings.md](.stage-b-audit/agent-cidocs-findings.md) |
| **TOTAL** | **32** | **61** | **40** | **133** | **15** | |

(`should-have-been-stage-a` is an orthogonal tag, not a separate severity tier — these findings ARE counted in HIGH/MEDIUM/LOW but flagged as defects the v2 ensemble should have caught at Stage A. See §6 v2-ensemble gap analysis.)

### Cross-cutting de-duplication

| Pair | Action |
|---|---|
| `KERNEL-B-007` (V2-004 Buffer/JSON corruption) ≡ `SURFACE-B-V2-004 cross-check` | merge — Kernel owns the fix (`src/kernel/cluster-kernel.ts:528-533` + `src/kernel/command-queue.ts:73`); Surface's `repo-knowledge/ingest.ts:236-249` is a known consumer-side workaround |
| `SURFACE-B-011` (dashboard blind to mutation_orphaned) ≡ `STORES-B-014` (doctor/verify limit-capped at 100) | merge as theme — different layers of the same observability chain; both fix scopes ship together |
| `CIDOCS-B-004` (release-gate non-determinism) ≡ `TESTS-B-001` (wave6-proof race) | merge as theme — root cause is Tests-domain; CI/Docs owns the operator-facing signal + retry path |
| `KERNEL-B-010` (CommandQueueCorruptError filesystem paths) ≡ `KERNEL-B-005` (cause.message propagation into ledger) | partial overlap; fix order is B-010 first (sanitize at error construction) then B-005 (sanitize at ledger persist) |

**Unique (after merges): 130 findings.**

---

## 3. Findings by severity

### CRITICAL (0)

None. The proactive lens did not surface any failures that would crash the cluster or corrupt the truth stores under normal operation.

### HIGH (32) — the Wave B1-Amend candidate set

Listed by domain. Each finding has full file:line + evidence + recommendation in the per-domain report; this index points there.

**Kernel (6):**
- **KERNEL-B-001** — Verb-scoped allow policies unreachable at commit (commitMutation enforces with `commandVerb: undefined`; matchCommandVerbs refuses to match allow rules on underspecified verb). `src/kernel/policy-enforced-kernel.ts:543-546`. *Category: defensive.*
- **KERNEL-B-002** — Redactor `summarize` and `strip` cases are byte-for-byte identical for `artifact_content`; `hash` leaves `affectedIds` exposed in `redactReceipt`. `src/policy/redactor.ts:33-110`. *Category: observability. AGG-005 active.*
- **KERNEL-B-003** — All four redactor switches lack `default:` arm — TS exhaustiveness covers compile-time, not runtime-loaded policies; unknown behavior returns `undefined` (silent type hole). `src/policy/redactor.ts:33-43,53-66,76-89,100-109`. *Category: defensive.*
- **KERNEL-B-004** — `update_entity` index refresh queries with no `limit` field; full-table scan O(N) memory; magic 100k cap in `indexStatus`/`listStaleRecords` silently truncates. `src/kernel/cluster-kernel.ts:495,928,1020`. *Category: degradation.*
- **KERNEL-B-005** — `cause.message` from receipt-failure path persists into ledger `mutation_orphaned` `detail.error` field with no redaction. Flows through `retrieveBundle.provenanceEvents` / `traceProvenance` / `inspectCommand`. `src/kernel/cluster-kernel.ts:129`. *Category: observability.*
- **KERNEL-B-006** — TraceBuilder bakes entity identifiers into `label` and `metadata` (`${entity.kind}: ${entity.name}`, `${event.action} by ${event.actorId}`). String-level regex mangling in `redactProvenanceActors` only catches `by `-prefixed actors; entity names/filenames never mangled. `src/provenance/trace-builder.ts:104,115,168,180,295,328`. *Category: observability. AGG-008 active — structural fix needed.*
- **KERNEL-B-007** — V2-004 confirmed: `ingest_artifact` commitMutation arm casts `payload.content as Buffer` after JSON round-trip; Buffer becomes `{type:'Buffer', data:[...]}` after `CommandQueue.persist` JSON.stringify. Silent content corruption on propose+commit lifecycle path. Reclassified `should-have-been-stage-a` (correctness bug). `src/kernel/cluster-kernel.ts:528-533` + `src/kernel/command-queue.ts:73`. *Category: defensive.*

**Stores (8):**
- **STORES-B-001** — Multi-process race on fixed `${path}.tmp` suffix across all 4 local adapters. Silent data loss with no integrity check downstream. Escalated from STORES-R2-007's LOW classification. `src/adapters/local/local-{canonical,ledger,index,artifact}-store.ts`. `should-have-been-stage-a`. *Category: defensive.*
- **STORES-B-002** — `LocalLedgerStore.persistEvents` rewrites entire array on every append: O(N²) cost, single bad write nukes the entire append-only ledger. `src/adapters/local/local-ledger-store.ts:31-43,165-175`. *Category: defensive / degradation.*
- **STORES-B-003** — Silent first-write-wins on `importEvent`/`importReceipt`/`importSnapshot` with no content comparison; tampered backup with matching ID silently masks tampered field. `src/adapters/local/local-ledger-store.ts:117-129,135-144`, `local-canonical-store.ts:94-97`, `local-artifact-store.ts:155-158`. STORES-R2-008 escalated. `should-have-been-stage-a`. *Category: observability / defensive.*
- **STORES-B-004** — `appendReceipt`/`importReceipt` do not stamp `owner`; asymmetric with `append()` (which does). Footgun for code that filters by owner. `src/adapters/local/local-ledger-store.ts:80-89,135-144`. *Category: defensive.*
- **STORES-B-005** — Postgres adapter has no migration_status / applied_migrations table; v0.1→v0.2 has no safe forward path. Single migration 001 is idempotent so latent; the next migration silently re-runs or fails. `src/adapters/postgres/migrations/001_create_canonical_entities.ts`, `postgres-canonical-store.ts:151-156`. *Category: future-proofing.*
- **STORES-B-006** — Postgres pool: no SSL config, no `pool.on('error', ...)` handler, no shutdown wiring. Cloud Postgres providers downgrade unencrypted; idle-client TCP RST crashes process. `src/adapters/factory.ts:52,86`. *Category: degradation / future-proofing.*
- **STORES-B-007** — `restore()` silently ignores `rebuildIndex` failure; no `index` field on `RestoreResult` — partial restore looks complete. `src/ops/backup.ts:213-225`. *Category: observability / degradation.*
- **STORES-B-008** — `LocalArtifactStore.importSnapshot` mutates in-memory state before persist; persist failure mid-flight leaves orphan content + missing metadata = artifact disappears on restart. `src/adapters/local/local-artifact-store.ts:150-200`. *Category: defensive / degradation.*

**Surface (5):**
- **SURFACE-B-001** — `cluster_find_sources` MCP arm returns raw `IndexRecord` with `metadata` field (mirrors entity content); AGG-001/003 closed singular-resolve paths, missed the LIST arm. Unconditional leak regardless of policy config. `src/mcp/server.ts:471-476`. `should-have-been-stage-a`. *Category: defensive.*
- **SURFACE-B-002** — `db-cluster policy explain` / `policy test` silently evaluate against `DEFAULT_POLICIES`, ignoring `.db-cluster/policies.json`. Operator-trust defect: dry-run interface reports decisions disconnected from real cluster. `src/cli.ts:829,865`. `should-have-been-stage-a`. *Category: observability.*
- **SURFACE-B-003** — MCP error catch returns raw `err.message` to host; leaks filesystem paths and internal state through one unified error path. `src/mcp/server.ts:815-820`. `should-have-been-stage-a`. *Category: defensive.*
- **SURFACE-B-004** — ~20 of ~30 CLI subcommands lack top-level try/catch; raw kernel stack traces hit stderr; incoherent exit codes break shell-script integration. `src/cli.ts` (multi-site). *Category: observability / degradation.*
- **SURFACE-B-005** — `ClusterTruthInspector.jsx:608-613` crashes (TypeError) on unknown URI with no fallback render. Sibling components have null-guards; the main inspector doesn't. `dashboard/ClusterTruthInspector.jsx:608`. *Category: defensive / degradation.*

**Tests (7):**
- **TESTS-B-001** — **HEADLINE**: wave6-proof.test.ts flake at ~85% empirical rate (22/22 + 20/22 across two session runs). Root cause is compound Windows-filesystem race: in-repo TEST_DIR (`test/.test-phase6-proof/`) + nested `.db-cluster` subdir + Windows Defender scanning + `CommandQueue.load()` silent-empty-Map fallback when file unexpectedly missing. Fix: migrate TEST_DIR to `mkdtempSync(join(tmpdir(), 'wave6-proof-'))` per-test (~6 lines) AND make `CommandQueue.load()` loud-on-loss (~15 lines). `test/wave6-proof.test.ts:8,25-56` + `src/kernel/command-queue.ts:51-52`. *Category: defensive (test side).*
- **TESTS-B-002** — `wave6-policy-proof.test.ts` accumulates ~80 mkdtempSync directories per file run with zero cleanup. Direct contributor to the file system load that opens TESTS-B-001's race window. `test/wave6-policy-proof.test.ts:127-141`. *Category: degradation.*
- **TESTS-B-003** — `CommandQueue.load()` silently returns empty Map when file unexpectedly missing — masks the persistence-lost failure mode as confusing "Not found in command store". `src/kernel/command-queue.ts:51-52`. *Category: observability.* `should-have-been-stage-a`.
- **TESTS-B-004** — `__admin` hidden-property cast in `policy-kernel.test.ts` bypasses TypeScript via double-cast; `verb-parity.test.ts POLICY_KERNEL_EXTRAS` allowlist cannot catch instance-property additions. TESTS-R2-006 unfixed; refactor `makePolicyKernel` to return `{ restricted, admin }`. `test/policy-kernel.test.ts:246,251`. *Category: defensive (type safety).* `should-have-been-stage-a`.
- **TESTS-B-005** — V3-007: Windows symlink test silent-skips on EPERM on the rig that needs it most. SURFACE-R2-002 path-sandbox mitigation has no coverage on the 5080. Use `it.skipIf` + Junction fallback. `test/wave-a3-surface-regression.test.ts:152-160`. *Category: degradation.*
- **TESTS-B-006** — V3-009: KERNEL-R2-002 `verify()` regression test covers 2 of 5 ledger-subject event types; the other 3 have no consumer test. `test/wave-a3-stores-regression.test.ts:78-126`. *Category: defensive (coverage gap).*
- **TESTS-B-007** — 24 of 63 test files use in-repo TEST_DIR pattern (`join(import.meta.dirname, '.test-XYZ')`). Same fragility multiplier as TESTS-B-001 sits under 23 other files. Mass migration to `tmpdir()` is the principled Stage B intervention. *Category: defensive.*

**CI/Docs (6):**
- **CIDOCS-B-001** — `docs/retrieval-bundles.md:16-31` and `docs/provenance-graphs.md:80-99` carry the same doc-vs-types drift class Wave A3 just fixed in `docs/sdk.md`. Three waves in a row of the same root cause (hand-maintained example interfaces). Sibling docs need patching AND a doc-drift detector for release-gate. *Category: observability.*
- **CIDOCS-B-002** — `package.json` has no `prepublishOnly`; a human or workflow running `npm publish` skips the entire release-gate. Single most consequential defensive gap on the publish boundary. `package.json:43-54`. *Category: defensive.*
- **CIDOCS-B-003** — `engines` field missing; `release-gate.mjs:69` uses `readdirSync(..., {recursive:true})` (Node 18.17+ only); README says "Node 18+" (ambiguous). Add `"engines": {"node": ">=20"}`. `package.json`. *Category: defensive / future-proofing.*
- **CIDOCS-B-004** — Release-gate is non-deterministic (22-fail/20-fail/0-fail across three session runs); no documentation, no retry path, no `workflow_dispatch`, `slice(-500)` stdout tail buries the failing test name. Tests-domain owns root cause; CI/Docs owns operator-actionable signal. `.github/workflows/release-gate.yml`, `scripts/release-gate.mjs:25-26`, `docs/release-readiness.md`. *Category: degradation / observability.*
- **CIDOCS-B-005** — CHANGELOG and README promise ship-ready coverage that release-gate cannot deliver on a flaky suite. External signal does not match internal reality. `CHANGELOG.md:1-72`, `README.md:58`. *Category: observability.*
- **CIDOCS-B-006** — Three loose `.txt` files committed at repo root (`AI Safe Data Control Plane over Fed.txt`, etc.); persisted through three amend waves with each Stage A audit flagging. `.gitignore` does not match. First-impression damage on GitHub. *Category: defensive / future-proofing.*

### MEDIUM (61)

Listed in per-domain reports. The most consequential MEDIUMs are:

- **KERNEL-B-009** — `redactIndexSourceUri` dead code (V2-011); type-system claims `index_source_uri` rules enforced, runtime is no-op. Delete or wire.
- **KERNEL-B-011** — `PolicyDeniedError.message` leaks policy ID + reason to caller (V2-012); structured decision field for audit + generic message for callers.
- **KERNEL-B-015** — `compensateMutation` writes original payload into compensating command unredacted (V2-014).
- **STORES-B-014** — `doctor()` + `verify()` orphan count silently limit-capped at 100; operator sees "100 orphaned" even when actual count is higher. Pair with **SURFACE-B-011**.
- **SURFACE-B-006** — CLI `loadPolicyConfig` no structural validation (V2-008); symmetric to MCP's SURFACE-R005 fix that didn't extend.
- **SURFACE-B-007** — `ClusterSDK.policyEnforced: boolean` is public-readonly (SURFACE-R009/R2-008); invites bypass-branching consumers.
- **SURFACE-B-008** — `SDK.retrieveBundle` is raw pass-through; non-policy-enforced consumers see unsanitized `indexRecords` + `provenanceEvents`. AGG-002 made `resolve()` unconditional; bundle was not extended.
- **SURFACE-B-009** — CLI silently substitutes `INTERNAL_TRUSTED_PRINCIPAL` BEFORE SDK construction (V2-005); SDK no-principal warning never fires from CLI. Architectural asymmetry vs MCP.
- **SURFACE-B-011** — Dashboard `OperationsPanel.jsx` does not render `mutation_orphaned` count; view-plane blind to load-bearing observability signal.
- **CIDOCS-B-008/009** — R5 and R4 completeness rules scoped too narrowly (R5: only `src/contracts/`; R4: switch-only, missing if/else discriminator chains). AGG-007 active.
- **CIDOCS-B-010** — CI matrix lacks macOS and Node 24.
- **CIDOCS-B-012** — Stryker shipped, advertised, inert (28-hr wall, never invoked); decision needed: scope, migrate, or drop.
- **CIDOCS-B-013/014** — Docs sprawl with no entry-point map; Policy/Principal/Capability documented across 6+ files.
- **TESTS-B-008** — 15+ test files use `beforeAll` to share state across tests; ordering-dependent passes today, future flake.
- **TESTS-B-009** — Stryker 28-hr wall (Wave A3 §11 documented); decision per CIDOCS-B-012.

(Full MEDIUM list in per-domain reports.)

### LOW (40)

Cosmetic, dead-code cleanup, defense-in-depth polish. See per-domain reports.

---

## 4. Carry-overs verification matrix

For each explicit Stage B carry-over enumerated in the dispatch §2e, present-or-not, severity under proactive lens, fix scope, owner.

| Carry-over ID | Present? | New severity | Fix scope (one line) | Owner domain | New file:line |
|---|---|---|---|---|---|
| **TESTS-007** fixture hygiene | YES — but mechanism reframed | **HIGH** (much worse than ~1% — ~85% empirical) | Migrate wave6-proof TEST_DIR to mkdtempSync + loud-on-loss CommandQueue; 24-file mass migration follows | Tests + Kernel | `test/wave6-proof.test.ts:8,25-56` + `src/kernel/command-queue.ts:51-52` |
| **SURFACE-R009 / R2-008** policyEnforced visibility | YES | MEDIUM | Make private + guarded getter; tests use known-policy SDK instead | Surface | `src/sdk/cluster-sdk.ts:131` |
| **CIDOCS-009 / R2-008** loose .txt files | YES (3 files tracked) | **HIGH** (workspace hygiene + first-impression) | Delete or move to `docs/notes/`; gitignore future drops | CI/Docs | repo root |
| **CIDOCS-011 / R2-009** no prepublishOnly | YES | **HIGH** (single most consequential publish-boundary gap) | Add `"prepublishOnly": "node scripts/release-gate.mjs"` | CI/Docs | `package.json:43-54` |
| **V1-001** backup.ts dead code | YES (4 sites) | MEDIUM | Delete optional-cast call sites OR widen R5 to cover ops/ | Stores + CI/Docs | `src/ops/backup.ts:113,138,175,195` + `scripts/checks/R5.yml:36` |
| **V1-003** bundle redaction edges | YES — actual finding broader than "edges" | MEDIUM | SDK boundary IS the leak path for non-policy-enforced consumers — sanitize indexRecords + provenanceEvents unconditionally | Surface | `src/sdk/cluster-sdk.ts:195-197` |
| **V2-004** Buffer-in-CommandQueue (≡ SURFACE-003 partial) | YES | **HIGH** (silent content corruption; reclassified should-have-been-A) | Reject Buffer in propose payload OR Buffer-aware CommandQueue serialization | Kernel | `src/kernel/cluster-kernel.ts:528-533` + `src/kernel/command-queue.ts:73` |
| **V2-005** CLI INTERNAL_TRUSTED_PRINCIPAL substitution | YES | MEDIUM | Pass `undefined` upstream so SDK warns (preferred) OR emit own warning at CLI site | Surface | `src/cli.ts:90,634` |
| **AGG-005** redactor allowlist completeness | YES — architectural | **HIGH** (multiple sub-findings) | Denylist→allowlist contract change; per-target rule matrix; add default arms to switches | Kernel | `src/policy/redactor.ts:33-110` |
| **AGG-007** R4/R5 widening | YES — process work + active leak | MEDIUM | R4: add if/else chain pattern; R5: extend to `src/ops/`; pair with B-001 (sibling docs) | CI/Docs | `scripts/checks/R4.yml:15-18`, `R5.yml:36` |
| **AGG-008** TraceBuilder structured redaction | YES — architectural | **HIGH** | Refactor `addNode` to structured metadata + render-time labels; add `entity_name`/`artifact_filename` redaction targets | Kernel | `src/provenance/trace-builder.ts:104,168,295` |
| **mutation_orphaned operator visibility** | Partial — data plane wired, view plane blind | MEDIUM (Surface) + MEDIUM (Stores limit-cap) | Stores: drop/raise orphan-count limit + sentinel rendering. Surface: add row to `OperationsPanel.jsx` + repair suggestion | Surface + Stores | `dashboard/components/OperationsPanel.jsx:72-83` + `src/ops/doctor.ts:218`, `verify.ts:158` |
| **Stryker mutation testing infrastructure** | YES (shipped, inert) | MEDIUM | Decision: scope (3 invariant-density files) OR migrate (incremental + perTest) OR drop (verifier-3 doctrine) | CI/Docs + Tests | `stryker.conf.json:10,36-40`, `package.json:47` |

**Verdict on carry-overs:** 4 of the 13 explicit carry-overs are materially worse than the Wave A3 amend report's classification suggested:

1. **TESTS-007** — A3 estimated ~1% intermittent; empirical ~85% per-run failure rate on the 5080 rig this session. The mechanism is also different (compound Windows-fs race, not the simple `beforeAll → beforeEach` story).
2. **V2-004 Buffer/JSON** — A3 deferred as a known-known; on the proactive lens it's HIGH silent corruption needing a structural fix (Buffer-aware persistence OR reject at validate).
3. **CIDOCS-009 / R2-008 .txt files** — A3 deferred as low-priority workspace hygiene; on the proactive lens it's HIGH because three Stage A audits flagged it and it persisted — a small finding that is materially worse for what it says about disposition of small things.
4. **CIDOCS-011 / R2-009 prepublishOnly** — A3 deferred as a process gap; on the proactive lens it's HIGH because the entire release-gate is bypass-able from a workstation by anyone with publish rights.

---

## 5. Cross-cutting themes

Eight themes emerged across domains. Each is mapped to specific findings so Wave B1-Amend can be designed coherently.

### Theme 1 — The Stage A meta-pattern recurs at a deeper layer

The pattern Wave A1/A2/A3 documented ("fix at the announced layer; adjacent call sites miss the migration") is now visible at the **family-of-call-sites** level, not the import-statement or wrapper-class level:

- **Surface-B-001**: AGG-001/003 fixed singular-resolve sanitization; the LIST arm (`cluster_find_sources`) was missed.
- **Kernel-B-012**: KERNEL-R2-008 hardened ledger-claim validation at ONE site (retrieveBundle); 3 other detail-reading sites (explainIndex, traceProvenance, traceObject) remain unguarded.
- **Kernel-B-006/B-016**: AGG-008 trace-builder leak is structural (identifiers baked into label/metadata) — the regex mitigation only catches `by `-prefixed actors; entity names and filenames bypass entirely.
- **CIDOCS-B-001**: A3 fixed sdk.md drift; `retrieval-bundles.md` and `provenance-graphs.md` carry the same drift class. Three waves of fix-this-site without fixing the mechanism.
- **CIDOCS-B-008/009**: R5 only scans `src/contracts/`; R4 only matches `switch`. The gates exist but their patterns are narrower than the patterns they're supposed to regression-protect.

**v2-ensemble gap:** the verifier lenses do not check "every other site that matches this pattern." A pattern-fix verifier — given the FIX, scan for sibling call sites — would catch this family. See §6.

### Theme 2 — Lifecycle data flow doesn't respect type promises

Commands traverse JSON persistence (CommandQueue), but type declarations claim Buffer survives the round-trip; receipts/compensations propagate raw payloads without redaction; error messages embed paths that flow into ledger details:

- **KERNEL-B-007 (V2-004)** — `ingest_artifact` commitMutation arm casts `payload.content as Buffer` after JSON round-trip; cast lies silently.
- **KERNEL-B-015 (V2-014)** — `compensateMutation` writes `originalPayload` into compensating command, two redaction levels deep.
- **KERNEL-B-005** — `cause.message` from receipt failure flows into ledger `mutation_orphaned` `detail.error`; surfaced through every read path.
- **KERNEL-B-017** — `validateCommand` doesn't probe `payload.content` shape; the Buffer assumption is unchecked at validate-time.

**Fix shape:** the propose-validate-approve-commit lifecycle must be a redaction-and-shape boundary. Either Buffer-aware persistence OR a `validatePayloadForVerb` that rejects ambiguous content shapes BEFORE they reach the queue.

### Theme 3 — Operational observability gap (orphan signal exists; view plane blind)

Wave A3 wired `verify()` and `doctor()` to consume `mutation_orphaned` events. The data plane is correct. But:

- **STORES-B-014** — `doctor()` + `verify()` orphan count is silently `limit: 100`-capped; operator running doctor twice sees the same 100 and can't tell if it's improving.
- **SURFACE-B-011** — `dashboard/components/OperationsPanel.jsx` has NO `mutation_orphaned` row. The dashboard is the most operator-facing health surface and it's blind.

The fix is small (3-file edit per SURFACE-B-011) but the discovery point matters: the proactive lens caught what the v2 ensemble's "fixed verify+doctor" framing missed.

### Theme 4 — Multi-process / Windows-filesystem fragility

This cross-cuts Tests + Stores + CI/Docs:

- **TESTS-B-001/007** — In-repo TEST_DIR pattern in 24 test files; Windows Defender scanning + nested mkdir races + CommandQueue silent-empty.
- **STORES-B-001** — Fixed `${path}.tmp` suffix race across 4 local adapters; silent data loss with no integrity check.
- **CIDOCS-B-004** — Release-gate non-determinism is the symptomatic bubble-up; needs CI-side mitigation (workflow_dispatch, wider stdout slice, docs/release-readiness.md "known flake" section) alongside Tests-side root-cause fix.

These don't share a single fix, but they share a single root: **the local-filesystem write paths and the test paths both assume single-writer + uncontested OS scheduling.** Windows + Defender + parallel test execution violates both assumptions. The principled Stage B intervention is mass migration of test fixtures to `os.tmpdir()` PLUS random-suffix `.tmp` files PLUS startup cleanup of orphan tmps.

### Theme 5 — Boundary surfaces leak through error and dry-run paths

Stage A focused on the read/write paths and closed sanitization there. The DRY-RUN paths and the ERROR paths were not part of the same audit lens:

- **SURFACE-B-002** — `policy explain` / `policy test` ignore `.db-cluster/policies.json` and evaluate against DEFAULTs. Dry-run interface is the operator's primary policy-reasoning tool; this defeats its purpose.
- **SURFACE-B-003** — MCP unified error catch returns raw `err.message` to host. Inbound (SURFACE-R005) was hardened; outbound was not.
- **SURFACE-B-006** — CLI `loadPolicyConfig` has no structural validation; MCP `buildSDKOptions` got fail-closed validation; CLI mirror deferred.
- **SURFACE-B-004** — ~20 CLI subcommands lack try/catch; raw stack traces hit stderr.
- **KERNEL-B-010/B-011** — Typed errors embed full filesystem paths (`CommandQueueCorruptError`) + policy IDs + reasons (`PolicyDeniedError`) into `.message`, which propagates through `.cause.message` chains.

**Fix shape:** every boundary error message + every dry-run-style introspection path needs the same redactor pass that the read/write paths got.

### Theme 6 — Defensive coding gaps at switch/union/cast boundaries

- **KERNEL-B-002/B-003** — Redactor switches lack default arms; unknown behavior returns `undefined` (silent type hole).
- **KERNEL-B-008** — `CommandVerb` union has dead `'propose_mutation'` member; switch silently rejects as "Unknown verb."
- **KERNEL-B-013** — `proposeMutation` casts `input.targetStore as any` past the policy boundary.
- **KERNEL-B-021/B-022** — `ResolveError` + `ClusterUriError` don't extend `ClusterError`; no stable error code.
- **STORES-B-020** — `as any` in `doctor.ts:152` erases pg row typing.
- **TESTS-B-004** — `(restricted as unknown as {...}).__admin = ...` cast bypasses TypeScript via double-cast.
- **SURFACE-B-007** — `policyEnforced: boolean` public-readonly invites bypass-branching consumers.

**Fix shape:** an "all switches have default arms; all type-narrowing uses guards not casts" sweep. Wave B1-Amend can codify this as an ast-grep R6 rule.

### Theme 7 — Future-proofing gaps blocking v0.2

- **STORES-B-005** — Postgres migrations have no registry table.
- **STORES-B-013** — Ledger has no archival/rotation hook (unbounded growth).
- **SURFACE-B-013** — Hardcoded `'0.1.0'` version strings in CLI + MCP server.
- **SURFACE-B-018** — No documented deprecation policy.
- **SURFACE-B-015** — `dashboard/components/*.jsx` shipped but never loaded by demo; future consumers hit the ESM race.
- **CIDOCS-B-013** — Phase docs sprawl (24 of 41 files) with no entry-point map.
- **CIDOCS-B-014** — Policy doc consolidation across 6+ files.
- **STORES-B-018** — `doctor()` hardcodes `'canonical_entities'`; drift risk vs `schema.ts` `CANONICAL_TABLE` constant.

**Fix shape:** a v0.2 design pass to establish: (a) migrations registry + format; (b) ledger archival contract; (c) version single-source-of-truth (build-time injection from package.json); (d) MIGRATION.md + @deprecated convention; (e) docs/README.md as canonical entry-point; (f) policy-and-redaction.md as canonical type source.

### Theme 8 — Half-fixed observability surfaces

- **CIDOCS-B-012** — Stryker shipped, CHANGELOG advertises it, never invoked, 28-hr wall — claim without machinery.
- **CIDOCS-B-005** — CHANGELOG/README claim 699/53/0 baseline; release-gate is best-of-N.
- **TESTS-B-018** — JSDOM gap closed via static-source + functional canary (Wave A3 choice); not formally documented as doctrine.
- **TESTS-B-019** — 53 silently-skipped Postgres tests; no operator-visible signal that explains.
- **CIDOCS-B-001** — `docs/sdk.md` fixed (3 times); sibling docs not.

**Fix shape:** every CLAIM in CHANGELOG/README/docs needs an ENFORCEMENT. Either ship the machinery (Stryker scoped run, doc-drift detector, JSDOM env) OR drop the claim. The doc-drift detector from CIDOCS-B-001 is the highest-leverage instance.

---

## 6. v2 ensemble gap analysis (audit confidence gaps)

The Wave A3 dogfood-swarm v2 protocol (3 lens-specialized adversarial verifiers + aggregator + per-finding test-first gate + mechanical completeness gates) caught the meta-pattern at the singular-resolve level. This Stage B audit shows two structural gaps:

### Gap 1 — No pattern-fix verifier

The contract-completeness / cross-boundary / invariant-test lenses each look at a wave's diff + call-graph closure of touched symbols. None of them does "given THIS fix, enumerate every other site that matches the same pattern and verify the fix was applied there too." The Surface-B-001 LIST arm, the Kernel-B-012 detail-reading site cluster, the CIDOCS-B-001 sibling doc drift, the Kernel-B-006 string-mangling regex, and the AGG-007 R4/R5 narrow scopes are all the same shape: **single-site fix, family-not-swept.**

**Candidate 4th lens:** "Pattern-fix completeness verifier." Given the wave's fix (the diff), generate ast-grep / Semgrep queries that find sibling call sites of the SAME pattern; flag any unfixed instances. Distinguish from R1-R5 completeness gates by being CHANGE-DRIVEN (rules generated per-wave) vs RULE-DRIVEN (static legacy patterns).

### Gap 2 — Dry-run and error paths not lens-scoped

The cross-boundary information-flow lens audits cross-domain edges. But it does not enumerate THESE paths as boundaries:

- Dry-run / introspection paths (policy explain, policy test) — these MUST reflect cluster state to be operator-trustworthy
- Outbound error paths (MCP catch, CLI exit codes, stack-trace stderr) — these are observability surfaces

**Candidate 4th lens (different one):** "Surface-side dry-run + error parity." Audits whether every interactive introspection path (policy explain, doctor, verify, why, lineage, trace) reflects the same state machine the real cluster uses; whether every catch arm returns a structurally-sanitized response.

### Other audit confidence gaps remain (carry-overs from re-audit-1 §9 + re-audit-2 §9)

| Gap | Status |
|---|---|
| Postgres adapter — no live pool | **still gap** — STORES-B-006/009/010 all reasoned from code |
| MCP server runtime not exhaustively fuzzed | **still gap** — SURFACE-B-010/026 confirm coverage gap |
| Dashboard rendering not in JSDOM | **still gap** — TESTS-B-018: chosen as doctrine, formally undocumented |
| CI workflows not run against fork-PR | **still gap** — CIDOCS observation only |
| `verify()` not exercised against real lifecycle | **partial closure** — Wave A3 closed phase15-proof; Tests-B-006 notes 2 of 5 event types |
| **NEW** — wave6-proof race only observable on this rig | **new gap** — Linux/Mac CI doesn't fire it; needs platform-aware test infra |
| **NEW** — release-gate non-determinism | **new gap** — symptomatic of TESTS-007; needs operator-facing signal |

---

## 7. Per-domain summaries (verbatim from agents)

### Kernel (agent-kernel-findings.md)

> The kernel domain after Wave A3 has cleanly closed orphan-mutation propagation, double-enforce existence oracles, and atomic index swap on rebuild. The proactive lens surfaces two related themes the v2 ensemble systematically missed.
>
> **Theme 1 — Lifecycle data flow does not respect type promises.** Commands traverse JSON persistence (CommandQueue) but the type system claims fields like `content: Buffer` survive the round-trip (V2-004 / KERNEL-B-007 / KERNEL-B-017). Compensation propagates raw `originalPayload` into a new command (V2-014 / KERNEL-B-015). Error messages embed paths that flow into ledger details (KERNEL-B-005). Each individual cast-without-validate compiles cleanly; the proactive shape is "the propose-validate-commit lifecycle is not a redaction boundary, and nobody guards it as one."
>
> **Theme 2 — Defense surfaces are point-fixes, not pattern-fixes.** KERNEL-R2-008 hardens one ledger-detail read site; KERNEL-B-012 shows three others remain unguarded. `redactArtifact`/`redactEntity`/etc. lack default arms (KERNEL-B-003). The verb-scoped policy gate only works for verb-explicit call sites (KERNEL-B-001). The pattern is "fix the reported bug, miss the family."

### Stores (agent-stores-findings.md)

> This domain is in solid shape after Wave A3 — the architectural fixes from re-audit-2 (contract-level required `importSnapshot`/`importEvent`/`importReceipt`, atomic tmp+rename for content writes, `replaceAll` on index, `ON CONFLICT` for Postgres TOCTOU, orphan-mutation surfacing in doctor) are all present and correct at HEAD `71ba55c`. The proactive-health concerns that remain are mostly about ROBUSTNESS UNDER STRESS that A3 wasn't scoped to address: multi-process write races (STORES-B-001), unbounded ledger growth + O(N²) writes (STORES-B-002, B-013), Postgres pool hardening (STORES-B-006, B-028), and migration-versioning futureproofing (STORES-B-005).

### Surface (agent-surface-findings.md)

> The surface is structurally well-disciplined post-Wave-A3 (5-store-type sanitization unconditional, MCP `_meta` annotations comprehensive, fail-closed on env-var validation, `policies-file` symlink sandboxing). But the proactive lens surfaces five categories of latent risk: (1) a metadata-leak path in `cluster_find_sources` mirroring the AGG-001 hole but on the list arm; (2) operator-misleading dry-run in `db-cluster policy explain` / `policy test` which ignore `.db-cluster/policies.json`; (3) unfiltered `err.message` leakage at the MCP error boundary; (4) ~20 CLI subcommands lack top-level try/catch; (5) a dashboard error state that crashes the entire UI on unknown URI. Plus the `mutation_orphaned` observability signal — wired into doctor/verify in Stage A — has no dashboard surface. Plus public-readonly `policyEnforced` remains a bypass-branch invitation. Deprecation policy, MCP fuzz coverage, and dashboard-component layering remain unfinished future-proofing work.

### Tests (agent-tests-findings.md)

> The TESTS-007 carry-over is materially worse than Wave A3 estimated — empirical failure rate ~85% (22/22 + 20/22 across two runs) vs. estimate ~1%. Root cause is NOT a missed `beforeAll → beforeEach` migration in wave6-proof itself (it already uses beforeEach). The mechanism is a compound Windows-filesystem race against an in-repo TEST_DIR (`test/.test-phase6-proof/`) with a nested `.db-cluster` subdir, amplified by Windows Defender real-time scanning of indexed paths and by `wave6-policy-proof.test.ts` accumulating ~80 uncleaned tmpdirs immediately before. Principled fix is two-part: migrate `wave6-proof.test.ts` TEST_DIR to `os.tmpdir()` per-test (Part 1), and make `CommandQueue.load()` LOUD when persistence is unexpectedly missing after a save (Part 2). The 24-file mass migration to `tmpdir()` is the proactive Stage B Tests intervention.

### CI/Docs (agent-cidocs-findings.md)

> The CI/Docs domain is functional but not proactively healthy. Three Stage A amend waves shipped CI workflows, completeness gates, mutation-testing config, and per-wave documentation churn — but several structural gaps persist:
>
> - The publish boundary is ungated (no `prepublishOnly`).
> - The release-gate is a coin flip on busy runners and has no documented retry/dispatch path.
> - Documentation drift recurs every wave (sdk.md fixed in A3, but `retrieval-bundles.md` and `provenance-graphs.md` carry the same drift class with the same root cause: hand-maintained example interfaces).
> - The completeness gates (R4/R5) are scoped too narrowly to regress-protect their stated targets.
> - Operator UX is sharp-edged: 41-file `docs/`, no entry-point map, tarball name hard-coded, stdout truncated.
>
> Wave B should close the publish-boundary gap, ship a doc-drift detector, broaden R4/R5, and document the release-gate flake honestly.

---

## 8. Should-have-been-stage-a tags (15)

These findings the v2 ensemble could and should have caught at Stage A. Listed here so the advisor can decide whether Stage A really exited cleanly, OR whether a brief Wave A4 sweep is warranted before Wave B1-Amend.

| ID | Domain | Severity | Why v2 ensemble missed it |
|---|---|---|---|
| KERNEL-B-007 (V2-004 Buffer/JSON) | Kernel | HIGH | Verifier-1 contract-completeness checked declared types; runtime round-trip not exercised |
| AGG-005 sub-findings (KERNEL-B-002/003) | Kernel | HIGH | Switch exhaustiveness checked at compile time; runtime policy injection not modeled |
| AGG-008 (KERNEL-B-006) | Kernel | HIGH | Cross-boundary lens caught labels-leak in concept; structured fix didn't ship |
| STORES-B-001 multi-process .tmp race | Stores | HIGH | No concurrency / TOCTOU lens (acknowledged in Wave A3 §10 lens-quality assessment) |
| STORES-B-003 silent duplicate-drop | Stores | HIGH | Cross-boundary lens would have caught with backup-tampering case study |
| STORES-B-015 trace() infinite loop | Stores | MEDIUM | Invariant-test lens would have caught with cyclic-chain property test |
| SURFACE-B-001 cluster_find_sources LIST | Surface | HIGH | AGG-001/003 audited singular paths; family-of-call-sites scan needed |
| SURFACE-B-002 policy explain DEFAULT_POLICIES | Surface | HIGH | Dry-run paths not in any verifier's scope |
| SURFACE-B-003 MCP raw err.message | Surface | HIGH | Outbound error path not in any verifier's scope |
| TESTS-A-MISS-001 / TESTS-B-003 CommandQueue silent-empty | Kernel (via Tests) | HIGH | Race-condition diagnosability not in any lens |
| TESTS-A-MISS-002 / TESTS-B-004 `__admin` cast | Tests | HIGH | TESTS-R2-006 docketed in re-audit-2; Wave A3 chose to ship without |
| CIDOCS-B-025 release-gate stdout slice(-500) | CI/Docs | HIGH | Operability observation outside any lens since Wave A1 |
| CIDOCS-B-026 vitest config disagreement | CI/Docs | MEDIUM | Observable since Wave A3 shipped stryker config; not in any lens |
| CIDOCS-B-027 lint script reporting | CI/Docs | LOW | Operability observation outside any lens |
| CIDOCS-B-015 workflow_dispatch missing | CI/Docs | MEDIUM | Operability observation outside any lens |

---

## 9. What hands to the advisor next

### Findings ready for Wave B1-Amend (no design decision required)

About 50 of the 130 unique findings are mechanical fixes with no ambiguity:

- All LOW + most MEDIUM in Kernel/Stores/Surface/CI/Docs
- Tests-B-001 (small surgical fix per the headline) + B-002 + B-005 + B-006
- CIDOCS-B-002 (add `prepublishOnly`), B-003 (add `engines`), B-006 (delete .txt files), B-007/008/009/010/011/015/016/017 (small CI tweaks)
- All `should-have-been-stage-a` finds where the fix is clear (SURFACE-B-001 wrap with sanitize; SURFACE-B-003 add `redactError`; KERNEL-B-002/003 add default arms)

### Findings that need a brief design pass before Wave B1-Amend (~10 architectural items)

These are large enough that the fix shape itself wants advisor review:

1. **AGG-005 redactor allowlist contract change** (KERNEL-B-002/B-003 + redactor refactor) — denylist→allowlist is a policy-authoring break; new policy files need migration path.
2. **AGG-008 TraceBuilder structured redaction** (KERNEL-B-006) — refactor `addNode` API + introduce `entity_name`/`artifact_filename` RedactionTargets.
3. **V2-004 Buffer/JSON resolution** (KERNEL-B-007) — choose between (a) Buffer-aware persistence (CommandQueue gets custom replacer/reviver) vs (b) reject Buffer at validate-time + require base64. Pick one and document.
4. **Lifecycle redaction boundary** (KERNEL-B-005 + KERNEL-B-015) — `cause.message` sanitization at error-construction site; `originalPayload` redaction in `compensateMutation`. Shared `redactErrorMessage(error): string` helper.
5. **Postgres v0.2 readiness** (STORES-B-005 + B-006 + B-009 + B-010 + B-013) — migrations registry table design; pool SSL/error handler/shutdown contract; optimistic concurrency contract for `update()`; metrics hook design; ledger archival contract.
6. **Doc-drift detector** (CIDOCS-B-001) — extract ```` ```typescript ```` blocks from `docs/**/*.md`, typecheck them; wire into release-gate stage 5. Pair with policy-doc consolidation (CIDOCS-B-014).
7. **Stryker decision** (CIDOCS-B-012, TESTS-B-009) — scope, migrate, or drop. Three viable paths; need advisor pick.
8. **CLI uniform try/catch + exit codes** (SURFACE-B-004) — `safeAction` wrapper across ~20 subcommands; doctrine on operator-facing vs internal errors.
9. **Test fixture mass migration to `tmpdir()`** (TESTS-B-007) — 24 files; 3-hour mechanical edit; needs advisor sign-off because it touches every domain's regression tests.
10. **Dashboard architecture clarification** (SURFACE-B-015 + B-021) — `ClusterTruthInspector.jsx`'s legacy flat schema vs `DashboardObject` doctrine; promote or demote `dashboard/components/`.

### Verdict

**Ready for Wave B1-Amend dispatch, with two pre-dispatch deliverables for the advisor:**

1. **Design pass on the 10 architectural items above** — about half can be one-paragraph design decisions ("Buffer/JSON: choose reject-at-validate"); 3-4 (redactor allowlist, TraceBuilder structured redaction, Postgres v0.2 readiness, doc-drift detector) want short design docs.

2. **Decide on `should-have-been-stage-a` tag**: are these 15 findings sufficient to warrant a brief Wave A4 sweep (closing the AGG family-of-sites + the silent corruption items) BEFORE Wave B1-Amend? Or fold them into Wave B1-Amend with explicit notation? The saturation criterion (Wave A3 §13) was met under the v2 spec; the proactive-lens audit shows the spec itself missed some classes. Advisor judgment call.

The proactive-health audit is complete. No CRITICAL findings. The cluster is structurally sound but materially less robust under stress than the Wave A3 close suggested — most notably on Windows-multi-process, on test-suite determinism, on publish-boundary gating, on dashboard observability, and on the documentation/release-signal pipeline. None of these are correctness blockers; all are wave-B-amend-able.

---

*End of Stage B Wave B1 audit report. Hand to advisor for Wave B1-Amend dispatch design (with the ~10 architectural items pre-decided) OR brief Wave A4 sweep on the 15 should-have-been-A items first.*
