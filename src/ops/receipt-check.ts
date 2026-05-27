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
 *
 * @param stores  ClusterStores bundle. Reads ledger.listReceipts +
 *                ledger.getEvent. Never mutates state.
 * @param options Optional knobs. `limit` caps how many receipts are sampled
 *                (default 200).
 * @returns       {@link ReceiptCheckResult} carrying total/valid/orphans
 *                counts plus per-orphan error strings and a structured
 *                HealthCheck[] surface.
 * @throws        Adapter-level exceptions from ledger.listReceipts /
 *                ledger.getEvent propagate.
 *
 * @example
 *   const result = await checkReceipts(stores);
 *   if (result.orphans > 0) {
 *       for (const e of result.errors) console.error(e);
 *   }
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
            // Wave C1-Amend fix-up (V1-C1-005): suggestedCommand for
            // doctor footer "Top fix" surfacing.
            suggestedCommand: 'db-cluster receipts',
            nextSteps: [
                'Run `db-cluster receipts` to inspect the affected receipts.',
                'Run `db-cluster trace <eventId>` for the missing provenance events.',
            ],
        });
    }

    return { total: receipts.length, valid, orphans, errors, checks };
}
