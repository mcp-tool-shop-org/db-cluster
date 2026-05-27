/**
 * STORES-R2-002 negative type test fixture.
 *
 * A class that claims to implement LedgerStore but omits `importEvent` (it
 * still implements `importReceipt`). See incomplete-canonical-store.fixture.ts
 * for the rationale.
 */

import type {
    LedgerStore,
    LedgerFilter,
    ReceiptFilter,
} from '../../src/contracts/ledger-store.js';
import type { ProvenanceEvent } from '../../src/types/provenance-event.js';
import type { Receipt } from '../../src/types/receipt.js';

// @ts-expect-error — class deliberately omits required `importEvent`.
export class IncompleteLedgerStoreEvent implements LedgerStore {
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

    // importReceipt present, importEvent intentionally absent.
    async importReceipt(receipt: Receipt): Promise<Receipt> {
        return receipt;
    }
}
