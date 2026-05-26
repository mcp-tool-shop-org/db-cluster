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
}

export interface IndexQuery {
    text?: string;
    sourceStore?: 'canonical' | 'artifact' | 'ledger';
    metadata?: Record<string, unknown>;
    limit?: number;
}
