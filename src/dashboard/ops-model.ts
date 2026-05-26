/**
 * Operations model — shaped health data for the dashboard ops panel.
 *
 * Consumes kernel doctor/verify/indexStatus outputs.
 * Never reads raw adapter stores.
 */

import type { ClusterStores } from '../contracts/index.js';
import { doctor } from '../ops/doctor.js';

export type HealthLevel = 'healthy' | 'degraded' | 'unhealthy' | 'unknown';

export interface StoreHealth {
    store: string;
    status: HealthLevel;
    message: string;
}

export interface IndexHealth {
    total: number;
    fresh: number;
    stale: number;
    missing: number;
}

export interface ProvenanceHealth {
    totalEvents: number;
    totalReceipts: number;
}

export interface ArtifactIntegrity {
    total: number;
    verified: number;
    corrupt: number;
}

export interface RepairSuggestion {
    action: string;
    command: string;
    description: string;
    severity: 'info' | 'warn' | 'error';
}

export interface OpsModel {
    overall: HealthLevel;
    stores: StoreHealth[];
    indexHealth: IndexHealth;
    provenanceHealth: ProvenanceHealth;
    artifactIntegrity: ArtifactIntegrity;
    repairSuggestions: RepairSuggestion[];
    lastChecked: string;
}

/**
 * Build ops model from kernel surfaces.
 */
export async function buildOpsModel(
    stores: ClusterStores,
    kernel: { indexStatus(): Promise<any>; listStaleRecords(): Promise<any[]>; listReceipts(filter?: any): Promise<any[]> },
): Promise<OpsModel> {
    const health = await doctor(stores);
    const indexStatus = await kernel.indexStatus();
    const staleRecords = await kernel.listStaleRecords();
    const receipts = await kernel.listReceipts({ limit: 1000 });

    // Map store checks
    const storeChecks: StoreHealth[] = health.checks
        .filter((c) => c.name.endsWith('_reachable'))
        .map((c) => ({
            store: c.store ?? c.name.replace('_reachable', ''),
            status: c.status === 'healthy' ? 'healthy' as const : 'unhealthy' as const,
            message: c.message,
        }));

    // Index health
    const indexHealth: IndexHealth = {
        total: indexStatus.totalRecords ?? 0,
        fresh: (indexStatus.totalRecords ?? 0) - staleRecords.length,
        stale: staleRecords.length,
        missing: indexStatus.missingRecords ?? 0,
    };

    // Artifact integrity (from doctor checks)
    const artifactChecks = health.checks.filter((c) => c.name.includes('artifact'));
    const artifactIntegrity: ArtifactIntegrity = {
        total: artifactChecks.length > 0 ? 1 : 0,
        verified: artifactChecks.filter((c) => c.status === 'healthy').length > 0 ? 1 : 0,
        corrupt: 0,
    };

    // Build repair suggestions
    const repairSuggestions: RepairSuggestion[] = [];
    if (staleRecords.length > 0) {
        repairSuggestions.push({
            action: 'rebuild_index',
            command: 'db-cluster reindex',
            description: `${staleRecords.length} stale index record(s) detected`,
            severity: 'warn',
        });
    }
    for (const check of health.checks) {
        if (check.status !== 'healthy' && check.repairAvailable) {
            repairSuggestions.push({
                action: `repair_${check.name}`,
                command: `db-cluster doctor --repair`,
                description: check.message,
                severity: check.severity === 'error' ? 'error' : 'warn',
            });
        }
    }

    // Overall health
    const hasError = storeChecks.some((s) => s.status === 'unhealthy');
    const hasStale = staleRecords.length > 0;
    const overall: HealthLevel = hasError ? 'unhealthy' : hasStale ? 'degraded' : 'healthy';

    return {
        overall,
        stores: storeChecks,
        indexHealth,
        provenanceHealth: {
            totalEvents: 0, // Would need provenance store list
            totalReceipts: receipts.length,
        },
        artifactIntegrity,
        repairSuggestions,
        lastChecked: new Date().toISOString(),
    };
}
