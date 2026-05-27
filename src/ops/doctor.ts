/**
 * Doctor — diagnoses cluster health by running all checks.
 * Does not mutate state. Reports findings with suggested repairs.
 */

import type { ClusterStores } from '../contracts/index.js';
import type { ClusterHealth, HealthCheck } from '../types/health.js';
import { buildClusterHealth } from './health.js';

export interface DoctorOptions {
    /** Postgres pool for backend checks (optional) */
    postgresPool?: { query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }> };
}

export async function doctor(stores: ClusterStores, options?: DoctorOptions): Promise<ClusterHealth> {
    const checks: HealthCheck[] = [];

    // --- Canonical store reachability ---
    try {
        await stores.canonical.list({ limit: 1 });
        checks.push({
            name: 'canonical_reachable',
            store: 'canonical',
            status: 'healthy',
            severity: 'info',
            message: 'Canonical store is reachable.',
            repairAvailable: false,
        });
    } catch (err: any) {
        checks.push({
            name: 'canonical_reachable',
            store: 'canonical',
            status: 'unreachable',
            severity: 'error',
            message: `Canonical store unreachable: ${err.message}`,
            repairAvailable: false,
        });
    }

    // --- Artifact store reachability ---
    try {
        await stores.artifact.list({ limit: 1 });
        checks.push({
            name: 'artifact_reachable',
            store: 'artifact',
            status: 'healthy',
            severity: 'info',
            message: 'Artifact store is reachable.',
            repairAvailable: false,
        });
    } catch (err: any) {
        checks.push({
            name: 'artifact_reachable',
            store: 'artifact',
            status: 'unreachable',
            severity: 'error',
            message: `Artifact store unreachable: ${err.message}`,
            repairAvailable: false,
        });
    }

    // --- Index store reachability ---
    try {
        await stores.index.count();
        checks.push({
            name: 'index_reachable',
            store: 'index',
            status: 'healthy',
            severity: 'info',
            message: 'Index store is reachable.',
            repairAvailable: false,
        });
    } catch (err: any) {
        checks.push({
            name: 'index_reachable',
            store: 'index',
            status: 'unreachable',
            severity: 'error',
            message: `Index store unreachable: ${err.message}`,
            repairAvailable: false,
        });
    }

    // --- Ledger store reachability ---
    try {
        await stores.ledger.listEvents({ limit: 1 });
        checks.push({
            name: 'ledger_reachable',
            store: 'ledger',
            status: 'healthy',
            severity: 'info',
            message: 'Ledger store is reachable.',
            repairAvailable: false,
        });
    } catch (err: any) {
        checks.push({
            name: 'ledger_reachable',
            store: 'ledger',
            status: 'unreachable',
            severity: 'error',
            message: `Ledger store unreachable: ${err.message}`,
            repairAvailable: false,
        });
    }

    // --- Index staleness check ---
    try {
        const indexCount = await stores.index.count();
        if (indexCount === 0) {
            const entities = await stores.canonical.list({ limit: 1 });
            const artifacts = await stores.artifact.list({ limit: 1 });
            if (entities.length > 0 || artifacts.length > 0) {
                checks.push({
                    name: 'index_populated',
                    store: 'index',
                    status: 'degraded',
                    severity: 'warning',
                    message: 'Index is empty but canonical/artifact stores have records. Index needs rebuild.',
                    repairAvailable: true,
                    suggestedCommand: 'db-cluster rebuild index',
                });
            } else {
                checks.push({
                    name: 'index_populated',
                    store: 'index',
                    status: 'healthy',
                    severity: 'info',
                    message: 'Index is empty (cluster has no data yet).',
                    repairAvailable: false,
                });
            }
        } else {
            checks.push({
                name: 'index_populated',
                store: 'index',
                status: 'healthy',
                severity: 'info',
                message: `Index contains ${indexCount} records.`,
                repairAvailable: false,
            });
        }
    } catch {
        // Already caught by reachability
    }

    // --- Postgres migration check ---
    if (options?.postgresPool) {
        try {
            const result = await options.postgresPool.query(
                `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'canonical_entities') AS exists`,
            );
            const exists = (result.rows[0] as any).exists;
            if (exists) {
                checks.push({
                    name: 'postgres_migration',
                    store: 'migration',
                    status: 'healthy',
                    severity: 'info',
                    message: 'Postgres canonical_entities table exists.',
                    repairAvailable: false,
                });
            } else {
                checks.push({
                    name: 'postgres_migration',
                    store: 'migration',
                    status: 'missing',
                    severity: 'error',
                    message: 'Postgres canonical_entities table not found. Migrations not run.',
                    repairAvailable: true,
                    suggestedCommand: 'db-cluster stores migrate',
                });
            }
        } catch (err: any) {
            checks.push({
                name: 'postgres_migration',
                store: 'migration',
                status: 'unreachable',
                severity: 'error',
                message: `Postgres health check failed: ${err.message}`,
                repairAvailable: false,
            });
        }
    }

    // --- Policy defaults loadable ---
    try {
        const { DEFAULT_POLICIES } = await import('../policy/default-policies.js');
        if (DEFAULT_POLICIES.length > 0) {
            checks.push({
                name: 'policy_defaults',
                store: 'policy',
                status: 'healthy',
                severity: 'info',
                message: `Policy engine loaded ${DEFAULT_POLICIES.length} default policies.`,
                repairAvailable: false,
            });
        }
    } catch (err: any) {
        checks.push({
            name: 'policy_defaults',
            store: 'policy',
            status: 'corrupt',
            severity: 'error',
            message: `Failed to load policy defaults: ${err.message}`,
            repairAvailable: false,
        });
    }

    // --- No orphaned mutations (V1-007 fix-up — STORES-R2-003 mirror) ---
    // Wave A2 added mutation_orphaned events on receipt failure (KERNEL-R009).
    // verify() consumes the signal at src/ops/verify.ts:154-189 but doctor()
    // had no consumer — the wave-edited comment at cluster-kernel.ts:322-329
    // promises "doctor()/verify() can flag it" but doctor.ts had zero
    // matches for mutation_orphaned. A cluster with orphaned mutations
    // reported healthy through doctor(). This check mirrors verify()'s
    // pattern so both ops surfaces see the orphan signal.
    try {
        const orphanedEvents = await stores.ledger.listEvents({ action: 'mutation_orphaned', limit: 100 });
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
            message: `Orphan check failed: ${err.message}`,
            repairAvailable: false,
        });
    }

    return buildClusterHealth(checks);
}
