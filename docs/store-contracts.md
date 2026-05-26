# Store Contracts

Every store in db-cluster implements a typed contract. The contract defines what the store owns and how it can be accessed. Physical backends (local JSON, Postgres) implement these contracts without changing the API surface.

## Canonical Store

**Owns:** Entities — structured state records with stable IDs.

```typescript
interface CanonicalStore {
    get(id: string): Promise<Entity | null>;
    list(filter?: EntityFilter): Promise<Entity[]>;
    exists(id: string): Promise<boolean>;
    create(entity: Omit<Entity, 'id' | 'createdAt' | 'updatedAt' | 'owner'>): Promise<Entity>;
    update(id: string, patch: Partial<Pick<Entity, 'name' | 'attributes'>>): Promise<Entity>;
}

interface EntityFilter {
    kind?: string;
    nameContains?: string;
    limit?: number;
}
```

**Ownership law:** The canonical store is the single source of truth for entity state. No other store may contradict it. Index records that reference a canonical entity are derivative — stale index entries do not override canonical truth.

## Artifact Store

**Owns:** Raw files — documents, source text, generated outputs. Immutable by default.

```typescript
interface ArtifactStore {
    get(id: string): Promise<Artifact | null>;
    getContent(id: string): Promise<Buffer | null>;
    list(filter?: ArtifactFilter): Promise<Artifact[]>;
    exists(id: string): Promise<boolean>;
    ingest(input: ArtifactIngestInput): Promise<Artifact>;
    versions(filename: string): Promise<Artifact[]>;
}

interface ArtifactFilter {
    mimeType?: string;
    filenameContains?: string;
    limit?: number;
}
```

**Ownership law:** Artifacts are immutable. Corrections create new versions, never overwrites. The artifact store owns content hashes, storage paths, and version lineage. Content is never stored in the canonical or index stores.

## Index Store

**Owns:** Discoverability — full-text search and metadata lookup. **This is the only derivative store.**

```typescript
interface IndexStore {
    search(query: IndexQuery): Promise<IndexRecord[]>;
    get(id: string): Promise<IndexRecord | null>;
    index(record: Omit<IndexRecord, 'id' | 'indexedAt' | 'owner'>): Promise<IndexRecord>;
    remove(id: string): Promise<void>;
    clear(): Promise<void>;
    count(): Promise<number>;
}

interface IndexQuery {
    text?: string;
    sourceStore?: 'canonical' | 'artifact' | 'ledger';
    metadata?: Record<string, unknown>;
    limit?: number;
}
```

**Ownership law:** The index store can be **destroyed and rebuilt** from canonical + artifact truth. Index records always carry `sourceId` and `sourceStore` — they point to owner truth, never hold it. Retrieval through the kernel always resolves index results to their owner stores before returning.

## Ledger Store

**Owns:** History — provenance events and mutation receipts. Append-only.

```typescript
interface LedgerStore {
    append(event: Omit<ProvenanceEvent, 'id' | 'timestamp' | 'owner'>): Promise<ProvenanceEvent>;
    getEvent(id: string): Promise<ProvenanceEvent | null>;
    listEvents(filter?: LedgerFilter): Promise<ProvenanceEvent[]>;
    trace(eventId: string): Promise<ProvenanceEvent[]>;
    appendReceipt(receipt: Omit<Receipt, 'id' | 'committedAt'>): Promise<Receipt>;
    getReceipt(id: string): Promise<Receipt | null>;
    listReceipts(filter?: ReceiptFilter): Promise<Receipt[]>;
}

interface LedgerFilter {
    subjectId?: string;
    action?: string;
    since?: string;
    limit?: number;
}
```

**Ownership law:** The ledger is append-only. Events are never deleted or modified. Receipts prove that mutations occurred. Provenance traces walk the event chain to explain why any object exists.

## ClusterStores

The kernel receives all four stores as a single composite:

```typescript
interface ClusterStores {
    canonical: CanonicalStore;
    artifact: ArtifactStore;
    index: IndexStore;
    ledger: LedgerStore;
}
```

## Physical backends

| Backend | Stores supported | Notes |
|---------|-----------------|-------|
| Local (JSON files) | All four | Default. No external dependencies. |
| Postgres | Canonical only | Requires `DB_CLUSTER_POSTGRES_URL`. Stronger durability. |

The store contract is identical regardless of backend. The kernel, SDK, MCP, and CLI never know which backend is active unless explicitly queried via `stores list`.
