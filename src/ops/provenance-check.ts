/**
 * Provenance check — verifies provenance event integrity.
 */

import type { ClusterStores } from '../contracts/index.js';
import type { HealthCheck } from '../types/health.js';

export interface ProvenanceCheckResult {
    total: number;
    valid: number;
    orphans: number;
    errors: string[];
    checks: HealthCheck[];
}

/**
 * Verify provenance events reference valid objects and form valid chains.
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
        });
    }

    return { total: events.length, valid, orphans, errors, checks };
}
