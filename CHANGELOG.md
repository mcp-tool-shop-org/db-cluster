# Changelog

The CHANGELOG audience is **external readers** — operators, developers, and AI integrators picking up db-cluster from npm or GitHub. Each wave section opens with three audience-tagged blocks:

- **User-visible changes** — what AI agents / operators / developers experience differently this release.
- **Breaking changes** — API / CLI / MCP / SDK contract changes (the package is 0.x.x — breaking is permitted but always documented).
- **Migration notes** — how to update existing usage.

Internal swarm-finding IDs (KERNEL-X-NNN, STORES-X-NNN, AGG-NNN) appear as **backlinks at the bottom** of each wave section so the audit trail is preserved, but the body text is written for the external reader.

## v1.0.0 — Phase 10 Full Treatment release (2026-05-27)

First shipped release. db-cluster exits the dogfood-swarm protocol with all
hard gates green and proceeds to a v1.0.0 release that's fully translated,
branded, documented, and indexed.

### User-visible changes

- **First published version on npm.** `npm install db-cluster` works; the `db-cluster` and `db-cluster-mcp` bins are usable from `npx` without a clone.
- **Landing page** at https://mcp-tool-shop-org.github.io/db-cluster/ — scaffolded via `@mcptoolshop/site-theme`. Hero block, four feature cards, four code cards (install / init+ingest+retrieve / SDK / MCP wire-up).
- **Starlight handbook** at https://mcp-tool-shop-org.github.io/db-cluster/handbook/ — 8 pages (index / getting-started / architecture / operations / policy-and-redaction / mcp / sdk / cli) with pagefind search across all of them. Cyan accent matching the brand logo.
- **README translations** in 7 languages — Japanese, Chinese (Simplified), Spanish, French, Hindi, Italian, Brazilian Portuguese — via polyglot-mcp's TranslateGemma 12B pipeline. Language nav bar injected above the logo in all 8 source-plus-translated READMEs.
- **CLI color polish** — kleur-based ANSI color codes for errors (red), warnings (yellow), success (green), headers (bold cyan), and `→ try:` remediation hints (dim italic). The `--no-color` flag forces colors off; the `NO_COLOR` env variable is honoured per https://no-color.org. Piped output (non-TTY) auto-disables.
- **Trust model section** in the README — pointer to the full threat model in `SECURITY.md`. Surfaces what data db-cluster touches, what it does NOT touch, and the permissions it asks for.
- **Shipcheck baseline** — repo joined the `@mcptoolshop/shipcheck` quality gate. SHIP_GATE.md filled, all four hard gates (A: Security, B: Error Handling, C: Operator Docs, D: Shipping Hygiene) pass at 27/27 applicable items + 5 SKIP justifications. SCORECARD.md, SECURITY.md (db-cluster-specific threat model), and `.github/dependabot.yml` (npm + github-actions ecosystems, grouped updates) all landed.
- **GitHub repo metadata** updated — description, homepage, 10 topics (ai-native, claude, cli, database, federated, mcp, model-context-protocol, policy, provenance, typescript).

### Breaking changes

- None. v1.0.0 finalizes the surface defined by Phase 15 (Release Readiness & Package Boundary) and audit-hardened through Stages A, B, C of the dogfood-swarm. Existing 0.1.x usage of `import 'db-cluster'`, `import 'db-cluster/sdk'`, the CLI verbs, and the MCP tool schemas all continue to work.

### Migration notes

- Pre-1.0 (any 0.x clone-and-build users): nothing to migrate; the published `db-cluster@1.0.0` is the same surface you've been running, just on npm now.
- AI integrators: continue branching on `AiErrorEnvelope.code` and `retryable`. The 16 MCP tools and their safety annotations are stable.
- Operators: the CLI exit-code table (0 / 1 / 65 / 70 / 77 / 78) is stable across versions per sysexits.h. `db-cluster --help-exit-codes` prints the live table.

### Stage D disposition (re-stated for completeness)

db-cluster ships as an npm package; there is no marketplace listing, no VS Code extension, and no first-class frontend surface. Stage D (Visual Polish) of the dogfood-swarm protocol is therefore not applicable. Its intent — coherent visual identity — folds into Phase 10 Full Treatment: brand logo (landed in C1-Amend), landing page, handbook, and inline CLI color polish. No Stage D swarm wave was dispatched.

### Release-gate

- Final baseline: 1255+ tests passing deterministically across 84 files (8 new tests added in the CLI color polish module), release-gate 9/9 PASS, lint clean.
- Coverage badge deferred to a later v1.x release per the full-treatment Phase 4 default ("ship without, defer to v1.x").

### Repo-knowledge

- Phase 5 entry landed in the repo-knowledge DB at `mcp-tool-shop-org/db-cluster` with thesis, architecture, and release_summary notes; relationships: `shares_domain_with` repo-knowledge, `shares_package_with` ollama-intern-mcp.

## Stage D — not applicable (2026-05-27)

db-cluster ships as an npm package. There is no marketplace listing, no VS Code extension, and no first-class frontend surface. Stage D (Visual Polish) of the dogfood-swarm protocol is therefore not applicable to this repo.

Stage D's intent — that the product carry a coherent visual identity — folds into Phase 10 Full Treatment work:

- **README brand logo** — landed in Wave C1-Amend.
- **Landing page** — `npx @mcptoolshop/site-theme init` (Phase 10 §2).
- **Handbook** — Starlight docs site scaffolded via `npx @mcptoolshop/site-theme handbook` (Phase 10 §3).
- **Inline CLI color polish** — kleur-based ANSI color output with `--no-color` flag and `NO_COLOR` env-var honoured (Phase 10 §1).

The dashboard demo (`dashboard/`) already carries a self-contained visual treatment from Phase 13 (StoreLanesMap, ProvenanceTimeline, ExplainIndexPanel, PolicyViewToggle).

No dogfood-swarm Stage D wave is dispatched. db-cluster exits the dogfood swarm at Stage C and proceeds directly to Phase 10 (Full Treatment) for v1.0.0 release.

## Wave C1-Amend — Dogfood-swarm Stage C Wave C1 amend (2026-05-27)

Stage C Wave C1 amend closing the 68 behavioral-humanization findings the Stage C audit surfaced (25 HIGH + 38 MEDIUM + 5 LOW + 8 should-have-been-A). The wave addresses the gap between "structurally sound" (Stage B exit) and "actually usable" — typed-error remediation, AI envelope enrichment, operator runbooks, JSDoc completeness.

### User-visible changes

- **AI agents** now receive structured error envelopes (`AiErrorEnvelope`: `code` + `retryable` + `remediation_hint` + `context` + optional `next_valid_actions`) at every MCP / SDK error boundary — pattern-match on `code`, branch on `retryable`, instead of parsing prose. See `docs/mcp.md` "Error envelope shape".
- **Operators** get four new runbooks in `docs/runbooks/` — one per failure class (corrupt-store, orphan-mutations, index-stale, postgres-unreachable). Each runbook follows the same Symptom / Cause / Verify / Recover / Escalate shape.
- **CLI exit codes** are documented in `docs/cli.md` with a full typed-error → exit-code table. Operators can branch CI pipelines on `$?` without parsing stderr.
- **Developers** can find `@example` blocks on every required public symbol. The new `scripts/jsdoc-gate.mjs` `[9/9]` release-gate stage enforces this forward.
- **Dashboard viewers** see explicit loading / empty / error states instead of `null` returns — and the documented redaction-marker contract is now wired at every panel consumer.
- **README** front-loads "Who is this for" + "Why use db-cluster" + 3-step quickstart so the 30-second test passes.
- **CHANGELOG** restructured: per-wave User-visible / Breaking / Migration blocks (you're reading this format now).

### Breaking changes

- None at the contract level — this wave adds new types (`AiErrorEnvelope`, `EmptyResultMeta`, `ComponentState`) and enriches existing error subclasses with public-readonly fields (`code`, `remediationHint`, `retryable`). Existing consumers continue to work; new consumers can branch on the richer fields.

### Migration notes

- AI integrators previously parsing prose error messages should switch to `instanceof ClusterError` + `err.code` branches (Node-side) or `AiErrorEnvelope` pattern-match (MCP-side). See `docs/mcp.md` for the canonical branching pattern.
- Operators who scripted against the CLI should consult the new `docs/cli.md` "Exit Codes" table and replace `[ "$?" -ne 0 ]` checks with code-specific branches (65 = data error, 70 = internal, 77 = permission, 78 = config).
- Custom dashboard components should adopt the `ComponentState<T>` prop shape — returning `null` from a panel is no longer acceptable per the dashboard contract.

### Release-gate

- New `[9/9] JSDoc-completeness` stage in `scripts/release-gate.mjs`. Verifies every symbol in `REQUIRED_JSDOC_SYMBOLS` carries `@throws` (or `@returns Promise<...>` with explicit error type) + at least one `@example`. The allowlist is forward-looking — new public methods added after 2026-05-27 must opt in.

### Internal swarm-finding backlinks (audit trail)

Wave C1-Amend closes findings KERNEL-C-001 through KERNEL-C-012, STORES-C-001 through STORES-C-012, SURFACE-C-001 through SURFACE-C-023, TESTS-C-001 through TESTS-C-011, CIDOCS-C-001 through CIDOCS-C-010, plus 8 should-have-been-A items (SHA-KERNEL-C-001, SHA-STORES-PHANTOM-CMD, SHA-SURFACE-LEAK-1 through -5, SHA-CIDOCS-C-SHBA-001). Full audit + amend reports: `swarm-stage-c-audit-1-1779892297.md` + `.stage-c-amend/`.

## Wave B1-Amend — Dogfood-swarm Stage B Wave B1 amend (2026-05-27)

### User-visible changes

- **Doc-drift detector** runs as `[8/8] Doc-drift` in the release-gate, typechecking every TypeScript code block in `docs/**/*.md` against the real `src/types/*` surface. Operators reading docs no longer hit invented field names.
- **Operations docs corrected** — `operations.md` now accurately says backup captures "base64-encoded content + SHA-256 checksum" (was wrongly: "metadata, not raw content").
- **CI matrix expanded** to Node 20/22/24 × ubuntu/windows/macOS.
- **`workflow_dispatch` triggers** on `ci.yml` + `release-gate.yml` so operators can re-run on a specific SHA.

### Breaking changes

- None.

### Migration notes

- No caller-side migration required. Custom docs pages that include `typescript` blocks must now use real `EvidenceBundle` / `ResolvedEvidence` / `ProvenanceGraph` / `ProvenanceNode` / `ProvenanceEdge` shapes — the doc-drift detector enforces.

### Internal swarm-finding backlinks (audit trail)

Stage B Wave B1 amend closing the 130 unique proactive-health findings the
Stage B audit surfaced after Stage A exited at Wave A4. This wave runs
under the v2 dogfood-swarm protocol (5 parallel domain fix agents + 3
parallel lens verifiers + aggregator + per-finding test-first gate +
saturation exit). See `swarm-stage-b-audit-1-20260527-091803Z.md` for the
full audit + `.stage-b-amend/agent-*-report.md` for per-domain reports.

### Kernel
- AGG-005 redactor allowlist + RedactionMarker types contract — switch
  redaction from denylist (`PRESERVED_FIELDS_*` + strip-unknown) to
  explicit allowlist behaviour with structured markers (see
  `src/types/redaction.ts`).
- AGG-008 TraceBuilder structured `labelData` refactor — node labels are
  now built from structured metadata at render time; the byte-level
  regex mangling in `redactProvenanceActors` is no longer load-bearing
  (`src/provenance/trace-builder.ts`).
- `redactErrorMessage` helper for typed-error `.message` and
  `.cause.message` scrubbing — wired into `recordOrphanMutation` so
  filesystem paths from `CommandQueueCorruptError.cause` no longer reach
  the ledger `mutation_orphaned` detail field.
- V2-004 follow-up — `validatePayloadForVerb` rejects Buffer payload
  shape at validate-time (the contentHash side-channel from Wave A4
  remains; this closes the propose-time gap).

### Stores
- `LedgerStore.rotate` + `LedgerStore.countEvents` contract additions —
  archival hook for the unbounded-ledger growth concern (STORES-B-013).
- Postgres pool hardening — SSL config respected when
  `DB_CLUSTER_POSTGRES_SSL` env is set; `pool.on('error', ...)` handler
  attached so an idle-client RST does not crash the process
  (STORES-B-006).
- `restore()` now propagates `rebuildIndex` failure on the returned
  `RestoreResult.index` field (STORES-B-007).
- `appendReceipt`/`importReceipt` stamp `owner` so the post-A4 dataset
  is symmetric with `append()` (STORES-B-004).

### Surface
- §2c CLI uniform try/catch wrapper — every subcommand goes through
  `safeAction(fn)` that maps domain errors to ASCII-coded stderr +
  consistent exit codes (SURFACE-B-004).
- `cluster_find_sources` LIST arm sanitization parity (SURFACE-B-001
  cross-check; the Wave A4 fix landed at the singular-resolve site).
- `SDK.retrieveBundle` sanitization for non-policy-enforced consumers
  (SURFACE-B-008).
- `policyEnforced` made private + guarded getter on `ClusterSDK`
  (SURFACE-B-007).
- `ClusterTruthInspector.jsx` null-guard on unknown-URI render
  (SURFACE-B-005).

### Tests
- TESTS-B-005 Windows symlink fallback to Junction so the path-sandbox
  coverage actually runs on the 5080 rig.
- TESTS-B-006 `verify()` regression coverage extended from 2 of 5
  ledger-subject event types to all 5.
- TESTS-B-008 targeted `beforeAll → beforeEach` migration on the 15+
  files where shared state was order-dependent.

### CI/Docs (this report)
- **§2d Doc-drift detector** — new `scripts/doc-drift.mjs` + wired into
  `release-gate.mjs` as `[8/8] Doc-drift`. Two layers:
  1. Typecheck every `typescript` code block in `docs/**/*.md` against
     `src/types/*` via the new `tsconfig.docs.json` (CIDOCS-B-001
     structural fix — the sdk.md / retrieval-bundles.md /
     provenance-graphs.md drift recurred for 3 waves before this
     landed).
  2. Verify every `from 'db-cluster[/sub]'` named import in docs
     resolves to a real exported symbol (catches drift like the
     `db-cluster/ops/doctor` subpath import that didn't exist).
- `docs/retrieval-bundles.md` + `docs/provenance-graphs.md` patched
  with real `EvidenceBundle` / `ResolvedEvidence` / `ProvenanceGraph` /
  `ProvenanceNode` / `ProvenanceEdge` shapes from `src/types/*`
  (CIDOCS-B-001 mechanical fix).
- `docs/operations.md` — fake `db-cluster/ops/*` subpath imports
  replaced with the real `db-cluster` top-level import + the
  `PolicyEnforcedKernel` path for rebuild/checkStale (caught by the
  new detector).
- `docs/cluster-uris.md` + `docs/mcp.md` — minor drift fixes the new
  detector surfaced.
- `docs/policy-and-redaction.md` is now the **canonical** source for
  Principal, Capability, Policy, TrustZone, VisibilityRule. Other docs
  (`handbook.md`, `sdk.md`, `cli.md`, `examples/mcp/safety-model.md`)
  link rather than restate (CIDOCS-B-014).
- New `docs/README.md` — doc map with "Start here", "Reference",
  "Development phase history" sections (CIDOCS-B-013). Linked from
  repo-root `README.md`.
- `package.json` gains `engines: { node: ">=20" }`, `repository`,
  `bugs`, `homepage` fields (CIDOCS-B-003 + CIDOCS-B-024). README and
  `docs/quickstart.md` updated to claim Node 20+ instead of Node 18+.
- `.github/workflows/ci.yml` matrix expanded to `node: [20, 22, 24]` ×
  `os: [ubuntu-latest, windows-latest, macos-latest]` (CIDOCS-B-010).
- `workflow_dispatch:` (with `sha:` input) added to `ci.yml` and
  `release-gate.yml` so operators can re-run on a specific SHA without
  bumping a tag or pushing an empty commit (CIDOCS-B-004 / B-015).
- `docs/release-readiness.md` — new "Known flake patterns
  (post-Wave-A4)" section explaining the closed wave6-proof race and
  the recommended re-run procedure; new "Stryker mutation testing —
  current disposition" section documenting the v2-protocol verifier-3
  doctrine substitution (CIDOCS-B-004 + CIDOCS-B-012).
- `docs/operations.md` backup claim corrected from
  "metadata, not raw content" → "with content, base64-encoded + SHA-256
  checksum" (CIDOCS-B-022 — already true since Phase 12; the doc was
  stale).
- `.gitignore` annotated with inline comments explaining each pattern;
  `.repo-knowledge/`, `cluster-backup-*.json`, `.doc-drift-extract/`
  added defensively (CIDOCS-B-019 + B-021).
- New `src/util/tmp-paths.ts` — canonical `buildRandomTmpPath` +
  `cleanupOrphanTmpFiles` + `sweepContentDirOrphans` helpers. The three
  inline copies (Stores' `tmp-cleanup.ts`, Kernel's `command-queue.ts`,
  Kernel's `cluster-kernel.ts` getStagingDir) can delegate at their
  domain's discretion (the no-back-edge rule is preserved because
  `src/util/` has no domain dependencies).
- Stryker: kept config files, removed CHANGELOG advertising claim,
  marked `vitest.stryker.config.ts` as EXPERIMENTAL + NOT IN CI. Per
  the v2 dogfood-swarm protocol verifier-3 lens substitution
  (CIDOCS-B-012). The `test:mutation` npm script remains for ad-hoc
  use; full rationale in `docs/release-readiness.md`.
- New test file `test/wave-b1-cidocs-regression.test.ts` — pins each
  fix above (workflow_dispatch presence, engines field, doc-drift
  detector exit code, CHANGELOG entry, tmp-paths helper behavior,
  matrix expansion).

## Wave A3 — Dogfood-swarm Stage A re-audit-2 amend (2026-05-27)

Third corrective wave on Stage A, dispatched after
`swarm-stage-a-reaudit2-20260527-033921Z.md` surfaced 7 HIGH findings (one a
regression of a Wave-A2 fix) plus 8 in-scope MEDIUMs that the two prior
amend waves did not fully close. Wave A3 also introduces the v2 swarm
architecture — lens-verifier ensemble plus mechanical completeness gates
plus a test-first gate plus saturation exit — and standardises the new
infrastructure pieces (`stryker` mutation testing, `ast-grep` completeness
rules) as standing protocol from this wave onward.

### Kernel
- Atomic index rebuild — the clear-then-loop pattern in
  `performIndexRebuild()` is replaced by the new `IndexStore.replaceAll()`
  contract method so a crash mid-rebuild cannot leave the index empty
  (KERNEL-R2-003, exposed by Wave A2's incomplete close).
- Wave-A1 typed errors and Wave-A2 atomic queue writes carry forward.
  (The Wave A3 wave originally claimed `npm run test:mutation` was "the
  first machine check on the test suite's discrimination power"; that
  claim is **withdrawn in Wave B1-Amend** — Stryker is shipped but
  experimental and not in the standing release-gate. The v2 dogfood-
  swarm protocol's verifier-3 invariant-test-completeness lens
  substitutes for mutation coverage. See `docs/release-readiness.md`
  "Stryker mutation testing — current disposition".)

### Stores
- `importSnapshot`, `importEvent`, `importReceipt` are no longer optional
  on `CanonicalStore`/`ArtifactStore`/`LedgerStore` contract interfaces.
  Adapters that cannot honour the contract throw
  `ImportSnapshotNotSupportedError` (or an equivalent typed error from
  `src/ops/errors.ts`) from a required method — restore() now relies on
  every adapter implementing the surface rather than feature-detecting
  it (STORES-R2-002).

### Surface
- The remaining post-A2 surfaces sweep — any direct `new ClusterResolver(...)`
  outside `src/sdk/cluster-sdk.ts` is now mechanically gated by R3 of
  the completeness checks, closing the regression vector that Wave A2's
  cli.ts/SDK cleanup left to discipline alone.

### Tests
- Test-first gate added — all Wave A3 fixes shipped with a failing test
  before the production change, then a green test on the fix.
- Mutation testing wired via `@stryker-mutator/core` +
  `@stryker-mutator/vitest-runner` + `@stryker-mutator/typescript-checker`.
  See `stryker.conf.json` for the target file list (every code path Waves
  A1/A2/A3 touched). Run with `npm run test:mutation`.
- Property-based tests via `fast-check` for any pure-function code path
  introduced or modified by this wave.

### CI/Docs
- New `scripts/completeness-checks.mjs` orchestrator + 5 ast-grep rules
  in `scripts/checks/`:
  - R1: `kernel._kernel` access outside `test/`
  - R2: non-atomic `index.clear()` then `index.index(...)` loop in one function
  - R3: raw `new ClusterResolver(...)` outside `src/sdk/cluster-sdk.ts`
  - R4: `switch` on `*.store` missing any of the 5 store cases
  - R5: optional `import*` methods on contract interfaces
- New `[7/7] Completeness` stage in `scripts/release-gate.mjs` invokes
  the orchestrator; release-gate now has 7 stages (was 6).
- New `npm run test:mutation` and `npm run completeness` scripts in
  `package.json`. Stryker config at `stryker.conf.json`.
- `docs/sdk.md` `retrieveBundle` example fixed — used invented
  `confidence`/`gaps`/`staleRecords` fields that do not exist on
  `EvidenceBundle`; now shows real
  `confidenceBoundaries`/`missingContext`/`freshness.staleCount` fields
  from `src/types/evidence-bundle.ts` (CIDOCS-R2-001).
- `docs/sdk.md` `policyExplain`/`policyTest` examples fixed — used
  invented `capabilities` field on `Principal`; now shows real
  `{ id, name, roles, trustZone, metadata? }` shape from
  `src/types/policy.ts` (CIDOCS-R2-003).
- `README.md`, `docs/release-notes-v0.1.md`, `docs/phase-15-closeout.md`
  test counts updated from `623+ / 58 files` to the post-wave count
  (`699+ tests across 63 files`) (CIDOCS-R2-002).

## Wave A2 — Dogfood-swarm Stage A re-audit amend (2026-05-27)

Second amend wave after the Stage A re-audit
(`swarm-stage-a-reaudit-20260527-013038Z.md`). Wave A2 closes the regressions
and partial-of-known findings surfaced by the re-audit, plus the policy-layer
per-object scoping cluster that Wave A1's "fix the type-and-wrapper layer"
pattern left to the call sites.

### Kernel
- `CommandQueue` now uses atomic `tmp+rename` writes + try/catch around
  `JSON.parse` on load with a typed `CorruptStoreError` (closes KERNEL-R001 —
  the relative outlier after the four Stores got atomic writes in Wave A1).
- Policy-layer per-object scoping extended to `retrieveBundle`
  provenanceEvents (ledger/index subjects), `explainIndex` ledger source
  store, `inspectCommand`, `listReceipts` resultSummary, plus a non-NOP
  `'reindex'` arm and an `ops/` consumer of `mutation_orphaned` events.

### Stores
- Deleted duplicate `ImportSnapshotNotSupportedError` in
  `src/adapters/local/errors.ts` (kept only the `src/ops/errors.ts` copy that
  `backup.ts` actually imports).
- `replaceAll` declared on the `IndexStore` contract (no longer duck-typed in
  `rebuild.ts`).
- `LocalArtifactStore.getContent()` now validates `contentHash` regex on the
  load path too (defense-in-depth parity with `importSnapshot`).
- `PostgresCanonicalStore.importSnapshot` uses `INSERT ... ON CONFLICT` to
  close the TOCTOU window on concurrent restores.

### Surface
- Deleted every `kernel._kernel` unwrap from `src/cli.ts` (10 sites) and
  `src/integrations/repo-knowledge/ingest.ts` (1 site) — the CLI and ingest
  now call `PolicyEnforcedKernel` wrappers directly, restoring the policy
  layer that Wave A1's KERNEL-001 wrappers were designed to enforce.
- Removed the SDK + CLI auto-walk; callers explicitly chain
  `validateMutation` → `approveMutation` → `commitMutation`, preserving the
  separation of duties tightening from KERNEL-006.
- `SDK.resolve()` now goes through the policy-enforced path (no more direct
  `ClusterResolver`); `sanitizeEntityForOutput` + `sanitizeReceiptForOutput`
  wired into every MCP boundary.
- `DB_CLUSTER_PRINCIPAL` JSON now schema-validated with fail-closed on
  malformed input; `DB_CLUSTER_POLICIES_FILE` path-sandboxed against cwd.
- `dashboard/components/PolicyViewToggle.jsx` now imports `applyRedaction`
  from the shared lib (no more divergent inline copy).

### Tests
- Rewrote `wave6-proof.test.ts:350` to assert
  `Object.keys(import('db-cluster')).not.toContain('ClusterKernel')` (was
  test theatre that passed via a JSDoc comment substring).
- Removed every `npx tsx` invocation from `phase10-proof.test.ts` (finishes
  the TESTS-006 sweep that missed sibling patterns in Wave A1).
- Added regression nets for the 5 typed errors / write mechanisms Wave A1
  shipped without tests: `ReceiptFailedError` + `mutation_orphaned`,
  `CorruptStoreError`, `ImportSnapshotNotSupportedError`,
  `LocalCanonicalStore.importSnapshot` entity-ID preservation,
  `LedgerStore.importEvent`/`importReceipt` idempotency.
- Added SDK end-to-end policy wiring tests (3+ integration tests asserting
  `findSources` filtering, `commitMutation` denial, and policy-less
  bypass behavior).
- Pinned the verify status either-OK assertions (`'healthy'|'degraded'`)
  back to specific expected outcomes — the 2 new instances Wave A1
  introduced are gone.
- Phase 12 Proof 12 now uses `verify()` (not `doctor()`) and asserts
  entity-ID round-trip preservation.

### CI/Docs
- Added `permissions: contents: read` to all three workflows
  (`ci.yml`, `release-gate.yml`, `smoke-install.yml`) for defense-in-depth.
- Added `concurrency:` block to `ci.yml` so pushes to a branch/PR cancel
  prior in-flight runs.
- `smoke-install.yml` now also triggers on `workflow_dispatch` and on PRs
  that touch `package.json`, so smoke runs against the to-be-tagged commit
  pre-tag (not only post-tag).
- `scripts/release-gate.mjs` `scanForDrift` widened to walk both
  `examples/` and `dashboard/lib/` (closes CIDOCS-R008).
- `docs/release-notes-v0.1.md`, `docs/package-boundary.md`,
  `docs/handbook.md`, `docs/phase-15-closeout.md`,
  `docs/release-readiness.md` swept clean of the false claim that
  `ClusterKernel` is exported from `'db-cluster'`.
- `docs/policy-and-redaction.md`, `docs/handbook.md`, `docs/cli.md`,
  `examples/mcp/safety-model.md` corrected to show the real `Principal`
  shape (`{ id, name, roles, trustZone, metadata? }`) and the real
  13-verb `Capability` union.
- Deleted `examples/sdk/postgres-canonical.ts` — the SDK does not support
  a Postgres-via-SDK path today (env var has no effect; SDK
  unconditionally calls `createLocalCluster`). Use
  `createClusterFromEnv()` with the raw kernel if Postgres canonical
  is required.
- `README.md`, `docs/release-notes-v0.1.md`, `docs/phase-15-closeout.md`
  updated to 623+ tests / 58 files (post-Wave-A2 count finalized in
  the amend report).
- `docs/phase-15-closeout.md` "Next phase candidates" no longer lists
  CI pipeline as future work (it landed in Wave A1).
- Documented the recommended release flow in `docs/release-readiness.md`
  (smoke pre-tag via `workflow_dispatch` + PR-on-version-bump, defense
  in depth via tag-push smoke).

## Wave A1 — Dogfood-swarm Stage A amend (2026-05-26)

Health-pass amend after the Stage A audit (`swarm-stage-a-audit-20260526-225638Z.md`).
This wave fixes CI/Docs-domain findings — Phase 15 self-declared PASS without
continuous verification, which the audit surfaced as a gap.

### CI workflows added
- `.github/workflows/ci.yml` — Node 20/22 × ubuntu/windows matrix on push/PR (lint, lint:examples, build, test).
- `.github/workflows/release-gate.yml` — runs `scripts/release-gate.mjs` on push to main and tag push.
- `.github/workflows/smoke-install.yml` — runs `scripts/smoke-install.mjs` on tag push.

### Release-gate portability
- `scripts/release-gate.mjs` drift check now uses a Node-native scan (was Windows-only `findstr` that silently passed on macOS/Linux).
- Matches both `from '../../src/...'` (static) and `import('../../src/...')` (dynamic) imports.

### Examples typecheck
- New `tsconfig.examples.json` extends the main tsconfig with `noEmit` + `examples/**/*` include.
- `package.json` adds `npm run lint:examples`; `npm run lint` now chains it.
- Every example rewritten against the current public-API surface (correct `actorId`, correct method names, SDK constructor with `policies`/`principal`, no `'../../src/'` imports).

### Documentation
- `docs/sdk.md`, `docs/cluster-uris.md`, `docs/handbook.md` updated to the §2 SDK constructor signature (`{ clusterDir, policies?, trustZones?, visibilityRules?, principal? }`); removed the structurally-impossible "Postgres via SDK" pattern.
- `docs/mcp.md` "Artifact content boundary" rewritten to reflect that artifact content is not retrievable via the MCP boundary (no `_contentAccess` escape hatch).
- `docs/release-readiness.md` updated to "verified post-Wave-A1" with CI/lint:examples evidence rows.
- `docs/release-notes-v0.1.md` corrected: 15 phases (not 14); test count carries a TODO marker pending the final Wave A1 vitest run.
- `docs/phase-15-closeout.md` annotated with the Wave A1 amend note.

### .gitignore
- Added `.db-cluster/` and `examples/**/.db-cluster/` so users following the quickstart don't accidentally commit cluster data.

## Phase 15 — Release Readiness & Package Boundary (2026-05-26)

Prepares db-cluster for a real versioned release. Deliberate public API, package boundary documentation, fresh install smoke tests, and release gate automation. **Verdict: PASS.**

### Public API surface (`src/index.ts` rewritten)
- Main entry exports: ClusterKernel, store contracts, domain types, factory, ops, URI
- Subpath exports: `db-cluster/sdk`, `db-cluster/mcp`, `db-cluster/policy`, `db-cluster/types`
- Internal details intentionally excluded (adapters, command queue, repo-knowledge)

### Package boundary
- `exports` map in package.json with explicit subpath conditions
- `files` field restricts to dist/docs/examples/dashboard/README/CHANGELOG/LICENSE
- `prepack` script ensures build before pack
- `docs/package-boundary.md` documents public vs private

### Release gate automation
- `scripts/release-gate.mjs` — 6-stage gate (build, test, pack, smoke, drift, exports)
- `scripts/smoke-install.mjs` — 9-test fresh install validation from tarball

### Documentation
- `docs/release-notes-v0.1.md` — honest positioning (is/is-not table)
- `docs/release-readiness.md` — readiness assessment checklist
- `docs/package-boundary.md` — public/private boundary reference
- All examples updated to use package import paths

### Proof suite
- `test/phase15-proof.test.ts` — 10 proofs: API surface, exports, bins, pack, examples, positioning, lifecycle, release-gate

## Phase 14 — Repo-Knowledge Integration Gate (2026-05-26)

Proves db-cluster adds value as a backing substrate for repo-knowledge workflows — provenance, evidence bundles, mutation safety, and recovery — without replacing the existing system. **Verdict: PASS.**

### Integration adapter (`src/integrations/repo-knowledge/`)
- `mapping.ts` — 10 entity kinds, 7 artifact kinds, 7 provenance edge types
- `ingest.ts` — parallel ingest (read-only, source files untouched)
- `compare-retrieval.ts` — evidence bundle vs flat-file comparison
- `update-workflow.ts` — typed command lifecycle (propose/validate/approve/commit)

### Scripts
- `scripts/repo-knowledge-dashboard-snapshot.ts` — dashboard snapshot of imported memory
- `scripts/repo-knowledge-update-demo.ts` — mutation workflow demonstration
- `scripts/repo-knowledge-ops.ts` — operations/recovery demonstration

### Documentation
- `docs/phase-14-repo-knowledge-integration-gate.md` — doctrine + boundary
- `docs/repo-knowledge-mapping.md` — mapping reference
- `docs/phase-14-repo-knowledge-integration-report.md` — gate verdict + evidence matrix
- `docs/phase-14-closeout.md` — closeout summary

### Tests (+65)
- 12 mapping tests, 9 ingest tests, 8 retrieval tests
- 8 dashboard tests, 8 mutation tests, 8 ops tests
- 12 integration gate proofs (`test/phase14-proof.test.ts`)

## Phase 13 — Dashboard / Truth Inspector Integration (2026-05-27)

Turns the ClusterTruthInspector template into a real inspector over dogfood data. Dashboard consumes cluster state through kernel verbs only — never raw adapter access.

### New modules
- `src/dashboard/dashboard-model.ts` — DashboardObject type contract (URI, ownerStore, sourceType, freshness, provenance, receipts, warnings)
- `src/dashboard/inspector-data.ts` — maps kernel verbs → DashboardObject instances
- `src/dashboard/ops-model.ts` — operations health model from doctor/verify
- `scripts/dashboard-snapshot.ts` — generates static JSON from live cluster

### React components (CDN, no build step)
- `dashboard/ClusterTruthInspector.jsx` — main inspector (StoreLanesMap, ProvenanceTimeline, ExplainIndexPanel)
- `dashboard/components/OperationsPanel.jsx` — cluster health and integrity at a glance
- `dashboard/components/CommandPreviewPanel.jsx` — command lifecycle visualization (proposed ≠ truth)
- `dashboard/components/PolicyViewToggle.jsx` — view-as operator/agent/observer/external + applyRedaction

### Demo + data
- `dashboard/demo-data.js` — 6 shaped DashboardObject instances + policy views + ops status
- `dashboard/index.html` — demo host page
- `dashboard/README.md` — doctrine and usage

### Test files
- `test/dashboard-model.test.ts` — 14 tests
- `test/dashboard-snapshot.test.ts` — 8 tests
- `test/dashboard-ops.test.ts` — 6 tests
- `test/dashboard-command-preview.test.ts` — 6 tests
- `test/dashboard-policy-view.test.ts` — 8 tests
- `test/phase13-proof.test.ts` — 12 architecture proofs

### 12 proofs verified
1. Dashboard model never reads raw adapters directly
2. Every DashboardObject has URI, ownerStore, and sourceType
3. Index records labeled derivative
4. Canonical = owner-truth, artifact = source-truth
5. Provenance graph has nodes and edges from real cluster data
6. Receipts connected to command lifecycle
7. Command preview lives in ledger (append-only, non-editable)
8. Redaction returns new copy — source never mutated
9. Ops model uses doctor() and kernel verbs
10. Snapshot generates from live cluster
11. Template files exist and expose window globals
12. No dashboard copy positions product as CRUD/RAG/admin

### Stats
- 539 tests passing (48 skipped), 0 failures
- 47 test files

## Phase 12 — Dogfood Findings Repair (2026-05-27)

Converts Phase 11's PASS_WITH_CONDITIONS into a stronger product foundation by fixing the four gaps discovered through self-dogfood.

### Findings repaired
1. **restore() doesn't restore artifacts** — Backup now captures base64 content + SHA-256 checksum; restore verifies integrity and uses `importSnapshot()` to preserve original artifact IDs.
2. **Command state not shared across kernel instances** — CommandQueue rewritten to read from disk on every `get()` call; no stale in-memory cache.
3. **commitMutation(create_entity) doesn't auto-index** — `create_entity` and `update_entity` now auto-index in `commitMutation()`, matching `createEntity()` behavior.
4. **Index is name-based, not content-based** — New `src/indexing/` module (tokenizer + content-indexer) produces content-aware index text from artifact content (headings, key terms).

### New files
- `src/indexing/tokenizer.ts` — text tokenization, heading extraction, stop-word filtering
- `src/indexing/content-indexer.ts` — content-aware artifact indexing
- `test/restore-artifacts.test.ts` — 6 tests
- `test/command-persistence.test.ts` — 7 tests
- `test/command-index-consistency.test.ts` — 6 tests
- `test/content-index.test.ts` — 10 tests
- `test/dogfood-replay.test.ts` — 6 tests
- `test/phase12-proof.test.ts` — 14 proofs
- `scripts/dogfood-replay.ts` — end-to-end regression replay
- `docs/phase-12-dogfood-repair.md` — doctrine doc
- `docs/phase-12-repair-report.md` — value report (Verdict: PASS)

### Stats
- 485 tests passing (48 skipped), 0 failures
- 41 test files

## Phase 11 — Dogfood Gate (2026-05-27)

### Wave 1 — Schema + Overview
- `examples/dogfood-project-memory/schema.md` — entity kinds, artifact kinds, provenance edges, trust zones, invariants
- `examples/dogfood-project-memory/README.md` — dogfood overview

### Wave 2 — Dogfood Ingest
- `scripts/dogfood-ingest.ts` — 12 artifacts (README, CHANGELOG, 10 closeout docs), 22 canonical entities (1 project, 10 phases, 6 decisions, 2 milestones, 3 findings), 19 provenance links

### Wave 3 — Retrieval Tests
- `scripts/dogfood-query.ts` — 9 retrieval queries
- `test/dogfood-retrieval.test.ts` — 10 tests (evidence bundles, not flat hits)

### Wave 4 — Trace Tests
- `scripts/dogfood-trace.ts` — 5 object traces
- `test/dogfood-trace.test.ts` — 7 tests (provenance graph navigation, why() explanations)

### Wave 5 — Mutation Tests
- `scripts/dogfood-update.ts` — full command lifecycle demo
- `test/dogfood-mutation.test.ts` — 7 tests (propose→validate→approve→commit→receipt)

### Wave 6 — Policy Tests
- `scripts/dogfood-policy.ts` — 4 principals with extended policies
- `test/dogfood-policy.test.ts` — 7 tests (operator/agent/observer/external enforcement)

### Wave 7 — Operations Tests
- `scripts/dogfood-ops.ts` — doctor, rebuild, backup, restore demo
- `test/dogfood-ops.test.ts` — 7 tests (health, rebuild, backup/restore)

### Wave 8 — Proof Suite + Value Report
- `test/phase11-proof.test.ts` — 12 proofs: ingest completeness, URI resolution, evidence bundles, trace-to-source, command lifecycle, agent denied, operator approved, redaction shape, index rebuild, backup/restore, report existence, friction surfaced
- `docs/phase-11-dogfood-report.md` — structured value report with real product findings

### Product Findings
1. `restore()` does not restore artifacts — only entities/events/receipts + index rebuild
2. `commitMutation(create_entity)` does not auto-index — entities not discoverable until rebuild
3. In-memory command state not shared across PolicyEnforcedKernel instances
4. Index stores entity names, not artifact content — limits semantic retrieval

### Summary
484 tests passing across 35 files. db-cluster proves value as project-memory substrate — structured retrieval, safe mutation, inspectable provenance, enforceable policy. Verdict: PASS_WITH_CONDITIONS.

## Phase 10 — Developer Product Surface (2026-05-27)

### Wave 1 — Documentation Architecture
- 12 docs in `docs/`: quickstart, architecture, store-contracts, cluster-uris, retrieval-bundles, provenance-graphs, mutation-law, policy-and-redaction, mcp, sdk, cli, operations
- All lead with cluster thesis and name store ownership law
- No framing as RAG, vector DB, AI memory, or middleware

### Wave 2 — Quickstart Golden Path
- `examples/quickstart/` — evidence.md, commands.md, README.md
- Expected output for init, ingest, doctor commands
- Developer can follow the golden path without reading source

### Wave 3 — CLI Reference Test
- `test/cli-docs.test.ts` — 14 tests verifying docs/cli.md stays in sync with CLI

### Wave 4 — SDK Reference Examples
- 5 SDK examples: local-cluster, postgres-canonical, retrieval-bundle, mutation-lifecycle, policy-redaction
- All compile and demonstrate cluster thesis

### Wave 5 — MCP Integration Guide
- `examples/mcp/` — config.example.json, tool-catalog.md (16 tools), safety-model.md
- Artifact content boundary, lifecycle enforcement, trust zones documented

### Wave 6 — Example Applications
- `examples/research-evidence-cluster/` — papers + claims
- `examples/project-memory-cluster/` — docs + decisions
- `examples/agent-safe-app-db/` — uploaded records + app records, policy enforcement

### Wave 7 — Installation + Smoke Tests
- `test/install-smoke.test.ts` — 9 tests: build, dist, CLI, SDK imports, MCP module, Postgres error path

### Wave 8 — Phase 10 Proof Suite
- `test/phase10-proof.test.ts` — 12 proofs: README accuracy, CLI parity, compilation, MCP tool parity, quickstart, 4-store usage, no single-store examples, no middleware framing, mutation lifecycle, policy non-leakage, operations docs, install cleanliness

### Summary
434 tests passing across 29 files. The cluster is legible and runnable as a developer product.

## Phase 9 — Operations, Rebuild, and Recovery (2026-05-26)

### Wave 1 — Operations Doctrine + Health Model
- `HealthStatus`, `HealthCheck`, `ClusterHealth`, `StoreHealth` types
- Health is explicit — not inferred from absence of errors
- `buildClusterHealth()` computes worst-of status from individual checks
- `worstStatus()` priority ordering: corrupt > unreachable > missing > stale > degraded > unverified > healthy

### Wave 2 — Doctor and Verify
- `doctor()` — full cluster reachability assessment (canonical, artifact, index, ledger)
- Detects: empty index when data exists, missing Postgres migrations, unloadable policies
- `verify()` — proves data consistency invariants (index→source, provenance→subject, receipt→event)
- Both are read-only: they never mutate state

### Wave 3 — Index Rebuild and Stale Repair
- `rebuildIndex()` — reconstructs index from canonical + artifact truth
- `checkStale()` — detects orphan index records and missing index entries
- `clear()` + re-index cycle: index is always derivative, never authoritative
- Dry-run mode for safe preview

### Wave 4 — Provenance + Receipt Checks
- `checkProvenance()` — verifies provenance events reference valid subjects
- `checkReceipts()` — verifies receipts reference valid provenance events
- Both return structured `HealthCheck[]` results

### Wave 5 — Backup and Restore
- `backup()` — exports entities, artifacts, events, receipts as portable JSON
- `restore()` — imports cluster state, rebuilds index after import
- Restore is additive: duplicate restores don't corrupt state
- Backup version field for future format evolution

### Wave 6 — Migration Status + Schema Verify
- `checkMigrationStatus()` — reports whether Postgres tables exist
- `verifySchema()` — validates column structure matches expectations
- Both work against live Postgres pool

### Wave 7 — Operational CLI Surface
- `db-cluster doctor` — full health assessment (with `--json`)
- `db-cluster verify` — invariant proofs (with `--json`, `--sample`)
- `db-cluster rebuild index` — reconstruct from truth (with `--dry-run`)
- `db-cluster rebuild check` — report stale records
- `db-cluster backup` — export cluster state
- `db-cluster restore <file>` — import from backup
- `db-cluster migration-status` — Postgres schema state
- `db-cluster verify-schema` — validate physical schema structure

### Wave 8 — Phase 9 Proof Suite (12 tests)
- Doctor reports healthy after clean setup
- Doctor detects degraded state when index wiped
- Verify detects stale index after unindexed entity insert
- rebuildIndex restores full discoverability after clear
- checkStale detects orphan index records
- Provenance check verifies event integrity
- Receipt check verifies receipt→event links
- Backup captures all cluster state
- Restore recovers state into empty cluster
- Restore is additive (no corruption on repeat)
- worstStatus computes correct severity ordering
- Full cycle: damage → detect → rebuild → verify passes

## Phase 8 — Physical Store Expansion (2026-05-26)

### Wave 1 — Backend Adapter Doctrine
- Physical backends are implementations of store law, not new product centers
- Postgres canonical adapter is first target
- No vector DB, graph DB, or distributed behavior yet
- No schema drift from existing CanonicalStore contract

### Wave 2 — Postgres Canonical Schema
- `canonical_entities` table: id, kind, name, attributes (JSONB), owner, timestamps
- Idempotent migration with `CREATE TABLE IF NOT EXISTS`
- Indexes on kind and name for query performance

### Wave 3 — PostgresCanonicalStore Adapter
- Implements `CanonicalStore` interface exactly: create, get, list, update, exists
- Parameterized queries (SQL injection safe)
- Proper UUID handling, JSONB attributes roundtrip
- `migrate()` and `teardown()` lifecycle methods

### Wave 4 — Store Factory and Config
- `createCluster()` — explicit backend config, no silent fallback
- `createClusterFromEnv()` — environment variable driven
- Fail-fast: missing Postgres URL throws immediately
- Mixed mode: Postgres canonical + local artifact/index/ledger

### Wave 5 — Kernel Regression Against Postgres (9 tests)
- ingest artifact writes to local, not Postgres
- create entity writes to Postgres canonical
- find resolves owner truth from Postgres
- inspect reads Postgres canonical truth
- retrieve bundle includes Postgres-backed entity
- trace graph crosses Postgres canonical + local ledger
- mutation lifecycle updates Postgres canonical truth
- receipts remain in ledger
- policy denies Postgres-backed entity for restricted principal

### Wave 6 — CLI Support
- `db-cluster stores verify` — backend config, connection status, migration status
- `db-cluster stores migrate` — run pending Postgres migrations
- `db-cluster stores list` — list configured backends per store

### Wave 7 — Backend Parity Tests (10 tests)
- Equivalent entity shape across backends
- Kernel behavior unchanged when backend changes
- Index remains derivative
- Ledger remains append-only
- Artifact store remains immutable
- Policy enforcement identical
- Redaction identical
- Mutation receipts identical
- Cross-process persistence stronger with Postgres
- Factory refuses unsafe/missing config

### Wave 8 — Phase 8 Proof Suite (10 tests)
- Delete index, rebuild from Postgres canonical truth
- Mutate only through command lifecycle
- Direct adapter mutation detectable as drift (no receipt)
- Retrieve bundle resolves Postgres owner truth
- Trace graph crosses Postgres canonical + local ledger
- Policy denial prevents reading Postgres owner truth
- Redaction hides Postgres-backed entity attributes
- MCP cannot distinguish backend except via allowed metadata
- SDK observes Postgres-backed mutation consistently
- Local and Postgres pass shared contract suite

## Phase 7 — Policy, Permissions, and Trust Boundaries (2026-05-26)

### Wave 1 — Policy Type Model
- `Policy`, `Principal`, `TrustZone`, `VisibilityRule`, `RedactionRule` types
- Principal: identity + roles + trustZone binding
- Policy: verb + resource + effect (allow/deny) + conditions + redactionRules
- TrustZone: named boundary with default policies + zone-level redaction

### Wave 2 — Deterministic Policy Engine
- `evaluatePolicy(principal, verb, resource, policies)` — first-match deny-wins
- `checkVisibility(principal, resource, rules)` — existence + metadata visibility
- `matchPolicy(principal, policy)` — role + zone + condition matching
- `DEFAULT_POLICIES`, `DEFAULT_TRUST_ZONES`, `DEFAULT_VISIBILITY_RULES`

### Wave 3 — Kernel Enforcement
- `PolicyEnforcedKernel` wraps `ClusterKernel` with policy checks on every operation
- Read enforcement: `inspectEntity`, `findSources`, `retrieveBundle`, `traceObject`, `why`
- Command enforcement: `inspectCommand`, `listReceipts`
- Mutation enforcement: `proposeMutation`, `commitMutation`
- Visibility-aware: denied reads either throw AccessDenied or silently exclude based on existence visibility

### Wave 4 — MCP/SDK/CLI Policy Surface
- `cluster_policy_explain` MCP tool — surfaces effective policy for a principal
- `cluster_policy_test` MCP tool — tests a specific action against policy
- SDK methods: `policyExplain`, `policyTest`
- CLI subcommands: `policy explain`, `policy test`

### Wave 5 — Redaction and Existence Leakage
- `redactArtifact()` — strips/masks/summarizes/hashes artifact storagePath
- `redactEntity()` — masks/strips entity attributes preserving object shape
- `redactCommand()` — strips command payloads preserving lifecycle metadata
- `redactReceipt()` — strips receipt details preserving audit shape
- `redactProvenanceActors()` — strips actor identities from graph nodes/edges
- `redactGraphNodes()` — replaces hidden nodes with `[Access restricted]` placeholders
- `sanitizeWarnings()` — removes stale/gap warnings referencing hidden URIs
- PolicyEnforcedKernel applies redaction on every read path

### Wave 6 — Phase 7 Proof Suite (34 tests)
- Denied reads cannot access entity owner truth
- Index-only access cannot escalate to owner truth
- Hidden existence: denied entities invisible in find results
- Redacted provenance trace preserves graph structure
- Redacted receipts preserve audit shape with stripped payloads
- MCP/SDK policy parity: same enforcement through both surfaces
- CLI safety: policy explain/test work without elevation
- Proposer-only principal cannot approve or commit
- Approver-only principal cannot propose mutations
- Existing kernel law preserved: command lifecycle, receipt emission, provenance

## Phase 6 — AI-Facing Interface: MCP and SDK (2026-05-26)

### Wave 1 — SDK Surface
- `ClusterSDK` class — clean programmatic API over kernel
- Methods: findSources, retrieveBundle, explainRetrieval, resolve, traceObject, why
- Mutation lifecycle: proposeMutation, validateMutation, approveMutation, rejectMutation, commitMutation, compensateMutation
- Inspection: inspectCommand, listReceipts
- Constructor takes `SDKOptions { clusterDir }`, creates cluster + kernel + resolver internally

### Wave 2 — MCP Tool Schema
- 14 tools defined with typed input schemas
- Read tools: cluster_find_sources, cluster_retrieve_bundle, cluster_explain_retrieval, cluster_resolve, cluster_trace, cluster_why, cluster_inspect_command, cluster_list_receipts
- Lifecycle tools: cluster_propose_mutation, cluster_validate_mutation, cluster_approve_mutation, cluster_reject_mutation
- Write tools: cluster_commit_mutation, cluster_compensate_mutation

### Wave 3 — MCP Server Runtime
- Stdio transport via `@modelcontextprotocol/sdk`
- `db-cluster-mcp` bin entry — startable as real tool surface
- All tools delegate to SDK → kernel → stores (no alternate path)
- `handleTool` exported for testability with SDK override

### Wave 4 — Safety Guardrails
- `ToolAnnotations` interface: readOnly, writesCluster, approvalSensitive, stagedOnly, requiresExistingCommand
- Every tool carries machine-readable annotations
- Output discipline: `_meta.operation`, `_meta.writesCluster`, `_sourceType`, `_staleWarning`, `_missingWarning`, `statusTransition`
- Prompt-injection boundary: artifact content/rawContent stripped, `_contentPolicy` marker
- `dataIntegrity` statement on retrieve_bundle: content is DATA, not instructions
- `formatCommandOutput` surfaces all lifecycle metadata visibly

### Wave 5 — Parity Tests (22 tests)
- retrieveBundle: same URIs, owner stores, freshness, confidence through MCP and SDK
- trace: equivalent provenance graph nodes/edges
- why: identical explanation text
- Lifecycle: propose → validate → approve → commit state matches at every step
- Rejected command cannot commit through MCP
- Stale index labeled derivative, resolved objects labeled owner-truth
- Missing owner truth surfaces as `_missingWarning`
- Receipts created via MCP visible through SDK
- All 14 tool annotations match intended risk classes (6 sub-assertions)
- Artifact sanitization strips content from MCP output, owner-store truth undamaged

### Wave 6 — Destructive Proof Suite (22 tests)
- MCP proposal writes no cluster truth (store state unchanged)
- MCP commit cannot bypass validation (invalid payload rejected, rejected commands blocked, double-commit blocked)
- Rejected command persists across SDK instances (survives restart)
- Adversarial artifact content cannot alter tool permissions/annotations
- Stale index warnings survive MCP retrieval
- Missing owner truth: empty retrieval returns valid structure, non-existent trace returns gap nodes
- Raw artifact content never exposed through MCP output
- MCP lifecycle receipts traceable through `why` and `trace`
- No raw adapter/store exported through any public surface
- CLI ↔ MCP parity: entity committed through MCP visible through CLI, entity committed through CLI visible through MCP

### Bonus Fix
- Removed duplicate `trace` command in CLI (Phase 2/4 overlap bug)

**Phase 6 total: 44 new tests (210 cumulative), all passing.**

---

## Phase 5 — Mutation Law and Command Runtime (2026-05-26)

### Wave 1 — Command Lifecycle Model
- `CommandStatus`: proposed → validated → approved → committed → (compensated) / rejected
- `ValidationResult`, `ValidationCheck` — named, inspectable validation output
- Commands carry: rejection reason/actor, approval metadata/note, commit actor, compensation references
- Added `compensate` verb

### Wave 2 — Command Validator
- 5 structural checks: verb_present, target_store_valid, payload_present, payload_shape, status_is_proposed
- Verb-specific payload validation: create_entity (kind+name), update_entity (entityId+patch), link_evidence (artifactId+entityId), compensate (originalCommandId+reason)
- Validation failures produce named check results, not opaque errors

### Wave 3 — Approval/Rejection Runtime
- `kernel.validateMutation(id)` — validate without committing
- `kernel.approveMutation(id, actor, note)` — operator/policy gate
- `kernel.rejectMutation(id, actor, reason)` — explicit rejection
- `kernel.inspectCommand(id)` — full lifecycle state inspection
- All transitions emit provenance events to ledger

### Wave 4 — Compensation Path
- `kernel.compensateMutation(id, actor, reason)` — correct without erasing
- Creates compensating command with receipt; links back to original
- Original receipt preserved; original command marked `compensated`
- Cannot compensate non-committed commands

### Wave 5 — CLI Surface
- `db-cluster validate <id>` — validate with check output
- `db-cluster approve <id> [--note]` — approve validated command
- `db-cluster reject <id> --reason` — reject with reason
- `db-cluster compensate <id> --reason` — compensate committed command
- `db-cluster inspect-command <id>` — full lifecycle JSON

### Wave 6 — Proof Tests
- No commit without validation
- Rejected commands cannot commit
- Full approval lifecycle (proposed→validated→approved→committed)
- Compensation preserves original receipt
- Failed commands produce audit trail (rejection, approval, compensation events)
- Cross-process command lifecycle survives restart
- Validation produces detailed named checks
- Invalid status transitions are rejected

**Phase 5 total: 17 new tests (166 cumulative), all passing.**

---

## Phase 4 — Provenance Graph and Trace Surface (2026-05-26)

### Wave 1 — Provenance Graph Type Model
- `ProvenanceGraph`, `ProvenanceNode`, `ProvenanceEdge` — machine-readable trace graph
- `TraceDirection` (backward/forward/bidirectional), `TraceOptions`
- `NodeType` (7 variants: entity, artifact, index_record, provenance_event, receipt, command, evidence_bundle)
- `EdgeType` (11 variants covering all store relationships)
- `TraceGap`, `TraceWarning`, `TraceSummary`

### Wave 2 — TraceBuilder
- `TraceBuilder` class: builds cross-store provenance graphs from any cluster URI
- Traces across all four stores + receipts (not just ledger parent chains)
- Surfaces gaps, stale projections, and missing owner truth honestly
- Deduplicates edges, avoids infinite loops via visited set

### Wave 3 — Kernel Trace Verbs
- `kernel.traceObject(uri, options)` → ProvenanceGraph
- `kernel.traceBundle(bundle, options)` → combined ProvenanceGraph
- `kernel.explainTrace(graph)` → human-readable multiline summary
- `kernel.why(uri)` → compact operator-facing explanation

### Wave 4 — CLI Trace Surface
- `db-cluster trace <uri> [--direction] [--depth] [--graph]`
- `db-cluster why <uri>`
- `db-cluster lineage <uri>` (bidirectional full trace)
- `db-cluster trace-bundle <query>` (retrieve + trace)

### Wave 5 — Proof Tests
- Cross-store trace: entity trace crosses canonical → ledger → artifact
- Derivative visibility: graph distinguishes source truth vs index projection
- Stale projection: stale index emits warning + stale_projection_of edge
- Missing truth: non-existent URI produces gap node, not crash
- Receipts connected: entity trace includes covering receipts
- Bundle trace: traceBundle covers all resolved evidence
- Cross-process: trace works across kernel instances (persistent state)
- Stable ordering: same trace produces same node/edge order
- Human-readable: explainTrace and why produce meaningful output
- Golden path: ingest → create → link → trace → explain lifecycle

**Phase 4 total: 12 new tests (149 cumulative), all passing.**

---

## Phase 3 — Retrieval Planner and Evidence Bundles (2026-05-26)

### Wave 1 — Evidence Bundle Type Model
- `EvidenceBundle` — structured retrieval output with query, resolved evidence, freshness, gaps, boundaries
- `ResolvedEvidence<T>` — owner-store object + URI + staleness + provenance event IDs
- `FreshnessAssessment`, `MissingContext`, `ConfidenceBoundary`

### Wave 2 — Retrieval Planner
- `RetrievalPlanner` class: query → index → resolve → attach provenance → classify freshness → compute confidence
- Returns `EvidenceBundle` (not search hits)
- Detects stale index records, missing provenance, missing owner truth
- Computes confidence boundaries: what the bundle can and cannot claim

### Wave 3 — Kernel Retrieval Verbs
- `kernel.retrieveBundle(query, options)` → EvidenceBundle
- `kernel.explainRetrieval(bundle)` → RetrievalExplanation

### Wave 4 — CLI Retrieval Surface
- `db-cluster retrieve <query> [--limit]`
- `db-cluster explain-retrieval <query> [--limit]`

### Wave 5 — Proof Tests
- Retrieval survives stale index
- Retrieval exposes missing provenance
- Retrieval confidence degrades honestly
- Bundle carries owner truth, not index projections
- Explain names specific gaps and boundaries

**Phase 3 total: 24 new tests (137 cumulative), all passing.**

---

## Phase 2 — Cross-Store Identity and Rebuildable Index (2026-05-26)

### Wave 1 — Cluster URI Model
- `cluster://<store>/<id>` URI scheme: canonical, artifact, index, ledger, receipt
- `parseClusterUri`, `formatClusterUri`, `isClusterUri`, `uriForObject`
- `ClusterUriError` for malformed/unknown store URIs
- 24 URI tests

### Wave 2 — Resolver Spine
- `ClusterResolver`: resolve, resolveAll, tryResolve
- Always resolves to owner store, never index
- `ResolveError` for missing objects
- 14 resolver tests

### Wave 3 — Index Rebuild
- `kernel.rebuildIndex()` — clear + re-derive from truth stores
- `kernel.indexStatus()` — count, per-store breakdown, staleness estimate
- CLI: `db-cluster index rebuild`, `db-cluster index status`
- 9 rebuild tests

### Wave 4 — Index Explain/Stale
- `kernel.explainIndex(recordId)` — why record exists, owner truth, freshness
- `kernel.listStaleRecords()` — detect all stale index records
- CLI: `db-cluster index explain <id>`, `db-cluster index stale`
- CLI: `db-cluster resolve <uri>`
- 7 explain tests

### Wave 5 — Proof Tests
- URI roundtrip: parse → format → resolve
- Resolver returns owner truth after index destruction
- Rebuild produces identical find results
- Stale detection catches mutations that bypass index
- Explain names specific owner truth
- Cross-store identity stable across restart
- 13 proof tests

**Phase 2 total: 67 new tests (113 cumulative), all passing.**

---

## Phase 1 — Cluster Spine (2026-05-26)

### Wave 1 — Identity + Contracts
- Package naming lock: `db-cluster`
- README with product thesis and architecture laws
- Phase 0 doctrine frozen in `docs/phase-0-doctrine.md`
- Store contract interfaces: CanonicalStore, ArtifactStore, IndexStore, LedgerStore
- Cluster object model: Entity, Artifact, IndexRecord, ProvenanceEvent, Command, Receipt
- 5 contract enforcement tests

### Wave 2 — Local Store Adapters
- File-backed LocalCanonicalStore (CRUD, owner enforcement)
- File-backed LocalArtifactStore (content-addressed, immutable, versioned)
- File-backed LocalIndexStore (rebuildable, clearable)
- File-backed LocalLedgerStore (append-only events + receipts)
- `createLocalCluster()` factory with physical directory separation
- 16 adapter tests

### Wave 3 — Kernel Spine
- ClusterKernel with 9 verbs: ingestArtifact, createEntity, linkEvidence, findSources, inspectEntity, traceProvenance, proposeMutation, commitMutation, listReceipts
- Command pattern: propose → validate → commit lifecycle
- Persistent CommandQueue (survives process restart)
- Typed errors: NotFoundError, ProvenanceMissingError, CommandNotValidatedError, CommandRejectedError
- 11 kernel tests

### Wave 4 — Golden-Path CLI
- Full CLI via Commander: init, ingest, entity create, link, find, inspect, trace, propose, commit, receipts
- `.db-cluster/` directory convention
- 3 CLI integration tests

### Wave 5 — Proof Tests
- Index rebuild: clear and rebuild from owned stores
- No mutation without command: propose writes nothing, commit is only path
- Artifact immutability: re-ingest creates versions, never overwrites
- Receipt completeness: every write operation has a receipt
- Trace survives restart: new kernel instance reads prior provenance
- Index is not truth: canonical/artifact survive index destruction
- Golden path regression: full lifecycle in one test
- 11 proof tests

**Total: 46 tests, all passing.**
