# Example: Research Evidence Cluster

A research team's evidence store — papers as artifacts, claims as canonical entities, topics linking claims. The cluster proves: retrieval returns structured evidence bundles (not search hits), every claim traces back to its source paper, and the doctor detects when the index has fallen out of sync with owner truth.

## What this demonstrates

- Ingesting papers as content-addressable artifacts.
- Creating claim and topic entities with cross-entity attribute references.
- Retrieving an `EvidenceBundle` — owner truth, freshness, confidence boundaries, gaps.
- Tracing a claim back to its source paper through the provenance graph.
- Detecting stale index state via `doctor()` after the index is wiped.

## Prerequisites

- Node.js 20+
- npm or pnpm
- `@mcptoolshop/db-cluster` installed (`npm install @mcptoolshop/db-cluster` or local `npm link`)

## Run

```bash
cd examples/research-evidence-cluster
npx tsx index.ts
```

## Expected output

```
=== Research Evidence Cluster ===

Papers ingested: <paper1Id> <paper2Id>
Claims created: <claim1Id> | <claim2Id>
Topic: <topicId>

--- Retrieve: "safety mutation" ---
Entities: <N>
Artifacts: <N>
All fresh: true

--- Trace claim provenance ---
Provenance nodes: <N>
  <node label> (cluster://<store>/<id>)
  ...

--- Stale index detection ---
After index wipe, doctor says: degraded
Index check: <message>
Repair available: true

Done.
```

## Variations to try

- Run `db-cluster rebuild index` on the wiped cluster — observe the index re-deriving from canonical + artifact truth.
- Add a new claim with a `relatedClaims` attribute referencing both existing claims — call `retrieveBundle` and inspect the freshness assessment.
- Add a stale projection scenario: mutate a canonical entity through direct adapter access (bypass kernel) and observe `verify` reporting the stale index record.
- Trigger `ContentHashMismatchError`: propose `ingest_artifact` with a hash that doesn't match the content. The propose-time validator (KERNEL-B-007) rejects before staging.

## Failure paths

| Class | Code | What it means |
|---|---|---|
| Stale index | (no error class — surfaced via doctor) | Run `db-cluster rebuild index`; see [docs/runbooks/index-stale.md](../../docs/runbooks/index-stale.md). |
| Content hash mismatch | `CONTENT_HASH_MISMATCH` | Recompute `sha256(content)` and re-propose. |
| Resolve not found | `RESOLVE_NOT_FOUND` | URI doesn't match any owner-truth record; the URI may be stale. |

## Next steps

- Read `docs/retrieval-bundles.md` for the full `EvidenceBundle` shape — what `freshness`, `confidenceBoundaries`, `missingContext` actually surface.
- Read `docs/runbooks/index-stale.md` for stale-index recovery procedure.
- See `examples/project-memory-cluster/` for an entity-update-focused example.
