/**
 * Operations model — shaped health data for the dashboard ops panel.
 *
 * Consumes kernel doctor/verify/indexStatus outputs.
 * Never reads raw adapter stores.
 */

import type { ClusterStores } from '../contracts/index.js';
import type { Command } from '../types/command.js';
import { doctor } from '../ops/doctor.js';
// SHA-SURFACE-LEAK-1 (Wave C1-Amend should-have-been-A): the pre-fix
// `kernel: { indexStatus(): Promise<any>; ... }` typing let the consumer
// read fields that don't exist on the actual producer's shape. Now we
// import the producer type so TypeScript catches drift at compile time.
import type { IndexStatusResult } from '../kernel/cluster-kernel.js';

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
    /**
     * Total provenance events. `null` when countEvents() failed at
     * runtime — preserves the "we don't know" signal rather than
     * silently collapsing to 0 (which masks degraded → healthy).
     *
     * Wave C1-Amend fix-up (V3-C1-011): pre-fix this was typed
     * `number` but the runtime set it to `null` on countEvents failure;
     * line 275 collapsed null → 0 with `?? 0`, defeating the purpose.
     * Mirrors the {@link orphanEvents} discipline below.
     */
    totalEvents: number | null;
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
    // SHA-SURFACE-LEAK-1 (Wave C1-Amend): tightened the kernel arg type
    // so the index-status read can't drift from the producer's shape
    // again. Pre-fix the implementation read `indexStatus.totalRecords` /
    // `.missingRecords` — neither field exists on IndexStatusResult.
    // TypeScript would have caught this on a typed reference; the typing
    // was deliberately `any` and silenced the error.
    kernel: {
        indexStatus(): Promise<IndexStatusResult>;
        listStaleRecords(): Promise<unknown[]>;
        listReceipts(filter?: { limit?: number }): Promise<unknown[]>;
    },
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

    // SHA-SURFACE-LEAK-3 (Wave C1-Amend should-have-been-A): pre-fix the
    // dashboard returned `totalEvents: 0` hardcoded with a TODO. The
    // operator looked at the panel and always saw zero. Now we count
    // via the ledger contract — countEvents() with no action filter
    // counts ALL provenance events. Same degraded-signal discipline as
    // orphanEvents: null on error so the dashboard renders '?'/degraded
    // rather than the misleading literal zero.
    let totalEvents: number | null = 0;
    try {
        totalEvents = await stores.ledger.countEvents();
    } catch {
        totalEvents = null;
    }

    // Map store checks
    const storeChecks: StoreHealth[] = health.checks
        .filter((c) => c.name.endsWith('_reachable'))
        .map((c) => ({
            store: c.store ?? c.name.replace('_reachable', ''),
            status: c.status === 'healthy' ? 'healthy' as const : 'unhealthy' as const,
            message: c.message,
        }));

    // SHA-SURFACE-LEAK-1 (Wave C1-Amend should-have-been-A): pre-fix
    // read `indexStatus.totalRecords` / `.missingRecords` — neither field
    // exists on IndexStatusResult (declared in src/kernel/cluster-kernel.ts).
    // Real shape: { total, byStore, expectedTotal, possiblyStale }.
    // `missing` is derived as `expectedTotal - total` (positive = some
    // owner records have no index entry). The pre-fix bug silently
    // displayed 0 in the dashboard IndexHealth tile for every cluster.
    const total = indexStatus.total ?? 0;
    const expectedTotal = indexStatus.expectedTotal ?? 0;
    const missing = Math.max(0, expectedTotal - total);
    const indexHealth: IndexHealth = {
        total,
        fresh: Math.max(0, total - staleRecords.length),
        stale: staleRecords.length,
        missing,
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
            // Wave C1-Amend fix-up (V1-C1-004 — sibling-pattern of
            // SHA-STORES-PHANTOM-CMD): the canonical CLI subcommand is
            // `db-cluster rebuild index` (cli.ts:1804). The pre-fix
            // `db-cluster reindex` did not exist — operators copy-pasting
            // the repair suggestion got "unknown command".
            command: 'db-cluster rebuild index',
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
            // Wave C1-Amend fix-up (V1-C1-004 — sibling-pattern of
            // SHA-STORES-PHANTOM-CMD): pre-fix this site emitted the
            // phantom `db-cluster doctor --repair` which does not exist
            // anywhere in src/cli.ts. Drop the synthetic suggestion when
            // the check itself didn't supply one — operators see no
            // wrong command instead of a fake. When the check carries
            // its own `suggestedCommand` (the canonical contract every
            // HealthCheck producer should populate), surface that.
            const command = (check as { suggestedCommand?: string }).suggestedCommand;
            if (command) {
                repairSuggestions.push({
                    action: `repair_${check.name}`,
                    command,
                    description: check.message,
                    severity: check.severity === 'error' ? 'error' : 'warn',
                });
            }
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
            // SHA-SURFACE-LEAK-3: read from ledger via countEvents({}).
            // null preserves the "we don't know" signal when the count
            // failed at runtime, mirroring the orphan-events discipline.
            //
            // Wave C1-Amend fix-up (V3-C1-011): preserve null through
            // the boundary rather than collapsing with `?? 0`. The
            // dashboard renderer interprets null as "?" so the operator
            // sees the degraded signal instead of "0 events".
            totalEvents: totalEvents,
            totalReceipts: receipts.length,
            orphanEvents,
            degradedReason,
        },
        artifactIntegrity,
        repairSuggestions,
        lastChecked: new Date().toISOString(),
    };
}
