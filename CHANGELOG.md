# Changelog

All notable user-facing changes to db-cluster. This project follows [semantic versioning](https://semver.org).

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
