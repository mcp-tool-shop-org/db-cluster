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

**Owns:** Discoverability — full-text (ranked) search and metadata lookup. Ranking (BM25) is a layer above `search()`, which returns candidates. **This is the only derivative store.**

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
    /**
     * Count events matching the filter without materializing them.
     * REQUIRED on the contract — adapters implement directly, callers
     * never feature-detect (STORES-B-014). `doctor()` / `verify()` use
     * the true count as the headline number rather than the silently-
     * truncated `listEvents({ limit }).length`.
     */
    countEvents(filter?: LedgerFilter): Promise<number>;
    trace(eventId: string): Promise<ProvenanceEvent[]>;

    appendReceipt(receipt: Omit<Receipt, 'id' | 'committedAt'>): Promise<Receipt>;
    getReceipt(id: string): Promise<Receipt | null>;
    listReceipts(filter?: ReceiptFilter): Promise<Receipt[]>;

    /**
     * Import an event preserving the original `id` and `timestamp`.
     * Used by backup/restore so re-runs are idempotent (STORES-002 /
     * STORES-B-003). Throws `ImportConflictError` when an existing
     * record with the same id has different content. REQUIRED on the
     * contract (STORES-R2-002).
     */
    importEvent(event: ProvenanceEvent): Promise<ProvenanceEvent>;
    /**
     * Import a receipt preserving original `id` and `committedAt`. Same
     * idempotence + conflict semantics as {@link importEvent}.
     * REQUIRED on the contract.
     */
    importReceipt(receipt: Receipt): Promise<Receipt>;

    /**
     * Archive events whose `timestamp < beforeTimestamp` into a sibling
     * `<dataDir>/ledger-archive/` file. Receipts archive likewise via
     * `committedAt`. STORES-B-013: gives operators a recovery valve
     * before the active ledger grows unbounded.
     *
     * Throws:
     *  - `InvalidRotateTimestampError` — boundary is not a parseable
     *    ISO-8601 datetime (AGG-B1-2b).
     *  - `RotateBoundaryInFutureError` — boundary is in the future;
     *    archiving "everything up to a future date" is almost always
     *    a typo (AGG-B1-2d).
     *
     * `trace()` does NOT read archived events — provenance chains that
     * crossed the boundary truncate at the youngest unarchived event.
     */
    rotate(beforeTimestamp: string): Promise<RotateResult>;
}

interface RotateResult {
    archived: number;
    retained: number;
    /** Absolute path of the archive file (omitted when nothing archived). */
    archiveFile?: string;
}

interface LedgerFilter {
    subjectId?: string;
    action?: string;
    since?: string;
    limit?: number;
}
```

**Ownership law:** The ledger is append-only. Events are never deleted or modified except via {@link rotate}. Receipts prove that mutations occurred. Provenance traces walk the event chain to explain why any object exists.

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
| SQLite (better-sqlite3) | All four | Optional. `better-sqlite3` is an [`optionalDependency`](https://docs.npmjs.com/cli/v10/configuring-npm/package-json#optionaldependencies), lazy-loaded — local stays the default; selecting this backend is the only thing that loads the native driver, and a missing driver yields a typed `SqliteDriverUnavailableError`. A single embedded WAL-mode database file under `<rootDir>/sqlite/cluster.db` (one shared connection, transactions for atomic multi-row writes). Opt in via the `backends` config. Like local, retrieval is decoupled: `search()` returns candidates and BM25 ranking rides above it (no FTS5 ranking inside the store). |

The store contract is identical regardless of backend. The kernel, SDK, MCP, and CLI never know which backend is active unless explicitly queried via `stores list`.
