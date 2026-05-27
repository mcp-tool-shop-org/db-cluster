# Stage B Audit — CI/Docs Domain — db-cluster

**Lens:** Proactive Health
**Date:** 2026-05-27
**HEAD audited:** 71ba55c

## Files audited

- `README.md`
- `CHANGELOG.md`
- `LICENSE`
- `.gitignore`
- `package.json`, `package-lock.json`
- `tsconfig.json`, `tsconfig.examples.json`
- `vitest.config.ts`, `vitest.stryker.config.ts`, `stryker.conf.json`
- `.github/workflows/{ci.yml,release-gate.yml,smoke-install.yml}`
- `scripts/release-gate.mjs`, `scripts/smoke-install.mjs`, `scripts/completeness-checks.mjs`
- `scripts/checks/{R1,R2,R3,R4,R5}.yml`
- `docs/architecture.md`, `docs/cli.md`, `docs/cluster-uris.md`, `docs/handbook.md`,
  `docs/mcp.md`, `docs/mutation-law.md`, `docs/operations.md`, `docs/package-boundary.md`,
  `docs/policy-and-redaction.md`, `docs/provenance-graphs.md`, `docs/quickstart.md`,
  `docs/release-notes-v0.1.md`, `docs/release-readiness.md`, `docs/retrieval-bundles.md`,
  `docs/sdk.md`, `docs/store-contracts.md`
- `docs/phase-{0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15}-closeout.md` (plus sub-phase docs)
- `docs/repo-knowledge-mapping.md`, `docs/phase-14-repo-knowledge-integration-{gate,report}.md`,
  `docs/phase-12-{dogfood-repair,repair-report}.md`, `docs/phase-11-dogfood-report.md`
- Root-level stray files: `AI Safe Data Control Plane over Fed.txt`,
  `Is it true that AI has a hard time.txt`, `phase map.txt`, `db-cluster-0.1.0.tgz`
- Source files referenced for doc-drift verification only: `src/types/evidence-bundle.ts`,
  `src/types/provenance-graph.ts`, `src/ops/backup.ts`, `src/cli.ts`, `src/mcp/server.ts`

## Severity rollup

| Severity | Count |
|---|---:|
| HIGH | 6 |
| MEDIUM | 14 |
| LOW | 7 |
| should-have-been-stage-a | 4 |

(Total: 27 of 30 cap.)

## Findings (HIGH then MEDIUM then LOW)

### CIDOCS-B-001 — `docs/retrieval-bundles.md` and `docs/provenance-graphs.md` carry the same kind of sdk.md drift Wave A3 just fixed

**Severity:** HIGH
**Category:** observability
**File:** `docs/retrieval-bundles.md:16-31`; `docs/provenance-graphs.md:80-99`
**Description:** Wave A3 fixed `docs/sdk.md` `EvidenceBundle` examples (CIDOCS-R2-001) after Wave A2 and Wave A1 each found similar drift. The same exact class of drift still lives in two sibling docs that Wave A3 did not touch.

- `retrieval-bundles.md:16-31` declares `EvidenceBundle` with `confidence: 'high'|'medium'|'low'|'none'` and `staleRecords: string[]` — neither field exists. Real shape (`src/types/evidence-bundle.ts:17-40`): `id`, `assembledAt`, `provenanceEvents`, `freshness: FreshnessAssessment`, `missingContext: MissingContext[]`, `confidenceBoundaries: ConfidenceBoundary[]`. `ResolvedEvidence<T>` in the doc shows `sourceUri`/`fresh`; real shape (`evidence-bundle.ts:45-56`) is `uri`/`ownerStore`/`indexStale`/`provenanceEventIds`.
- `provenance-graphs.md:80-99` declares `ProvenanceGraph` with `rootUri`; real field is `focalUri` (`provenance-graph.ts:96-117`). `ProvenanceNode` doc shows `store`/`action`/`actorId`/`timestamp`; real shape (`provenance-graph.ts:42-55`) is `uri`/`type: NodeType`/`ownerStore`/`isSourceTruth`/`label`/`metadata?`/`isGap?`. `ProvenanceEdge` doc shows `relationship`; real field is `type: EdgeType` plus `reason`.

This is the third wave in a row to find docs-vs-types drift. The Wave A3 fix closed the sdk.md instances but the underlying mechanism (hand-maintained example interfaces) is unchanged, so the same drift will recur on the next type change.

**Recommendation:** Treat doc-drift as systemic, not whack-a-mole. Two complementary fixes:
1. **Wave-B inclusion** of these two docs (mechanical: copy real interfaces from `src/types/`).
2. **A doc-drift detector** for the release-gate stage 5: extract every ```` ```typescript ```` block from `docs/**/*.md`, write them to temp `.ts` files, run them through `tsc --noEmit` against the real types. The carry-over note in the brief flagged this as a candidate; the recurrence here makes it load-bearing.

**Evidence:** Wave A1, A2, A3 each fixed a doc that contradicted a `src/types/` shape. Wave A3's CIDOCS-R2-001 acknowledgment is in `CHANGELOG.md:61-65`; the same drift class persists in `docs/retrieval-bundles.md:16-31` and `docs/provenance-graphs.md:80-99` after that fix shipped.

---

### CIDOCS-B-002 — `npm publish` has no gate; `prepublishOnly` missing

**Severity:** HIGH
**Category:** defensive
**File:** `package.json:43-54`
**Description:** This was flagged as carry-over CIDOCS-011/R2-009 and confirmed present. `package.json` defines `prepack: "npm run build"` but not `prepublishOnly`. A maintainer (or a CI workflow firing on tag push) running `npm publish` skips the entire release-gate by definition — `prepack` only runs during `npm pack`, while `prepublishOnly` is the documented hook that `npm publish` honors and that wraps `pack`. Combined with the release-gate's flake history (the wave6-proof race surfaces here), this is the single most consequential defensive gap: anyone with publish rights can ship a tarball that has never seen the gate.

**Recommendation:**
```json
"scripts": {
  "prepublishOnly": "node scripts/release-gate.mjs"
}
```
And in the publish runbook (currently `docs/release-readiness.md` §"Recommended release flow"), name `prepublishOnly` explicitly so a human running `npm publish` from a workstation also goes through the gate.

**Evidence:** `package.json:50` has `prepack`; no `prepublishOnly`. `docs/release-readiness.md:54-75` describes a recommended release flow built around CI workflows but does not address the local-workstation publish path or hook gating.

---

### CIDOCS-B-003 — `engines` field missing; release-gate uses Node-18.17+ API

**Severity:** HIGH
**Category:** defensive | future-proofing
**File:** `package.json` (no `engines`); `scripts/release-gate.mjs:69-71`; `docs/quickstart.md:7`
**Description:** Carry-over CIDOCS-R2-006 confirmed.

- `release-gate.mjs:69` uses `readdirSync(dir, { withFileTypes: true, recursive: true })`. The `recursive: true` option was added in Node 18.17.0; on Node 18.0.0–18.16.x this returns `TypeError [ERR_INVALID_ARG_TYPE]`.
- `package.json` has no `engines` field, so npm/yarn cannot warn the consumer.
- `docs/quickstart.md:7` says "Node.js 18+" — strictly true if you read "18" as ≥18.17, but the doc does not say that.

So a consumer on Node 18.0–18.16 follows the README's "Node 18+" claim, runs `npm install db-cluster`, then runs `node scripts/release-gate.mjs` (if they cloned the repo) and gets a TypeError instead of "Node version too old."

**Recommendation:** Add `"engines": { "node": ">=20" }` to `package.json` (the CI matrix already only tests 20 and 22 — this just makes the policy explicit and gives `npm install` a clean warning). Update `docs/quickstart.md:7` and `docs/release-readiness.md` to match. Optionally, if you want to keep the 18.17+ contract narrower than 20, use `">=18.17"` and bump CI's lower bound to 18.17.0.

**Evidence:** `release-gate.mjs:69` `readdirSync(dir, { withFileTypes: true, recursive: true })`. Node release notes: `recursive` option added in v18.17.0. `package.json` has no `engines` key in the 82-line file. CI matrix at `ci.yml:11-13` tests `node: [20, 22]`.

---

### CIDOCS-B-004 — Release-gate is a non-deterministic gate, undocumented as such

**Severity:** HIGH
**Category:** degradation | observability
**File:** `.github/workflows/release-gate.yml`; `scripts/release-gate.mjs:39-41`; `docs/release-readiness.md`
**Description:** This session observed 22-fail / 20-fail / 0-fail across three runs of the full vitest suite. Stage 2 of `release-gate.mjs` (`npx vitest run`, line 41) runs that same suite. Therefore: the release gate randomly fails. The brief explicitly raised this. Several proactive-health consequences:

1. **Tag-push smoke and release-gate workflows are not gates** — they are coin flips on a fast cluster. A clean push can fail. A genuinely-broken push can pass.
2. **No retry policy is documented** — operators have no idea whether one red checkmark means "the bug returned" or "the wave6-proof race fired again." The release-readiness doc has no "if the gate is red" section.
3. **No `workflow_dispatch` on `release-gate.yml`** (`release-gate.yml:2-5` triggers only on push to main + `v*` tags) — when the gate is red, the operator can't trigger a fresh run on a specific SHA without an empty commit or a tag-bump.
4. **Stage 2 in `release-gate.mjs` only logs the last 500 bytes of stdout/stderr** (`release-gate.mjs:25-26`). With a 699-test suite that prints per-file headers, the failing test name is often outside the tail window, so the actual flake is invisible to the human reading CI logs.

The Tests-domain root cause (`wave6-proof.test.ts` race) is not yours to fix. The CI/Docs-side mitigation is yours.

**Recommendation:**
1. Add `workflow_dispatch:` trigger to `release-gate.yml` and `ci.yml` (both lack it; `smoke-install.yml:7` has it). This gives the operator a re-run button without touching the tree.
2. Add a "Known flaky tests / how to handle a red gate" section to `docs/release-readiness.md` near §"Recommended release flow" naming the wave6-proof race, the empirical rate, and the procedure (re-run via dispatch; bail to v0.1.1+1 only if it fails twice).
3. Add a CHANGELOG entry to v0.1.0 declaring "release-gate is currently best-of-N" so downstream consumers reading the release page see the limitation.
4. Increase the `slice(-500)` tail buffer in `release-gate.mjs:25-26` to at least `slice(-8000)`; or pipe per-stage stdout to a per-stage log file that the CI workflow uploads as an artifact, so the failing test name is preserved.

**Evidence:** Session observation in the brief. `release-gate.yml:2-5`. `release-gate.mjs:25-26`. `vitest.config.ts:5` (`fileParallelism: false` already shows the suite is contention-aware) and `vitest.stryker.config.ts:6-15` excludes 9 files known to require sequential or special handling, including `wave6-proof.test.ts`.

---

### CIDOCS-B-005 — CHANGELOG promises ship-ready coverage that release-gate cannot deliver on a flaky suite

**Severity:** HIGH
**Category:** observability
**File:** `CHANGELOG.md:1-72`; `README.md:58`
**Description:** Wave A3's CHANGELOG entry (`CHANGELOG.md:1-72`) reads as a clean closeout: "699+ tests passing", mechanical completeness gates, test-first gate. Nothing in the CHANGELOG signals that the suite is flake-prone or that the release-gate is currently best-of-N. The README at line 58 carries the same framing.

A reader landing on the GitHub release page or the npm `README` for `v0.1.0` will believe the gate is deterministic. A reader running the gate locally on a marginally-slow rig will see it fail and assume regressions, not a known race.

This is the observability axis: the product's external signal does not match its internal reality. The operator needs to know.

**Recommendation:** Two small additions:
1. CHANGELOG entry under "Wave A3 — Tests" (or a fresh "Known issues" section): "wave6-proof.test.ts contains a race that fires under load. The full suite passes in steady state but may require re-running release-gate on busy runners."
2. README §Status (line 58) add one line: "Tests: 699/53/0 in steady state; suite has a known race condition under load — see CHANGELOG."

This is doctrine-aligned: the cluster surfaces gaps explicitly (`missingContext`, freshness). Apply the same surface-the-gap discipline to the project's own test suite.

**Evidence:** `CHANGELOG.md:1-72` has zero mention of flake/race. `README.md:58` says "Phase 15 — Release Readiness & Package Boundary: PASS. 699+ tests passing across 63 files (post-Wave-A3 count finalized in the amend report)." Session log: 22 fails → 20 fails → 0 fails.

---

### CIDOCS-B-006 — Three loose `.txt` files committed at repo root

**Severity:** HIGH
**Category:** defensive | future-proofing
**File:** `AI Safe Data Control Plane over Fed.txt`, `Is it true that AI has a hard time.txt`, `phase map.txt`
**Description:** Carry-over CIDOCS-009 / R2-008 confirmed. All three files are git-tracked (`git ls-files --error-unmatch "AI Safe Data Control Plane over Fed.txt"` succeeds; `.gitignore` does not match them). They have brainstorming-document filenames with spaces and capital letters, suggesting they were dragged into the repo from an AI chat session. They contribute to:

- **First-impression damage** — anyone landing on the GitHub repo via `mcp-tool-shop-org/db-cluster` sees these alongside README, CHANGELOG, LICENSE.
- **npm package noise** (mitigated — `package.json:34-42` `files` field restricts the tarball, so the txt files do NOT ship; verified). The damage is purely on the GitHub-visible repo.
- **Future-proofing** — without a `docs/notes/` discipline, the next thinking-out-loud document goes here too.

This persisted through three amend waves with the Stage A audits explicitly flagging it.

**Recommendation:**
1. Either delete the three files or move them to `docs/notes/` (which is currently absent — creating the directory establishes the convention).
2. Add `/notes/` or `*.scratch.md` to `.gitignore` for future drag-drops.

**Evidence:** Files exist at repo root (verified via `ls -la`). All three tracked in git (verified via `git ls-files --error-unmatch`). Wave A1, A2, A3 did not touch them.

---

### CIDOCS-B-007 — `smoke-install.yml` PR trigger only fires on `package.json` changes

**Severity:** MEDIUM
**Category:** observability | future-proofing
**File:** `.github/workflows/smoke-install.yml:5-6`
**Description:** Carry-over CIDOCS-R2-005 confirmed. The workflow only triggers on PRs that touch `package.json`. The whole point of smoke-install is to catch "the installed package doesn't behave like the in-tree code" regressions — but those regressions arrive through src/, not through the package.json. A PR that adds a new SDK method without bumping the version (because the version is still 0.1.0) will not trigger smoke-install on the PR, will not trigger it on merge to main (no path), and will only be tested at tag push — after merge, when rolling back is git-history pollution.

**Recommendation:** Broaden the PR trigger:
```yaml
pull_request:
  paths:
    - 'package.json'
    - 'src/**'
    - 'scripts/smoke-install.mjs'
    - 'scripts/release-gate.mjs'
```
Or simpler: drop `paths:` and let it run on every PR. Smoke-install takes ~30 sec on an `ubuntu-latest` runner, which is small price for a real gate.

**Evidence:** `smoke-install.yml:5-6` `pull_request: paths: ['package.json']`.

---

### CIDOCS-B-008 — R5 completeness rule scope is too narrow (`src/contracts/` only)

**Severity:** MEDIUM
**Category:** defensive
**File:** `scripts/checks/R5-optional-import-contract-method.yml:36`; `src/ops/backup.ts:113,138,175,195`
**Description:** Carry-over AGG-007 confirmed. R5 declares `files: ["src/contracts/*.ts"]`. It catches `importSnapshot?` declared on a contract interface. But the symptom Wave A3 was supposed to close (STORES-R2-002) was that `src/ops/backup.ts` was doing `(stores.canonical as { importSnapshot?: ... }).importSnapshot` and feature-detecting. Those four call sites (`backup.ts:113, 138, 175, 195`) are still present and still feature-detect via optional cast. They throw correctly today, but R5 cannot regress-protect against someone removing the throw and silently skipping.

**Recommendation:** Either widen R5 to cover `src/ops/**` with a new rule pattern matching `as { import*?: ... }`, or add a sibling rule `R5b-optional-cast-import-contract.yml` that finds the optional-cast pattern at call sites. R5's body comment already names `src/ops/errors.ts` and `backup.ts`, so the scope/intent gap is visible in the rule's own documentation.

**Evidence:** `R5.yml:36` `files: ["src/contracts/*.ts"]`. `src/ops/backup.ts` grep confirms 4 optional-cast call sites at the lines above.

---

### CIDOCS-B-009 — R4 completeness rule pattern misses if/else discriminator chains

**Severity:** MEDIUM
**Category:** defensive
**File:** `scripts/checks/R4-switch-on-resolved-store-incomplete.yml:15-18`; `src/cli.ts:652-660`; `src/mcp/server.ts:554-562`
**Description:** Carry-over AGG-007 confirmed. R4 only matches `switch ($X.store) { ... }`, `switch (resolved.store) { ... }`, `switch (parsed.store) { ... }`. But there are at least two real call sites that use `if (resolved.store === 'X') ... else if ...` chains on the same discriminator:

- `src/cli.ts:652-660` — 5-branch if/else on `resolved.store`
- `src/mcp/server.ts:554-562` — 5-branch if/else on `resolved.store`

Both happen to cover all 5 cases today, but the proactive-health failure mode is exactly what R4 was designed to catch: someone adds a 6th store (the doctrine doc lists `receipt` as a parsed-store variant already) and the if/else chain silently drops it.

**Recommendation:** Add an `if`-chain pattern to the R4 rule:
```yaml
rule:
  any:
    - pattern: switch ($X.store) { $$$ }
    - pattern: |
        if ($X.store === $A) { $$$ }
        else if ($X.store === $B) { $$$ }
        $$$
```
The post-process step that ensures all 5 case labels are present already exists in `completeness-checks.mjs:74-86` and handles arbitrary match text — it will work on the if/else chain text as-is.

**Evidence:** `R4.yml:15-18` patterns enumerated. `src/cli.ts:652-660` and `src/mcp/server.ts:554-562` confirmed via grep.

---

### CIDOCS-B-010 — CI matrix lacks macOS and Node 24

**Severity:** MEDIUM
**Category:** future-proofing
**File:** `.github/workflows/ci.yml:10-13`
**Description:** Carry-over CIDOCS-R2-007 confirmed. The matrix is `node: [20, 22]` × `os: [ubuntu-latest, windows-latest]`. Three coverage gaps:

1. **macOS** — db-cluster ships on a homebrew-heavy ecosystem (the user runs Mac + Windows rigs per global memory). The first time a Mac developer cloning the repo hits a path-separator or fs-watcher difference, it's a release blocker that CI never saw.
2. **Node 24** — released 2025-10. The CI runs Node 22, the lockfile/types are `@types/node: ^25.9.1` (`package.json:71`). That's an LTS-versus-current mismatch the matrix should be testing.
3. **Postgres adapter is unobservable in CI** — flagged in `release-readiness.md:79` as "not blocking." Proactive-health concern: the adapter is in the shipped tarball.

**Recommendation:**
```yaml
matrix:
  node: [20, 22, 24]
  os: [ubuntu-latest, windows-latest, macos-latest]
```
The cluster's local-only path is portable enough that the macos-latest leg is mechanical to add. Optionally add a separate `postgres` job (matrix `node: [22]`, services: postgres:16) so the adapter has any CI signal.

**Evidence:** `ci.yml:11-13` lists only `node: [20, 22]` and `os: [ubuntu-latest, windows-latest]`. `package.json:71` references `@types/node: ^25.9.1`.

---

### CIDOCS-B-011 — `release-readiness.md` rollback guidance conflates pre-publish and post-publish

**Severity:** MEDIUM
**Category:** observability | future-proofing
**File:** `docs/release-readiness.md:70-75`
**Description:** Carry-over CIDOCS-R2-010 confirmed. The doc says "If smoke fails on tag push: the tag is already published but the release is broken. Roll back by publishing a fixed patch (e.g., 0.1.2) with the smoke-install fix; leave the broken tag in place for audit traceability and mark the GitHub release as a draft or pre-release." This conflates two cases:

1. **Git tag created, `npm publish` not yet run** — the tag CAN be deleted (`git tag -d v0.1.1 && git push --delete origin v0.1.1`) before npm sees it. The release version remains available for reuse.
2. **`npm publish` already ran** — the version IS burned (npm is append-only for published versions), and the patch-bump path the doc describes is correct.

A reader following the doc's advice in case 1 burns a perfectly-reusable version number.

**Recommendation:** Split the §"What to do if smoke fails on tag push" into two cases:
- **Tag created but no `npm publish` yet:** delete the tag and the release, fix, re-tag.
- **`npm publish` already ran:** bump to next patch, leave broken version in place but mark as deprecated via `npm deprecate db-cluster@<bad-version> "..."`.

Also tie this to CIDOCS-B-002 (`prepublishOnly`): if the gate runs locally on publish, the only way to land in case 2 is to bypass the gate.

**Evidence:** `release-readiness.md:70-75` quoted verbatim above.

---

### CIDOCS-B-012 — Stryker mutation testing configured but never run on full suite; decision pending

**Severity:** MEDIUM
**Category:** defensive | future-proofing
**File:** `stryker.conf.json`; `package.json:47`; `CHANGELOG.md:42-45`
**Description:** Carry-over from brief confirmed. The CHANGELOG announces mutation testing as "the first machine check on the test suite's discrimination power" (lines 42-45). Yet:

- `stryker.conf.json:10` has `coverageAnalysis: 'off'` — Stryker docs warn this means every mutation triggers the full suite (~28 hours wall-clock for a 699-test suite at this concurrency).
- `package.json:47` exposes `test:mutation` as an npm script but it is not invoked by `release-gate.mjs` or any workflow.
- `stryker.conf.json:36-40` sets `break: null` — even if it runs, it cannot fail CI.

So mutation testing is shipped, advertised, and inert. Proactive-health risk: someone runs `npm run test:mutation` to verify the claim, the rig falls over, the test feels unsupported.

**Recommendation:** One of three:
1. **Scope it** — narrow `mutate:` to one or two files at a time, run via `workflow_dispatch:` weekly, gate at `break: 70`.
2. **Migrate to `incremental`** — Stryker 7+ supports `incremental: true` plus `coverageAnalysis: 'perTest'` after the first full run, dropping subsequent runs to minutes. Requires committing the `.stryker-tmp/` baseline.
3. **Drop it** — remove `test:mutation`, the Stryker devDeps, the config file, and the CHANGELOG line.

Whichever — the current state is a CHANGELOG claim with no underlying machinery, which is exactly the doc-drift pattern the brief calls out.

**Evidence:** `stryker.conf.json:10,36-40`. `package.json:47,68-70`. `CHANGELOG.md:42-45`. Not referenced in `release-gate.mjs` or `.github/workflows/`.

---

### CIDOCS-B-013 — Phase docs sprawl with no operator entry-point

**Severity:** MEDIUM
**Category:** future-proofing
**File:** `docs/` (24 phase docs out of 41 total)
**Description:** Carry-over from brief confirmed. The `docs/` directory has 41 files; 24 of them are phase-internal (phase-0-doctrine, phase-1-cluster-spine, phase-1-closeout, phase-2-cross-store-identity, phase-2-closeout, ... through phase-15-closeout, plus phase-11-dogfood-report, phase-12-dogfood-repair, phase-12-repair-report, phase-13-dashboard-integration, phase-14-repo-knowledge-integration-{gate,report}, repo-knowledge-mapping).

A developer landing on the GitHub repo and clicking into `docs/` sees 41 files alphabetically, with no signpost separating "what should I read first" (quickstart, handbook, architecture) from "internal phase reports" (phase-1-closeout, phase-2-closeout, ...). `docs/handbook.md` is the canonical operator/developer guide per its own claim (line 5) but it sits at position ~25 in alphabetic order.

**Recommendation:** Three small fixes:
1. Add `docs/README.md` (1 page) with a doc map: "Start here" (quickstart, handbook, architecture); "Reference" (sdk, cli, mcp, store-contracts, etc.); "Development phase history" (phase-* docs — for historical context, not for users).
2. Optionally move `docs/phase-*.md` to `docs/phases/` to physically separate.
3. Link to `docs/README.md` from the repo-root `README.md` so newcomers find it.

This is also the natural place to add the doc-drift detector note (CIDOCS-B-001) if it becomes a guardrail.

**Evidence:** `ls docs/` yields 41 entries; 24 phase-related.

---

### CIDOCS-B-014 — Policy/Principal/Capability documented across 6+ files; no canonical source

**Severity:** MEDIUM
**Category:** observability | future-proofing
**File:** `docs/sdk.md:225-227`, `docs/mcp.md`, `docs/cli.md:216-225`, `docs/handbook.md:415-434`, `docs/policy-and-redaction.md:1-32`, `examples/mcp/safety-model.md`, `README.md`
**Description:** Carry-over from brief confirmed. `Principal` shape and the `Capability` union are documented in six places:

- `sdk.md:225-227` — gestures at `src/types/policy.ts` ("the canonical list")
- `policy-and-redaction.md:9-32` — full TypeScript interface + Capability union (the actual canonical-looking source)
- `handbook.md:399-434` — Capability table + interface
- `cli.md:216-224` — JSON-shape example in CLI invocations
- `mcp.md` — JSON-shape examples in MCP call examples
- `examples/mcp/safety-model.md` — not read but flagged in brief

When the underlying type changes, six files have to be touched. Wave A3 fixed `sdk.md` but doesn't appear to have touched `policy-and-redaction.md`, `handbook.md`, or `cli.md`. They happen to agree today, but the next type change will fork them.

**Recommendation:** Pick `docs/policy-and-redaction.md` as canonical (it already has the full interface + Capability union and is the doc dedicated to the topic). Other docs link to it instead of restating. The Capability table currently in `handbook.md:399-413` should be either deleted (with a link) or kept as a quick-reference summary that names policy-and-redaction.md as the source of truth.

If the doc-drift detector from CIDOCS-B-001 lands, this is the second consumer.

**Evidence:** File paths above all contain Principal interface or Capability union restatements.

---

### CIDOCS-B-015 — Workflows lack `workflow_dispatch` on `ci.yml` and `release-gate.yml`

**Severity:** MEDIUM
**Category:** degradation
**File:** `.github/workflows/ci.yml`; `.github/workflows/release-gate.yml`
**Description:** Cross-cut with B-004. Only `smoke-install.yml` has `workflow_dispatch:` (line 7). When release-gate fails due to the wave6-proof race (or when a maintainer wants to re-run on an arbitrary SHA without a tag bump), there is no UI path; the operator must push an empty commit or a tag. That's friction at the worst time (a red gate before release).

**Recommendation:** Add to both:
```yaml
on:
  push: ...
  workflow_dispatch:
    inputs:
      sha:
        description: 'Commit SHA to test (default: HEAD)'
        required: false
```

**Evidence:** `ci.yml:2` shows `on: [push, pull_request]` only; `release-gate.yml:2-5` shows `on: push: {branches, tags}` only.

---

### CIDOCS-B-016 — `release-gate.mjs` Stage 4 uses hard-coded tarball name `db-cluster-0.1.0.tgz`

**Severity:** MEDIUM
**Category:** future-proofing
**File:** `scripts/release-gate.mjs:46`; `scripts/smoke-install.mjs:16`
**Description:** Both scripts hard-code the version into the filename:
- `release-gate.mjs:46` → `const tgz = join(ROOT, 'db-cluster-0.1.0.tgz');`
- `smoke-install.mjs:16` → `const tgzPath = resolve(process.argv[2] || 'db-cluster-0.1.0.tgz');`

When the package version bumps to 0.1.1, the release-gate will FAIL at stage 4 ("tarball not found") because `npm pack` produces `db-cluster-0.1.1.tgz`. The version bump PR's smoke-install run (per CIDOCS-B-007's path filter) will fail too. Releases would silently break at version-bump time.

**Recommendation:**
```js
// Read version from package.json
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const tgz = join(ROOT, `${pkg.name}-${pkg.version}.tgz`);
```
Same fix in `smoke-install.mjs:16`.

**Evidence:** `release-gate.mjs:46`; `smoke-install.mjs:16` — both string-literal `'db-cluster-0.1.0.tgz'`.

---

### CIDOCS-B-017 — `release-gate.mjs` Stage 3 doesn't clean up `.tgz` between runs

**Severity:** MEDIUM
**Category:** defensive
**File:** `scripts/release-gate.mjs:45-50`
**Description:** Stage 3 runs `npm pack` and then checks the result exists. There is no `rm -f db-cluster-*.tgz` before pack and no cleanup after. As a result:

1. The repo accumulates stale `*.tgz` files on every local release-gate run.
2. The `*.tgz` is gitignored (`.gitignore:4`) so it doesn't reach the repo, but it sits in the working tree.
3. If a previous release shipped 0.1.0 and someone now runs the gate locally on 0.1.1, both tarballs may coexist briefly — which doesn't break anything but offers no signal.

Existing: `db-cluster-0.1.0.tgz` is in the working tree right now (`371855 bytes`, dated 2026-05-27) — the brief asked about this. `.gitignore` matches `*.tgz` so it's not committed.

**Recommendation:** Wrap Stage 3:
```js
// Clean before
for (const f of readdirSync(ROOT).filter(n => n.endsWith('.tgz'))) {
    rmSync(join(ROOT, f));
}
run('npm pack', 'npm pack');
```
And at the end of the script, `rmSync(tgz)` after Stage 4 finishes.

**Evidence:** `release-gate.mjs:45-50`. `.gitignore:4` `*.tgz` — confirmed, tarball is not committed.

---

### CIDOCS-B-018 — Translation infrastructure not present

**Severity:** LOW
**Category:** future-proofing
**File:** `README.md` (no `README.{ja,zh,es,fr,hi,it,pt-BR}.md` siblings)
**Description:** Carry-over note from brief. Full-treatment / pre-Phase-10 release flow requires translated READMEs via polyglot-mcp. None of `README.{ja,zh,es,fr,hi,it,pt-BR}.md` exist. README has no language nav bar at top either. This is pre-translation state — flagged for awareness, not for Stage B fix.

**Recommendation:** Defer to release-prep workflow per the global instruction's translation-rule.

**Evidence:** `ls README.*` shows only `README.md`.

---

### CIDOCS-B-019 — `dist/` is gitignored but not in `.gitignore` comments

**Severity:** LOW
**Category:** defensive
**File:** `.gitignore`
**Description:** `.gitignore` is 8 lines, all bare patterns. The patterns include `.test-*`, `.stryker-tmp/`, `reports/`, `examples/**/.db-cluster/` which are domain-specific and won't be obvious to a future contributor. No comments explain why these are here, which invites later "let me clean up the gitignore" passes that remove load-bearing entries.

**Recommendation:** Add inline comments:
```
node_modules/
dist/                          # tsc output, rebuilt by `npm run build`
.test-*                        # vitest temp dirs (test/temp-cluster-XXX)
*.tgz                          # release-gate pack output (CIDOCS-B-017)
.db-cluster/                   # quickstart cluster data (CIDOCS-B-021)
examples/**/.db-cluster/       # quickstart cluster data inside examples
.stryker-tmp/                  # mutation testing baseline
reports/                       # mutation/stryker html reports
```

**Evidence:** `.gitignore` 9 lines, no comments.

---

### CIDOCS-B-020 — `smoke-install.mjs` uses non-ASCII checkmarks; Windows console encoding risk

**Severity:** LOW
**Category:** degradation
**File:** `scripts/smoke-install.mjs:36-41`
**Description:** `smoke-install.mjs:36` prints `✓` (U+2713) and `:41` prints `✗` (U+2717). Node's default Windows console codepage (CP850/CP437) can mangle these to `?`. The CI matrix already includes `windows-latest` (`ci.yml:13`); release-gate stage 4 invokes smoke-install on linux, but local Windows runs of `node scripts/smoke-install.mjs <tgz>` will show garbled output.

**Recommendation:** Either replace with ASCII (`[OK]` / `[FAIL]`) or set `process.stdout` encoding to UTF-8 at the top of the script. The release-gate script already uses `'OK'` / `'FAIL'` strings throughout (consistent ASCII).

**Evidence:** `smoke-install.mjs:36-41` source bytes contain U+2713 and U+2717.

---

### CIDOCS-B-021 — `.gitignore` covers `.db-cluster/` but not `.repo-knowledge/` or other adjacent stores

**Severity:** LOW
**Category:** defensive
**File:** `.gitignore:5-6`
**Description:** `.gitignore:5` `.db-cluster/` and `:6` `examples/**/.db-cluster/` cover the quickstart cluster data path. The Phase 14 integration test uses repo-knowledge alongside; if it creates a `.repo-knowledge/` directory anywhere in the tree it would be tracked. Defensive coding: gitignore the failure mode before it happens.

**Recommendation:** Add `.repo-knowledge/` and `**/.repo-knowledge/` to `.gitignore`. Also consider `cluster-backup-*.json` (the backup output filename pattern).

**Evidence:** `.gitignore` does not mention repo-knowledge or backup file patterns. `docs/operations.md:78` documents `db-cluster backup -o ./backup.json` as default.

---

### CIDOCS-B-022 — `docs/operations.md:84` says backup excludes raw content; conflicts with handbook

**Severity:** LOW
**Category:** observability
**File:** `docs/operations.md:84`; `docs/handbook.md:528-534`
**Description:** `docs/operations.md:84` says backup includes "All artifacts (metadata, not raw content)." But `docs/handbook.md:528-534` says "Backup exports: ... All artifacts (with content, base64-encoded)." Phase 12 repair report (`phase-12-repair-report.md:14-19`) confirms backup now captures `base64 content + SHA-256 checksum`. So `operations.md` is stale by two phases.

**Recommendation:** Update `operations.md:84` to match handbook:
```md
- All artifacts (with content, base64-encoded + SHA-256 checksum)
```

**Evidence:** Three files cited.

---

### CIDOCS-B-023 — `.github/workflows/ci.yml` lacks pinned action versions beyond major

**Severity:** LOW
**Category:** defensive | future-proofing
**File:** `.github/workflows/ci.yml:16-17`; `release-gate.yml:12-13`; `smoke-install.yml:14-15`
**Description:** All three workflows use `actions/checkout@v4` and `actions/setup-node@v4`. v4 is a moving target — a v4.x.y release can change runtime behavior. The supply-chain best practice is to pin to commit SHA. Defense-in-depth proactive concern. Low priority — none of these actions have shipped a v4 breaking change yet.

**Recommendation:** Optional and lower-priority than B-001 through B-006. If the repo wants `Dependabot` for actions:
```yaml
# .github/dependabot.yml
version: 2
updates:
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: monthly
```

**Evidence:** All three workflow files use `actions/checkout@v4` and `actions/setup-node@v4`.

---

### CIDOCS-B-024 — `package.json` `description` and keywords correct; "Tracked decisions" missing

**Severity:** LOW
**Category:** future-proofing
**File:** `package.json:4`
**Description:** Description reads "AI-native federated database cluster — specialized truth stores behaving as one governed substrate." This matches the README thesis. Keywords (`ai`, `database`, `federated`, `truth-store`, `provenance`, `cluster`, `mcp`) are accurate. No `repository`, `bugs`, or `homepage` fields — npm registry pages will display "(none)" for those.

**Recommendation:** Add npm metadata so the registry page is operator-friendly:
```json
"repository": {
  "type": "git",
  "url": "https://github.com/mcp-tool-shop-org/db-cluster.git"
},
"bugs": "https://github.com/mcp-tool-shop-org/db-cluster/issues",
"homepage": "https://github.com/mcp-tool-shop-org/db-cluster#readme"
```

**Evidence:** `package.json:1-82` — no `repository`, `bugs`, `homepage` fields.

---

### CIDOCS-B-025 — `scripts/release-gate.mjs` truncates stdout/stderr to last 500 bytes

**Severity:** should-have-been-stage-a
**Category:** observability
**File:** `scripts/release-gate.mjs:25-26`
**Description:** When a stage fails, the script prints `e.stdout.toString().slice(-500)` and `e.stderr.toString().slice(-500)`. For a vitest run with 699 tests printing per-file headers, the failing test name is often pushed out of the 500-byte window. Operator response to "release-gate failed" requires scrolling to find the actual fail signal — which is often absent.

This was knowable as soon as Wave A1 added the release-gate workflow. None of Waves A1, A2, A3 widened the slice. Stage A had three chances. Classifying as should-have-been-stage-a per the brief's "Stage A real bug" rule.

**Recommendation:** Widen to `slice(-8000)` (8 KB is the GitHub Actions log line wrapping limit). Or, better: stream stdout/stderr to per-stage log files and upload them as workflow artifacts.

**Evidence:** `release-gate.mjs:25-26`.

---

### CIDOCS-B-026 — `vitest.config.ts` and `vitest.stryker.config.ts` disagree on excluded tests

**Severity:** should-have-been-stage-a
**Category:** observability
**File:** `vitest.config.ts:5`; `vitest.stryker.config.ts:6-15`
**Description:** `vitest.config.ts:5` `include: ['test/**/*.test.ts']` — every test runs. `vitest.stryker.config.ts:6-15` excludes 9 specific test files including `wave6-proof.test.ts`, `phase15-proof.test.ts`, etc. The excluded files are *exactly* the ones most likely to be flake sources or to require sequential setup.

This means the regular `vitest run` (and the release-gate's Stage 2) executes the flake-prone tests. The mutation runner excludes them. That's inverted — the mutation runner should test more (or at least the same), not less.

If Stage A had triaged the flake correctly, the right answer was either:
- Pull the flake out of the regular `vitest.config.ts` too (until fixed) — option A.
- Fix the flake before Wave A3 declared "test-first gate" — option B.

Neither happened.

**Recommendation:** Either:
1. Move the wave6-proof race fix forward (Tests-domain — but CI/Docs surface).
2. Until then, declare the regular suite as "699 tests passing in steady state, with 9 flake-prone files excluded from mutation testing" in `release-readiness.md`.

**Evidence:** Two config files cited.

---

### CIDOCS-B-027 — `package.json` `lint` script chains `tsc --noEmit` and `lint:examples` but reports no test count

**Severity:** should-have-been-stage-a
**Category:** observability
**File:** `package.json:48-49`
**Description:** `npm run lint` does `tsc --noEmit && npm run lint:examples`. If either fails, you get a tsc error message. Fine. But there is no `--listFiles` or `--noErrorTruncation`, so when tsc fails on one of the docs-example blocks (per CIDOCS-B-001), the error location can be opaque. Lower priority than the doc-drift detection itself.

**Recommendation:** Optional: `lint:report` script that emits a summary count of files checked, surfaced via `release-gate.mjs`. Carry-over from the broader doc-drift work.

**Evidence:** `package.json:48-49`.

---

## Carry-over verification matrix

| ID | Present? | Proactive severity | Fix scope | New file:line |
|---|---|---|---|---|
| CIDOCS-009 / R2-008 (loose .txt files) | YES | HIGH | Wave B | `AI Safe Data Control Plane over Fed.txt`, `Is it true that AI has a hard time.txt`, `phase map.txt` at repo root |
| CIDOCS-011 / R2-009 (no prepublishOnly) | YES | HIGH | Wave B | `package.json:43-54` (scripts block has prepack but no prepublishOnly) |
| CIDOCS-R2-005 (smoke-install PR trigger narrow) | YES | MEDIUM | Wave B | `.github/workflows/smoke-install.yml:5-6` |
| CIDOCS-R2-006 (engines field missing + Node 18.17+ usage) | YES | HIGH | Wave B | `package.json` (no engines), `scripts/release-gate.mjs:69` |
| CIDOCS-R2-007 (CI matrix coverage) | YES | MEDIUM | Wave B | `.github/workflows/ci.yml:11-13` |
| CIDOCS-R2-010 (release-readiness rollback wording) | YES | MEDIUM | Wave B | `docs/release-readiness.md:70-75` |
| CIDOCS-R2-011 (permissions: contents: read OK) | OK | n/a | n/a — observation only | `.github/workflows/*.yml` all carry it |
| AGG-007 R4 widening (if/else missed) | YES | MEDIUM | Wave B | `scripts/checks/R4.yml:15-18`; `src/cli.ts:652-660`; `src/mcp/server.ts:554-562` |
| AGG-007 R5 widening (ops/backup.ts call sites) | YES | MEDIUM | Wave B | `scripts/checks/R5.yml:36`; `src/ops/backup.ts:113,138,175,195` |
| Stryker config inert | YES | MEDIUM | decision needed | `stryker.conf.json:10,36-40`; `package.json:47`; no workflow invokes it |
| sdk.md doc-drift recurrence | YES (sibling docs) | HIGH | Wave B | `docs/retrieval-bundles.md:16-31`; `docs/provenance-graphs.md:80-99` (sdk.md itself fixed in A3) |
| Policy doc consolidation | YES | MEDIUM | Wave B | 6 files restate Principal/Capability |
| Release-gate non-determinism | YES | HIGH | Wave B | release-gate flake bubble-up; needs CHANGELOG/README signal + workflow_dispatch |
| Translation infra | absent | LOW | Pre-Phase-10 | no `README.{ja,zh,es,fr,hi,it,pt-BR}.md` siblings |
| `db-cluster-0.1.0.tgz` at root | YES | MEDIUM | Wave B | `.gitignore:4 *.tgz` matches, NOT committed; cleanup logic needed in release-gate |
| Phase docs sprawl | YES | MEDIUM | Wave B | `docs/` 24 phase docs out of 41 total — needs entry-point map |

## Domain summary (≤150 words)

The CI/Docs domain is functional but not proactively healthy. Three Stage A amend waves shipped CI workflows, completeness gates, mutation-testing config, and per-wave documentation churn — but several structural gaps persist:

- The publish boundary is ungated (no `prepublishOnly`).
- The release-gate is a coin flip on busy runners and has no documented retry/dispatch path.
- Documentation drift recurs every wave (sdk.md fixed in A3, but `retrieval-bundles.md` and `provenance-graphs.md` carry the same drift class with the same root cause: hand-maintained example interfaces).
- The completeness gates (R4/R5) are scoped too narrowly to regress-protect their stated targets.
- Operator UX is sharp-edged: 41-file `docs/`, no entry-point map, tarball name hard-coded, stdout truncated.

Wave B should close the publish-boundary gap, ship a doc-drift detector, broaden R4/R5, and document the release-gate flake honestly.

---

## 200-word summary

**Top 3 HIGH:**

1. **CIDOCS-B-002** — `npm publish` has no `prepublishOnly` gate. A human running `npm publish` from a workstation skips the entire release-gate. This is the single most consequential defensive gap.

2. **CIDOCS-B-001** — `docs/retrieval-bundles.md:16-31` and `docs/provenance-graphs.md:80-99` carry the same doc-vs-type drift Wave A3 just fixed in `docs/sdk.md`. Three waves in a row have found this class. Mechanical fix is patching the sibling docs; structural fix is a doc-drift detector that extracts ```` ```typescript ```` blocks and typechecks them.

3. **CIDOCS-B-004** — Release-gate is non-deterministic (22-fail/20-fail/0-fail across three runs this session). No documentation, no retry path, no `workflow_dispatch`, and the failing test name is often outside the 500-byte stdout tail window.

**Counts:** HIGH 6, MEDIUM 14, LOW 7, should-have-been-stage-a 4. Total 27 of 30 cap.

**Release-gate flake bubble-up:** The Tests-domain `wave6-proof.test.ts` race fires through `release-gate.mjs` Stage 2 (`npx vitest run`). CI/Docs-side mitigations are (a) add `workflow_dispatch:` to `release-gate.yml` so the operator can re-run on the same SHA without a tag bump; (b) document the flake in `docs/release-readiness.md` and `CHANGELOG.md` with the empirical rate and the "re-run once, escalate to patch bump only after second fail" procedure; (c) widen the stdout/stderr `slice(-500)` to `slice(-8000)` or upload per-stage log artifacts so the failing test name is preserved. The race fix lives in Tests-domain but the operator-actionable signal lives here.
