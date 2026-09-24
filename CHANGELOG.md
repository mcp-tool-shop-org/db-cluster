# Changelog

All notable user-facing changes to db-cluster. This project follows [semantic versioning](https://semver.org).

## Unreleased

### Breaking changes

- **Node.js 22.12 or later is required.** `engines.node` is now `>=22.12` (was `>=20`). Node 20 reached end-of-life on 2026-04-30, and the dependencies had already moved past it: the CLI's `commander` 15 requires Node 22.12, and the optional SQLite driver `better-sqlite3` 13 requires Node 22. CI tests Node 22 and 24 on Linux and Windows.

### Fixes

- **Kernel mutations require an actor.** `createEntity`, `ingestArtifact`, `linkEvidence`, `proposeMutation`, `approveMutation`, `rejectMutation`, `commitMutation`, `compensateMutation` and `rebuildIndex` now reject a missing or blank actor with the typed `INVALID_ACTOR` error (CLI exit 65) before touching any store. Previously the local backend recorded provenance with no actor, and the SQLite backend failed only after the write, leaving an orphaned mutation. The CLI always supplies an actor; SDK and MCP callers that omitted one, or sent an empty string, now get the error.

- **The CLI and MCP server honor `DB_CLUSTER_CANONICAL_BACKEND`.** Both surfaces used to build local stores unconditionally, so a documented Postgres configuration was silently served from local JSON. Every CLI data command and the MCP server now open the canonical store on the configured backend: `local` (the default), `postgres` with `DB_CLUSTER_POSTGRES_URL`, or `sqlite`, which is new on these surfaces. An unknown value, or `postgres` without a URL, fails closed with `INVALID_BACKEND_CONFIG` (CLI exit 78) instead of falling back to local stores. `createCluster` applies the same check to every store's backend name. With `postgres` selected, MCP tool calls now connect to that Postgres host; the README and SECURITY.md trust model say so.

### Notes

- **`npm ci` can drop the SQLite driver.** `better-sqlite3` 13 ships prebuilt binaries inside its npm package, but `npm ci` still attempts a `node-gyp` build of it. Where that build cannot run (no C++ toolchain, or a Visual Studio release the bundled node-gyp does not recognize), npm removes the optional package, binary and all. A plain `npm install` is unaffected. If selecting the SQLite backend fails with `SQLITE_DRIVER_UNAVAILABLE` after an `npm ci`, either give the machine a C++ toolchain or install with `npm ci --ignore-scripts` when nothing else in the project needs its install scripts. db-cluster's own CI does the latter.

## 2.0.1

Documentation-only release — no code, API, or behavior changes from 2.0.0.

- **Refreshed the README front door.** The landing copy now leads with the problem db-cluster exists to solve — traditional databases assume a careful, deterministic caller, and AI agents are neither — and maps it to what db-cluster does differently. Translations refreshed across all 7 languages.

## 2.0.0

The first major release since 1.0.0. db-cluster gains ranked retrieval, entity and artifact version history, an opt-in embedded SQLite backend, and a round of contract-honesty and security hardening. Several public contracts changed — see **Breaking changes** and **Migration**.

### New

- **Ranked full-text retrieval.** Retrieval ranks results by BM25 relevance instead of returning candidates in arbitrary order. Evidence bundles carry a per-result relevance `score` and a short content `snippet`, and `find` / `retrieve` support `offset` pagination. Ranking is lexical full-text — db-cluster does not do vector/embedding similarity search, by design.
- **Entity and artifact version history.** Canonical entities and artifacts retain their full version history. The SDK, MCP, and CLI expose policy-enforced reads of prior versions (`listVersions` / `getVersion`), subject-scoped lineage and single-receipt lookups, opaque-cursor pagination, and a `list-commands` view of the mutation queue.
- **Opt-in SQLite backend.** A new embedded SQLite backend implements all four stores (canonical, artifact, index, ledger) in a single WAL-mode database file — real concurrency without running a Postgres server. Purely additive: local stays the default, and the native driver (`better-sqlite3`, an optional dependency) is loaded only if you select SQLite. A ledger written on one backend verifies on the other.
- **MCP and CLI ergonomics.** MCP tools carry spec-standard `readOnlyHint` / `destructiveHint` annotations. A new `db-cluster stats` command prints entity / command / receipt counts. Under `--json`, CLI errors also emit a structured `{ error: { code, message, hint } }` object on stdout.

### Breaking changes

- **The package root exports only `createSafeCluster()`.** The raw store factories (`createCluster`, `createClusterFromEnv`, `createLocalCluster`) are no longer exported from the package root — they are reachable only via the explicit `@mcptoolshop/db-cluster/unsafe` subpath. The root hands back a policy-enforced handle (a `PolicyEnforcedKernel` plus the read-only ops) with no raw store mutators.
- **The MCP server defaults to redaction on.** Started with no policy configured, the server now applies the `ai-facing` trust zone — artifact content and sensitive attributes are stripped at the boundary, and write tools (`cluster_commit_mutation`, `cluster_compensate_mutation`) refuse to write until the command is `approved`. The privileged posture requires the explicit `DB_CLUSTER_MCP_ALLOW_PRIVILEGED` opt-in. In-process SDK callers are unaffected.
- **MCP approval-gate refusals are error results.** A refused write returns `isError: true` (with the `POLICY_DENIED` envelope JSON-stringified in `content[0].text`) instead of a success-shaped object. Detect failures via the top-level `isError` flag, not via `_meta`.
- **MCP tool annotations changed shape.** Spec hint keys (`readOnlyHint`, `destructiveHint`, `idempotentHint`) are under `annotations`; the internal classification moved under `_meta['io.dbcluster/classification']`.
- **`doctor` / `verify` exit non-zero on an unhealthy cluster** — `70` for `corrupt`/`unreachable`, `1` for any other non-healthy state, `0` for healthy. Scripts that assumed these commands always exit `0` must treat a non-zero exit as a health signal.
- **Paginated reads return an opaque `{ items, nextCursor }` shape.**

### Security

- **Policy-enforced by default** on both the package root and the MCP surface (see Breaking changes).
- **Integrity on read.** Artifact `getContent` re-hashes the stored bytes and rejects tampered content; the ledger carries a tamper-**evident** `integrityHash` + `prevHash` chain that detects corruption, reordering, and edits. The chain is unkeyed — tamper-evident, not tamper-proof against an adversary who holds the package; a keyed / externally-anchored upgrade is tracked.
- **Redaction at every read path**, including the content snippets returned by retrieval.
- **Postgres SSL claim corrected.** db-cluster does not configure TLS for the Postgres connection — enforce it via your connection string (`sslmode=require`), a TLS-terminating proxy, or a private network.
- A full I1–I7 trust-invariant matrix, re-audited across the composed 2.0.0 surface, is in [`SECURITY.md`](SECURITY.md).

### Migration

- **`import { createLocalCluster } from '@mcptoolshop/db-cluster'` no longer resolves.** Use `createSafeCluster(...)` from the root, or import the raw factories from `@mcptoolshop/db-cluster/unsafe`. The `/sdk`, `/mcp`, `/policy`, and `/types` subpaths are unchanged.
- **MCP integrators:** detect a failed tool call via top-level `isError === true`, then `JSON.parse(result.content[0].text)` and branch on `body.code`; drive writes through `cluster_approve_mutation` before `cluster_commit_mutation`.
- **Operators / CI:** branch on the exit code of `doctor` / `verify` (`0` healthy, `70` corrupt/unreachable, `1` other non-healthy).
- **Postgres operators:** apply migration `002_add_entity_version` before relying on entity versioning — existing rows backfill to version 1, no data loss.
- **SQLite adopters:** `npm install better-sqlite3` and set the relevant `backends.*` entries to `'sqlite'`; a fresh database is created and migrated on first open.

## 1.0.0

First published release.

- **On npm and Docker** — `npm install @mcptoolshop/db-cluster`; multi-arch image at `ghcr.io/mcp-tool-shop-org/db-cluster`.
- **The federated truth model** — canonical / artifact / index / ledger stores with a routing kernel; typed errors with remediation hints and structured CLI exit codes; AI error envelopes at every MCP and SDK boundary; content-addressable mutation receipts and a provenance graph; policy and redaction; operator tooling (`doctor` / `verify` / `backup` / `restore`).
- **Docs and brand** — a landing page, an 8-page Starlight handbook with search, README translations in seven languages, and a brand logo.

---

The detailed per-version development history (build phases and internal review passes) lives in the git commit history and the `swarm-*` reports in the repository, rather than on this public changelog.
