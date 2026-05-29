# Ship Gate

> No repo is "done" until every applicable line is checked.
> Copy this into your repo root. Check items off per-release.

**Tags:** `[all]` every repo · `[npm]` `[pypi]` `[vsix]` `[desktop]` `[container]` published artifacts · `[mcp]` MCP servers · `[cli]` CLI tools

**This repo:** `[all]` `[npm]` `[mcp]` `[cli]`

---

## A. Security Baseline

- [x] `[all]` SECURITY.md exists (report email, supported versions, response timeline) (2026-05-27)
- [x] `[all]` README includes threat model paragraph (data touched, data NOT touched, permissions required) (2026-05-27)
- [x] `[all]` No secrets, tokens, or credentials in source or diagnostics output (2026-05-27) — verified: only `DB_CLUSTER_POSTGRES_URL` / `DB_CLUSTER_PRINCIPAL` / `DB_CLUSTER_POLICIES_FILE` env vars read; never committed
- [x] `[all]` No telemetry by default — stated explicitly even if obvious (2026-05-27) — see SECURITY.md "Data NOT touched"

### Default safety posture

- [x] `[cli|mcp|desktop]` Dangerous actions (kill, delete, restart) require explicit `--allow-*` flag (2026-05-27) — `destructiveCommand` HOF wraps `restore`, `rebuild index`, `index rebuild`, `compensate`, `backup --force-overwrite`; gated by `--yes` flag + interactive TTY confirmation
- [x] `[cli|mcp|desktop]` File operations constrained to known directories (2026-05-27; clusterDir containment 2026-05-29) — `.db-cluster/` is the only write target. The cluster directory is the working-directory `.db-cluster/` by default; a `config.json` `clusterDir` is **contained to cwd** (EGRESS-002), and `DB_CLUSTER_DIR` is the explicit operator override for a location outside cwd. `DB_CLUSTER_POLICIES_FILE` is path-sandboxed against cwd (lexical + realpath, blocks symlink escape); artifact reads bounded to user-supplied paths.
- [x] `[mcp]` Network egress off by default (2026-05-27) — 16 MCP tools all local-only; Postgres connection only when `DB_CLUSTER_POSTGRES_URL` explicitly set
- [x] `[mcp]` Stack traces never exposed — structured error results only (2026-05-27) — `src/mcp/sanitize.ts::redactError` + `AiErrorEnvelope` shape; `--debug` flag (CLI only, stderr) is the sole reveal path

## B. Error Handling

- [x] `[all]` Errors follow the Structured Error Shape: `code`, `message`, `hint`, `cause?`, `retryable?` (2026-05-27) — `ClusterError` base + per-class subclasses with `code` / `remediationHint` / `retryable`; `AiErrorEnvelope` at every AI-facing boundary
- [x] `[cli]` Exit codes structured per documented convention (2026-05-27) — db-cluster uses sysexits.h: 0 ok, 65 data error, 70 internal error, 77 permission, 78 config. Fully documented in `docs/cli.md` "Exit Codes" table. Equivalent in intent to shipcheck's 0/1/2/3 mapping; the convention is structured, stable across releases, and machine-branchable.
- [x] `[cli]` No raw stack traces without `--debug` (2026-05-27) — `cliCommand` wrapper at `src/cli.ts` catches all errors, formats via `formatForUser`; `--debug` is the only path to raw stacks (stderr)
- [x] `[mcp]` Tool errors return structured results — server never crashes on bad input (2026-05-27) — handled at `src/mcp/server.ts::handleTool`; bad input → structured `AiErrorEnvelope`, server stays up
- [x] `[mcp]` State/config corruption degrades gracefully (stale data over crash) (2026-05-27) — `CorruptStoreError` + `RestoreResult.index` propagation; `commandQueue` atomic tmp+rename writes; Postgres pool error handler attached
- [ ] `[desktop]` SKIP: db-cluster is not a desktop application
- [ ] `[vscode]` SKIP: db-cluster is not a VS Code extension

## C. Operator Docs

- [x] `[all]` README is current: what it does, install, usage, supported platforms + runtime versions (2026-05-27) — post-Wave-C1-Amend; Phase 10 §1 finalizes for v1.0.0
- [x] `[all]` CHANGELOG.md (Keep a Changelog format) (2026-05-27) — per-wave User-visible / Breaking / Migration sections; audit-trail backlinks at section bottoms
- [x] `[all]` LICENSE file present and repo states support status (2026-05-27) — MIT; supported-versions table in SECURITY.md
- [x] `[cli]` `--help` output accurate for all commands and flags (2026-05-27) — Commander auto-generates; verified via `test/cli-docs.test.ts` (14 sync tests)
- [x] `[cli|mcp|desktop]` Logging levels defined: silent / normal / verbose / debug — secrets redacted at all levels (2026-05-27) — `--quiet` + `--log-level={debug,info,warn,error}` wired in Wave C1-Amend; `redactErrorMessage` scrubs at every level
- [x] `[mcp]` All tools documented with description + parameters (2026-05-27) — `docs/mcp.md` covers 16 tools; tool definitions carry typed input schemas + safety annotations (`readOnlyHint`, `destructiveHint`, `requiresApprovalHint`)
- [x] `[complex]` HANDBOOK.md: daily ops, warn/critical response, recovery procedures (2026-05-27) — `docs/handbook.md` (operator+developer guide) + `docs/runbooks/` (one runbook per typed-error class: corrupt-store, orphan-mutations, index-stale, postgres-unreachable)

## D. Shipping Hygiene

- [x] `[all]` `verify` script exists (test + build + smoke in one command) (2026-05-27) — `npm run verify` → `node scripts/release-gate.mjs` runs 9 stages: build, test, pack, smoke, drift, exports, completeness, doc-drift, JSDoc
- [x] `[all]` Version in manifest matches git tag (2026-05-27) — enforced at release time by `.github/workflows/release.yml::Verify tag matches package.json version` step; workflow fails if mismatched
- [x] `[all]` Dependency scanning runs in CI (2026-05-27) — `.github/dependabot.yml` configured for npm + github-actions ecosystems
- [x] `[all]` Automated dependency update mechanism exists (2026-05-27) — Dependabot weekly schedule with grouped updates (typescript-toolchain, stryker, vitest, mcp-sdk)
- [x] `[npm]` `npm pack --dry-run` includes: dist/, README.md, CHANGELOG.md, LICENSE (2026-05-27) — release-gate stage `[3/9] Package` verifies; `package.json` `files` array enforces
- [x] `[npm]` `engines.node` set (2026-05-27) — `">=20"` in package.json
- [x] `[npm]` Lockfile committed (2026-05-27) — `package-lock.json` present
- [ ] `[vsix]` SKIP: db-cluster does not ship as a .vsix
- [ ] `[desktop]` SKIP: db-cluster does not ship as a desktop installer

## E. Identity (soft gate — does not block ship)

- [x] `[all]` Logo in README header (2026-05-27) — brand repo `mcp-tool-shop-org/brand/logos/db-cluster/readme.png` (commit `12675c2`); rendered at the top of README.md
- [ ] `[all]` Translations (polyglot-mcp, 8 languages) — Phase 10 §3c (user runs translation script before release commit)
- [ ] `[org]` Landing page (@mcptoolshop/site-theme) — Phase 10 §4 (site/ scaffold) + §5 (handbook)
- [ ] `[all]` GitHub repo metadata: description, homepage, topics — Phase 10 §6 (`gh repo edit`)

---

## Gate Rules

**Hard gate (A–D):** Must pass before any version is tagged or published.
If a section doesn't apply, mark `SKIP:` with justification — don't leave it unchecked.

**Soft gate (E):** Should be done. Product ships without it, but isn't "whole."

**Checking off:**
```
- [x] `[all]` SECURITY.md exists (2026-02-27)
```

**Skipping:**
```
- [ ] `[pypi]` SKIP: not a Python project
```
