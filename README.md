<p align="center">
  <a href="README.ja.md">日本語</a> | <a href="README.zh.md">中文</a> | <a href="README.es.md">Español</a> | <a href="README.fr.md">Français</a> | <a href="README.hi.md">हिन्दी</a> | <a href="README.it.md">Italiano</a> | <a href="README.pt-BR.md">Português (BR)</a>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/mcp-tool-shop-org/brand/main/logos/db-cluster/readme.png" alt="db-cluster" width="800" />
</p>

<p align="center">
  <a href="https://github.com/mcp-tool-shop-org/db-cluster/actions/workflows/ci.yml"><img src="https://github.com/mcp-tool-shop-org/db-cluster/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://www.npmjs.com/package/@mcptoolshop/db-cluster"><img src="https://img.shields.io/npm/v/@mcptoolshop%2Fdb-cluster.svg" alt="npm version" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-yellow.svg" alt="License: MIT" /></a>
  <a href="https://mcp-tool-shop-org.github.io/db-cluster/handbook/"><img src="https://img.shields.io/badge/handbook-online-blue.svg" alt="Handbook" /></a>
  <a href="https://github.com/mcp-tool-shop-org/db-cluster/pkgs/container/db-cluster"><img src="https://img.shields.io/badge/ghcr.io-db--cluster-2496ED?logo=docker" alt="Docker image on GHCR" /></a>
</p>

**AI-native federated database cluster.** Specialized truth stores behaving as one governed substrate — typed errors, structured exit codes, mutation receipts, MCP + SDK + CLI surfaces.

"Federated" means specialized truth stores that may run on different backends; the Postgres backend currently applies to the **canonical store only** — the artifact, index, and ledger stores run on the local/SQLite backends.

## Who is this for

- **AI agents** that need trustworthy retrieval, structured error envelopes, and a mutation lifecycle that won't let them silently corrupt state.
- **Operators** running graph + provenance stores who want typed exit codes, doctor/verify diagnostics, runbooks, and safe backup/restore.
- **Developers** building cluster-backed applications who want a deliberate public API, fresh-install smoke tests, and per-method JSDoc + examples.
- **Dashboard viewers** auditing cluster truth — store ownership, provenance lineage, command preview, redaction view.

## Why use db-cluster

- **Typed errors with `remediationHint`** — every `ClusterError` subclass answers WHAT TO DO, not just WHAT failed (CLI exit codes 65/70/77/78 mapped to typed-error codes).
- **AI error envelopes** — `{code, message, retryable, remediation_hint, context, next_valid_actions}` schema; AI agents can branch on `code` and `retryable` instead of parsing prose.
- **Receipts on every mutation** — content-addressable; provenance graph; rebuild-from-truth contract on the index store.
- **MCP server with safety annotations** — read-only / staged / approval / write tools each carry machine-readable `readOnlyHint` / `destructiveHint` flags. The server defaults to the `ai-facing` trust zone (redaction ON, no raw content), and MCP write tools refuse to commit until the command is `approved`.
- **Policy-enforced by default** — the package root factory `createSafeCluster()` hands back a policed handle (a `PolicyEnforcedKernel` + read-only ops, no raw store mutators). Raw, unpoliced stores are reachable only via the explicit `@mcptoolshop/db-cluster/unsafe` escape hatch.

## Quickstart (3 steps)

```bash
npx @mcptoolshop/db-cluster init                # 1. initialize .db-cluster/
npx @mcptoolshop/db-cluster ingest ./file.md    # 2. ingest an artifact
npx @mcptoolshop/db-cluster retrieve "query"    # 3. retrieve an evidence bundle
```

Or install globally + use the `db-cluster` and `db-cluster-mcp` bins directly:

```bash
npm install -g @mcptoolshop/db-cluster
db-cluster init
```

Or run via Docker (no Node install required):

```bash
docker run --rm -v "$PWD:/workspace" ghcr.io/mcp-tool-shop-org/db-cluster:latest init
```

Full golden path: [`docs/quickstart.md`](docs/quickstart.md) (5 minutes).

## What this is

A federated database cluster where:

- **Canonical store** — entities, IDs, stable state records
- **Artifact store** — raw files, documents, source text, generated outputs
- **Index store** — discoverability, full-text (ranked) lookup, metadata search
- **Event/provenance ledger** — actions, links, mutations, receipts, lineage

The kernel routes. The index discovers. The cluster owns truth.

## What this is not

- An AI database assistant
- An index over many stores
- Governance middleware
- A vector database with plugins
- An agent memory layer

## Architecture laws

1. Every fact has an owner store
2. Indexes are derivative — can be deleted and rebuilt from owned stores
3. AI never mutates raw state directly
4. Every answer traces to source truth
5. Every mutation crosses a typed command boundary
6. Artifact truth is immutable by default — corrections create versions, not overwrites
7. Kernel routes; cluster owns

## CLI

```bash
db-cluster init
db-cluster ingest ./source.md
db-cluster entity create ...
db-cluster find "..."
db-cluster inspect <id>
db-cluster trace <uri> [--direction] [--depth] [--graph]
db-cluster why <uri>
db-cluster lineage <uri>
db-cluster retrieve "..."
db-cluster trace-bundle "..."
db-cluster propose ...
db-cluster commit ...
db-cluster receipts
```

See [`docs/cli.md`](docs/cli.md) for the full CLI reference (including the typed-error exit-code table).

## Prerequisites

- Node.js 20+ (enforced via `engines.node` in `package.json`)
- npm

## Trust model

db-cluster runs **locally**. It reads + writes a `.db-cluster/` directory in the
working directory you point it at and reads artifacts you pass to `ingest`.
There is **no network egress** by default and **no telemetry**. The only
optional outbound connection is to a Postgres host if you set
`DB_CLUSTER_POSTGRES_URL`. **db-cluster does not configure SSL/TLS for that
connection in v1.0.0** — the transport is plaintext unless your connection
string enforces it (e.g. `sslmode=require`, which the `pg` driver honours), a
TLS-terminating proxy, or a private network. Driver-managed TLS config is
planned for a future release.

The MCP server tools read + write the local stores only — they never reach the
network, and structured `AiErrorEnvelope` responses never leak stack traces or
filesystem paths. **The MCP server defaults to the `ai-facing` trust zone with
redaction ON:** artifact content and sensitive entity attributes are stripped at
the boundary by default, and no MCP tool returns raw artifact bytes. An operator
who needs the privileged (`internal` / `cluster-admin`) posture must explicitly
opt in via an environment flag (provisionally `DB_CLUSTER_MCP_ALLOW_PRIVILEGED`;
see [`docs/mcp.md`](docs/mcp.md)). **MCP write tools enforce approval:**
`cluster_commit_mutation` and `cluster_compensate_mutation` refuse to write
unless the command is in `approved` status — the caller must first call
`cluster_approve_mutation`, and the refusal is a structured `AiErrorEnvelope`,
not a partial write. (Trusted in-process SDK callers are unaffected — this gate
is MCP-surface only.) Destructive CLI commands (`restore`, `rebuild index`,
`compensate`, `backup --force-overwrite`) require an explicit `--yes` flag plus
an interactive confirmation on TTY.

The full threat model — data touched, data NOT touched, permissions required,
surface-by-surface posture, and tracked residuals — lives in
[`SECURITY.md`](SECURITY.md).

## Documentation

See [`docs/README.md`](docs/README.md) for the full doc map (Start here /
Reference / Development phase history). Highlights:

- [Quickstart](docs/quickstart.md) — 5-minute golden path
- [Handbook](docs/handbook.md) — canonical operator + developer guide
- [Architecture](docs/architecture.md) — federated truth model + the seven architecture laws
- [Store contracts](docs/store-contracts.md) — what each of the four stores owns and guarantees
- [Mutation law](docs/mutation-law.md) / [Provenance graphs](docs/provenance-graphs.md) — safe-write lifecycle and lineage tracing
- [SDK](docs/sdk.md) / [CLI](docs/cli.md) / [MCP](docs/mcp.md) — surface references
- [Policy and Redaction](docs/policy-and-redaction.md) — Principal, Capability, Policy, TrustZone
- [Operations](docs/operations.md) — doctor, verify, rebuild, backup, restore
- [Operator runbooks](docs/runbooks/README.md) — one runbook per typed-error class
- [Release readiness](docs/release-readiness.md) — release flow + known flake patterns

## License

MIT
