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

for (const node of graph.nodes) {
    console.log(node.uri, node.action, node.actorId);
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

Traces return a `ProvenanceGraph`:

```typescript
interface ProvenanceGraph {
    rootUri: string;
    nodes: ProvenanceNode[];
    edges: ProvenanceEdge[];
}

interface ProvenanceNode {
    uri: string;
    store: string;
    action: string;
    actorId: string;
    timestamp: string;
}

interface ProvenanceEdge {
    from: string;
    to: string;
    relationship: string;
}
```

Nodes represent events. Edges represent causal relationships (parent→child, evidence→claim, source→derivative).

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
