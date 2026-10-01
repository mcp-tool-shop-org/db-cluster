/**
 * Coverage — adapters/factory: mixed local/sqlite backend wiring,
 * createClusterFromEnv, the postgres pool wiring (no server contacted), and
 * the SafeCluster doctor/verify/backup/restore wrappers that thread the data
 * directory through.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import {
    createCluster,
    createClusterFromEnv,
    createSafeCluster,
} from '../src/adapters/factory.js';
import { LocalCanonicalStore } from '../src/adapters/local/local-canonical-store.js';
import { LocalArtifactStore } from '../src/adapters/local/local-artifact-store.js';
import { SqliteArtifactStore } from '../src/adapters/sqlite/sqlite-artifact-store.js';
import { SqliteLedgerStore } from '../src/adapters/sqlite/sqlite-ledger-store.js';
import { SqliteCanonicalStore } from '../src/adapters/sqlite/sqlite-canonical-store.js';
import { PostgresCanonicalStore } from '../src/adapters/postgres/postgres-canonical-store.js';

describe('createCluster()', () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'cov-factory-'));
    });
    afterEach(() => {
        vi.restoreAllMocks();
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });

    it('a local canonical store beside sqlite siblings shares one sqlite database', async () => {
        const { stores, sqliteDb, pool } = createCluster({
            rootDir: dir,
            backends: { canonical: 'local', artifact: 'sqlite', ledger: 'sqlite' },
        });
        try {
            expect(pool).toBeUndefined();
            expect(sqliteDb).toBeDefined();
            expect(stores.canonical).toBeInstanceOf(LocalCanonicalStore);
            expect(stores.artifact).toBeInstanceOf(SqliteArtifactStore);
            expect(stores.ledger).toBeInstanceOf(SqliteLedgerStore);
            expect(existsSync(join(dir, 'sqlite', 'cluster.db'))).toBe(true);

            // The stores are live and independent: write through each.
            const entity = await stores.canonical.create({ kind: 'note', name: 'mixed', attributes: {} });
            const art = await stores.artifact.ingest({ filename: 'a.txt', content: Buffer.from('a'), mimeType: 'text/plain' });
            const ev = await stores.ledger.append({ action: 'x', actorId: 'op', subjectId: entity.id, subjectStore: 'canonical', detail: {} });
            expect((await stores.canonical.get(entity.id))?.name).toBe('mixed');
            expect((await stores.artifact.getContent(art.id))?.toString()).toBe('a');
            expect((await stores.ledger.getEvent(ev.id))?.subjectId).toBe(entity.id);
        } finally {
            sqliteDb?.close();
        }
    });

    it('an all-local config returns plain local stores with no pool or sqlite handle', () => {
        const cluster = createCluster({ rootDir: dir });
        expect(cluster.pool).toBeUndefined();
        expect(cluster.sqliteDb).toBeUndefined();
        expect(cluster.stores.canonical).toBeInstanceOf(LocalCanonicalStore);
        expect(cluster.stores.artifact).toBeInstanceOf(LocalArtifactStore);
    });

    it('a sqlite canonical backend is built on the shared database', () => {
        const { stores, sqliteDb } = createCluster({ rootDir: dir, backends: { canonical: 'sqlite' } });
        try {
            expect(stores.canonical).toBeInstanceOf(SqliteCanonicalStore);
            expect(stores.artifact).toBeInstanceOf(LocalArtifactStore);
        } finally {
            sqliteDb?.close();
        }
    });

    it('a postgres backend builds a pool-backed store without contacting a server, and logs idle-client errors minimally', async () => {
        const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
        const { stores, pool } = createCluster({
            rootDir: dir,
            backends: { canonical: 'postgres' },
            postgresUrl: 'postgres://user:secret@127.0.0.1:1/never',
        });
        try {
            expect(stores.canonical).toBeInstanceOf(PostgresCanonicalStore);
            expect(pool).toBeDefined();
            // An idle-client error must not crash the process or leak the connection string.
            pool!.emit('error', new Error('connection reset by peer'));
            expect(stderr).toHaveBeenCalledTimes(1);
            const line = String(stderr.mock.calls[0][0]);
            expect(line).toBe('[db-cluster] postgres pool: idle-client error (process kept alive): connection reset by peer');
            expect(line).not.toContain('secret');
        } finally {
            await pool?.end();
        }
    });

    it('postgres without a URL is refused with a typed config error', () => {
        let caught: unknown;
        try {
            createCluster({ rootDir: dir, backends: { canonical: 'postgres' } });
        } catch (e) {
            caught = e;
        }
        expect(caught).toMatchObject({ code: 'INVALID_BACKEND_CONFIG', name: 'InvalidBackendConfigError', retryable: false });
        expect(String((caught as Error).message)).toContain('DB_CLUSTER_POSTGRES_URL is required');
    });
});

describe('createClusterFromEnv()', () => {
    let dir: string;
    const saved: Record<string, string | undefined> = {};
    const KEYS = ['DB_CLUSTER_CANONICAL_BACKEND', 'DB_CLUSTER_POSTGRES_URL'];

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'cov-factory-env-'));
        for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    });
    afterEach(() => {
        for (const k of KEYS) {
            if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
        }
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });

    it('builds local stores when no backend variable is set', () => {
        const { stores } = createClusterFromEnv(dir);
        expect(stores.canonical).toBeInstanceOf(LocalCanonicalStore);
    });

    it('honours DB_CLUSTER_CANONICAL_BACKEND=sqlite', () => {
        process.env.DB_CLUSTER_CANONICAL_BACKEND = 'sqlite';
        const { stores, sqliteDb } = createClusterFromEnv(dir);
        try {
            expect(stores.canonical).toBeInstanceOf(SqliteCanonicalStore);
        } finally {
            sqliteDb?.close();
        }
    });

    it('rejects an unknown backend from the environment', () => {
        process.env.DB_CLUSTER_CANONICAL_BACKEND = 'mysql';
        expect(() => createClusterFromEnv(dir)).toThrow(expect.objectContaining({ code: 'INVALID_BACKEND_CONFIG' }));
    });
});

describe('createSafeCluster() wrappers', () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'cov-factory-safe-'));
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });

    it('doctor() threads the data directory through so the staging check runs, and caller options override', async () => {
        const safe = createSafeCluster({ rootDir: dir });
        const health = await safe.doctor();
        expect(health.checks.find((c) => c.name === 'no_orphan_staging')?.status).toBe('healthy');
        expect(health.status).toBe('healthy');

        // An old staging file with no pending command is reported through the wrapper.
        const staging = join(dir, 'pending-content');
        mkdirSync(staging, { recursive: true });
        const hash = createHash('sha256').update('orphan').digest('hex');
        writeFileSync(join(staging, hash), 'x');
        const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
        utimesSync(join(staging, hash), old, old);
        const degraded = await safe.doctor();
        expect(degraded.checks.find((c) => c.name === 'no_orphan_staging')?.status).toBe('degraded');

        // Explicit options win over the defaults the wrapper supplies.
        const other = join(dir, 'elsewhere');
        const overridden = await safe.doctor({ dataDir: other });
        expect(overridden.checks.find((c) => c.name === 'no_orphan_staging')?.status).toBe('healthy');
    });

    it('verify() always includes the command-receipt bijection check', async () => {
        const safe = createSafeCluster({ rootDir: dir });
        const health = await safe.verify();
        expect(health.checks.find((c) => c.name === 'command_receipt_bijection')?.status).toBe('healthy');
    });

    it('backup() and restore() round-trip through the safe cluster, carrying staging files by data directory', async () => {
        const source = createSafeCluster({ rootDir: join(dir, 'source') });
        const { entity } = await source.kernel.createEntity({ kind: 'note', name: 'safe-note', attributes: {}, actorId: 'op' });
        const stagingDir = join(dir, 'source', 'pending-content');
        mkdirSync(stagingDir, { recursive: true });
        const bytes = Buffer.from('staged for restore');
        const hash = createHash('sha256').update(bytes).digest('hex');
        writeFileSync(join(stagingDir, hash), bytes);

        const snapshot = await source.backup();
        expect(snapshot.entities.map((e) => e.id)).toEqual([entity.id]);
        expect(snapshot.staging).toEqual([{ contentHash: hash, content: bytes.toString('base64') }]);

        const target = createSafeCluster({ rootDir: join(dir, 'target') });
        const result = await target.restore(snapshot);
        expect(result.entities.created).toBe(1);
        expect(result.staging).toMatchObject({ restored: 1, skipped: 0, errors: [] });
        expect(existsSync(join(dir, 'target', 'pending-content', hash))).toBe(true);
        expect((await target.backup({ includeContent: false })).entities[0].name).toBe('safe-note');
    });
});
