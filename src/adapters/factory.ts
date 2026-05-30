/**
 * Store factory — creates cluster stores from config.
 * Supports mixed backends (e.g., Postgres canonical + local everything else).
 *
 * Two factory tiers (Wave S2-A1 — KERNEL-001):
 *  - {@link createSafeCluster} (the SAFE, policy-enforced tier) is what the
 *    package ROOT exports. It returns a {@link SafeCluster} handle that hands
 *    back a {@link PolicyEnforcedKernel} + the read-only ops — NEVER the raw
 *    store mutators. This is the only entry a normal consumer should reach.
 *  - {@link createCluster} / {@link createClusterFromEnv} (the RAW tier) build
 *    bare {@link ClusterStores}. They remain for operator tooling, tests, and
 *    internal callers (CLI / SDK build the kernel themselves), and are
 *    surfaced publicly ONLY through the explicit
 *    `@mcptoolshop/db-cluster/unsafe` escape hatch — never the package root.
 */

import { Pool } from 'pg';
import type { ClusterStores } from '../contracts/index.js';
import { createLocalCluster } from './local/index.js';
import { PostgresCanonicalStore } from './postgres/index.js';
import { LocalCanonicalStore } from './local/local-canonical-store.js';
import { LocalArtifactStore } from './local/local-artifact-store.js';
import { LocalIndexStore } from './local/local-index-store.js';
import { LocalLedgerStore } from './local/local-ledger-store.js';
import { SqliteDb } from './sqlite/sqlite-db.js';
import { SqliteCanonicalStore } from './sqlite/sqlite-canonical-store.js';
import { SqliteArtifactStore } from './sqlite/sqlite-artifact-store.js';
import { SqliteIndexStore } from './sqlite/sqlite-index-store.js';
import { SqliteLedgerStore } from './sqlite/sqlite-ledger-store.js';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { PolicyEnforcedKernel } from '../kernel/policy-enforced-kernel.js';
import { CommandQueue } from '../kernel/command-queue.js';
import {
    DEFAULT_POLICIES,
    DEFAULT_TRUST_ZONES,
    DEFAULT_VISIBILITY_RULES,
} from '../policy/default-policies.js';
import type { Principal } from '../types/policy.js';
import { doctor } from '../ops/doctor.js';
import { verify } from '../ops/verify.js';
import { backup, restore } from '../ops/backup.js';
import type { DoctorOptions } from '../ops/doctor.js';
import type { VerifyOptions } from '../ops/verify.js';
import type {
    BackupOptions,
    RestoreOptions,
    ClusterBackup,
    RestoreResult,
} from '../ops/backup.js';
import type { ClusterHealth } from '../types/health.js';

/**
 * Structured log line for a Postgres pool-level error. The `pg` Pool emits
 * `'error'` on an idle client whose backend connection drops (e.g. a cloud
 * provider closing an idle TCP connection, or a network RST). With NO handler
 * attached, that event becomes an unhandled `'error'` on an EventEmitter and
 * CRASHES the host process (EGRESS-001 / STORES-B-006). The handler logs and
 * swallows — the next query transparently re-establishes a client.
 *
 * The message is deliberately minimal: the error's own `.message` only (no
 * stack, no connection string, no path) so a logged pool error never leaks the
 * Postgres URL or any secret embedded in it.
 */
function attachPoolErrorHandler(pool: Pool): void {
    pool.on('error', (err: Error) => {
        // eslint-disable-next-line no-console
        console.error(
            `[db-cluster] postgres pool: idle-client error (process kept alive): ${err.message}`,
        );
    });
}

export interface ClusterConfig {
    /** Root directory for local stores. Required. */
    rootDir: string;
    /** Backend selection per store. Defaults to 'local' for all. */
    backends?: {
        canonical?: 'local' | 'postgres' | 'sqlite';
        artifact?: 'local' | 'sqlite';
        index?: 'local' | 'sqlite';
        ledger?: 'local' | 'sqlite';
    };
    /** Postgres connection URL. Required when canonical backend is 'postgres'. */
    postgresUrl?: string;
}

export interface ClusterWithPool {
    stores: ClusterStores;
    /** Postgres pool — present when Postgres backend is used. Call pool.end() on shutdown. */
    pool?: Pool;
    /**
     * SQLite connection — present when ANY store uses the 'sqlite' backend. A
     * single shared WAL connection backs every sqlite-selected store. Call
     * `sqliteDb.close()` on shutdown (releases the file lock + checkpoints WAL).
     */
    sqliteDb?: SqliteDb;
}

/**
 * Create a cluster from explicit config.
 * Fails clearly when Postgres URL is missing or backends are misconfigured.
 * Never silently falls back to local.
 */
export function createCluster(config: ClusterConfig): ClusterWithPool {
    const canonicalBackend = config.backends?.canonical ?? 'local';
    const artifactBackend = config.backends?.artifact ?? 'local';
    const indexBackend = config.backends?.index ?? 'local';
    const ledgerBackend = config.backends?.ledger ?? 'local';

    const anySqlite =
        canonicalBackend === 'sqlite' ||
        artifactBackend === 'sqlite' ||
        indexBackend === 'sqlite' ||
        ledgerBackend === 'sqlite';

    // Unchanged default: every store local. Byte-for-byte the prior behavior —
    // no sqlite connection, no postgres pool. Preserves the existing tests.
    if (!anySqlite && canonicalBackend !== 'postgres') {
        return { stores: createLocalCluster(config.rootDir) };
    }

    mkdirSync(config.rootDir, { recursive: true });

    // A single shared SQLite connection (WAL) backs every sqlite-selected store.
    // Opened once under <rootDir>/sqlite/cluster.db; lazily loads better-sqlite3
    // and throws a typed SqliteDriverUnavailableError if the optional driver is
    // absent. Local stays the default; sqlite is strictly opt-in. Never silently
    // falls back.
    const sqliteDb = anySqlite
        ? SqliteDb.open(join(config.rootDir, 'sqlite', 'cluster.db'))
        : undefined;

    let pool: Pool | undefined;

    // Canonical: postgres | sqlite | local. Never silently falls back to local.
    let canonical: ClusterStores['canonical'];
    if (canonicalBackend === 'postgres') {
        if (!config.postgresUrl) {
            throw new Error(
                'DB_CLUSTER_POSTGRES_URL is required when canonical backend is "postgres". ' +
                'Set postgresUrl in config or DB_CLUSTER_POSTGRES_URL environment variable.',
            );
        }
        pool = new Pool({ connectionString: config.postgresUrl });
        // EGRESS-001 / STORES-B-006: without an 'error' listener an idle-client
        // TCP drop crashes the process. Attach before any query can run.
        attachPoolErrorHandler(pool);
        canonical = new PostgresCanonicalStore(pool);
    } else if (canonicalBackend === 'sqlite') {
        canonical = new SqliteCanonicalStore(sqliteDb!);
    } else {
        canonical = new LocalCanonicalStore(join(config.rootDir, 'canonical'));
    }

    const artifact =
        artifactBackend === 'sqlite'
            ? new SqliteArtifactStore(sqliteDb!)
            : new LocalArtifactStore(join(config.rootDir, 'artifact'));
    const index =
        indexBackend === 'sqlite'
            ? new SqliteIndexStore(sqliteDb!)
            : new LocalIndexStore(join(config.rootDir, 'index'));
    const ledger =
        ledgerBackend === 'sqlite'
            ? new SqliteLedgerStore(sqliteDb!)
            : new LocalLedgerStore(join(config.rootDir, 'ledger'));

    return {
        stores: { canonical, artifact, index, ledger },
        ...(pool ? { pool } : {}),
        ...(sqliteDb ? { sqliteDb } : {}),
    };
}

/**
 * Create a cluster from environment variables.
 */
export function createClusterFromEnv(rootDir: string): ClusterWithPool {
    const canonicalBackend = process.env.DB_CLUSTER_CANONICAL_BACKEND ?? 'local';
    const postgresUrl = process.env.DB_CLUSTER_POSTGRES_URL;

    if (canonicalBackend === 'postgres' && !postgresUrl) {
        throw new Error(
            'DB_CLUSTER_CANONICAL_BACKEND=postgres requires DB_CLUSTER_POSTGRES_URL to be set.',
        );
    }

    return createCluster({
        rootDir,
        backends: { canonical: canonicalBackend as 'local' | 'postgres' | 'sqlite' },
        postgresUrl,
    });
}

// ─── SAFE (policy-enforced) factory — KERNEL-001 ─────────────────────────────

/**
 * A policed cluster handle returned by {@link createSafeCluster}.
 *
 * This is the ONLY cluster handle the package root hands back. It deliberately
 * exposes NO raw store mutators (`.canonical` / `.artifact` / `.index` /
 * `.ledger` / `.stores`): every read and every mutation MUST flow through the
 * {@link PolicyEnforcedKernel}, which applies policy, redaction, receipts,
 * provenance, and the mutation law. The four ops (`doctor` / `verify` /
 * `backup` / `restore`) are bound to the underlying stores so operators still
 * get health/consistency/backup without reaching the raw handles.
 *
 * If you genuinely need the raw, unpoliced stores (operator tooling, tests),
 * import them from the explicit `@mcptoolshop/db-cluster/unsafe` escape hatch.
 */
export interface SafeCluster {
    /** The policy-enforced kernel — the only path to read/mutate cluster truth. */
    kernel: PolicyEnforcedKernel;
    /** Run the full health-check matrix. Read-only. */
    doctor(options?: DoctorOptions): Promise<ClusterHealth>;
    /** Prove cluster invariants hold (consistency, not reachability). Read-only. */
    verify(options?: VerifyOptions): Promise<ClusterHealth>;
    /** Export cluster state as a portable JSON backup. */
    backup(options?: BackupOptions): Promise<ClusterBackup>;
    /** Restore cluster state from a backup payload. */
    restore(data: ClusterBackup, options?: RestoreOptions): Promise<RestoreResult>;
    /**
     * Postgres pool — present only when a Postgres backend is configured. Call
     * `pool.end()` on shutdown. Exposed for lifecycle management only; it is
     * NOT a truth-store handle.
     */
    pool?: Pool;
    /**
     * SQLite connection — present only when a SQLite backend is configured. Call
     * `sqliteDb.close()` on shutdown. Exposed for lifecycle management only; it
     * is NOT a truth-store handle (every read/write still flows through the
     * kernel).
     */
    sqliteDb?: SqliteDb;
}

/**
 * Configuration for {@link createSafeCluster}. Same backend selection as
 * {@link ClusterConfig}, plus optional overrides for the safe-default
 * principal / policy bundle. Omit them to get the secure defaults.
 */
export interface SafeClusterConfig extends ClusterConfig {
    /**
     * The principal the policed kernel acts as. Defaults to a single-operator
     * `cluster-admin` principal in the `internal` trust zone — authorized
     * under {@link DEFAULT_POLICIES} so the handle is usable, while still
     * routing every verb through the policy gate. Supply your own to run as a
     * less-privileged principal (e.g. an `observer` or `proposer`).
     */
    principal?: Principal;
}

/**
 * The safe-default principal: a single in-process operator. It holds the
 * `cluster-admin` role (granted full access by {@link DEFAULT_POLICIES}) in
 * the trusted `internal` zone. Policy enforcement is REAL — every verb still
 * calls `enforce()` — this principal is simply authorized, which is the
 * correct default for "I built this cluster locally and I'm the operator."
 * Drop privileges by passing your own {@link SafeClusterConfig.principal}.
 */
const DEFAULT_SAFE_PRINCIPAL: Principal = {
    id: 'db-cluster-operator',
    name: 'db-cluster operator (default)',
    roles: ['cluster-admin'],
    trustZone: 'internal',
};

/**
 * Create a POLICY-ENFORCED cluster — the safe package-root entry (KERNEL-001).
 *
 * Builds the raw stores internally (via {@link createCluster}) and wraps them
 * in a {@link PolicyEnforcedKernel} with the secure defaults
 * ({@link DEFAULT_POLICIES} + {@link DEFAULT_TRUST_ZONES} +
 * {@link DEFAULT_VISIBILITY_RULES}) and a safe-default principal. Returns a
 * {@link SafeCluster} handle that exposes the kernel + the read-only ops but
 * NEVER the raw store mutators — closing the KERNEL-001 hole where the public
 * root previously handed back raw, unpoliced `ClusterStores`.
 *
 * The kernel persists its command queue / staging area under `config.rootDir`
 * (same root the local stores use), so a single `rootDir` is self-contained.
 *
 * @param config Backend selection + optional principal / policy overrides.
 * @returns A policed {@link SafeCluster} handle.
 * @throws  The same configuration errors as {@link createCluster} (e.g.
 *          missing `postgresUrl` when the canonical backend is `postgres`),
 *          plus any {@link PolicyEnforcedKernel} construction error (corrupt
 *          pending-commands file, etc.).
 *
 * @example
 *   import { createSafeCluster } from '@mcptoolshop/db-cluster';
 *   const cluster = createSafeCluster({ rootDir: '.db-cluster' });
 *   const { entity } = await cluster.kernel.createEntity({
 *       kind: 'note', name: 'hello', attributes: {},
 *   });
 *   const health = await cluster.doctor();
 */
export function createSafeCluster(config: SafeClusterConfig): SafeCluster {
    const { stores, pool, sqliteDb } = createCluster(config);

    const principal = config.principal ?? DEFAULT_SAFE_PRINCIPAL;
    const kernel = new PolicyEnforcedKernel(
        stores,
        { principal, trustZone: principal.trustZone },
        {
            policies: DEFAULT_POLICIES,
            trustZones: DEFAULT_TRUST_ZONES,
            visibilityRules: DEFAULT_VISIBILITY_RULES,
            dataDir: config.rootDir,
        },
    );

    // Bind the ops to these stores so the handle exposes operator surface
    // WITHOUT leaking the raw stores. Doctor gets the pool (when present) for
    // its Postgres migration check and the dataDir for the staging check.
    //
    // Wave S2-A1 fix-up (Task 2): the kernel persists its CommandQueue under
    // `config.rootDir` (same `dataDir` passed to PolicyEnforcedKernel above).
    // verify() SKIPS the `command_receipt_bijection` check entirely when no
    // `commandQueue` is supplied — so the previous `verify(stores, options)`
    // binding meant this policed root surface NEVER ran the bijection check,
    // and an orphan/forged receipt read back as healthy. Construct the queue
    // over the same rootDir and pass it as the DEFAULT, spreading caller
    // `options` AFTER so a caller-supplied `commandQueue` still wins. This is
    // the wave's new policed root entry, so it must detect the bijection break
    // it was designed for.
    const commandQueue = new CommandQueue(config.rootDir);
    return {
        kernel,
        doctor: (options?: DoctorOptions) =>
            doctor(stores, {
                dataDir: config.rootDir,
                ...(pool ? { postgresPool: pool } : {}),
                ...options,
            }),
        verify: (options?: VerifyOptions) => verify(stores, { commandQueue, ...options }),
        backup: (options?: BackupOptions) =>
            backup(stores, { dataDir: config.rootDir, ...options }),
        restore: (data: ClusterBackup, options?: RestoreOptions) =>
            restore(stores, data, { dataDir: config.rootDir, ...options }),
        ...(pool ? { pool } : {}),
        ...(sqliteDb ? { sqliteDb } : {}),
    };
}
