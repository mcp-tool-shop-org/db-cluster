# Quickstart

Get db-cluster running in under 5 minutes. This guide proves the core truth loop: ingest → index → retrieve → mutate → prove.

## Prerequisites

- Node.js 20+ (the `engines.node` field in `package.json` enforces this on
  install; older Node versions are unsupported because the release-gate
  script uses `readdirSync(..., { recursive: true })`, a Node-18.17+ API,
  and the CI matrix tests against 20 / 22 / 24)
- npm

Optional (for Postgres canonical backend):
- PostgreSQL 16+
- `DB_CLUSTER_POSTGRES_URL` environment variable

## Install

```bash
npm install @mcptoolshop/db-cluster
```

Or clone and build from source:

```bash
git clone https://github.com/mcp-tool-shop-org/db-cluster.git
cd db-cluster
npm install
npm run build
```

## Initialize a cluster

```bash
db-cluster init
```

This creates `.db-cluster/` with four stores:
- `canonical/` — entities, stable IDs, owner truth
- `artifact/` — raw files, immutable source documents
- `index/` — derivative discoverability (rebuildable)
- `ledger/` — provenance events and mutation receipts

## Ingest an artifact

```bash
db-cluster ingest ./evidence.md
```

The artifact store takes ownership. The index store gets a derivative record. The canonical store is not touched — artifacts are not entities.

## Create an entity

```bash
db-cluster entity create --kind claim --name "LLMs should not write directly to databases" --attr '{"confidence":"high","domain":"architecture"}'
```

The canonical store takes ownership. An index record is created. The ledger records a provenance event.

## Link artifact as evidence

```bash
db-cluster link --entity-id <entity-id> --artifact-id <artifact-id>
```

This creates a provenance link in the ledger: the artifact is evidence for the entity. Neither store's truth is mutated — only the ledger records the relationship.

## Retrieve an evidence bundle

```bash
db-cluster retrieve "LLMs database architecture"
```

The cluster retrieves across all stores:
- Index discovers candidate records
- Canonical store resolves entities to owner truth
- Artifact store resolves source documents
- Freshness and confidence are computed

This is **not** RAG. It is structured retrieval with provenance boundaries.

## Trace provenance

```bash
db-cluster trace cluster://canonical/<entity-id>
```

Shows the full provenance graph: who created this entity, what evidence supports it, what mutations changed it. Every node traces to a specific store.

## Propose a mutation

```bash
db-cluster propose '{"verb":"update_entity","targetStore":"canonical","payload":{"entityId":"<entity-id>","patch":{"name":"Updated claim"}},"proposedBy":"developer"}'
```

This **does not write** to any store. It creates a staged command in `proposed` status.

## Validate and commit

```bash
db-cluster validate <command-id>
db-cluster commit <command-id>
```

Only `commit` writes to the canonical store. A receipt is emitted to the ledger. The mutation is now traceable.

## Check receipts

```bash
db-cluster receipts
```

Every committed mutation has a receipt: command ID, affected IDs, provenance event link, timestamp.

## Run doctor

```bash
db-cluster doctor
```

Reports cluster health: store reachability, index freshness, policy state.

## What you just proved

1. **Four stores, four owners** — artifact, canonical, index, ledger each own their truth
2. **Index is derivative** — it discovers, but the cluster resolves to owner truth
3. **Mutations cross a command boundary** — propose → validate → commit, never direct writes
4. **Provenance is native** — every action is traceable to actor, store, and timestamp
5. **Health is explicit** — doctor reports state, not absence of errors

## Next steps

- [Architecture](architecture.md) — why four stores, not one
- [Mutation Law](mutation-law.md) — the command lifecycle in detail
- [SDK](sdk.md) — programmatic access
- [MCP](mcp.md) — AI agent integration
- [Operations](operations.md) — doctor, verify, rebuild, backup
