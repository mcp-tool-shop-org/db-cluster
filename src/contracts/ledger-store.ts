import type { ProvenanceEvent } from '../types/provenance-event.js';
import type { Receipt } from '../types/receipt.js';

/**
 * LedgerStore contract.
 * Owns: actions, links, mutations, receipts, lineage.
 * Append-only. No updates, no deletes.
 */
export interface LedgerStore {
    append(event: Omit<ProvenanceEvent, 'id' | 'timestamp' | 'owner'>): Promise<ProvenanceEvent>;
    getEvent(id: string): Promise<ProvenanceEvent | null>;
    listEvents(filter?: LedgerFilter): Promise<ProvenanceEvent[]>;
    /** Trace lineage: walk parent chain from a given event. */
    trace(eventId: string): Promise<ProvenanceEvent[]>;

    appendReceipt(receipt: Omit<Receipt, 'id' | 'committedAt'>): Promise<Receipt>;
    getReceipt(id: string): Promise<Receipt | null>;
    listReceipts(filter?: ReceiptFilter): Promise<Receipt[]>;

    /**
     * Import an event preserving the original `id` and `timestamp`.
     * Used by backup/restore — STORES-002 requires this so re-running restore
     * is idempotent (otherwise every run inserts new copies under fresh UUIDs).
     */
    importEvent?(event: ProvenanceEvent): Promise<ProvenanceEvent>;

    /**
     * Import a receipt preserving the original `id` and `committedAt`.
     * Same rationale as {@link importEvent} but for receipts.
     */
    importReceipt?(receipt: Receipt): Promise<Receipt>;
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
