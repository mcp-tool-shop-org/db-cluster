/**
 * Operations model — shaped health data for the dashboard ops panel.
 *
 * Consumes kernel doctor/verify/indexStatus outputs.
 * Never reads raw adapter stores.
 */

import type { ClusterStores } from '../contracts/index.js';
import type { Command } from '../types/command.js';
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
    /**
     * SURFACE-B-011 (Wave B1-Amend): the count of `mutation_orphaned`
     * ledger events. Wave A2 introduced this event family on receipt
     * failure; Wave A3 wired `verify()` and `doctor()` to consume them.
     * The dashboard surface was blind until this wave — `OperationsPanel`
     * now renders the count + a repair suggestion when > 0.
     *
     * V1-B1-007 / V2-B1-011 (B1-Amend fix-up): pre-fix the defensive
     * try/catch around `countEvents` set this to `0` on ANY error,
     * collapsing degraded → healthy. Post-fix the value is `null` when
     * a runtime error prevented counting (with a matching
     * `degradedReason`), `number` on success. The dashboard renders '?'
     * when null so the operator sees "we don't know" instead of "zero."
     */
    orphanEvents: number | null;
    /**
     * Optional human-readable degraded reason — mirrors the verify.ts
     * structured degraded signal so dashboard consumers see the same
     * one-line explanation the CLI emits.
     */
    degradedReason?: string;
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
 * AGG-B1-6 (Wave B1-Amend fix-up): accept `dataDir` + `commandQueue` so
 * `doctor()`'s `no_orphan_staging` check actually runs. The pre-fix call
 * `doctor(stores)` silently skipped the staging gate because both options
 * were missing — the dashboard health row showed "healthy" while the gate
 * was never evaluated.
 */
export interface BuildOpsModelOptions {
    dataDir?: string;
    commandQueue?: { list(): Command[] };
}

/**
 * Build ops model from kernel surfaces.
 *
 * SURFACE-B-011 (Wave B1-Amend): the ops model now surfaces
 * `mutation_orphaned` ledger event counts so the dashboard renders the
 * load-bearing observability signal Wave A3 wired into `verify()` and
 * `doctor()`. Counting uses `stores.ledger.countEvents({ action })`
 * shipped by Stores in this wave (STORES-B-014); a no-limit count is
 * the headline number, in contrast to the pre-fix `listEvents().length`
 * approach which silent-truncated at the contract's default limit.
 *
 * V3-B1-005 (fix-up): countEvents is REQUIRED on the LedgerStore
 * contract; the pre-fix feature-detect was inconsistent with the
 * contract and degraded silently on non-conforming stubs. Removed —
 * callers must supply a conforming LedgerStore.
 *
 * V1-B1-007 / V2-B1-011 (fix-up): a runtime error from countEvents now
 * produces `orphanEvents = null` + `degradedReason` rather than the
 * pre-fix `orphanEvents = 0` which collapsed degraded → healthy.
 *
 * AGG-B1-6 (fix-up): `dataDir` + `commandQueue` are forwarded to
 * `doctor()` so `no_orphan_staging` actually fires for callers that
 * have them (CLI, kernel-backed surfaces). When omitted, the staging
 * check is skipped (documented in doctor.ts).
 */
export async function buildOpsModel(
    stores: ClusterStores,
    kernel: { indexStatus(): Promise<any>; listStaleRecords(): Promise<any[]>; listReceipts(filter?: any): Promise<any[]> },
    options?: BuildOpsModelOptions,
): Promise<OpsModel> {
    const health = await doctor(stores, {
        dataDir: options?.dataDir,
        commandQueue: options?.commandQueue,
    });
    const indexStatus = await kernel.indexStatus();
    const staleRecords = await kernel.listStaleRecords();
    const receipts = await kernel.listReceipts({ limit: 1000 });
    // Count mutation_orphaned ledger events without sampling. V3-B1-005:
    // countEvents is REQUIRED on the contract — no feature-detect.
    // V1-B1-007 / V2-B1-011: a runtime error sets orphanEvents to null
    // (signal: count unavailable) so the dashboard renders '?' instead of
    // masking degraded as healthy.
    let orphanEvents: number | null = 0;
    let countDegradedReason: string | undefined = undefined;
    try {
        orphanEvents = await stores.ledger.countEvents({ action: 'mutation_orphaned' });
    } catch {
        orphanEvents = null;
        countDegradedReason = 'orphan_count_unavailable';
    }

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
    // SURFACE-B-011 repair suggestion: when mutation_orphaned events are
    // present, the receipt write failed and entity state may be out of
    // sync with the ledger.
    if (typeof orphanEvents === 'number' && orphanEvents > 0) {
        repairSuggestions.push({
            action: 'investigate_orphaned',
            command: 'db-cluster verify --json',
            description: `${orphanEvents} mutation_orphaned event(s) — receipt write failed; entity state may be out of sync with ledger`,
            severity: 'warn',
        });
    }
    // V1-B1-007 / V2-B1-011: surface a repair suggestion when the count
    // itself is unavailable (countEvents threw). Operators see a clear
    // "we don't know" signal rather than masking degraded as healthy.
    if (orphanEvents === null) {
        repairSuggestions.push({
            action: 'investigate_orphan_count_unavailable',
            command: 'db-cluster verify --json',
            description: 'Could not query mutation_orphaned event count — ledger countEvents threw a runtime error',
            severity: 'error',
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
    const hasOrphans = typeof orphanEvents === 'number' && orphanEvents > 0;
    // V1-B1-007 / V2-B1-011: when the count is unavailable the cluster is
    // degraded (not healthy) — operators must know we couldn't measure.
    const countUnavailable = orphanEvents === null;
    const overall: HealthLevel = hasError
        ? 'unhealthy'
        : (hasStale || hasOrphans || countUnavailable)
            ? 'degraded'
            : 'healthy';

    // Compose the degraded reason: count-unavailable signal wins over the
    // orphan-count signal so the operator sees the more severe condition
    // first.
    const degradedReason = countUnavailable
        ? countDegradedReason
        : hasOrphans
            ? `${orphanEvents} mutation_orphaned event(s) detected — see verify --json`
            : undefined;

    return {
        overall,
        stores: storeChecks,
        indexHealth,
        provenanceHealth: {
            totalEvents: 0, // Would need provenance store list
            totalReceipts: receipts.length,
            orphanEvents,
            degradedReason,
        },
        artifactIntegrity,
        repairSuggestions,
        lastChecked: new Date().toISOString(),
    };
}
