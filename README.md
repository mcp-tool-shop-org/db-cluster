<p align="center">
  <img src="https://raw.githubusercontent.com/mcp-tool-shop-org/brand/main/logos/db-cluster/readme.png" alt="db-cluster" width="800" />
</p>

**AI-native federated database cluster.**

An AI system should not query one flattened database. It should operate over a cluster of specialized truth stores, where each store preserves its native truth shape and the cluster exposes one coherent retrieval, provenance, and mutation surface.

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

## Status

**Phase 15 — Release Readiness & Package Boundary: PASS.** Post-Wave-B1-Amend
baseline: **778+ tests passing across 68 files** (the exact number tracks
through each amend wave — see `CHANGELOG.md` for the per-wave count).
Stryker mutation testing is shipped but experimental — not in the standing
release-gate per the v2 dogfood-swarm protocol's verifier-3 doctrine. See
`docs/release-readiness.md` "Stryker mutation testing — current disposition".

Phase 15 establishes a deliberate public API surface, package boundary, fresh
install smoke tests, and release gate automation. The package is ready for
versioned release as v0.1.0. The release-gate (`scripts/release-gate.mjs`) is
8 stages — build, tests, pack, smoke-install, docs-drift, package-exports,
completeness-checks, and (new in Wave B1-Amend) the doc-drift detector that
typechecks every `typescript` code block in `docs/` against the real
`src/types/*` surface.

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
- [Release readiness](docs/release-readiness.md) — release flow + known flake patterns

## License

MIT
