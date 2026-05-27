/**
 * Doctor — diagnoses cluster health by running all checks.
 * Does not mutate state. Reports findings with suggested repairs.
 */

import type { ClusterStores } from '../contracts/index.js';
import type { ClusterHealth, HealthCheck } from '../types/health.js';
import { buildClusterHealth } from './health.js';
import { CANONICAL_TABLE, getRequiredTables } from '../adapters/postgres/schema.js';
import type { Command } from '../types/command.js';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface DoctorOptions {
    /** Postgres pool for backend checks (optional) */
    postgresPool?: { query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }> };
    /**
     * Cluster data directory — required for the `no_orphan_staging` check
     * (V1-A4-005). Without it the staging check is skipped because doctor()
     * has no way to locate the `<dataDir>/pending-content/` directory.
     */
    dataDir?: string;
    /**
     * CommandQueue-like handle that exposes the set of pending commands so
     * `no_orphan_staging` can distinguish "live staging file referenced by a
     * pending ingest_artifact" from "orphan staging file from a crashed or
     * abandoned propose call." Most callers pass the kernel here (it
     * implements `list()` via its internal commandQueue accessor).
     *
     * Optional: when missing, every staging file older than the grace
     * window is treated as an orphan (the conservative choice).
     */
    commandQueue?: { list(): Command[] };
    /**
     * Progress callback (STORES-C-002). Fired between individual store
     * reachability probes and the multi-step orphan/staging checks. The
     * `total` count includes all built-in checks doctor() runs in this
     * session (e.g. canonical / artifact / index / ledger reachability,
     * index population, postgres migration, policy defaults, orphan
     * mutations, staging files). `message` is a short human-readable
     * label of the check currently running.
     *
     * Optional — CLI surface subscribes for live progress in the
     * terminal; the SDK/MCP layer wires this through for callers that
     * want to render a progress bar.
     */
    onProgress?: (current: number, total: number, message?: string) => void;
}

/**
 * Run the full cluster health-check matrix and return a structured
 * {@link ClusterHealth} report. Doctor never mutates cluster state; every
 * finding is read-only and accompanied by an actionable remediation hint
 * (either {@link HealthCheck.suggestedCommand} or
 * {@link HealthCheck.nextSteps}).
 *
 * Checks performed (in order):
 *   1. Store reachability — canonical / artifact / index / ledger.
 *   2. Index-vs-truth population — empty index against populated truth.
 *   3. Postgres migration registry — when `postgresPool` is supplied.
 *   4. Policy defaults loadable.
 *   5. Orphaned mutations — surfaces `mutation_orphaned` ledger events.
 *   6. Orphan staging files — surfaces unreferenced pending-content/.
 *
 * Every check produced with `repairAvailable: true` ALSO carries
 * {@link HealthCheck.suggestedCommand} so operator-facing surfaces can
 * render `→ fix: ${cmd}` without conditional branching. Multi-step
 * recoveries populate {@link HealthCheck.nextSteps} additionally.
 *
 * @param stores  ClusterStores bundle — canonical / artifact / index /
 *                ledger adapters. Doctor calls `list({ limit: 1 })` on
 *                each store for the reachability probe.
 * @param options Doctor-specific knobs. See {@link DoctorOptions}.
 * @returns       A {@link ClusterHealth} summarizing all checks. The
 *                top-level `status` is the worst of the per-check statuses
 *                (corrupt > unreachable > missing > stale > degraded >
 *                healthy). Never throws — every check error is converted
 *                to a `status: 'unreachable'` check.
 * @throws        Doctor itself does not throw. Individual store-adapter
 *                exceptions are caught and surfaced as `unreachable`
 *                checks. The only path that could throw is a corrupted
 *                CommandQueue handle passed via `options.commandQueue`;
 *                doctor swallows those too (best-effort).
 *
 * @example
 *   const health = await doctor(stores);
 *   for (const check of health.checks) {
 *       if (check.suggestedCommand) {
 *           console.log(`  → fix: ${check.suggestedCommand}`);
 *       }
 *       if (check.nextSteps) {
 *           for (const step of check.nextSteps) console.log(`    • ${step}`);
 *       }
 *   }
 */
export async function doctor(stores: ClusterStores, options?: DoctorOptions): Promise<ClusterHealth> {
    const checks: HealthCheck[] = [];
    const onProgress = options?.onProgress;
    // Conservative upper bound — actual count depends on postgresPool presence
    // and dataDir presence; the CLI clamps display at `current ≤ total` so a
    // slight over-count is fine.
    const totalSteps = 8;
    let step = 0;
    const tick = (label: string) => {
        step++;
        try {
            onProgress?.(step, totalSteps, label);
        } catch {
            // Best-effort: a misbehaving callback must not derail doctor.
        }
    };

    // --- Canonical store reachability ---
    tick('canonical_reachable');
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
            nextSteps: [
                'Verify DB_CLUSTER_CANONICAL_BACKEND and connection env vars (e.g. DB_CLUSTER_POSTGRES_URL).',
                'Run `db-cluster stores verify` to test backend connectivity.',
                'Inspect the cluster data directory permissions and disk space.',
            ],
        });
    }

    // --- Artifact store reachability ---
    tick('artifact_reachable');
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
            nextSteps: [
                'Inspect the cluster data directory for read/write permissions.',
                'Run `db-cluster stores verify` to confirm adapter state.',
            ],
        });
    }

    // --- Index store reachability ---
    tick('index_reachable');
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
            repairAvailable: true,
            suggestedCommand: 'db-cluster rebuild index',
            nextSteps: [
                'Inspect the index file under the cluster data directory for corruption.',
                'Run `db-cluster rebuild index` to reconstruct the index from owner truth.',
            ],
        });
    }

    // --- Ledger store reachability ---
    tick('ledger_reachable');
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
            nextSteps: [
                'Inspect the ledger events.json file for corruption.',
                'Restore from a backup with `db-cluster restore <backup.json>`.',
            ],
        });
    }

    // --- Index staleness check ---
    tick('index_populated');
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
                    nextSteps: [
                        'Run `db-cluster rebuild index --dry-run` first to inspect the plan.',
                        'Then run `db-cluster rebuild index` to populate the index from owner truth.',
                    ],
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
    // STORES-B-018: walk the schema registry rather than hard-coding the
    // canonical-entities literal. When migration 002 adds a new required
    // table, only `getRequiredTables()` changes and this loop picks it up.
    if (options?.postgresPool) {
        tick('postgres_migration');
        try {
            const required = getRequiredTables();
            // Single round-trip: ask information_schema for every required
            // table at once, then diff.
            const placeholders = required.map((_, i) => `$${i + 1}`).join(', ');
            const result = await options.postgresPool.query(
                `SELECT table_name FROM information_schema.tables WHERE table_name IN (${placeholders})`,
                Array.from(required),
            );
            const present = new Set(
                result.rows.map((r) => (r as { table_name: string }).table_name),
            );
            const missing = required.filter((t) => !present.has(t));
            if (missing.length === 0) {
                checks.push({
                    name: 'postgres_migration',
                    store: 'migration',
                    status: 'healthy',
                    severity: 'info',
                    message: `Postgres required tables exist: ${required.join(', ')}.`,
                    repairAvailable: false,
                });
            } else {
                // SHA-STORES-PHANTOM-CMD (Stage C Wave C1-Audit):
                // Pre-fix this check set `suggestedCommand: 'db-cluster stores migrate'`.
                // The CLI command DOES exist (cli.ts:1134) and runs
                // PostgresCanonicalStore.migrate() — a `CREATE TABLE IF NOT
                // EXISTS canonical_entities` shim. But there is no real
                // applied_migrations registry yet (that lands with v0.2 per
                // the Stage B B1-Amend deferral of AGG-B1-7), and Stage C
                // advisor disposition is to NOT promise an operator-facing
                // migration workflow that doesn't actually track applied
                // migrations. Drop suggestedCommand; explain the situation
                // via `details` + `nextSteps`.
                checks.push({
                    name: 'postgres_migration',
                    store: 'migration',
                    status: 'missing',
                    severity: 'error',
                    message: `Postgres required table(s) not found: ${missing.join(', ')}. Migration registry pending — manual schema setup required.`,
                    repairAvailable: false,
                    details:
                        'A first-class applied_migrations registry lands with v0.2. Until then, ' +
                        'the Postgres backend exposes a `db-cluster stores migrate` shim that calls ' +
                        '`CREATE TABLE IF NOT EXISTS canonical_entities` but does not track applied ' +
                        'migration state. Operators bootstrapping a fresh Postgres backend should run ' +
                        'the shim once and inspect `information_schema.tables` to verify.',
                    nextSteps: [
                        'Inspect required tables in Postgres: `SELECT table_name FROM information_schema.tables WHERE table_name IN (\'canonical_entities\')`.',
                        'For first-time setup of a fresh Postgres backend, run the schema bootstrap shim available via the SDK\'s PostgresCanonicalStore.migrate() method.',
                        'For schema drift, consult the migration timeline in docs/operations.md (v0.2 will ship a real applied_migrations registry).',
                    ],
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
                nextSteps: [
                    'Verify DB_CLUSTER_POSTGRES_URL is set and the Postgres instance accepts connections.',
                    'Run `db-cluster stores verify` to test the connection out-of-band.',
                ],
            });
        }
    }
    // Reference CANONICAL_TABLE explicitly so the import is load-bearing —
    // if a future migration removes the canonical table from the registry
    // this name stays the canonical constant for adapter code that needs it.
    void CANONICAL_TABLE;

    // --- Policy defaults loadable ---
    tick('policy_defaults');
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
            nextSteps: [
                'Inspect `.db-cluster/policies.json` for malformed JSON or invalid rule shape.',
                'Run `db-cluster policy explain` to see which policies the engine successfully loads.',
                'If the file is corrupted, delete it to fall back to default policies; the policy engine will recreate it on next mutation.',
            ],
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
    //
    // STORES-B-014: pre-fix this used `listEvents({ limit: 100 })` and
    // reported `orphanedEvents.length` as the orphan count — silently
    // capping at 100. Operator running doctor twice saw "100 orphaned"
    // both times even when the real number was 500. Post-fix the headline
    // count comes from `countEvents({ action: 'mutation_orphaned' })`
    // (no limit) and listEvents is only used to sample a small set for
    // display. The message reports the true count and (when capped)
    // notes the sample size.
    //
    // STORES-C-001 (Stage C Wave C1-Audit): pre-fix this check produced
    // `repairAvailable: false` AND no suggestedCommand AND no nextSteps.
    // Operators were told "uninspectable state" with no recovery path.
    // Post-fix the check carries suggestedCommand (inspection command)
    // AND nextSteps (multi-step recovery procedure).
    tick('no_orphaned_mutations');
    try {
        const SAMPLE_LIMIT = 100;
        const orphanCount = await stores.ledger.countEvents({
            action: 'mutation_orphaned',
        });
        // The sample is unused at the moment — kept as a bounded call so the
        // assertion that doctor() does not materialize all orphans into
        // memory holds (STORES-B-014 regression test asserts this).
        await stores.ledger.listEvents({
            action: 'mutation_orphaned',
            limit: SAMPLE_LIMIT,
        });

        if (orphanCount > 0) {
            const capped = orphanCount > SAMPLE_LIMIT;
            const suffix = capped ? ` (showing first ${SAMPLE_LIMIT})` : '';
            checks.push({
                name: 'no_orphaned_mutations',
                store: 'ledger',
                status: 'degraded',
                severity: 'warning',
                message: `${orphanCount} orphaned mutation event(s) recorded${suffix}. A mutation completed against a store but its receipt write failed — the cluster has uninspectable state.`,
                repairAvailable: false,
                suggestedCommand: 'db-cluster verify',
                nextSteps: [
                    'Run `db-cluster verify` to confirm the orphan count and identify affected subjects.',
                    'For each orphan, run `db-cluster trace <subjectId>` to inspect the lineage.',
                    'Run `db-cluster receipts --limit 200` to confirm whether matching receipts are present or missing.',
                    'If receipts are missing, the cluster\'s post-mutation provenance write failed: inspect logs around the original `mutation_orphaned` event timestamps to find the cause.',
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
            message: `Orphan check failed: ${err.message}`,
            repairAvailable: false,
            nextSteps: [
                'Inspect the ledger events.json file for corruption.',
                'Run `db-cluster verify` to re-attempt the check via the verify surface.',
            ],
        });
    }

    // --- No orphan staging files (V1-A4-005) ---
    // Wave A4 introduced `<dataDir>/pending-content/` as the staging area for
    // ingest_artifact Buffer payloads (KERNEL-B-007). The proposeMutation arm
    // writes there, commitMutation reads back + unlinks on success, and
    // markRejected/compensateMutation unlink on failure. A staging file
    // lingering older than 1h with no matching command is a sign of either
    // a crashed proposer or a code path that lost cleanup discipline.
    //
    // Heuristics:
    //  - If `options.dataDir` is not provided, skip the check (no way to
    //    locate the staging dir without it).
    //  - Grace window: 1 hour. Younger files are ignored so an in-flight
    //    propose call between writeFileSync and the matching commit does not
    //    flap the health status.
    //  - "Referenced by a command" means: there exists a queued command
    //    whose payload.contentHash equals the filename's hash. We accept
    //    commands in any status — proposed/validated/approved/etc. — because
    //    rejected/committed commands should have already unlinked the file.
    if (options?.dataDir) {
        tick('no_orphan_staging');
    }
    try {
        if (options?.dataDir) {
            const stagingDir = join(options.dataDir, 'pending-content');
            const ORPHAN_AGE_MS = 60 * 60 * 1000; // 1 hour
            const cutoff = Date.now() - ORPHAN_AGE_MS;

            // Build the set of hashes referenced by live commands (if a
            // commandQueue was provided). Without one, every old staging
            // file is treated as orphan.
            const referencedHashes = new Set<string>();
            if (options.commandQueue) {
                try {
                    for (const cmd of options.commandQueue.list()) {
                        const hash = (cmd.payload as { contentHash?: unknown })
                            ?.contentHash;
                        if (typeof hash === 'string' && hash.length > 0) {
                            referencedHashes.add(hash);
                        }
                    }
                } catch {
                    // Best-effort: if list() throws we proceed without
                    // command-references and every old file is orphan.
                }
            }

            let orphanCount = 0;
            let oldestOrphanAgeMs = 0;
            if (existsSync(stagingDir)) {
                let entries: string[];
                try {
                    entries = readdirSync(stagingDir);
                } catch {
                    entries = [];
                }
                for (const entry of entries) {
                    // Only consider files whose name matches the content-hash
                    // shape (sha256 hex). Tmp files (`<hash>.<pid>-<rand>.tmp`)
                    // are swept by the kernel's getStagingDir sweep — not
                    // doctor's concern.
                    if (!/^[a-f0-9]{64}$/.test(entry)) continue;
                    const fullPath = join(stagingDir, entry);
                    let mtimeMs: number;
                    try {
                        mtimeMs = statSync(fullPath).mtimeMs;
                    } catch {
                        continue;
                    }
                    if (mtimeMs >= cutoff) continue; // young, in-flight
                    if (referencedHashes.has(entry)) continue; // matches a pending command
                    orphanCount++;
                    const age = Date.now() - mtimeMs;
                    if (age > oldestOrphanAgeMs) oldestOrphanAgeMs = age;
                }
            }

            if (orphanCount > 0) {
                const oldestMin = Math.floor(oldestOrphanAgeMs / 60000);
                checks.push({
                    name: 'no_orphan_staging',
                    store: 'cluster',
                    status: 'degraded',
                    severity: 'warning',
                    message:
                        `${orphanCount} orphan staging file(s) in pending-content/ ` +
                        `(oldest ${oldestMin} min). A propose call wrote staged content ` +
                        `but no matching command was found in the queue — likely a ` +
                        `crashed proposer or a missed cleanup. Inspect the files and ` +
                        `delete them, or re-propose the corresponding ingest_artifact ` +
                        `commands.`,
                    repairAvailable: false,
                    nextSteps: [
                        'Inspect `<dataDir>/pending-content/` for files older than 1 hour.',
                        'Run `db-cluster inspect-command <id>` against any proposed/validated ingest_artifact commands to identify matching hashes.',
                        'Manually delete orphan staging files that have no matching command, or re-propose the ingest_artifact commands they correspond to.',
                    ],
                });
            } else {
                checks.push({
                    name: 'no_orphan_staging',
                    store: 'cluster',
                    status: 'healthy',
                    severity: 'info',
                    message: 'No orphan staging files in pending-content/.',
                    repairAvailable: false,
                });
            }
        }
    } catch (err: any) {
        checks.push({
            name: 'no_orphan_staging',
            store: 'cluster',
            status: 'unreachable',
            severity: 'error',
            message: `Orphan-staging check failed: ${err.message}`,
            repairAvailable: false,
            nextSteps: [
                'Verify the cluster data directory and pending-content/ subdirectory permissions.',
            ],
        });
    }

    return buildClusterHealth(checks);
}
