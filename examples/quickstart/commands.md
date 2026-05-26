# Quickstart Commands

Run these commands in order after installing db-cluster.

## Prerequisites

```bash
npm install    # or: npm link (if working from source)
```

## The golden path

```bash
# 1. Initialize a cluster
db-cluster init

# 2. Ingest source evidence
db-cluster ingest ./evidence.md

# 3. Create a canonical entity (claim)
db-cluster entity create --kind claim --name "LLMs should not write directly to databases" --attr '{"confidence":"high","domain":"architecture"}'

# 4. Find through the index
db-cluster find "database architecture"

# 5. Retrieve an evidence bundle
db-cluster retrieve "LLM database mutations"

# 6. Trace provenance of the entity
#    (use the entity ID from step 3)
db-cluster trace cluster://canonical/<entity-id>

# 7. Propose a mutation (does NOT write)
db-cluster propose '{"verb":"update_entity","targetStore":"canonical","payload":{"entityId":"<entity-id>","patch":{"name":"LLMs require command-gated mutation"}},"proposedBy":"developer"}'

# 8. Validate the proposed command
db-cluster validate <command-id>

# 9. Commit the mutation (WRITES to canonical store)
db-cluster commit <command-id>

# 10. Check receipts
db-cluster receipts

# 11. Run doctor
db-cluster doctor
```

## What this proves

| Step | Law proven |
|------|-----------|
| init | Four stores created with distinct ownership |
| ingest | Artifact store owns raw files |
| entity create | Canonical store owns structured state |
| find | Index discovers but doesn't own truth |
| retrieve | Bundle resolves to owner truth |
| trace | Provenance tracks every action |
| propose | Mutations are staged, not immediate |
| validate | Commands are structurally checked |
| commit | Only commit writes to stores |
| receipts | Every mutation has a receipt |
| doctor | Health is explicit and inspectable |

## Cleanup

```bash
rm -rf .db-cluster
```
