# SDK Reference

The `ClusterSDK` provides programmatic access to db-cluster. It wraps the kernel with a clean API surface that enforces the same laws as CLI and MCP.

## Setup

```typescript
import { ClusterSDK } from 'db-cluster/sdk';
import { createLocalCluster } from 'db-cluster';

const stores = createLocalCluster('.db-cluster');
const sdk = new ClusterSDK({ stores, dataDir: '.db-cluster' });
```

With Postgres canonical backend:

```typescript
import { createCluster } from 'db-cluster';

const { stores } = createCluster({
    rootDir: '.db-cluster',
    backends: { canonical: 'postgres' },
    postgresUrl: process.env.DB_CLUSTER_POSTGRES_URL!,
});
const sdk = new ClusterSDK({ stores, dataDir: '.db-cluster' });
```

## Methods

### Discovery

#### `findSources(query, limit?)`

Search the cluster index and resolve results to owner truth.

```typescript
const result = await sdk.findSources('database architecture');
// result.indexRecords — raw index matches
// result.resolvedEntities — canonical entities (owner truth)
// result.resolvedArtifacts — artifacts (owner truth)
```

#### `retrieveBundle(query, options?)`

Structured evidence bundle with freshness and gaps.

```typescript
const bundle = await sdk.retrieveBundle('LLM safety claims', { limit: 10 });

console.log(bundle.confidence);        // 'high' | 'medium' | 'low' | 'none'
console.log(bundle.resolvedEntities);  // owner truth entities
console.log(bundle.gaps);              // missing references
console.log(bundle.staleRecords);      // stale index entries
```

#### `explainRetrieval(bundle)`

Explain a retrieval result.

```typescript
const explanation = await sdk.explainRetrieval(bundle);
console.log(explanation.summary);
console.log(explanation.resolvedCount);
console.log(explanation.missingCount);
console.log(explanation.allFresh);
```

### Resolution

#### `resolve(uri)`

Resolve a cluster URI to its owner-store object.

```typescript
const { store, object } = await sdk.resolve('cluster://canonical/entity-id');
// store === 'canonical'
// object is the full Entity
```

### Provenance

#### `traceObject(uri, options?)`

Get the full provenance graph for an object.

```typescript
const graph = await sdk.traceObject('cluster://canonical/entity-id');
for (const node of graph.nodes) {
    console.log(node.action, node.actorId, node.timestamp);
}
```

#### `why(uri)`

Compact explanation of why an object exists.

```typescript
const explanation = await sdk.why('cluster://canonical/entity-id');
console.log(explanation);
// "Created by developer at 2026-05-26T10:00:00Z. Updated once."
```

### Mutation lifecycle

#### `proposeMutation(input)`

Propose a mutation. Does NOT write to stores.

```typescript
const cmd = await sdk.proposeMutation({
    verb: 'update_entity',
    targetStore: 'canonical',
    payload: { entityId: '...', patch: { name: 'Updated' } },
    proposedBy: 'developer',
});
// cmd.status === 'proposed'
```

#### `validateMutation(commandId)`

Validate a proposed command.

```typescript
const validated = await sdk.validateMutation(cmd.id);
// validated.status === 'validated'
```

#### `approveMutation(commandId, approvedBy, note?)`

Approve a validated command.

```typescript
const approved = await sdk.approveMutation(cmd.id, 'operator', 'Looks good');
// approved.status === 'approved'
```

#### `rejectMutation(commandId, rejectedBy, reason)`

Reject a command. Terminal state.

```typescript
const rejected = await sdk.rejectMutation(cmd.id, 'operator', 'Not needed');
// rejected.status === 'rejected'
```

#### `commitMutation(commandId, actorId)`

Commit — this writes to the target store. Returns command + receipt.

```typescript
const { command, receipt } = await sdk.commitMutation(cmd.id, 'operator');
// command.status === 'committed'
// receipt.commandId === cmd.id
// receipt.provenanceEventId links to ledger
```

#### `compensateMutation(commandId, compensatedBy, reason)`

Correct a committed mutation without erasing it.

```typescript
const { compensatingCommand, originalCommand, receipt } =
    await sdk.compensateMutation(cmd.id, 'operator', 'Name was wrong');
```

### Command inspection

#### `inspectCommand(commandId)`

Get full command lifecycle state.

```typescript
const cmd = await sdk.inspectCommand(commandId);
console.log(cmd.status, cmd.proposedAt, cmd.committedAt);
```

#### `listReceipts(filter?)`

List mutation receipts.

```typescript
const receipts = await sdk.listReceipts({ limit: 10 });
for (const r of receipts) {
    console.log(r.commandId, r.committedAt, r.affectedIds);
}
```

### Policy

#### `policyExplain(input)`

Explain effective policy for a principal.

```typescript
const result = sdk.policyExplain({
    principal: { id: 'agent', trustZone: 'agent', capabilities: ['read'] },
    resource: 'cluster://canonical/entity-id',
});
```

#### `policyTest(input)`

Test policy actions.

```typescript
const result = sdk.policyTest({
    principal: { id: 'external', trustZone: 'external', capabilities: ['read'] },
    actions: [
        { verb: 'read', store: 'canonical' },
        { verb: 'write', store: 'canonical' },
    ],
});
// result.results[0].decision === 'allow'
// result.results[1].decision === 'deny'
```

## Ownership law

- The SDK never bypasses the kernel
- Retrieval always resolves to owner truth
- Mutations always go through the command lifecycle
- `commit` is the only method that writes to truth stores
- Every commit produces a receipt and provenance event
- Policy is enforced when using `PolicyEnforcedKernel`
