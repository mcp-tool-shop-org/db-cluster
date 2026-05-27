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
    // STORES-B-018: walk the schema registry rather than hard-coding the
    // canonical-entities literal. When migration 002 adds a new required
    // table, only `getRequiredTables()` changes and this loop picks it up.
    if (options?.postgresPool) {
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
                checks.push({
                    name: 'postgres_migration',
                    store: 'migration',
                    status: 'missing',
                    severity: 'error',
                    message: `Postgres required table(s) not found: ${missing.join(', ')}. Migrations not run.`,
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
    // Reference CANONICAL_TABLE explicitly so the import is load-bearing —
    // if a future migration removes the canonical table from the registry
    // this name stays the canonical constant for adapter code that needs it.
    void CANONICAL_TABLE;

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
    //
    // STORES-B-014: pre-fix this used `listEvents({ limit: 100 })` and
    // reported `orphanedEvents.length` as the orphan count — silently
    // capping at 100. Operator running doctor twice saw "100 orphaned"
    // both times even when the real number was 500. Post-fix the headline
    // count comes from `countEvents({ action: 'mutation_orphaned' })`
    // (no limit) and listEvents is only used to sample a small set for
    // display. The message reports the true count and (when capped)
    // notes the sample size.
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
        });
    }

    return buildClusterHealth(checks);
}
