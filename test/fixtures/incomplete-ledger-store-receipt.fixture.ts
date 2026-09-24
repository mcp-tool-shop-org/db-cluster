/**
 * STORES-R2-002 negative type test fixture.
 *
 * A class that claims to implement LedgerStore but omits `importReceipt`
 * (it still has `importEvent`). See incomplete-canonical-store.fixture.ts
 * for the rationale.
 */

import type { LedgerStore } from '../../src/contracts/ledger-store.js';

export interface IncompleteLedgerStoreReceipt extends Omit<LedgerStore, 'importReceipt'> {}

// @ts-expect-error — class deliberately omits required `importReceipt`.
export class IncompleteLedgerStoreReceipt implements LedgerStore {}
