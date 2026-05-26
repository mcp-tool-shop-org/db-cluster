/**
 * Receipt check — verifies receipts reference valid provenance events.
 */

import type { ClusterStores } from '../contracts/index.js';
import type { HealthCheck } from '../types/health.js';

export interface ReceiptCheckResult {
    total: number;
    valid: number;
    orphans: number;
    errors: string[];
    checks: HealthCheck[];
}

/**
 * Verify receipts reference valid provenance events.
 */
export async function checkReceipts(stores: ClusterStores, options?: { limit?: number }): Promise<ReceiptCheckResult> {
    const limit = options?.limit ?? 200;
    const receipts = await stores.ledger.listReceipts({ limit });
    let valid = 0;
    let orphans = 0;
    const errors: string[] = [];

    for (const receipt of receipts) {
        if (!receipt.provenanceEventId) {
            valid++;
            continue;
        }

        const event = await stores.ledger.getEvent(receipt.provenanceEventId);
        if (event) {
            valid++;
        } else {
            orphans++;
            errors.push(`Receipt ${receipt.id} references missing provenance event ${receipt.provenanceEventId}`);
        }
    }

    const checks: HealthCheck[] = [];
    if (orphans === 0) {
        checks.push({
            name: 'receipt_integrity',
            store: 'ledger',
            status: 'healthy',
            severity: 'info',
            message: `All ${valid} receipts reference valid provenance events.`,
            repairAvailable: false,
        });
    } else {
        checks.push({
            name: 'receipt_integrity',
            store: 'ledger',
            status: 'stale',
            severity: 'warning',
            message: `${orphans}/${receipts.length} receipt(s) reference missing provenance events.`,
            repairAvailable: false,
        });
    }

    return { total: receipts.length, valid, orphans, errors, checks };
}
