# Dogfood Project Memory

db-cluster managing its own project memory — phases, decisions, milestones, and findings backed by real repo artifacts.

## What this proves

db-cluster can serve as a project-memory substrate where:
- Docs go to artifact store (source truth preserved)
- Phases/decisions/milestones go to canonical store (structured state)
- Discovery uses index (derivative, rebuildable)
- Every claim traces to source artifacts via provenance
- Updates require command lifecycle (propose → validate → approve → commit)
- Policy controls who can read/write what

## What this is not

- A notes app
- A todo manager
- A markdown archive
- A replacement for repo-knowledge (yet)
- An AI chat interface

## Running

```bash
# Ingest repo artifacts into dogfood cluster
npx tsx scripts/dogfood-ingest.ts

# Query project memory
npx tsx scripts/dogfood-query.ts

# Trace decisions/phases
npx tsx scripts/dogfood-trace.ts

# Mutation workflow
npx tsx scripts/dogfood-update.ts

# Policy/redaction
npx tsx scripts/dogfood-policy.ts

# Operations/recovery
npx tsx scripts/dogfood-ops.ts
```

## Schema

See [schema.md](schema.md) for the canonical entity kinds, artifact kinds, and provenance edge types.
