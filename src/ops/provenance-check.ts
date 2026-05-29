/**
 * Provenance check — verifies provenance event integrity.
 *
 * Wave S2-A1 (PROV-003/PROV-004): augmented from existence-only to
 * tamper-detecting. The pre-amend check only confirmed that an event's
 * `subjectId` resolved to an existing canonical/artifact record — it PASSED on
 * a hand-edited event. This version ALSO recomputes `computeIntegrityHash` on
 * every stamped event and compares it to the stored `integrityHash` (the single
 * source of truth in `src/types/integrity.ts`; NEVER hand-rolled here). A
 * tampered event makes the result NON-healthy. The existing
 * `provenance_integrity` check + the `{total, valid, orphans, errors, checks}`
 * result shape are preserved; a new `provenance_tamper_evidence` check is added.
 */

import type { ClusterStores } from '../contracts/index.js';
import type { HealthCheck } from '../types/health.js';
import type { ProvenanceEvent } from '../types/provenance-event.js';
import { computeIntegrityHash } from '../types/integrity.js';

export interface ProvenanceCheckResult {
    total: number;
    valid: number;
    orphans: number;
    errors: string[];
    checks: HealthCheck[];
}

/**
 * Verify provenance events reference valid objects AND are tamper-free.
 *
 * @param stores  ClusterStores bundle. Reads ledger.listEvents + canonical.exists
 *                + artifact.exists. Never mutates state.
 * @param options Optional knobs. `limit` caps how many events are sampled
 *                (default 200).
 * @returns       {@link ProvenanceCheckResult} carrying total/valid/orphans
 *                counts plus per-orphan error strings and a structured
 *                HealthCheck[] surface (existence + tamper-evidence checks).
 * @throws        Adapter-level exceptions from ledger.listEvents propagate.
 *
 * @example
 *   const result = await checkProvenance(stores);
 *   if (result.orphans > 0) {
 *       for (const e of result.errors) console.error(e);
 *   }
 */
export async function checkProvenance(stores: ClusterStores, options?: { limit?: number }): Promise<ProvenanceCheckResult> {
    const limit = options?.limit ?? 200;
    const events = await stores.ledger.listEvents({ limit });
    let valid = 0;
    let orphans = 0;
    const errors: string[] = [];

    for (const event of events) {
        if (!event.subjectId) {
            valid++;
            continue;
        }

        const inCanonical = await stores.canonical.exists(event.subjectId);
        const inArtifact = await stores.artifact.exists(event.subjectId);

        if (inCanonical || inArtifact) {
            valid++;
        } else {
            orphans++;
            errors.push(`Provenance event ${event.id} references unknown subject ${event.subjectId}`);
        }
    }

    const checks: HealthCheck[] = [];
    if (orphans === 0) {
        checks.push({
            name: 'provenance_integrity',
            store: 'ledger',
            status: 'healthy',
            severity: 'info',
            message: `All ${valid} provenance events reference valid subjects.`,
            repairAvailable: false,
        });
    } else {
        checks.push({
            name: 'provenance_integrity',
            store: 'ledger',
            status: 'stale',
            severity: 'warning',
            message: `${orphans}/${events.length} provenance event(s) reference missing subjects.`,
            repairAvailable: false,
            // Wave C1-Amend fix-up (V1-C1-005): suggestedCommand for
            // doctor footer "Top fix" surfacing.
            suggestedCommand: 'db-cluster verify --json',
            nextSteps: [
                'Run `db-cluster trace <subjectId>` for the affected events to inspect lineage.',
                'Reconcile by either restoring the missing canonical/artifact records or removing the stale provenance events.',
            ],
        });
    }

    // Wave S2-A1 (PROV-004): tamper-evidence. Recompute the integrity hash on
    // every stamped event. Un-stamped events (pre-tamper-evidence ledger) are
    // skipped so we never raise a false alarm.
    const tamperErrors = collectEventTamperErrors(events);
    if (tamperErrors.length > 0) {
        for (const e of tamperErrors) errors.push(e);
        checks.push({
            name: 'provenance_tamper_evidence',
            store: 'ledger',
            status: 'corrupt',
            severity: 'error',
            message:
                `${tamperErrors.length} provenance event(s) failed tamper-evidence verification: their stored ` +
                `integrityHash does not match the recomputed hash. The events were edited after being written.`,
            repairAvailable: false,
            suggestedCommand: 'db-cluster restore <backup.json>',
            details: tamperErrors.slice(0, 10).join('\n'),
            nextSteps: [
                'The append-only event ledger has been hand-edited.',
                'Inspect events.json for altered records.',
                'Restore from a known-good backup (`db-cluster restore <backup.json>`).',
            ],
        });
    }

    return { total: events.length, valid, orphans, errors, checks };
}

/**
 * Recompute `computeIntegrityHash` for each stamped event and return a
 * violation string per mismatch. Un-stamped events are skipped.
 */
function collectEventTamperErrors(events: ProvenanceEvent[]): string[] {
    const out: string[] = [];
    for (const event of events) {
        const stored = event.integrityHash;
        if (typeof stored !== 'string' || stored.length === 0) continue;
        const recomputed = computeIntegrityHash(event as unknown as Record<string, unknown>);
        if (recomputed !== stored) {
            out.push(
                `Provenance event ${event.id} failed integrity check: stored integrityHash does not match ` +
                    `recomputed hash (the record content was tampered with).`,
            );
        }
    }
    return out;
}
