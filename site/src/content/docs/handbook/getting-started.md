---
title: Getting Started
description: Install db-cluster and run the 5-minute golden path — init, ingest, retrieve, mutate, trace.
sidebar:
  order: 1
---

This guide gets db-cluster running in under 5 minutes. It walks the **core truth loop**: ingest → index → retrieve → mutate → prove.

## Prerequisites

- **Node.js 20+** (enforced via `engines.node` in `package.json`).
- **npm** (or `pnpm` / `yarn`).

Optional for the Postgres canonical backend:

- **PostgreSQL 16+**.
- `DB_CLUSTER_POSTGRES_URL` environment variable (e.g. `postgres://user:pass@host:5432/db`).
- For TLS, put `sslmode=require` in the connection string itself — the `pg` driver honours it. db-cluster does **not** configure SSL/TLS in v1.0.0 and there is no `DB_CLUSTER_POSTGRES_SSL` variable; the connection is plaintext unless the URL (or a TLS proxy / private network) enforces it.

## Install

```bash
npm install @mcptoolshop/db-cluster
```

Or run via Docker (no Node install required):

```bash
docker run --rm -v "$PWD:/workspace" ghcr.io/mcp-tool-shop-org/db-cluster:latest init
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
npx db-cluster init
```

This creates `.db-cluster/` with four physical stores:

```
.db-cluster/
├── canonical/   # entities, stable IDs, owner truth
├── artifact/    # raw files, immutable source documents
├── index/       # derivative discoverability (rebuildable)
├── ledger/      # provenance events and mutation receipts
└── commands/    # staged commands awaiting validation
```

## Ingest an artifact

```bash
npx db-cluster ingest ./evidence.md
```

The artifact store takes ownership of the bytes (content-addressable, hashed). The index store gets a derivative record. The canonical store is **not** touched — artifacts are not entities.

## Create an entity

```bash
npx db-cluster entity create \
  --kind claim \
  --name "LLMs should not write directly to databases" \
  --attr '{"confidence":"high","domain":"architecture"}'
```

The canonical store takes ownership. An index record is created. The ledger records a provenance event.

## Link the artifact as evidence

```bash
npx db-cluster link --entity-id <entity-id> --artifact-id <artifact-id>
```

A provenance link goes into the ledger: the artifact is **evidence for** the entity. Neither store's truth is mutated — only the ledger records the relationship.

## Retrieve an evidence bundle

```bash
npx db-cluster retrieve "LLMs database architecture"
```

The cluster retrieves across all stores:

- Index discovers candidate records.
- Canonical store resolves entities to owner truth.
- Artifact store resolves source documents.
- Freshness and confidence are computed.

This is **not** RAG. It is structured retrieval with provenance boundaries.

## Trace provenance

```bash
npx db-cluster trace cluster://canonical/<entity-id>
```

Shows the full provenance graph — who created this entity, what evidence supports it, what mutations changed it. Every node traces to a specific store.

## Propose a mutation

```bash
npx db-cluster propose '{
  "verb": "update_entity",
  "targetStore": "canonical",
  "payload": { "entityId": "<entity-id>", "patch": { "name": "Updated claim" } },
  "proposedBy": "developer"
}'
```

This **does not write** to any store. It creates a staged command in `proposed` status.

## Validate and commit

```bash
npx db-cluster validate <command-id>
npx db-cluster approve <command-id> --note "reviewed by operator"
npx db-cluster commit <command-id>
```

The full lifecycle: **propose → validate → approve → commit**. Each step is auditable. Compensating a committed command creates a new compensating command — original receipts are preserved.

## Verify the cluster is healthy

```bash
npx db-cluster doctor
npx db-cluster verify
```

`doctor` checks reachability and structural health. `verify` proves data consistency invariants (index→source, provenance→subject, receipt→event). Both are read-only — neither mutates state.

## Next steps

- [Architecture](../architecture/) — why the four-store split is load-bearing.
- [MCP Integration](../mcp/) — make db-cluster available to AI agents.
- [Operations](../operations/) — backup, restore, rebuild, runbooks.
- [SDK Reference](../sdk/) — programmatic usage from your Node code.
