/**
 * STORES-R2-002 negative type test fixture.
 *
 * A class that claims to implement LedgerStore but omits `importReceipt`
 * (it still implements `importEvent`). See incomplete-canonical-store.fixture.ts
 * for the rationale.
 */

import type {
    LedgerStore,
    LedgerFilter,
    ReceiptFilter,
} from '../../src/contracts/ledger-store.js';
import type { ProvenanceEvent } from '../../src/types/provenance-event.js';
import type { Receipt } from '../../src/types/receipt.js';

// @ts-expect-error — class deliberately omits required `importReceipt`.
export class IncompleteLedgerStoreReceipt implements LedgerStore {
    async append(_e: Omit<ProvenanceEvent, 'id' | 'timestamp' | 'owner'>): Promise<ProvenanceEvent> {
        throw new Error('not implemented');
    }
    async getEvent(_id: string): Promise<ProvenanceEvent | null> { return null; }
    async listEvents(_filter?: LedgerFilter): Promise<ProvenanceEvent[]> { return []; }
    async trace(_eventId: string): Promise<ProvenanceEvent[]> { return []; }

    async appendReceipt(_r: Omit<Receipt, 'id' | 'committedAt'>): Promise<Receipt> {
        throw new Error('not implemented');
    }
    async getReceipt(_id: string): Promise<Receipt | null> { return null; }
    async listReceipts(_filter?: ReceiptFilter): Promise<Receipt[]> { return []; }

    // importEvent present, importReceipt intentionally absent.
    async importEvent(event: ProvenanceEvent): Promise<ProvenanceEvent> {
        return event;
    }
}
