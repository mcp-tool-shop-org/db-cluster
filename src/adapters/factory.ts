/**
 * Store factory — creates cluster stores from config.
 * Supports mixed backends (e.g., Postgres canonical + local everything else).
 */

import { Pool } from 'pg';
import type { ClusterStores } from '../contracts/index.js';
import { createLocalCluster } from './local/index.js';
import { PostgresCanonicalStore } from './postgres/index.js';
import { LocalArtifactStore } from './local/local-artifact-store.js';
import { LocalIndexStore } from './local/local-index-store.js';
import { LocalLedgerStore } from './local/local-ledger-store.js';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export interface ClusterConfig {
    /** Root directory for local stores. Required. */
    rootDir: string;
    /** Backend selection per store. Defaults to 'local' for all. */
    backends?: {
        canonical?: 'local' | 'postgres';
        artifact?: 'local';
        index?: 'local';
        ledger?: 'local';
    };
    /** Postgres connection URL. Required when canonical backend is 'postgres'. */
    postgresUrl?: string;
}

export interface ClusterWithPool {
    stores: ClusterStores;
    /** Postgres pool — present when Postgres backend is used. Call pool.end() on shutdown. */
    pool?: Pool;
}

/**
 * Create a cluster from explicit config.
 * Fails clearly when Postgres URL is missing or backends are misconfigured.
 * Never silently falls back to local.
 */
export function createCluster(config: ClusterConfig): ClusterWithPool {
    const canonicalBackend = config.backends?.canonical ?? 'local';

    if (canonicalBackend === 'postgres') {
        if (!config.postgresUrl) {
            throw new Error(
                'DB_CLUSTER_POSTGRES_URL is required when canonical backend is "postgres". ' +
                'Set postgresUrl in config or DB_CLUSTER_POSTGRES_URL environment variable.',
            );
        }

        const pool = new Pool({ connectionString: config.postgresUrl });
        const canonical = new PostgresCanonicalStore(pool);

        mkdirSync(config.rootDir, { recursive: true });

        return {
            stores: {
                canonical,
                artifact: new LocalArtifactStore(join(config.rootDir, 'artifact')),
                index: new LocalIndexStore(join(config.rootDir, 'index')),
                ledger: new LocalLedgerStore(join(config.rootDir, 'ledger')),
            },
            pool,
        };
    }

    // Default: all local
    return { stores: createLocalCluster(config.rootDir) };
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
        backends: { canonical: canonicalBackend as 'local' | 'postgres' },
        postgresUrl,
    });
}
