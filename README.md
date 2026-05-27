<p align="center">
  <img src="https://raw.githubusercontent.com/mcp-tool-shop-org/brand/main/logos/db-cluster/readme.png" alt="db-cluster" width="800" />
</p>

**AI-native federated database cluster.** Specialized truth stores behaving as one governed substrate — typed errors, structured exit codes, mutation receipts, MCP + SDK + CLI surfaces.

## Who is this for

- **AI agents** that need trustworthy retrieval, structured error envelopes, and a mutation lifecycle that won't let them silently corrupt state.
- **Operators** running graph + provenance stores who want typed exit codes, doctor/verify diagnostics, runbooks, and safe backup/restore.
- **Developers** building cluster-backed applications who want a deliberate public API, fresh-install smoke tests, and per-method JSDoc + examples.
- **Dashboard viewers** auditing cluster truth — store ownership, provenance lineage, command preview, redaction view.

## Why use db-cluster

- **Typed errors with `remediationHint`** — every `ClusterError` subclass answers WHAT TO DO, not just WHAT failed (CLI exit codes 65/70/77/78 mapped to typed-error codes).
- **AI error envelopes** — `{code, message, retryable, remediation_hint, context, next_valid_actions}` schema; AI agents can branch on `code` and `retryable` instead of parsing prose.
- **Receipts on every mutation** — content-addressable; provenance graph; rebuild-from-truth contract on the index store.
- **MCP server with safety annotations** — read-only / staged / approval / write tools each carry machine-readable `readOnlyHint` / `destructiveHint` flags.
- **SDK with policy enforcement** — `PolicyEnforcedKernel` is the only path; `ClusterKernel` is intentionally not exported.

## Quickstart (3 steps)

```bash
npx db-cluster init                # 1. initialize .db-cluster/
npx db-cluster ingest ./file.md    # 2. ingest an artifact
npx db-cluster retrieve "query"    # 3. retrieve an evidence bundle
```

Full golden path: [`docs/quickstart.md`](docs/quickstart.md) (5 minutes).

## What this is

A federated database cluster where:

- **Canonical store** — entities, IDs, stable state records
- **Artifact store** — raw files, documents, source text, generated outputs
- **Index store** — discoverability, full-text/vector lookup, metadata search
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

## Status

**Phase 15 — Release Readiness & Package Boundary: PASS.** Post-Wave-C1-Amend
baseline: **1200+ tests passing across 80+ files** (the exact number tracks
through each amend wave — see `CHANGELOG.md` for the per-wave count). Stryker
mutation testing is shipped but experimental — not in the standing release-gate
per the v2 dogfood-swarm protocol's verifier-3 doctrine. See
`docs/release-readiness.md` "Stryker mutation testing — current disposition".

Phase 15 establishes a deliberate public API surface, package boundary, fresh
install smoke tests, and release gate automation. The package is ready for
versioned release as v0.1.0. The release-gate (`scripts/release-gate.mjs`) is
9 stages — build, tests, pack, smoke-install, docs-drift, package-exports,
completeness-checks, doc-drift, and (new in Wave C1-Amend) JSDoc-completeness
that verifies every required public symbol carries `@throws` + `@example`.

Previous: Phase 14 — Repo-Knowledge Integration Gate.

## Prerequisites

- Node.js 20+ (enforced via `engines.node` in `package.json`)
- npm

## Documentation

See [`docs/README.md`](docs/README.md) for the full doc map (Start here /
Reference / Development phase history). Highlights:

- [Quickstart](docs/quickstart.md) — 5-minute golden path
- [Handbook](docs/handbook.md) — canonical operator + developer guide
- [SDK](docs/sdk.md) / [CLI](docs/cli.md) / [MCP](docs/mcp.md) — surface references
- [Policy and Redaction](docs/policy-and-redaction.md) — Principal, Capability, Policy, TrustZone
- [Operations](docs/operations.md) — doctor, verify, rebuild, backup, restore
- [Operator runbooks](docs/runbooks/README.md) — one runbook per typed-error class
- [Release readiness](docs/release-readiness.md) — release flow + known flake patterns

## License

MIT
