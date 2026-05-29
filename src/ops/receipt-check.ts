/**
 * Receipt check — verifies receipts reference valid provenance events.
 *
 * Wave S2-A1 (PROV-003/PROV-004): augmented from existence-only to
 * tamper-detecting. The pre-amend check only confirmed that a receipt's
 * `provenanceEventId` resolved to an existing event — it PASSED on a hand-edited
 * receipt. This version ALSO recomputes `computeIntegrityHash` on every stamped
 * receipt and compares it to the stored `integrityHash` (the single source of
 * truth in `src/types/integrity.ts`; NEVER hand-rolled here). A tampered receipt
 * makes the result NON-healthy. The existing `receipt_integrity` check + the
 * `{total, valid, orphans, errors, checks}` result shape are preserved; a new
 * `receipt_tamper_evidence` check is added.
 */

import type { ClusterStores } from '../contracts/index.js';
import type { HealthCheck } from '../types/health.js';
import type { Receipt } from '../types/receipt.js';
import { computeIntegrityHash } from '../types/integrity.js';

export interface ReceiptCheckResult {
    total: number;
    valid: number;
    orphans: number;
    errors: string[];
    checks: HealthCheck[];
}

/**
 * Verify receipts reference valid provenance events AND are tamper-free.
 *
 * @param stores  ClusterStores bundle. Reads ledger.listReceipts +
 *                ledger.getEvent. Never mutates state.
 * @param options Optional knobs. `limit` caps how many receipts are sampled
 *                (default 200).
 * @returns       {@link ReceiptCheckResult} carrying total/valid/orphans
 *                counts plus per-orphan error strings and a structured
 *                HealthCheck[] surface (existence + tamper-evidence checks).
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

    // Wave S2-A1 (PROV-004): tamper-evidence. Recompute the integrity hash on
    // every stamped receipt. Un-stamped receipts (pre-tamper-evidence ledger)
    // are skipped so we never raise a false alarm.
    const tamperErrors = collectReceiptTamperErrors(receipts);
    if (tamperErrors.length > 0) {
        for (const e of tamperErrors) errors.push(e);
        checks.push({
            name: 'receipt_tamper_evidence',
            store: 'ledger',
            status: 'corrupt',
            severity: 'error',
            message:
                `${tamperErrors.length} receipt(s) failed tamper-evidence verification: their stored integrityHash ` +
                `does not match the recomputed hash. The receipts were edited after being written.`,
            repairAvailable: false,
            suggestedCommand: 'db-cluster restore <backup.json>',
            details: tamperErrors.slice(0, 10).join('\n'),
            nextSteps: [
                'The append-only receipt ledger has been hand-edited.',
                'Inspect receipts.json for altered records.',
                'Restore from a known-good backup (`db-cluster restore <backup.json>`).',
            ],
        });
    }

    return { total: receipts.length, valid, orphans, errors, checks };
}

/**
 * Recompute `computeIntegrityHash` for each stamped receipt and return a
 * violation string per mismatch. Un-stamped receipts are skipped.
 */
function collectReceiptTamperErrors(receipts: Receipt[]): string[] {
    const out: string[] = [];
    for (const receipt of receipts) {
        const stored = receipt.integrityHash;
        if (typeof stored !== 'string' || stored.length === 0) continue;
        const recomputed = computeIntegrityHash(receipt as unknown as Record<string, unknown>);
        if (recomputed !== stored) {
            out.push(
                `Receipt ${receipt.id} failed integrity check: stored integrityHash does not match recomputed ` +
                    `hash (the record content was tampered with).`,
            );
        }
    }
    return out;
}
