/**
 * Verify — proves cluster invariants hold.
 * Unlike doctor (reachability/health), verify checks data consistency.
 */

import type { ClusterStores } from '../contracts/index.js';
import type { HealthCheck } from '../types/health.js';
import { buildClusterHealth } from './health.js';
import type { ClusterHealth } from '../types/health.js';

export interface VerifyOptions {
    /** Max records to sample per store (default: 100) */
    sampleLimit?: number;
}

export async function verify(stores: ClusterStores, options?: VerifyOptions): Promise<ClusterHealth> {
    const limit = options?.sampleLimit ?? 100;
    const checks: HealthCheck[] = [];

    // --- Index records resolve to owner truth ---
    try {
        const records = await stores.index.search({ limit });
        let staleCount = 0;
        let missingCount = 0;

        for (const record of records) {
            if (record.sourceStore === 'canonical') {
                const exists = await stores.canonical.exists(record.sourceId);
                if (!exists) {
                    missingCount++;
                }
            } else if (record.sourceStore === 'artifact') {
                const exists = await stores.artifact.exists(record.sourceId);
                if (!exists) {
                    missingCount++;
                }
            }
        }

        // Check staleness for canonical entities
        const entities = await stores.canonical.list({ limit });
        for (const entity of entities) {
            const expectedText = `${entity.kind}: ${entity.name}`;
            const indexResults = await stores.index.search({ text: expectedText, limit: 1 });
            const match = indexResults.find((r) => r.sourceId === entity.id);
            if (!match) {
                staleCount++;
            }
        }

        if (missingCount > 0) {
            checks.push({
                name: 'index_references_valid',
                store: 'index',
                status: 'corrupt',
                severity: 'error',
                message: `${missingCount} index record(s) reference non-existent source objects.`,
                repairAvailable: true,
                suggestedCommand: 'db-cluster rebuild index',
            });
        } else if (staleCount > 0) {
            checks.push({
                name: 'index_references_valid',
                store: 'index',
                status: 'stale',
                severity: 'warning',
                message: `${staleCount} entity/artifact(s) not found in index. Index may need rebuild.`,
                repairAvailable: true,
                suggestedCommand: 'db-cluster rebuild index',
            });
        } else {
            checks.push({
                name: 'index_references_valid',
                store: 'index',
                status: 'healthy',
                severity: 'info',
                message: `All sampled index records resolve to existing source objects.`,
                repairAvailable: false,
            });
        }
    } catch (err: any) {
        checks.push({
            name: 'index_references_valid',
            store: 'index',
            status: 'unreachable',
            severity: 'error',
            message: `Index verification failed: ${err.message}`,
            repairAvailable: false,
        });
    }

    // --- Provenance events reference existing objects ---
    // KERNEL-R2-002 alignment: only canonical/artifact-subject events are
    // checked here. Events with subjectStore='ledger' or 'index' reference
    // command/index IDs by design — their reachability is not verifiable
    // via canonical/artifact.exists. The pre-fix code iterated all events
    // and false-flagged every command_approved / command_rejected /
    // mutation_orphaned / command_compensated event as an orphan because
    // their subjectId is a command UUID never present in canonical or
    // artifact. That made verify() report 'stale' for any cluster that
    // had ever approved or rejected a command.
    try {
        const events = await stores.ledger.listEvents({ limit });
        let orphanCount = 0;

        for (const event of events) {
            // Only canonical- and artifact-subject events are verifiable
            // via store.exists(). Ledger- and index-subject events reference
            // commandIds / indexIds whose reachability is not modelled by
            // the canonical/artifact stores.
            if (event.subjectStore !== 'canonical' && event.subjectStore !== 'artifact') {
                continue;
            }
            if (event.subjectId) {
                const inCanonical = await stores.canonical.exists(event.subjectId);
                const inArtifact = await stores.artifact.exists(event.subjectId);
                if (!inCanonical && !inArtifact) {
                    orphanCount++;
                }
            }
        }

        if (orphanCount > 0) {
            checks.push({
                name: 'provenance_references_valid',
                store: 'ledger',
                status: 'stale',
                severity: 'warning',
                message: `${orphanCount} provenance event(s) reference objects not found in canonical/artifact stores.`,
                repairAvailable: false,
            });
        } else {
            checks.push({
                name: 'provenance_references_valid',
                store: 'ledger',
                status: 'healthy',
                severity: 'info',
                message: 'All sampled provenance events reference existing objects.',
                repairAvailable: false,
            });
        }
    } catch (err: any) {
        checks.push({
            name: 'provenance_references_valid',
            store: 'ledger',
            status: 'unreachable',
            severity: 'error',
            message: `Provenance verification failed: ${err.message}`,
            repairAvailable: false,
        });
    }

    // --- No orphaned mutations (STORES-R2-003) ---
    // Wave A2 added mutation_orphaned events on receipt failure (KERNEL-R009)
    // but verify()/doctor() had no consumer for that signal. A cluster with
    // orphaned mutations reported healthy. This check surfaces the orphans.
    try {
        const orphanedEvents = await stores.ledger.listEvents({ action: 'mutation_orphaned', limit });
        const orphanCount = orphanedEvents.length;

        if (orphanCount > 0) {
            checks.push({
                name: 'no_orphaned_mutations',
                store: 'ledger',
                status: 'degraded',
                severity: 'warning',
                message: `${orphanCount} orphaned mutation event(s) recorded. A mutation completed against a store but its receipt write failed — the cluster has uninspectable state.`,
                repairAvailable: false,
            });
        } else {
            checks.push({
                name: 'no_orphaned_mutations',
                store: 'ledger',
                status: 'healthy',
                severity: 'info',
                message: 'No orphaned mutation events recorded.',
                repairAvailable: false,
            });
        }
    } catch (err: any) {
        checks.push({
            name: 'no_orphaned_mutations',
            store: 'ledger',
            status: 'unreachable',
            severity: 'error',
            message: `Orphan verification failed: ${err.message}`,
            repairAvailable: false,
        });
    }

    // --- Receipts reference commands ---
    try {
        const receipts = await stores.ledger.listReceipts({ limit });
        let missingEventCount = 0;

        for (const receipt of receipts) {
            if (receipt.provenanceEventId) {
                const event = await stores.ledger.getEvent(receipt.provenanceEventId);
                if (!event) {
                    missingEventCount++;
                }
            }
        }

        if (missingEventCount > 0) {
            checks.push({
                name: 'receipts_provenance_valid',
                store: 'ledger',
                status: 'stale',
                severity: 'warning',
                message: `${missingEventCount} receipt(s) reference missing provenance events.`,
                repairAvailable: false,
            });
        } else {
            checks.push({
                name: 'receipts_provenance_valid',
                store: 'ledger',
                status: 'healthy',
                severity: 'info',
                message: 'All sampled receipts reference existing provenance events.',
                repairAvailable: false,
            });
        }
    } catch (err: any) {
        checks.push({
            name: 'receipts_provenance_valid',
            store: 'ledger',
            status: 'unreachable',
            severity: 'error',
            message: `Receipt verification failed: ${err.message}`,
            repairAvailable: false,
        });
    }

    return buildClusterHealth(checks);
}
