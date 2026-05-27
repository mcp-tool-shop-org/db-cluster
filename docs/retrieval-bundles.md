# Retrieval Bundles

Retrieval in db-cluster is not vector similarity search. It is structured resolution from index discovery to owner truth.

## What retrieval does

1. **Index search** — finds candidate records (derivative)
2. **Owner resolution** — resolves each candidate to its owner store
3. **Freshness check** — detects stale index entries
4. **Gap detection** — reports what was expected but missing
5. **Confidence boundary** — indicates what the cluster knows vs. doesn't

## The EvidenceBundle

The canonical type lives at `src/types/evidence-bundle.ts` and is re-exported
through `@mcptoolshop/db-cluster/types`:

```typescript
import type {
    EvidenceBundle,
    ResolvedEvidence,
    FreshnessAssessment,
    MissingContext,
    ConfidenceBoundary,
} from '@mcptoolshop/db-cluster/types';
```

The shape:

```typescript
interface EvidenceBundle {
    /** Unique bundle ID */
    id: string;
    /** The original query that produced this bundle */
    query: string;
    /** When the bundle was assembled */
    assembledAt: string;
    /** Entities resolved from owner stores (canonical truth) */
    resolvedEntities: ResolvedEvidence<Entity>[];
    /** Artifacts resolved from owner stores (artifact truth) */
    resolvedArtifacts: ResolvedEvidence<Artifact>[];
    /** Index records that matched (derivative — not truth) */
    indexRecords: IndexRecord[];
    /** Provenance events supporting the resolved objects */
    provenanceEvents: ProvenanceEvent[];
    /** Freshness assessment */
    freshness: FreshnessAssessment;
    /** What the cluster could not find or verify */
    missingContext: MissingContext[];
    /** Confidence boundaries — what the bundle can and cannot claim */
    confidenceBoundaries: ConfidenceBoundary[];
}

interface ResolvedEvidence<T> {
    /** The resolved owner-store object */
    object: T;
    /** The cluster URI for this object */
    uri: string;
    /** Owner store name */
    ownerStore: string;
    /** Whether this object's index record is stale */
    indexStale: boolean;
    /** Provenance event IDs that touch this object */
    provenanceEventIds: string[];
}
```

Older Phase-3 docs sometimes show invented fields like `confidence: 'high'|'medium'|...`
or `staleRecords: string[]` — those don't exist on the real type. The
`scripts/doc-drift.mjs` detector (release-gate stage [8/8]) typechecks every
`typescript` code block in `docs/` against the actual `src/` types to prevent
this drift from re-appearing.

## CLI usage

```bash
db-cluster retrieve "database architecture claims"
```

Output includes:
- Resolved entities (from canonical store)
- Resolved artifacts (from artifact store)
- Freshness status per record
- Gaps (references that couldn't resolve)
- Confidence level

For explained retrieval:

```bash
db-cluster explain-retrieval "database architecture claims"
```

## SDK usage

```typescript
const bundle = await sdk.retrieveBundle('database architecture claims');

for (const entity of bundle.resolvedEntities) {
    // entity.object is the Entity from canonical truth
    // entity.indexStale tells you whether the matching index record is stale
    console.log(entity.object.name, entity.indexStale ? 'stale' : 'fresh');
}

// Surface freshness summary
const stale = bundle.freshness.staleCount;
const allFresh = bundle.freshness.allFresh;

// Surface what the cluster did NOT find
for (const missing of bundle.missingContext) {
    console.log(missing.description, missing.impact);
}

const explanation = await sdk.explainRetrieval(bundle);
console.log(explanation.summary);
```

## MCP usage

```json
{
  "tool": "cluster_retrieve_bundle",
  "arguments": { "query": "database architecture claims" }
}
```

Returns the same structured bundle. The AI host sees owner truth, freshness, and gaps — never raw index projections as final answers.

## Why this is not RAG

| RAG | db-cluster retrieval |
|-----|---------------------|
| Embeds chunks into a vector store | Indexes records with source provenance |
| Returns similarity matches | Returns owner truth from canonical/artifact stores |
| No ownership model | Every result traces to a specific owner store |
| No freshness | Stale records explicitly detected |
| No gap detection | Missing references reported |
| No provenance | Every result is traceable via `cluster_trace` |

## Ownership law

Retrieval always crosses at least two stores:
- The **index store** discovers candidates
- The **canonical/artifact store** resolves them to owner truth

Index records are never the final answer. The cluster always goes back to the owner.

## Freshness

A resolved record is marked `fresh: true` if the index entry matches current owner state. If the canonical entity has been updated since indexing, the record is stale. The bundle reports this explicitly so consumers know what to trust.

## Gaps

If an index record references a `sourceId` that no longer exists in the owner store, it becomes a gap. Gaps indicate potential data inconsistency — use `db-cluster verify` or `db-cluster rebuild index` to repair.
