# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 1.x     | Yes       |
| 0.x     | No (pre-release; upgrade to 1.x) |

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

## Threat model — what db-cluster touches

db-cluster is an **AI-native federated database cluster** that ships as an npm package. It runs in two surfaces: a CLI (`db-cluster`, `db-cluster-mcp`) and a Node.js library (`import 'db-cluster'`). Below is what it touches, what it does NOT touch, and what permissions it asks for.

### Data touched

- **`.db-cluster/` directory** in the current working directory (or the path you pass to `init`). This holds the four physical stores: `canonical/`, `artifact/`, `index/`, `ledger/`, plus the `commands/` queue.
- **Artifacts you ingest** — files passed to `db-cluster ingest <path>` are read, hashed, and stored as content-addressable copies under `.db-cluster/artifact/`. The originals are not modified.
- **`DB_CLUSTER_PRINCIPAL` and `DB_CLUSTER_POLICIES_FILE` env vars** if set — JSON principal identity + policy file path, schema-validated with fail-closed on malformed input. The policy file path is sandboxed against cwd.
- **`DB_CLUSTER_POSTGRES_URL`** if set — Postgres connection string for the canonical store backend. SSL respected when `DB_CLUSTER_POSTGRES_SSL` is set.

### Data NOT touched

- **No network egress** by default. The MCP server tools (16 of them) read and write local stores only; none make outbound HTTP/HTTPS requests.
- **No telemetry.** Nothing is collected or sent to any external service.
- **No credentials handling.** db-cluster does not read, store, or transmit auth tokens, API keys, OAuth credentials, or passwords. The only secret it reads is the Postgres connection string from env (and only when explicitly configured).
- **No source-file modification.** Artifact ingest reads and copies; it never writes back to the file you pointed at.
- **No global state.** All state lives under `.db-cluster/` in the directory you ran `init` from. Removing that directory removes all db-cluster state.

### Permissions required

- **File system:** read on any path you pass for ingestion; read+write on `.db-cluster/`.
- **Network:** none, unless you configure a Postgres backend (then: TCP to your Postgres host).
- **Process:** runs as your user; no elevation requested.

### Surface-by-surface posture

- **CLI** — destructive commands (`restore`, `rebuild index`, `compensate`, `backup --force-overwrite`) gate behind a `--yes` flag plus an interactive confirmation when stdin is a TTY (see `src/cli.ts::destructiveCommand`). The MCP-equivalent tools have `destructiveHint: true` annotations.
- **MCP server** — tool errors return structured `AiErrorEnvelope` results (`code`, `message`, `retryable`, `remediation_hint`, `context`, `next_valid_actions`). No raw stack traces, no path leakage from typed-error `.cause.message` (scrubbed via `redactErrorMessage`).
- **SDK** — `PolicyEnforcedKernel` is the only exported kernel entry; `ClusterKernel` is intentionally not on the public surface. Policy enforcement applies to every read and every mutation.
- **Dashboard demo** — static HTML + CDN React, viewer-only, no network calls. State comes from `dashboard/demo-data.js` or a generated `dashboard-snapshot.json`. Redaction via `applyRedaction` from the shared lib.

### Output discipline

- Stack traces never reach STDOUT or MCP responses; the `--debug` flag enables them on STDERR only.
- The `--quiet` and `--log-level` flags gate non-error output for clean pipe-to-`jq` usage (`db-cluster doctor --json --quiet`).
- Logging redaction is applied at every level (silent / normal / verbose / debug) — secrets and path-like strings are scrubbed before write.

### Known residuals tracked for v1.x

- `V2-C1-009` — long-running MCP ops (doctor/verify/rebuild/backup/restore) currently surface as single-shot tools; granular progress streaming is documented but not in v1.0.0. See `docs/release-readiness.md`.
- `KERNEL-C-012` — OperatorSignal cross-domain channel is a v1.1+ architectural extension.

## Scope

This tool operates **locally** by default. Network egress only when explicitly configured via `DB_CLUSTER_POSTGRES_URL`. See **Threat model** above for the full surface.
