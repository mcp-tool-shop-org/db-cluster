/**
 * STORES-R2-002 negative type test fixture.
 *
 * A class that claims to implement LedgerStore but omits `importEvent` (it
 * still has `importReceipt`). See incomplete-canonical-store.fixture.ts
 * for the rationale.
 */

import type { LedgerStore } from '../../src/contracts/ledger-store.js';

export interface IncompleteLedgerStoreEvent extends Omit<LedgerStore, 'importEvent'> {}

// @ts-expect-error — class deliberately omits required `importEvent`.
export class IncompleteLedgerStoreEvent implements LedgerStore {}
