# Quickstart Example

This directory contains everything needed to run the db-cluster golden path.

## Files

- `evidence.md` — sample source document (artifact)
- `commands.md` — step-by-step commands with explanations
- `expected-output/` — reference output for verification

## Quick run

```bash
cd examples/quickstart

# Initialize
db-cluster init

# Ingest evidence
db-cluster ingest ./evidence.md

# Create entity
db-cluster entity create --kind claim --name "LLMs should not write directly to databases" --attr '{"confidence":"high","domain":"architecture"}'

# Retrieve
db-cluster retrieve "LLM database mutations"

# Doctor
db-cluster doctor

# Cleanup
rm -rf .db-cluster
```

## Prerequisites

- Node.js 18+
- db-cluster installed (`npm install -g db-cluster` or `npm link` from repo root)

## Postgres path (optional)

To run with Postgres canonical backend:

```bash
export DB_CLUSTER_CANONICAL_BACKEND=postgres
export DB_CLUSTER_POSTGRES_URL=postgresql://user:pass@localhost:5432/dbname

db-cluster init
db-cluster stores migrate
db-cluster ingest ./evidence.md
db-cluster entity create --kind claim --name "LLMs should not write directly to databases" --attr '{"confidence":"high"}'
db-cluster doctor
```

The experience is identical. Only the canonical store backend changes.

## What you should see

1. `init` creates `.db-cluster/` with `canonical/`, `artifact/`, `index/`, `ledger/`
2. `ingest` reports the artifact ID and filename
3. `entity create` reports the entity ID
4. `retrieve` shows a bundle with resolved entities and artifacts
5. `doctor` reports all stores healthy
