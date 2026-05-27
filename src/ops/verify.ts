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
    /**
     * Progress callback (STORES-C-002). Fired between major verify steps
     * (index references / provenance references / orphan mutations /
     * receipt provenance). `total` is the count of major checks.
     *
     * Optional — operators running `verify` against large clusters subscribe
     * to render a progress bar via the CLI.
     */
    onProgress?: (current: number, total: number, message?: string) => void;
}

/**
 * Run cluster-invariant verification — proves canonical/artifact/index/ledger
 * consistency rather than reachability. Read-only; never mutates cluster
 * state. Every check carrying `repairAvailable: true` ALSO carries
 * {@link HealthCheck.suggestedCommand} so operator-facing surfaces can render
 * `→ fix: ${cmd}` without conditional branching.
 *
 * Checks performed (in order):
 *   1. Index records resolve to owner truth — flag corrupt/stale index.
 *   2. Provenance events reference existing canonical/artifact subjects.
 *   3. Orphaned mutations — surfaces `mutation_orphaned` ledger events.
 *   4. Receipts reference existing provenance events.
 *
 * @param stores  ClusterStores bundle. Verify reads from each store via
 *                its public contract methods (search, list, exists, get).
 * @param options Verify-specific knobs. See {@link VerifyOptions}.
 * @returns       A {@link ClusterHealth} summarizing all checks.
 * @throws        Verify itself does not throw. Adapter-level exceptions are
 *                caught and surfaced as `unreachable` checks.
 *
 * @example
 *   const health = await verify(stores, { sampleLimit: 500 });
 *   if (health.status !== 'healthy') {
 *       for (const check of health.checks) {
 *           if (check.status !== 'healthy') console.error(check.message);
 *           if (check.suggestedCommand) console.error(`  → fix: ${check.suggestedCommand}`);
 *       }
 *   }
 */
export async function verify(stores: ClusterStores, options?: VerifyOptions): Promise<ClusterHealth> {
    const limit = options?.sampleLimit ?? 100;
    const checks: HealthCheck[] = [];
    const onProgress = options?.onProgress;
    const totalSteps = 4;
    let step = 0;
    const tick = (label: string) => {
        step++;
        try {
            onProgress?.(step, totalSteps, label);
        } catch {
            // Best-effort.
        }
    };

    // --- Index records resolve to owner truth ---
    tick('index_references_valid');
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
                nextSteps: [
                    'Run `db-cluster rebuild index --dry-run` to inspect the rebuild plan.',
                    'Then run `db-cluster rebuild index` to reconstruct the index from owner truth.',
                    'Run `db-cluster verify` again after rebuild to confirm the count drops to zero.',
                ],
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
                nextSteps: [
                    'Run `db-cluster rebuild index --dry-run` to inspect the rebuild plan.',
                    'Then run `db-cluster rebuild index` to bring the index back in sync with owner truth.',
                ],
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
            nextSteps: [
                'Inspect the index file under the cluster data directory.',
                'Run `db-cluster doctor` to confirm store reachability.',
            ],
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
    tick('provenance_references_valid');
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
                // Wave C1-Amend fix-up (V1-C1-005): every HealthCheck
                // producer that has actionable nextSteps SHOULD also
                // populate `suggestedCommand` so the doctor footer's
                // "Top fix" line can surface a concrete one-liner.
                suggestedCommand: 'db-cluster verify --json',
                nextSteps: [
                    'Run `db-cluster trace <subjectId>` for the affected subjects to inspect lineage.',
                    'Reconcile by either restoring the missing canonical/artifact records or removing the stale provenance events from the ledger.',
                ],
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
            nextSteps: [
                'Inspect the ledger events.json file for corruption.',
            ],
        });
    }

    // --- No orphaned mutations (STORES-R2-003) ---
    // Wave A2 added mutation_orphaned events on receipt failure (KERNEL-R009)
    // but verify()/doctor() had no consumer for that signal. A cluster with
    // orphaned mutations reported healthy. This check surfaces the orphans.
    //
    // STORES-B-014: pre-fix this used the `limit` option (default 100) to
    // bound listEvents AND to derive the orphan count via
    // `orphanedEvents.length`. The cap silently truncated the headline
    // number; ops dashboards reported "100 orphaned" even at 500. Post-fix
    // we use `countEvents` for the true number and only sample for the
    // (unused-today, but bounded) display set.
    //
    // STORES-C-001 (Stage C Wave C1-Audit): pre-fix this check produced
    // `repairAvailable: false` AND no suggestedCommand AND no nextSteps.
    // Post-fix it carries both.
    tick('no_orphaned_mutations');
    try {
        const orphanCount = await stores.ledger.countEvents({
            action: 'mutation_orphaned',
        });
        // Keep the sample-fetch bounded so callers that override `limit`
        // still control memory pressure during verify().
        await stores.ledger.listEvents({
            action: 'mutation_orphaned',
            limit,
        });

        if (orphanCount > 0) {
            const capped = orphanCount > limit;
            const suffix = capped ? ` (showing first ${limit})` : '';
            checks.push({
                name: 'no_orphaned_mutations',
                store: 'ledger',
                status: 'degraded',
                severity: 'warning',
                message: `${orphanCount} orphaned mutation event(s) recorded${suffix}. A mutation completed against a store but its receipt write failed — the cluster has uninspectable state.`,
                repairAvailable: false,
                suggestedCommand: 'db-cluster verify',
                nextSteps: [
                    'For each orphan, run `db-cluster trace <subjectId>` to inspect the lineage.',
                    'Run `db-cluster receipts --limit 200` to confirm whether matching receipts are present or missing.',
                    'If receipts are missing, inspect logs around the original `mutation_orphaned` event timestamps to find the cause.',
                    'Restore from a backup taken before the mutation_orphaned event timestamps if the orphan state is unrecoverable.',
                ],
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
            nextSteps: [
                'Inspect the ledger events.json file for corruption.',
                'Run `db-cluster doctor` to confirm ledger reachability.',
            ],
        });
    }

    // --- Receipts reference commands ---
    tick('receipts_provenance_valid');
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
                // Wave C1-Amend fix-up (V1-C1-005): suggestedCommand
                // populated so doctor footer surfaces a concrete next
                // command.
                suggestedCommand: 'db-cluster receipts',
                nextSteps: [
                    'Run `db-cluster receipts` to inspect the affected receipts.',
                    'Run `db-cluster trace <eventId>` for the missing provenance events to find the lineage gap.',
                ],
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
            nextSteps: [
                'Inspect the ledger receipts.json file for corruption.',
            ],
        });
    }

    return buildClusterHealth(checks);
}
