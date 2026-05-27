# Provenance Graphs

Every object in db-cluster has a provenance trail. Provenance answers: why does this exist? What created it? What changed it? What evidence supports it?

## The provenance model

```typescript
interface ProvenanceEvent {
    id: string;
    timestamp: string;
    action: string;
    actorId: string;
    subjectId: string;
    subjectStore: 'canonical' | 'artifact' | 'index' | 'ledger';
    detail: Record<string, unknown>;
    parentEventId?: string;
    owner: 'ledger';
}
```

Every provenance event lives in the **ledger store**. The ledger is append-only — events are never deleted or modified.

## Actions

| Action | Meaning | Subject store |
|--------|---------|--------------|
| `entity_created` | New entity in canonical store | canonical |
| `entity_updated` | Entity state changed | canonical |
| `artifact_ingested` | New artifact stored | artifact |
| `evidence_linked` | Artifact linked as evidence for entity | canonical/artifact |
| `command_committed` | Mutation executed through command lifecycle | canonical |
| `command_compensated` | Committed mutation corrected | canonical |

## Tracing

### CLI

```bash
# Trace a specific object
db-cluster trace cluster://canonical/<entity-id>

# Ask "why does this exist?"
db-cluster why cluster://canonical/<entity-id>

# Full lineage (bidirectional)
db-cluster lineage cluster://canonical/<entity-id>

# Trace everything in a retrieval bundle
db-cluster trace-bundle "query text"
```

### SDK

```typescript
const graph = await sdk.traceObject('cluster://canonical/<entity-id>');

// graph.focalUri is the URI you traced from
// graph.nodes carry uri, type, ownerStore, label, isSourceTruth
// graph.edges carry from, to, type, reason
for (const node of graph.nodes) {
    console.log(node.uri, node.type, node.label, node.isSourceTruth ? '(source)' : '(derivative)');
}
for (const edge of graph.edges) {
    console.log(edge.from, '→', edge.to, `[${edge.type}]`, edge.reason);
}

const explanation = await sdk.why('cluster://canonical/<entity-id>');
console.log(explanation);
// "Created by developer at 2026-05-26T10:00:00Z. Updated once (update_entity by developer)."
```

### MCP

```json
{
  "tool": "cluster_trace",
  "arguments": { "uri": "cluster://canonical/<entity-id>" }
}
```

## The provenance graph

Traces return a `ProvenanceGraph`. The canonical type lives at
`src/types/provenance-graph.ts` and is re-exported through `@mcptoolshop/db-cluster/types`:

```typescript
import type {
    ProvenanceGraph,
    ProvenanceNode,
    ProvenanceEdge,
    NodeType,
    EdgeType,
    TraceDirection,
    TraceOptions,
    TraceGap,
    TraceWarning,
    TraceSummary,
} from '@mcptoolshop/db-cluster/types';
```

The shape:

```typescript
interface ProvenanceGraph {
    /** The focal URI — the object this graph was traced from */
    focalUri: string;
    /** Trace direction */
    direction: TraceDirection;
    /** All nodes in the graph */
    nodes: ProvenanceNode[];
    /** All edges in the graph */
    edges: ProvenanceEdge[];
    /** Gaps — missing provenance or truth */
    gaps: TraceGap[];
    /** Warnings — stale projections, missing chains */
    warnings: TraceWarning[];
    /** Summary statistics */
    summary: TraceSummary;
    /** When this graph was assembled */
    assembledAt: string;
}

interface ProvenanceNode {
    /** Cluster URI for this node */
    uri: string;
    /** Node type */
    type: NodeType;
    /** Owner store (or null for gaps) */
    ownerStore: string | null;
    /** Is this source truth or derivative? */
    isSourceTruth: boolean;
    /** Display label */
    label: string;
    /** Optional metadata snapshot */
    metadata?: Record<string, unknown>;
    /** Whether this node represents a gap/warning */
    isGap?: boolean;
}

interface ProvenanceEdge {
    /** Source node URI */
    from: string;
    /** Target node URI */
    to: string;
    /** Edge type — the reason this connection exists */
    type: EdgeType;
    /** Human-readable reason */
    reason: string;
    /** Provenance event ID that establishes this edge (if any) */
    sourceEventId?: string;
    /** Timestamp of the edge relationship */
    timestamp?: string;
    /** Is this edge a warning (stale, missing)? */
    isWarning?: boolean;
}
```

Nodes carry a typed `NodeType` (one of: `entity`, `artifact`, `index_record`,
`provenance_event`, `receipt`, `command`, `evidence_bundle`). Edges carry a
typed `EdgeType` (11 variants covering all store relationships) and a
human-readable `reason`. Older docs sometimes showed invented fields like
`rootUri`, `store`, `action`, `actorId` or `relationship` — those don't exist
on the real type. The `scripts/doc-drift.mjs` detector (release-gate stage
[8/8]) typechecks every `typescript` code block in `docs/` against the actual
`src/` types to prevent this drift from re-appearing.

## Parent chains

Events can have `parentEventId` — forming a chain:

```
entity_created (original)
  └─ entity_updated (first mutation)
      └─ entity_updated (second mutation)
```

Walking the parent chain shows the full lifecycle of an object.

## Receipts as provenance proof

Every committed mutation produces a `Receipt`:

```typescript
interface Receipt {
    id: string;
    commandId: string;
    committedAt: string;
    resultSummary: string;
    affectedIds: string[];
    provenanceEventId: string;
}
```

The `provenanceEventId` links the receipt to its provenance event — forming a complete audit trail from command proposal through to store mutation.

## Ownership law

Provenance is owned by the **ledger store**. It is append-only and never derivative. You cannot delete provenance events. You cannot modify them. The ledger is the permanent record of why the cluster looks the way it does.

## Verification

```bash
# Check provenance event integrity
db-cluster verify

# Check receipts reference valid events
db-cluster doctor
```

Both commands verify that provenance chains are intact without modifying any state.
