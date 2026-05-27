import type { IndexRecord } from '../types/index-record.js';

/**
 * IndexStore contract.
 * Owns: discoverability, full-text/vector lookup, metadata search.
 * DERIVATIVE — can always be rebuilt from canonical + artifact + ledger stores.
 */
export interface IndexStore {
    /**
     * Search the index. `text` runs against the full-text payload; other
     * fields narrow the candidate set before/after text matching depending
     * on adapter implementation.
     *
     * Returns derivative records — never owner truth. A caller that needs
     * the canonical/artifact record after a hit should follow `sourceId`
     * + `sourceStore` to the owning store via `get(sourceId)`.
     *
     * @param query  Optional. `text` narrows by content; `sourceStore`
     *               narrows by owning store; `metadata` does shallow-equal
     *               attribute matching; `limit` caps results.
     * @returns      Array of matching IndexRecord. Empty array on no
     *               match; never returns `null`.
     */
    search(query: IndexQuery): Promise<IndexRecord[]>;

    /**
     * Fetch a single index record by its index-record id (NOT the
     * sourceId — those are different namespaces). `null` if absent.
     */
    get(id: string): Promise<IndexRecord | null>;

    /**
     * Index a single new record. Stamps `id` (UUID), `indexedAt`
     * (ISO-8601), and `owner='index'` at the adapter boundary.
     *
     * Postconditions:
     *  - The record is searchable via {@link search} after this call
     *    resolves (the index may be eventually consistent for some
     *    adapters, but the local adapter is strongly consistent).
     */
    index(record: Omit<IndexRecord, 'id' | 'indexedAt' | 'owner'>): Promise<IndexRecord>;

    /**
     * Remove a single index record by its index-record id.
     *
     * Mostly used during rebuild + stale-record cleanup. Most callers
     * should prefer {@link replaceAll} for atomic batch swaps rather than
     * a sequence of remove() + index() calls.
     */
    remove(id: string): Promise<void>;

    /**
     * Drop all index records. Used to prove rebuildability — the index
     * is DERIVATIVE state; deletion is recoverable via
     * `rebuildIndex(stores)`.
     *
     * Most production code should NOT call this directly; the high-level
     * `rebuildIndex` op uses {@link replaceAll} for an atomic swap that
     * collapses the empty-index window to a single filesystem rename
     * on the local adapter.
     */
    clear(): Promise<void>;

    /**
     * Return the exact count of records in the index. Used by doctor's
     * index-vs-truth check and the index-populated health probe.
     */
    count(): Promise<number>;

    /**
     * Atomically replace the entire record set. Used by `rebuildIndex` to swap
     * a freshly-built index over the live one without an empty window between
     * clear() and the first index() call (STORES-008 / STORES-R003).
     *
     * Adapters that cannot guarantee atomic replacement may implement this as
     * clear() + index()-loop, but they MUST implement it — `rebuildIndex` no
     * longer falls back to a duck-typed `replaceAll?` check.
     *
     * Postconditions:
     *  - The index contains exactly the records supplied (modulo adapter-
     *    stamped `id` / `indexedAt` / `owner` fields).
     *  - No reader sees the empty intermediate state on the local adapter
     *    (rename-based swap).
     *
     * @param records  Replacement record set (input shape, sans stamped
     *                 fields). Stamped during the write.
     */
    replaceAll(records: Omit<IndexRecord, 'id' | 'indexedAt' | 'owner'>[]): Promise<void>;
}

export interface IndexQuery {
    text?: string;
    sourceStore?: 'canonical' | 'artifact' | 'ledger';
    metadata?: Record<string, unknown>;
    limit?: number;
}
