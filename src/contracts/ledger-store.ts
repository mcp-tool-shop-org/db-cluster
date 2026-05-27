import type { ProvenanceEvent } from '../types/provenance-event.js';
import type { Receipt } from '../types/receipt.js';

/**
 * LedgerStore contract.
 * Owns: actions, links, mutations, receipts, lineage.
 * Append-only. No updates, no deletes (except via {@link rotate}).
 */
export interface LedgerStore {
    /**
     * Append a provenance event to the ledger and return the stamped record.
     *
     * Preconditions:
     *  - `event.action` is a non-empty string naming the lifecycle moment
     *    (e.g. `entity_created`, `mutation_committed`).
     *  - `event.subjectStore` is one of `'canonical' | 'artifact' | 'index' |
     *    'ledger'` and `subjectId` is the matching record id (if any).
     *  - `actorId` is the principal/system that emitted the event.
     *
     * Postconditions:
     *  - The returned ProvenanceEvent has `id` (UUID), `timestamp` (ISO-8601),
     *    and `owner='ledger'` stamped by the adapter. Caller-supplied values
     *    for those fields are IGNORED — the adapter rewrites them via the
     *    post-spread stamp pattern (closes STORES-B-021).
     *  - Persistence is durable before the promise resolves; NDJSON
     *    adapters append + fsync (STORES-B-002).
     *
     * Throws:
     *  - Adapter-level I/O errors (corrupt store, disk full, etc.) propagate.
     */
    append(event: Omit<ProvenanceEvent, 'id' | 'timestamp' | 'owner'>): Promise<ProvenanceEvent>;

    /**
     * Fetch a single provenance event by id, or `null` if absent.
     *
     * @param id  The event id stamped at `append` / `importEvent` time.
     * @returns   The matching event, or `null` if no event with that id
     *            exists in the active ledger (archived events are NOT
     *            visible — see {@link rotate}).
     */
    getEvent(id: string): Promise<ProvenanceEvent | null>;

    /**
     * List events matching the filter, in append order (oldest first).
     *
     * @param filter  Optional filter. `subjectId` narrows to events for a
     *                specific subject; `action` narrows to a specific
     *                lifecycle action; `since` narrows to events with
     *                `timestamp >= since`; `limit` caps the returned
     *                count (default: adapter-specific, typically 100).
     * @returns       Array of matching events. Empty array if no matches;
     *                never returns `null`.
     */
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
     *
     * @param filter  Same filter shape as {@link listEvents}.
     * @returns       Exact count of matching events. Never throws under
     *                normal conditions; adapter I/O failures propagate.
     */
    countEvents(filter?: LedgerFilter): Promise<number>;

    /**
     * Trace lineage: walk parent chain from a given event.
     *
     * Walks `parentEventId` from the supplied event back toward the root.
     * Stops at events whose `parentEventId` is null/missing. Detects cycles
     * (a tampered ledger where A → B → A) via the visited-set guard;
     * surfaces them as a {@link LedgerCycleDetectedError} rather than
     * looping forever (STORES-B-015).
     *
     * Archived events (post-rotation) are NOT walked — the chain truncates
     * at the youngest unarchived event. This is intentional; see
     * {@link rotate}.
     *
     * @param eventId  The leaf event id to start tracing from.
     * @returns        Array of events from leaf back toward root. Empty if
     *                 the leaf has no parent and is itself absent.
     * @throws         {@link LedgerCycleDetectedError} when the parent
     *                 chain revisits an id.
     */
    trace(eventId: string): Promise<ProvenanceEvent[]>;

    /**
     * Append a receipt for a committed command. Same stamp discipline as
     * {@link append}: caller-supplied `id`/`committedAt` are ignored; the
     * adapter stamps both via the post-spread pattern (STORES-B-004).
     *
     * Postconditions:
     *  - Returned Receipt has `id` (UUID) and `committedAt` (ISO-8601)
     *    stamped by the adapter.
     *  - Persistence durable before resolve.
     *
     * @param receipt Receipt body without `id` / `committedAt`.
     * @returns       The stamped Receipt.
     * @throws        Adapter I/O failures propagate.
     */
    appendReceipt(receipt: Omit<Receipt, 'id' | 'committedAt'>): Promise<Receipt>;

    /**
     * Fetch a single receipt by id, or `null` if absent.
     *
     * @param id  Receipt id stamped at append / import time.
     */
    getReceipt(id: string): Promise<Receipt | null>;

    /**
     * List receipts matching the filter, in append order.
     *
     * @param filter  Optional filter. `commandId` narrows to receipts for
     *                a specific command; `since` narrows by `committedAt`;
     *                `limit` caps count.
     */
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
     *
     * Preconditions:
     *  - `event.id` is a non-empty string (the original UUID from the
     *    source cluster).
     *  - `event.timestamp` is a parseable ISO-8601 string.
     *
     * Postconditions:
     *  - The returned event has `id` and `timestamp` exactly as supplied.
     *  - `owner='ledger'` is restamped by the adapter (the field is part
     *    of the store identity, not the event payload).
     *
     * @param event Full provenance event including its original `id`,
     *              `timestamp`, and `parentEventId`.
     * @returns     The stored event (with `owner='ledger'`).
     * @throws      {@link ImportConflictError} via assertContentMatch if
     *              an event with the same id already exists but with
     *              different content.
     */
    importEvent(event: ProvenanceEvent): Promise<ProvenanceEvent>;

    /**
     * Import a receipt preserving the original `id` and `committedAt`.
     * Same rationale as {@link importEvent} but for receipts.
     *
     * REQUIRED on the contract (STORES-R2-002).
     *
     * Preconditions:
     *  - `receipt.id` and `receipt.committedAt` are present and well-formed.
     *
     * Postconditions:
     *  - Returned receipt preserves `id` and `committedAt` verbatim.
     *
     * @throws  {@link ImportConflictError} on id collision with different content.
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
     *  - Boundary in the future: throws {@link RotateBoundaryInFutureError}.
     *    Archiving "everything up to a future date" is almost always a typo,
     *    so we refuse rather than silently archive the entire active ledger.
     *    Operators that truly want to archive everything should pass a
     *    boundary at or just after the newest event's timestamp.
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
     *
     * @param beforeTimestamp ISO-8601 datetime string. Events strictly
     *                        older than this move to the archive.
     * @returns               {@link RotateResult} with archived/retained
     *                        counts and the archive file path (when any
     *                        events were archived).
     * @throws                {@link InvalidRotateTimestampError} when the
     *                        timestamp fails `Date.parse()`;
     *                        {@link RotateBoundaryInFutureError} when the
     *                        boundary is in the future.
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
