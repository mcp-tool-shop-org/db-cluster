/**
 * IndexRecord — a derivative discoverability entry.
 * Lives in the index store. Can always be rebuilt from canonical + artifact stores.
 */
export interface IndexRecord {
    id: string;
    sourceId: string;
    sourceStore: 'canonical' | 'artifact' | 'ledger';
    text: string;
    metadata: Record<string, unknown>;
    embedding?: number[];
    indexedAt: string;
    owner: 'index';
}
