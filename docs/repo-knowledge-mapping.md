# Repo-Knowledge → db-cluster Mapping

How repo-knowledge concepts map into cluster truth stores.

## Concept mapping table

| Repo-knowledge concept | db-cluster store | db-cluster type | Notes |
|------------------------|-----------------|-----------------|-------|
| repo | canonical | entity(repo) | Top-level repo identity |
| project | canonical | entity(project) | Project within repo |
| fact | canonical | entity(fact) | Extracted or stated knowledge |
| decision note | canonical | entity(decision) | Recorded design/product decision |
| source file/doc | artifact | artifact | Raw file ingested as evidence |
| sync run | ledger | provenance_event | When knowledge was synced |
| fact extraction | ledger | provenance_event | Edge: fact_extracted_from artifact |
| tags/topics | canonical + index | attributes + index terms | Stored as attributes, projected into index |
| stale fact | index | stale_warning | Freshness check against source |
| memory file | artifact | artifact(memory_doc) | Ingested as source artifact |

## Entity kinds (canonical store)

- `repo` — top-level repository identity
- `project` — project/tool within a repo
- `fact` — extracted or stated knowledge unit
- `decision` — recorded design or product decision
- `finding` — observation from dogfood or audit
- `task` — actionable work item
- `phase` — development phase marker
- `milestone` — progress checkpoint
- `source` — reference to external source
- `sync_run` — knowledge sync event record

## Artifact kinds (artifact store)

- `memory_doc` — project memory / notes file
- `readme` — README file
- `changelog` — CHANGELOG file
- `source_file` — generic source code or doc
- `run_log` — sync or build log
- `closeout_doc` — phase closeout document
- `repo_note` — repository-level note

## Provenance edges (ledger store)

- `fact_extracted_from` — fact derived from source artifact
- `decision_supported_by` — decision backed by evidence
- `repo_described_by` — repo documented by artifact
- `sync_created` — entity created during sync run
- `fact_updated_by` — fact modified by later evidence
- `finding_observed_in` — finding discovered in context
- `memory_backed_by` — entity has backing memory file

## Ownership rules

| Store | Owns | Never owns |
|-------|------|------------|
| canonical | Entity state, relationships | Raw file content |
| artifact | Source documents, evidence files | Business logic state |
| index | Derived search records | Source truth |
| ledger | Events, receipts, provenance | Mutable state |

## Key principle

Repo-knowledge concepts map into cluster ownership **without losing their original meaning**. A "fact" in repo-knowledge becomes a canonical entity with provenance linking it to the source artifact it was extracted from.
