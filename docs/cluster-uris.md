# Cluster URIs

Every object in db-cluster has a unique URI that identifies its owner store and ID.

## Format

```
cluster://<store>/<id>
```

### Examples

```
cluster://canonical/a1b2c3d4-e5f6-7890-abcd-ef1234567890
cluster://artifact/f9e8d7c6-b5a4-3210-fedc-ba9876543210
cluster://index/11223344-5566-7788-99aa-bbccddeeff00
cluster://ledger/aabbccdd-eeff-0011-2233-445566778899
```

## Stores

| Store | URI prefix | Contains |
|-------|-----------|----------|
| `canonical` | `cluster://canonical/` | Entities |
| `artifact` | `cluster://artifact/` | Artifacts |
| `index` | `cluster://index/` | Index records |
| `ledger` | `cluster://ledger/` | Provenance events |

## Resolution

Resolving a URI returns the **owner truth** for that object:

```bash
db-cluster resolve cluster://canonical/<id>
```

```typescript
const sdk = new ClusterSDK({ clusterDir: '.db-cluster' });
const { store, object } = await sdk.resolve('cluster://canonical/<id>');
// store === 'canonical'
// object is the Entity with full attributes
```

Resolution never returns index projections. It always goes to the owner store.

## URI in provenance

Provenance events reference subjects by URI:

```json
{
  "id": "event-uuid",
  "action": "entity_created",
  "actorId": "developer",
  "subjectId": "entity-uuid",
  "subjectStore": "canonical",
  "timestamp": "2026-05-26T10:00:00.000Z"
}
```

The combination of `subjectId` + `subjectStore` forms the logical URI `cluster://canonical/entity-uuid`.

## URI in commands

Mutation commands target a store:

```json
{
  "verb": "update_entity",
  "targetStore": "canonical",
  "payload": { "entityId": "...", "patch": { "name": "..." } }
}
```

The `targetStore` field identifies which store owns the mutation target.

## Parsing and formatting

```typescript
import { parseClusterUri, formatClusterUri, isClusterUri } from 'db-cluster';

const uri = formatClusterUri('canonical', 'abc-123');
// 'cluster://canonical/abc-123'

const parsed = parseClusterUri(uri);
// { store: 'canonical', id: 'abc-123' }

isClusterUri('cluster://artifact/xyz');  // true
isClusterUri('https://example.com');      // false
```

## Ownership law

A URI always identifies **one owner store**. There is no ambiguity about where truth lives. The index may reference a canonical entity, but `cluster://canonical/<id>` always resolves from the canonical store, never the index.
