# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 2.x     | Yes       |
| 1.x     | No (upgrade to 2.x) |
| 0.x     | No (pre-release; upgrade to 2.x) |

## Reporting a Vulnerability

Email: **64996768+mcp-tool-shop@users.noreply.github.com**

Include:
- Description of the vulnerability
- Steps to reproduce
- Version affected
- Potential impact (data exposure, mutation bypass, policy escape, etc.)

### Response timeline

| Action | Target |
|--------|--------|
| Acknowledge report | 48 hours |
| Assess severity | 7 days |
| Release fix | 30 days |

Critical issues (active exploit, data loss, policy bypass) follow an accelerated track; reach out and we'll coordinate.

## Trust invariants — re-audited for 2.0.0

db-cluster's security rests on seven invariants. Each was adversarially re-audited across the **composed** 2.0.0 surface — ranked retrieval, entity/artifact version history, the opt-in SQLite backend, and the MCP / SDK / CLI surfaces — after the feature work landed, to confirm no feature regressed a guarantee. Current verdicts:

| Invariant | Verdict |
|-----------|---------|
| **I1 — No network egress by default** | **Upheld.** No network primitives in the codebase; the SQLite backend opens a single local file (no remote URIs, no extension loading); the only outbound connection is an opt-in Postgres backend (`DB_CLUSTER_POSTGRES_URL`). |
| **I2 — No stack-trace or filesystem-path leakage to a consumer** | **Upheld.** Every error surfaced to an AI / MCP / CLI consumer is path-scrubbed (including the `--json` error object); stack traces reach STDERR only under `--debug`. |
| **I3 — Redaction at every read path** | **Upheld.** Entity attributes, artifact content **including the content snippets returned by retrieval**, command payloads, receipts, provenance, index metadata, and entity/artifact version history are redacted per the caller's policy at every surface (SDK, MCP, CLI). |
| **I4 — `PolicyEnforcedKernel` is the only path to cluster truth** | **Upheld.** The package root exposes only the policed `createSafeCluster()`; raw stores are reachable solely via the explicit `@mcptoolshop/db-cluster/unsafe` escape hatch — on every backend, including SQLite. |
| **I5 — Mutation law + provenance/receipt integrity** | **Upheld, with a disclosed ceiling.** The mutation lifecycle is enforced and the ledger is tamper-**evident** — but it is not tamper-**proof** against a package-holding adversary (see "Tamper-evidence scope" below). |
| **I6 — Destructive and sensitive operations are gated** | **Upheld.** MCP write tools enforce approval (refusals are structured error results, not partial writes); destructive CLI commands require `--yes` + an interactive TTY; the privileged MCP posture is operator-launch-only. |
| **I7 — Untrusted input stays data** | **Upheld.** All SQL (Postgres and SQLite) is parameterized; cluster URIs are parsed opaquely; policy files are structurally validated and prototype-pollution-guarded; the principal / trust-zone cannot be set from untrusted tool input. |

## Threat model — what db-cluster touches

db-cluster is an **AI-native federated database cluster** that ships as an npm package. It runs in two surfaces: a CLI (`db-cluster`, `db-cluster-mcp`) and a Node.js library (`import 'db-cluster'`). Below is what it touches, what it does NOT touch, and what permissions it asks for.

### Data touched

- **`.db-cluster/` directory** in the current working directory (or the path you pass to `init`). This holds the four physical stores: `canonical/`, `artifact/`, `index/`, `ledger/`, plus the `commands/` queue. A `clusterDir` value read from a project `config.json` is **contained to the working directory** — it cannot point the cluster at an arbitrary location outside cwd (EGRESS-002). The `DB_CLUSTER_DIR` environment variable remains the supported **explicit operator override** for targeting a cluster outside cwd: a value the operator sets deliberately, not one an untrusted config file can smuggle in.
- **Artifacts you ingest** — files passed to `db-cluster ingest <path>` are read, hashed, and stored as content-addressable copies under `.db-cluster/artifact/`. The originals are not modified.
- **`DB_CLUSTER_PRINCIPAL` and `DB_CLUSTER_POLICIES_FILE` env vars** if set — JSON principal identity + policy file path, schema-validated with fail-closed on malformed input. The policy file path is sandboxed against cwd.
- **`DB_CLUSTER_POSTGRES_URL`** if set — Postgres connection string for the canonical store backend. **SSL/TLS is NOT configured by db-cluster:** the connection is plaintext unless your connection string itself enforces TLS (e.g. an `sslmode=require` query parameter that the `pg` driver honours). db-cluster does not set `ssl` on the pool and does not read a `DB_CLUSTER_POSTGRES_SSL` variable. Encrypted transport is your responsibility (connection-string `sslmode`, a TLS-terminating proxy, or a private network). Driver-managed `ssl` config is a tracked upgrade for a later release.
- **SQLite backend (opt-in)** — when you select the SQLite backend, db-cluster stores cluster state in a local SQLite database under `.db-cluster/` (WAL mode), via the optional `better-sqlite3` native module. That module is installed **only if you opt into SQLite**; the default local-file backend needs no native module. SQLite is a local file — no network access, no extension loading, no remote URIs.

### Data NOT touched

- **No network egress** by default. The MCP server tools (19 of them) read and write local stores only; none make outbound HTTP/HTTPS requests.
- **No telemetry.** Nothing is collected or sent to any external service.
- **No credentials handling.** db-cluster does not read, store, or transmit auth tokens, API keys, OAuth credentials, or passwords. The only secret it reads is the Postgres connection string from env (and only when explicitly configured).
- **No source-file modification.** Artifact ingest reads and copies; it never writes back to the file you pointed at.
- **No global state.** All state lives under `.db-cluster/` in the directory you ran `init` from. Removing that directory removes all db-cluster state.

### Permissions required

- **File system:** read on any path you pass for ingestion; read+write on `.db-cluster/` (including the SQLite database file when that backend is selected). The cluster directory is the working-directory `.db-cluster/` by default; a `config.json` `clusterDir` is contained to cwd, and `DB_CLUSTER_DIR` is the explicit operator override for a location outside cwd (see "Data touched" above).
- **Network:** none, unless you configure a Postgres backend (then: TCP to your Postgres host — plaintext unless your connection string enforces TLS; see the `DB_CLUSTER_POSTGRES_URL` note above).
- **Process:** runs as your user; no elevation requested.

### Tamper-evidence scope (what the ledger and content-addressing do and do NOT guarantee)

db-cluster's ledger (receipts + provenance events) is **tamper-evident, not tamper-proof.** Each record carries an `integrityHash` — an **unkeyed** SHA-256 over its canonical content — chained to the prior record via `prevHash`. That detects **accidental corruption** (bit-rot, partial/truncated writes), **reordering**, **inserted or deleted records**, and **casual single-record edits**: in each case the recomputed hash or the chain link no longer matches and `verify()` reports the ledger corrupt. This holds identically on the local and SQLite backends — both stamp the same `integrityHash` over the same canonical record, so a ledger written by one backend verifies under the other.

It is **not a cryptographic anti-forgery guarantee against a party who holds this package.** The hash function and the public `computeIntegrityHash` use no secret, so an actor with the package can edit or delete a record, recompute its `integrityHash`, and re-stamp every forward record's `prevHash` + `integrityHash` so the entire chain re-verifies clean. A **keyed HMAC** (over an operator-held secret) or **external chain-head anchoring/signing** of the tail hash would close this; neither ships yet. Both are the **tracked** upgrade path for a later release. Treat the ledger as proof against accidental damage and unsophisticated editing — not as evidence that would withstand a determined, package-holding adversary.

Two inherent limits of content-addressing apply alongside the above:

- **Metadata reads are not byte-integrity-checked.** Only `getContent()` (and `verify()`, which re-hashes sampled blobs) prove an artifact's stored bytes still hash to their recorded `contentHash`. The metadata-only paths — `get()` / `list()` — return the recorded metadata without re-reading and re-hashing the content, so a blob tampered on disk is surfaced by `getContent`/`verify`, not by a bare `get`/`list`.
- **Re-content is undetectable at the content layer by design.** If an actor rewrites a blob **and** its recorded `contentHash` together (a consistent re-content), the content layer cannot detect it — by construction, content-addressing only proves bytes match the hash that is *recorded for them*, not that the hash itself was never changed. The intended backstop is the **ingest provenance event** in the ledger (it records what was originally ingested); that backstop is itself bounded by the unkeyed-chain limitation above.

### Surface-by-surface posture

- **CLI** — destructive commands (`restore`, `rebuild index`, `compensate`, `backup --force-overwrite`) gate behind a `--yes` flag plus an interactive confirmation when stdin is a TTY (see `src/cli.ts::destructiveCommand`). The MCP-equivalent tools carry spec-standard `destructiveHint: true` annotations. `doctor` / `verify` exit non-zero when the cluster is not healthy (corrupt/unreachable → 70, otherwise → 1), so `verify && deploy` and cron health checks fail closed on an unsound cluster.
- **MCP server** — **defaults to the `ai-facing` trust zone with redaction ON.** Started with no policy env vars, the server applies the default ai-facing policies + redaction rather than a fully-trusted in-process kernel, so artifact content and sensitive entity attributes — including retrieval **snippets** — are stripped at the boundary by default and no tool returns raw artifact bytes (KERNEL-002). The privileged (`internal` / `cluster-admin`) posture is reachable only when an operator **explicitly opts in** via the `DB_CLUSTER_MCP_ALLOW_PRIVILEGED` environment flag; absent that flag the server stays ai-facing, and the flag cannot be set from any tool argument, request, or config file. **MCP write tools enforce approval:** `cluster_commit_mutation` and `cluster_compensate_mutation` refuse to write unless the command is in `approved` status — the caller must first call `cluster_approve_mutation`, and the refusal is a structured `AiErrorEnvelope` returned as an **error result** (`isError: true`), never a partial write or a success-shaped body (INJECT-001 / AI-006). This approval gate is **MCP-surface only**; trusted in-process SDK callers (which already passed an explicit policy/principal) are unaffected. Tool errors return structured `AiErrorEnvelope` results (`code`, `message`, `retryable`, `remediation_hint`, `context`, `next_valid_actions`): no raw stack traces, no path leakage from typed-error `.cause.message` (scrubbed via `redactErrorMessage`).
- **SDK / package root** — **policy-enforced by default.** The package root factory `createSafeCluster()` returns a policed handle whose only door to cluster truth is a `PolicyEnforcedKernel` (policy + redaction + receipts + provenance + mutation law); it exposes no raw store mutators. The raw `ClusterKernel` class is not exported, and the raw store factories (`createCluster` / `createLocalCluster`) are reachable only via the explicit, documented `@mcptoolshop/db-cluster/unsafe` escape hatch — which deliberately bypasses policy/receipts/provenance for operator-tooling and test use. Policy enforcement applies to every read and every mutation on the default (root) path, on every backend.
- **Backend trust note.** The MCP server's ai-facing redaction default fronts the cluster it is launched against. Selecting a Postgres or SQLite backend is an **operator action** performed through `createSafeCluster` / the documented configuration — a deliberately-trusted in-process path, not an untrusted surface. Configuring a backend does not bypass redaction; it is the operator choosing where their own trusted cluster's truth is stored.
- **Dashboard demo** — static HTML + CDN React, viewer-only, no network calls. State comes from `dashboard/demo-data.js` or a generated `dashboard-snapshot.json`. Redaction via `applyRedaction` from the shared lib.

### Output discipline

- Stack traces never reach STDOUT or MCP responses; the `--debug` flag enables them on STDERR only.
- The `--quiet` and `--log-level` flags gate non-error output for clean pipe-to-`jq` usage (`db-cluster doctor --json --quiet`).
- Logging redaction is applied at every level (silent / normal / verbose / debug) — secrets and path-like strings are scrubbed before write.

### Known residuals tracked for 2.x

- **Externally-anchored / keyed ledger integrity** — the unkeyed-chain ceiling described under "Tamper-evidence scope" above. A keyed HMAC over an operator-held secret, or external chain-head anchoring/signing of the tail hash, is the tracked upgrade toward tamper-*proof*.
- **Postgres backend parity** — Postgres currently backs the **canonical store only**; artifact/index/ledger on Postgres are a tracked extension. The local and SQLite backends support all four stores. (Honestly disclosed in `docs/store-contracts.md` and `docs/architecture.md`.)
- **Granular progress streaming** for long-running MCP ops (doctor/verify/rebuild/backup/restore), which currently surface as single-shot tools.
- **OperatorSignal cross-domain channel** — a deferred architectural extension for operator-visible safety events.

## Scope

This tool operates **locally** by default. Network egress only when explicitly configured via `DB_CLUSTER_POSTGRES_URL`. See **Threat model** above for the full surface.
