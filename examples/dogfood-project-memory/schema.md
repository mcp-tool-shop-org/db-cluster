# Dogfood Project Memory Schema

## Canonical Entity Kinds

| Kind | Description | Example |
|------|-------------|---------|
| `project` | The root project | db-cluster |
| `phase` | A development phase | Phase 5 — Mutation Law |
| `wave` | A wave within a phase | Phase 9 Wave 3 — Index Rebuild |
| `decision` | An architectural/design decision | "AI proposes, command runtime disposes" |
| `finding` | An observed fact or insight | "Index is derivative" |
| `risk` | A risk or drift trap | "RAG framing reduces product" |
| `repair` | A fix applied to correct drift | "Renamed kernel methods" |
| `tag` | A git tag / release marker | phase-10-developer-product-surface |
| `milestone` | A project milestone | "434 tests across 29 files" |

## Artifact Kinds

| Kind | Description | Example |
|------|-------------|---------|
| `source_doc` | A repo source document | README.md |
| `closeout_doc` | A phase closeout document | docs/phase-10-closeout.md |
| `changelog` | The project changelog | CHANGELOG.md |
| `readme` | The project README | README.md |
| `test_report` | Test execution results | "434 tests passing" |
| `implementation_note` | Implementation detail doc | docs/store-contracts.md |
| `operator_log` | Operational action log | backup/restore records |
| `design_prompt` | A design prompt or spec | Phase 11 checklist |

## Provenance Edge Types

| Edge | From | To | Meaning |
|------|------|----|---------|
| `phase_closed_by` | phase | closeout_doc | Phase was closed by this document |
| `wave_proven_by` | wave | test_report | Wave proven by test results |
| `decision_supported_by` | decision | artifact | Decision backed by this evidence |
| `finding_observed_in` | finding | artifact | Finding comes from this source |
| `repair_addresses` | repair | risk | Repair was applied to fix this risk |
| `artifact_ingested_as` | artifact | entity | Artifact was ingested and linked to entity |
| `milestone_tagged_by` | milestone | tag | Milestone marked by this git tag |
| `status_updated_from` | entity | entity | Status changed from one state to another |

## Trust Zones (for dogfood policy)

| Zone | Capabilities | Description |
|------|-------------|-------------|
| `operator` | Full read/write/trace/commit | Project maintainer |
| `agent` | Read/discover/propose | AI agent assisting project |
| `observer` | Read derivative/indexed | Read-only reviewer |
| `external` | Discover existence only | External party, no content |

## Cluster URIs

```
cluster://canonical/<entity-id>     → phase, decision, milestone, etc.
cluster://artifact/<artifact-id>    → source doc, closeout doc, changelog
cluster://index/<record-id>         → search/discovery index record
cluster://ledger/<event-id>         → provenance event
```

## Invariants

1. Every canonical entity has at least one supporting artifact (via provenance)
2. Every artifact is indexed (derivative record in index store)
3. Every mutation produces a receipt in the ledger
4. Decisions trace to source docs, not generated summaries
5. Index can be deleted and rebuilt from canonical + artifact stores
