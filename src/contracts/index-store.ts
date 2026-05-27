import type { IndexRecord } from '../types/index-record.js';

/**
 * IndexStore contract.
 * Owns: discoverability, full-text/vector lookup, metadata search.
 * DERIVATIVE — can always be rebuilt from canonical + artifact + ledger stores.
 */
export interface IndexStore {
    search(query: IndexQuery): Promise<IndexRecord[]>;
    get(id: string): Promise<IndexRecord | null>;
    index(record: Omit<IndexRecord, 'id' | 'indexedAt' | 'owner'>): Promise<IndexRecord>;
    remove(id: string): Promise<void>;
    /** Drop all index records. Used to prove rebuildability. */
    clear(): Promise<void>;
    count(): Promise<number>;
    /**
     * Atomically replace the entire record set. Used by `rebuildIndex` to swap
     * a freshly-built index over the live one without an empty window between
     * clear() and the first index() call (STORES-008 / STORES-R003).
     *
     * Adapters that cannot guarantee atomic replacement may implement this as
     * clear() + index()-loop, but they MUST implement it — `rebuildIndex` no
     * longer falls back to a duck-typed `replaceAll?` check.
     */
    replaceAll(records: Omit<IndexRecord, 'id' | 'indexedAt' | 'owner'>[]): Promise<void>;
}

export interface IndexQuery {
    text?: string;
    sourceStore?: 'canonical' | 'artifact' | 'ledger';
    metadata?: Record<string, unknown>;
    limit?: number;
}
