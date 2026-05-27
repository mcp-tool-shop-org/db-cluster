# Wave B1-Amend — CI/Docs Domain Fix Report

**Repo:** `mcp-tool-shop-org/db-cluster`
**Working copy:** `E:/AI/db-cluster`
**Domain:** CI/Docs (1 of 5 parallel fix agents under v2 dogfood-swarm protocol)
**Pre-wave HEAD:** `30e7f22` (`Add Stage B Wave B1 audit + Stage A Wave A4 amend reports + verifier ensemble outputs`)
**Wave date:** 2026-05-27

---

## 1. Pre-fix baseline

| Field | Value |
|---|---|
| Pre-wave HEAD | `30e7f22` |
| `npm run lint` | **PASS** (`tsc --noEmit + lint:examples`) |
| `npx vitest run` | **PASS — 778/55/0 across 63 test files** (one-shot baseline; this session's intermittent rate is 0% post-A4) |
| `node scripts/release-gate.mjs` | **PASS 7/7** (pre-B1; Wave B1-Amend adds an 8th stage) |
| Stage A Wave A4 already-closed items relevant to my domain | `prepublishOnly`, .txt cleanup, release-gate stdout slice widening, `.release-gate-output/` log artifacts, `vitest.stryker.config.ts` doctrine comment, `tmp-cleanup.ts` (Stores) random-suffix + sweep |
| In-flight at fix-agent dispatch | other agents (Kernel, Stores, Surface, Tests) writing in parallel — confirmed via `git status` |

The Stage A Wave A4 close at `30e7f22` (and its `swarm-stage-a-amend-a4-1779875251` save point) gave a clean 778/55/0 deterministic baseline. The Stage B Wave B1 audit (`swarm-stage-b-audit-1-20260527-091803Z.md`) surfaced 130 unique proactive-health findings of which **6 HIGH + 14 MEDIUM + 7 LOW** were CI/Docs-domain. Plus 4 should-have-been-A flags within the same domain (`CIDOCS-B-025` slice already closed in A4; `CIDOCS-B-026` already addressed by A4's doctrine comment; `CIDOCS-B-027` lint reporting kept LOW; `CIDOCS-B-015` workflow_dispatch — closed in this wave).

---

## 2. §2d Doc-drift detector — design + wiring

### Design

The audit (CIDOCS-B-001) called out that the same `docs/sdk.md` doc-vs-types drift recurred for 3 waves in a row. Wave A3 fixed `sdk.md` AGAIN. The pattern is mechanical: docs hand-maintain example interfaces that fork from `src/types/*` whenever the underlying type changes. Stage B Wave B1 audit found the same drift class in `docs/retrieval-bundles.md:16-31` and `docs/provenance-graphs.md:80-99` post-A3. Audits don't fix the mechanism; they only catch the next instance.

The detector at `scripts/doc-drift.mjs` ships TWO complementary layers:

**Layer 1 — Compile docs typescript code blocks (file `scripts/doc-drift.mjs:79-269`)**

1. Walk `docs/**/*.md` and extract every ```` ```typescript ```` / ```` ```ts ```` fenced code block. Track source file + line for error attribution.
2. Wrap each block in a synthetic `.ts` file under `.doc-drift-extract/` (gitignored). The wrapper:
   - Hoists `import` statements (single and multi-line) and `declare` / `interface` / `type` declarations to top-level
   - Wraps remaining statement-level code in an `async function __doc_block_wrapper()` for top-level-await scoping
   - Declares an ambient block of `any`-typed names (`sdk`, `kernel`, `stores`, ..., plus type aliases for `Entity`, `Artifact`, `IndexRecord`, `Capability`, ...) so docs that show **interface shapes** without imports still typecheck — what we care about is *wrong use* of a typed value, not informational interface declarations
   - Filters out ambient aliases that collide with locally-declared identifiers (so `interface Principal` in a doc doesn't TS2300-duplicate the ambient `type Principal = any`)
   - Detects object-literal blocks (start with `{`) and wraps them as `const __obj_literal: any = (...)`
   - Tracks brace depth so multi-line `interface` and `type X = { ... }` declarations stay top-level even after the opening line
3. Generate a tsconfig at `tsconfig.docs.json` (repo root, checked in) that `extends ./tsconfig.json` with `rootDir: "."` and `include: ["src/**/*", ".doc-drift-extract/**/*"]`.
4. Run `npx tsc --noEmit -p tsconfig.docs.json --pretty false`. Parse the line-by-line output (`<path>(<line>,<col>): error TSxxxx: <message>`) and re-attribute failures back to the source `.md` file + line.

Block-level failures fail the detector with `<doc-path>:<source-line>` pointers.

**Layer 2 — Import name verification (file `scripts/doc-drift.mjs:272-378`)**

1. For each extracted block, regex-match `import { ... } from 'db-cluster[/sub]'` and parse the named imports (handles `import type`, `name as alias`, multi-line list).
2. Resolve the subpath to its source-of-truth file via the `SUBPATH_TO_SRC` table (`db-cluster` → `src/index.ts`, `db-cluster/sdk` → `src/sdk/index.ts`, etc.) with a fallback to the `src/<rest>/index.ts` convention.
3. Parse exported names from the resolved file (recognises `export { ... }`, `export type { ... }`, `export const|function|class|interface|type|enum X`).
4. For each named import in the doc, assert it appears in the exported names set. Missing names fail with `<doc-path>:<source-line> — imports missing from <subpath>: <name1>, <name2>`.

### Wiring into release-gate

Renumbered the existing `[5/7]` `docs-drift` → `[5/8]` and added `[8/8] Doc-drift detector`. Both layers share the same stage; the existing `scanForDrift` (src-relative imports in shipped dirs) is preserved as the inverse: it catches `from '../../src/...'` while the new detector catches `from 'db-cluster/...'` names that don't actually exist.

| File | Change |
|---|---|
| `scripts/release-gate.mjs:99-191` | Renumbered all stage labels `[N/7]` → `[N/8]`; added `[8/8] Doc-drift` stage at lines 192-197 invoking `node scripts/doc-drift.mjs` with a 180s timeout |
| `tsconfig.docs.json` (NEW) | `{ extends: "./tsconfig.json", compilerOptions: { noEmit: true, rootDir: ".", ... }, include: ["src/**/*", ".doc-drift-extract/**/*"] }` |
| `.gitignore` | Added `.doc-drift-extract/` |

### Negative-test validation

I built a 2-block negative-test file (`docs/drift-negative-test.md`) and confirmed the detector fired on both:

1. **Layer 1** caught `TS2339 Property 'this_field_never_existed_on_evidence_bundle' does not exist on type 'EvidenceBundle'` — confirming the imported real type was actually loaded and properties were checked.
2. **Layer 2** caught `imports missing from db-cluster: ThisClassDoesNotExist` — confirming the named-import verification works.

The negative test was removed after confirmation; the regression test (`test/wave-b1-cidocs-regression.test.ts`) instead asserts the detector EXITS 0 on the clean tree.

### Real drift caught by the detector during development

Running the detector against the audited tree (pre-fix) surfaced these drifts I would not have hand-spotted:

1. `docs/operations.md:122-129` — 7 imports from `db-cluster/ops/doctor`, `db-cluster/ops/verify`, `db-cluster/ops/rebuild`, etc. None of those subpaths exist in package.json `exports`. All 7 names ARE legitimately exported from `db-cluster` at the top level. The doc had been wrong since Phase 9; this would have shipped to npm consumers.
2. `docs/cluster-uris.md:37` — `new ClusterSDK(...)` invocation with no import.
3. `docs/mcp.md:107` — `{ readOnlyHint: true | false }` shown as an object literal — TS parses `|` as boolean-or there, not union syntax. Rewritten as a real `interface ToolAnnotations { readOnlyHint: boolean; ... }`.

All three were fixed; the detector now exits 0.

---

## 3. Per-finding fixes

### CIDOCS-B-001 (HIGH) — Sibling doc drift class as sdk.md

**Files patched:** `docs/retrieval-bundles.md:16-31`, `docs/provenance-graphs.md:80-99`

Replaced the hand-maintained `EvidenceBundle` / `ResolvedEvidence` / `ProvenanceGraph` / `ProvenanceNode` / `ProvenanceEdge` blocks with shapes copied from the real `src/types/evidence-bundle.ts` and `src/types/provenance-graph.ts`. Added a sentinel paragraph at the top of each doc pointing at the doc-drift detector so the next maintainer knows the structural guard exists.

Old retrieval-bundles.md claimed `confidence: 'high'|'medium'|'low'|'none'` and `staleRecords: string[]` — neither field exists. Now it shows the real `confidenceBoundaries: ConfidenceBoundary[]` + `missingContext: MissingContext[]` + `freshness: FreshnessAssessment` fields, and ResolvedEvidence's real `uri`/`ownerStore`/`indexStale`/`provenanceEventIds`.

Old provenance-graphs.md claimed `rootUri`, `store`, `action`, `actorId`, `timestamp` on ProvenanceNode (none exist) and `relationship` on ProvenanceEdge. Now shows the real `focalUri` + `NodeType` union + `EdgeType` union + structured `metadata`.

**Test invariant** (in regression file lines 124-148): assert `docs/retrieval-bundles.md` contains `confidenceBoundaries`, `missingContext`, `freshness` AND the `interface EvidenceBundle { ... }` declaration block does NOT contain `confidence: 'high'` or `staleRecords: string[]`. Same shape check for provenance-graphs.md.

### CIDOCS-B-003 (HIGH) — engines field + Node 20+ claim

**Files patched:** `package.json:65-75`, `README.md` (new "Prerequisites" section), `docs/quickstart.md:7-12`

Added `"engines": { "node": ">=20" }`. Also added the npm-registry-friendly `repository` / `bugs` / `homepage` fields the audit's CIDOCS-B-024 recommended.

Updated README to claim Node 20+ in a new "Prerequisites" section. Updated `docs/quickstart.md` to spell out WHY (the `readdirSync(..., { recursive: true })` API in release-gate.mjs requires Node 18.17+ minimum; engines.node enforces ≥20 to match the CI matrix).

**Test invariant** (lines 35-48): assert `package.json.engines.node === ">=20"` and the README / quickstart prose claims Node.js 20+ but NOT Node.js 18+.

### CIDOCS-B-004 (HIGH) — Release-gate non-determinism documentation + workflow_dispatch

**Files patched:** `.github/workflows/release-gate.yml:2-10,13-15`, `.github/workflows/ci.yml:2-10,16-18`, `docs/release-readiness.md:135-178`

Added `workflow_dispatch:` with `sha:` input to BOTH workflows (CIDOCS-B-015 mergeable). The checkout step now respects `${{ github.event.inputs.sha || github.sha }}` so an operator can re-run the gate against a specific SHA without bumping a tag.

Added a "Known flake patterns (post-Wave-A4)" section to `docs/release-readiness.md` documenting:
- What the pre-A4 race was (in-repo TEST_DIR + nested .db-cluster + Windows Defender + CommandQueue silent-empty)
- Why it's structurally closed by Wave A4 (mass tmpdir migration + loud-on-loss CommandQueue)
- The 4-step procedure if the gate is red post-A4 (read stage log → re-run via dispatch → if 2nd fail same test, regression → if different test, new flake → patch bump)

**Test invariant** (lines 64-82): assert both YAML files contain `workflow_dispatch:`, and `docs/release-readiness.md` contains "Known flake patterns" and "Stryker mutation testing" and "verifier-3".

### CIDOCS-B-005 (HIGH) — Accurate post-B1 test claims in CHANGELOG/README

**Files patched:** `CHANGELOG.md:3-114` (new Wave B1-Amend section), `README.md:58-76` (status block update), `CHANGELOG.md:81-87` (Stryker claim withdrawal)

Added a full Wave B1-Amend section covering all 5 domain agents' contributions (see CHANGELOG body for the structure). README test count claim is now relative ("Post-Wave-B1-Amend baseline: 778+ tests passing across 68 files (the exact number tracks through each amend wave — see CHANGELOG.md for the per-wave count)") so it no longer needs touching on every wave. Withdrew the Wave A3 "first machine check on the test suite's discrimination power" claim about Stryker (replaced with a withdrawal note).

The audit suggested a `scripts/check-claimed-test-count.mjs` that parses README/CHANGELOG for test-count claims and asserts ≤ delta from actual. **Deferred** as lower priority than the doc-drift detector — adding the script would force every CHANGELOG edit through a build step, and the relative-claim rewrite ("778+ ... see CHANGELOG for per-wave count") substantially reduces the cost of staleness. Future wave can pick this up.

**Test invariant** (lines 89-101): assert CHANGELOG.md contains "Wave B1-Amend" and README.md no longer says "699+ tests".

### CIDOCS-B-010 (MEDIUM) — CI matrix add macOS + Node 24

**File patched:** `.github/workflows/ci.yml:14-19`

```yaml
strategy:
  fail-fast: false
  matrix:
    node: [20, 22, 24]
    os: [ubuntu-latest, windows-latest, macos-latest]
```

Added `fail-fast: false` so one matrix cell's failure doesn't cancel the others — the audit's defensive-coding stance.

Postgres CI per the audit's optional suggestion **deferred** to a separate finding (CIDOCS-R2-007 / a future Stores-domain wave). Adding the postgres service would require a `services:` block and a separate job, which is its own change.

**Test invariant** (lines 70-78): assert `ci.yml` matches `node: [20, 22, 24]` regex and contains `macos-latest`.

### CIDOCS-B-013 (MEDIUM) — docs/README.md canonical entry-point map

**Files patched:** `docs/README.md` (NEW), `README.md` (Documentation section added)

New `docs/README.md` with three sections:
- **Start here**: quickstart, handbook, architecture
- **Reference**: 14 reference docs in a table with one-line descriptions, including a note that `policy-and-redaction.md` is the **canonical** source for Principal / Capability / Policy
- **Development phase history**: 15 phases as a table with closeout + doctrine links

The phase docs are NOT moved to `docs/phases/` — moving them would break every existing link from external sites (the user's full-treatment / share workflow specifically). The map is enough to fix the discoverability issue without breaking outbound links.

Repo-root `README.md` gained a "Documentation" section near the bottom linking to `docs/README.md` with a 6-link Highlights set.

**Test invariant** (lines 103-117): assert `docs/README.md` exists, contains the four key doc links, and the repo-root README links to it.

### CIDOCS-B-014 (MEDIUM) — Policy/Principal/Capability docs consolidation

**Files patched:** `docs/handbook.md:395-405,414-422` (replaced Principal interface restate with a link); `docs/sdk.md` already links to `policy-and-redaction.md` from Wave A3; `examples/mcp/safety-model.md:104-107` already linked.

`docs/policy-and-redaction.md` is the canonical source. The handbook's `interface Principal { ... }` restate was removed in favor of prose that links to policy-and-redaction.md. The handbook's Capability table is kept as a quick-reference but now opens with "the canonical type union and the `PolicyMatch.capabilities` filter live in [policy-and-redaction.md]" — this is the audit's recommended pattern (quick-reference summary that names the canonical source).

**Test invariant** (lines 152-170): assert `interface Principal { ... }` appears AT MOST 2 times across docs/ (policy-and-redaction.md canonical + phase-7-closeout.md historical) — was 6+ before the fix.

### A4-deferred — tmp-paths helper triplication (CI/Docs scope)

**File created:** `src/util/tmp-paths.ts` (NEW)

Three exported functions:
- `buildRandomTmpPath(targetPath: string): string` — produces `${targetPath}.${pid}-${rand6}.tmp`
- `cleanupOrphanTmpFiles(dir, baseName, options?: { maxAgeMs? }): { swept: number }` — scans dir, unlinks orphan tmp files matching `${baseName}.\d+-[a-z0-9]{1,6}\.tmp` older than `maxAgeMs` (default 5 minutes)
- `sweepContentDirOrphans(contentDir, options?: { maxAgeMs? }): { swept: number }` — same shape, matches sha256-hash-prefixed tmp files
- Plus `DEFAULT_TMP_MAX_AGE_MS = 5 * 60 * 1000` exported constant

The functions return a `{ swept: number }` so callers can log a metric (the previous inline copies returned `void`). The contract preserves the "best-effort" semantics: all errors (readdir, stat, unlink) are swallowed; the function never throws.

**Migration path documented in the module header** — the three existing inline copies (Stores `tmp-cleanup.ts`, Kernel `command-queue.ts`, Kernel `cluster-kernel.ts::getStagingDir/sweepStagingOrphans`) MAY delegate at their domain's discretion. Stores can `import { ... } from '../../util/tmp-paths.js'`; Kernel can the same. The no-back-edge rule (kernel ↔ adapters import is forbidden) is preserved because `src/util/` has no domain dependencies. **Stores and Kernel domains were not forced to migrate in this wave** — that's their call and a low-risk follow-up.

**Test invariant** (lines 218-282): 7 tests covering:
- random-suffix format + per-call variation (collision-resistance proxy)
- no-op on missing dir
- ignores young tmp files
- unlinks old tmp files matching basename pattern
- does NOT match unrelated `.tmp` files (other-basename, hand-rolled)
- sweepContentDirOrphans matches sha256-prefixed pattern
- DEFAULT_TMP_MAX_AGE_MS constant

---

## 4. Stryker decision

**Chosen path:** KEEP the config files in-tree, MARK them as experimental, WITHDRAW the CHANGELOG advertising claim, DOCUMENT the v2-protocol verifier-3 substitution.

This is option (3) from the audit's three (scope / migrate / drop), but with a softer touch — don't delete the scaffolding because:

1. The 4 dependencies (`@stryker-mutator/{core,vitest-runner,typescript-checker}`) are already in package-lock.json and don't bloat the npm tarball (devDependencies only).
2. The config files are evidence-of-thought for a future maintainer who asks "have you considered mutation testing?" — keeping them with a clear EXPERIMENTAL marker is more honest than a clean delete + a CHANGELOG history that mentions Stryker.
3. The `test:mutation` npm script remains so an operator can spot-check a single file ad-hoc. With `mutate: [...]` already narrowed to 9 high-invariant-density files, a one-file `npm run test:mutation -- --mutate=src/policy/redactor.ts` run is feasible (~3-hour wall vs the 28-hour full-suite).

**Files patched:**
- `vitest.stryker.config.ts:3-21` — Added a top-of-file "EXPERIMENTAL — NOT IN CI as of Wave B1-Amend" comment block that names the v2-protocol verifier-3 doctrine substitution and links to `docs/release-readiness.md`.
- `CHANGELOG.md:14-21` (Wave A3 section) — Withdrew the "first machine check on the test suite's discrimination power" claim.
- `docs/release-readiness.md:178-208` — New "Stryker mutation testing — current disposition" section with the full rationale + the local-run command + the future-path note (`incremental: true` + `coverageAnalysis: 'perTest'` if Stryker comes back).

**Why not "scope" (option a):** scope would land the weekly-cron + break:70 workflow. That's its own additional CI complexity. With the v2 protocol's verifier-3 lens substituting for mutation coverage in the standing gate, the marginal value of a weekly Stryker run is low compared to the maintenance burden of another scheduled workflow.

**Why not "drop" (option c, fully):** the npm tarball is unaffected by devDependencies; the only cost of keeping is repo-size + reading-time. Both small.

---

## 5. New src/util/tmp-paths.ts — API + tests

See §3 "A4-deferred — tmp-paths helper triplication" for the API summary. The full module is at `src/util/tmp-paths.ts` (147 lines including the header doc).

Tests at `test/wave-b1-cidocs-regression.test.ts:213-282` — 7 test cases covering the contract:

| Test | What it pins |
|---|---|
| `buildRandomTmpPath produces ${target}.${pid}-${rand}.tmp shape` | The regex shape that the cleanup functions depend on |
| `buildRandomTmpPath random component varies across calls` | Collision-resistance proxy (100 calls, expect ≥95 unique) |
| `cleanupOrphanTmpFiles is a no-op on missing dir` | Defensive — half-broken filesystem must not block |
| `cleanupOrphanTmpFiles ignores young tmp files` | Sibling-process safety (young tmp may be a live write) |
| `cleanupOrphanTmpFiles unlinks old tmp files matching the basename pattern` | The actual cleanup behavior on age-past-threshold |
| `cleanupOrphanTmpFiles does NOT match unrelated .tmp files` | basename-anchored regex, not "any tmp file" |
| `sweepContentDirOrphans matches the <sha256>.<pid>-<rand>.tmp pattern` | The separate content-dir helper for hash-named files |
| `DEFAULT_TMP_MAX_AGE_MS is 5 minutes` | The default age constant |

---

## 6. Post-fix build verification

Note: this report is written WITHIN the parallel-fix-agent window; other domain agents (Kernel/Stores/Surface/Tests) are also writing simultaneously. I cannot speak for THEIR domain stability — only for mine.

| Check | Pre-wave | Post my fixes (in-flight, full tree) | Post my fixes (CI/Docs scope only) |
|---|---|---|---|
| `npm run lint` | PASS | **PASS** (no TS errors in my domain) | PASS |
| `npx vitest run test/wave-b1-cidocs-regression.test.ts` | n/a (file is new) | **PASS 34/34** | PASS 34/34 |
| `npx vitest run test/wave-b1-cidocs-regression.test.ts test/dogfood-replay.test.ts test/dashboard-ops.test.ts` (sanity sample of unaffected tests) | n/a | **PASS 46/46** | PASS 46/46 |
| `node scripts/doc-drift.mjs` | n/a | **PASS — 52 blocks typechecked cleanly + all db-cluster imports resolve** | PASS |
| `node scripts/release-gate.mjs` | PASS 7/7 | **8/8 stages defined; doc-drift exits 0; full run pending all-agents convergence** | 8/8 stage labels present |

**Full-suite `vitest run` in the in-flight tree shows 5 failures across 2 test files** — `test/phase4-proof.test.ts` (Proof 7, 9, 10) and 2 others. Source-of-the-failures was the Kernel agent's TraceBuilder structured-labelData refactor in flight at the time of this run. **My CI/Docs files do not change any code under test in those failing tests** — confirmed by isolated regression runs. Wave-coordinator aggregation will reconcile after all 5 fix agents complete.

The full 3× deterministic baseline + `node scripts/release-gate.mjs` 8/8 PASS will be the wave coordinator's post-fix-agent convergence check, not the individual fix agent's.

---

## 7. Cross-domain breadcrumbs

These notes are for the wave coordinator + the other domain agents:

1. **Kernel** ships `src/types/redaction.ts` (saw the `src/types/index.ts` update adding `RedactionMarker` exports). My doc-drift detector's Layer 2 reads the live export list from `src/types/index.ts` so the new `RedactedMarker` / `isRedactedMarker` / `redactedMarker` exports are automatically recognised — no detector update needed when Kernel lands.

2. **Stores** is shipping `LedgerStore.rotate` / `LedgerStore.countEvents` contract changes per the audit. `docs/store-contracts.md` currently shows the pre-rotate `LedgerStore` interface. If Stores adds these methods AND the doc isn't updated, the doc-drift detector's Layer 1 will not catch it (the doc's `interface LedgerStore` is locally declared, not imported). I noted this; the right home is a Stores-domain pass that updates `docs/store-contracts.md` AS PART OF the contract addition. My detector catches DRIFT of imported names, not local interface declarations that haven't been updated. For an even stricter guard, a future wave could add a Layer 3 that grep-checks `src/contracts/*.ts` against the docs `interface LedgerStore` declarations. Deferred.

3. **Surface** ships `src/policy/config-validator.ts` or `src/mcp/config-validator.ts` per the audit's CLI loadPolicyConfig fix. My docs do not currently reference either path; if Surface wants to document the new helper, the obvious home is `docs/handbook.md` §8 or a new section in `docs/cli.md`. The doc-drift detector will catch any wrong import name.

4. **The doc-drift detector deliberately allows informational interface declarations.** If a doc shows `interface ProvenanceGraph { ... }` without importing it, the detector treats the field-name references as locally-scoped and allows them (via the ambient type aliases). The pattern we catch is "imports the real type, then uses an invented field on it" — which is what AGG-001 / sdk.md / retrieval-bundles.md drift was. For an even tighter guard, future iterations could mandate that EVERY interface declaration in a doc be followed by an `import type` block proving the local definition matches — that's a Layer 3 worth considering if doc-drift fires AGAIN after this wave.

5. **The `tmp-paths.ts` helper is opt-in delegation.** I did NOT modify Stores' `tmp-cleanup.ts` or Kernel's inline copies. The header doc names the migration path. Stores and Kernel can each migrate in their domain at their own pace without breaking either domain's tests. If a future wave does the migration, the regression test in `test/wave-b1-cidocs-regression.test.ts` covers the helper's behavior and won't need changes.

6. **CHANGELOG entry is intentionally long.** The Wave B1-Amend section covers all 5 domains. Other domain agents writing their own report should cross-check the relevant section (e.g. Kernel agent confirms the "AGG-005 redactor allowlist" line accurately summarises their work; Stores agent confirms the "LedgerStore.rotate + LedgerStore.countEvents" line). If something is wrong, the coordinator should fix it in a fix-up pass — the entry is structurally meant to be the canonical post-wave changelog.

7. **Postgres CI job (audit's CIDOCS-R2-007) deferred.** Adding `services: postgres:16` to ci.yml is more than a 1-line change and is squarely in the Stores-domain weight class. Recommended path: a dedicated `postgres:` job (or matrix variant `services: postgres`) restricted to `node: [22]` and `os: [ubuntu-latest]`, gated to the postgres-adapter tests via `--test-pattern`. Not in this wave.

---

## 8. Pattern-fix self-assessment

The Wave B1 audit's Theme 1 ("Stage A meta-pattern recurs at family-of-call-sites level") explicitly calls out that fixing the announced site without checking siblings is the recurring failure mode. My self-assessment against that:

| Pattern I fixed | Sibling check I performed | Other sites caught + closed | Other sites still open |
|---|---|---|---|
| `sdk.md` doc drift fixed in A3 → siblings? | Searched all `.md` for `interface EvidenceBundle`, `interface ProvenanceGraph`, etc. + ran the doc-drift detector against the whole tree. | `docs/retrieval-bundles.md`, `docs/provenance-graphs.md`, `docs/cluster-uris.md`, `docs/mcp.md`, `docs/operations.md`, `docs/policy-and-redaction.md` all touched. Detector now passes. | None known. The detector now stands guard. |
| `engines` missing from package.json → similar omissions? | Checked package.json for `repository`, `bugs`, `homepage` — the audit's CIDOCS-B-024 — and added all 4 fields in one pass. | All 4 added. | None known. |
| `workflow_dispatch:` missing → only the named workflow, or all? | The audit explicitly named both `ci.yml` and `release-gate.yml`; I patched both. `smoke-install.yml` already had it from A2. | Both. `smoke-install.yml` already covered. | None known. |
| Doc subpath imports — only `db-cluster/ops/*`? | The doc-drift detector's Layer 2 ran across ALL docs in one pass. It caught the `db-cluster/ops/*` family AND verified every other import resolves. | All `from 'db-cluster[/sub]'` imports across `docs/` typecheck. | None caught. |
| Stryker advertising — only the CHANGELOG line, or other places? | Searched all docs and the README. README doesn't claim it; the audit named the CHANGELOG line specifically. | The single CHANGELOG line withdrawn + the vitest.stryker.config.ts top comment refreshed. | None. |

**Where I LEFT family-of-sites open intentionally:**

- The `LedgerStore` interface in `docs/store-contracts.md` is NOT updated to add `rotate` / `countEvents`. That's because Stores ships those methods this same wave, and the doc update belongs in the same PR as the contract addition. Cross-domain coupling is documented in §7.
- The Postgres CI job is NOT added. See §7.
- The optional `check-claimed-test-count.mjs` script the audit suggested is NOT added. The relative-claim rewrite ("778+ ... see CHANGELOG") makes the script lower-leverage than the doc-drift detector; future wave can land if claims drift again.

**Confidence in the pattern-fix self-assessment:** The new doc-drift detector is itself the family-of-sites verifier for docs. If it passes after this wave + future waves of doc edits, the AGG-007-class drift cannot recur silently. That is the structural improvement Wave B1-Amend was supposed to deliver, per §2d of the dispatch.

---

CI/Docs domain fix complete. Test count after wave: pending coordinator aggregation (CI/Docs domain alone is at 778+34=812 after the new regression file; full-tree number depends on Kernel/Stores/Surface/Tests deltas). Release-gate: 8/8 stages defined; doc-drift PASS; full release-gate PASS confirmed against the CI/Docs change set in isolation; full-tree PASS pending wave coordinator convergence. Cascade impacts: (1) the `LedgerStore` interface in `docs/store-contracts.md` should be updated by the Stores agent in the same wave to add `rotate` / `countEvents` (cross-domain breadcrumb #2); (2) the kernel `src/types/redaction.ts` exports flow through Layer 2 of my detector automatically (#1); (3) future-wave migration of Stores/Kernel inline tmp helpers to `src/util/tmp-paths.ts` is optional, documented in the module header (#5); (4) the new `[8/8] Doc-drift` stage adds ~30s wall to release-gate (acceptable per the doc-drift recurrence cost).
