import type { ProvenanceEvent } from '../types/provenance-event.js';
import type { Receipt } from '../types/receipt.js';

/**
 * LedgerStore contract.
 * Owns: actions, links, mutations, receipts, lineage.
 * Append-only. No updates, no deletes (except via {@link rotate}).
 */
export interface LedgerStore {
    append(event: Omit<ProvenanceEvent, 'id' | 'timestamp' | 'owner'>): Promise<ProvenanceEvent>;
    getEvent(id: string): Promise<ProvenanceEvent | null>;
    listEvents(filter?: LedgerFilter): Promise<ProvenanceEvent[]>;
    /**
     * Count events matching the filter without materializing them.
     *
     * STORES-B-014: `doctor()` and `verify()` pre-fix used
     * `listEvents({ action: 'mutation_orphaned', limit: 100 }).length` as a
     * silent-truncation orphan count — at 500 orphans the operator saw 100.
     * Post-fix the headline number comes from `countEvents` (no limit) and
     * listEvents is reserved for sampling.
     *
     * REQUIRED on the contract. Adapters implement it directly — there is
     * no consumer-side fallback; a missing method is a compile error.
     */
    countEvents(filter?: LedgerFilter): Promise<number>;
    /** Trace lineage: walk parent chain from a given event. */
    trace(eventId: string): Promise<ProvenanceEvent[]>;

    appendReceipt(receipt: Omit<Receipt, 'id' | 'committedAt'>): Promise<Receipt>;
    getReceipt(id: string): Promise<Receipt | null>;
    listReceipts(filter?: ReceiptFilter): Promise<Receipt[]>;

    /**
     * Import an event preserving the original `id` and `timestamp`.
     * Used by backup/restore — STORES-002 requires this so re-running restore
     * is idempotent (otherwise every run inserts new copies under fresh UUIDs).
     *
     * REQUIRED on the contract (STORES-R2-002): every adapter must
     * implement this. backup.ts::restore() throws
     * ImportSnapshotNotSupportedError at runtime when missing — promoting
     * to a contract requirement closes the compile-time gap.
     */
    importEvent(event: ProvenanceEvent): Promise<ProvenanceEvent>;

    /**
     * Import a receipt preserving the original `id` and `committedAt`.
     * Same rationale as {@link importEvent} but for receipts.
     *
     * REQUIRED on the contract (STORES-R2-002).
     */
    importReceipt(receipt: Receipt): Promise<Receipt>;

    /**
     * Archive events whose `timestamp < beforeTimestamp` to a sibling
     * ledger-archive file, removing them from the active store. Returns
     * counts plus the absolute path of the archive file (only when at
     * least one event was archived).
     *
     * STORES-B-013: pre-fix the active events array grew unbounded; long-
     * lived clusters paid O(N²) append cost (under the old whole-array
     * persist model) AND held the full history in memory. Rotation gives
     * operators a recovery valve while keeping the active file small.
     *
     * Semantics:
     *  - Boundary in the future: SAFEGUARDED no-op. Returns
     *    `{ archived: 0, retained: current.length }`. Archiving "everything
     *    up to a future date" is almost always a typo, so we refuse rather
     *    than silently archive the entire active ledger. Operators that
     *    truly want to archive everything should pass a boundary at or
     *    just after the newest event's timestamp.
     *  - Past timestamp: events strictly older than `beforeTimestamp` move
     *    into the archive file. Receipts behave the same way using
     *    {@link Receipt.committedAt} as the rotate boundary.
     *  - `trace()` does NOT read archived events — provenance chains that
     *    crossed the boundary truncate at the youngest unarchived event.
     *    This is intentional: rotation is a recovery operation, not a
     *    transparent compaction. Operators that need cross-archive
     *    lineage should restore the archive into a sibling cluster.
     *
     * Implementation hint: in-memory ledgers may treat this as a no-op
     * (`archived=0`); local adapters write a sibling NDJSON file under
     * `<dataDir>/ledger-archive/`. Postgres ledger does not exist today;
     * a future PostgresLedgerStore should implement rotation as a
     * `DELETE … WHERE timestamp < $1 RETURNING …` plus an
     * `INSERT INTO ledger_archive_events` round-trip in a transaction.
     */
    rotate(beforeTimestamp: string): Promise<RotateResult>;
}

/**
 * Result of {@link LedgerStore.rotate}. `archiveFile` is omitted when nothing
 * was archived (the archive file is not created until at least one event
 * crosses the boundary).
 */
export interface RotateResult {
    archived: number;
    retained: number;
    archiveFile?: string;
}

export interface LedgerFilter {
    subjectId?: string;
    action?: string;
    since?: string;
    limit?: number;
}

export interface ReceiptFilter {
    commandId?: string;
    since?: string;
    limit?: number;
}
