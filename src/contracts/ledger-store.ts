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
