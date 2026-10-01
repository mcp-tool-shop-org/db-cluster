/**
 * Coverage — ops/doctor: every check driven into each status it reports.
 * Unreachable stores are simulated by overlaying a single method on a real
 * local store; the Postgres probe uses an in-test pool that records the
 * query it receives.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createLocalCluster } from '../src/adapters/local/index.js';
import { ClusterKernel } from '../src/kernel/cluster-kernel.js';
import { doctor } from '../src/ops/doctor.js';
import type { ClusterHealth, HealthCheck } from '../src/types/health.js';
import type { ClusterStores } from '../src/contracts/index.js';
import type { Command } from '../src/types/command.js';

const ACTOR = 'operator';

function overlay<T extends object>(target: T, overrides: Record<string, unknown>): T {
    return new Proxy(target, {
        get(t, prop) {
            if (typeof prop === 'string' && prop in overrides) return overrides[prop];
            const value = Reflect.get(t, prop, t);
            return typeof value === 'function' ? value.bind(t) : value;
        },
    });
}

function check(health: ClusterHealth, name: string): HealthCheck {
    const found = health.checks.find((c) => c.name === name);
    if (!found) throw new Error(`no check named ${name}; have ${health.checks.map((c) => c.name).join(', ')}`);
    return found;
}

describe('doctor() — store reachability and index population', () => {
    let dir: string;
    let stores: ClusterStores;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'cov-doctor-'));
        stores = createLocalCluster(dir);
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('a fresh empty cluster is healthy, with every reachability check passing', async () => {
        const health = await doctor(stores);
        expect(health.status).toBe('healthy');
        for (const name of ['canonical_reachable', 'artifact_reachable', 'index_reachable', 'ledger_reachable']) {
            expect(check(health, name)).toMatchObject({ status: 'healthy', severity: 'info' });
        }
        expect(check(health, 'index_populated').message).toBe('Index is empty (cluster has no data yet).');
        expect(check(health, 'policy_defaults').message).toMatch(/^Policy engine loaded \d+ default policies\.$/);
        expect(check(health, 'no_orphaned_mutations').status).toBe('healthy');
        // Optional checks are absent without their inputs.
        expect(health.checks.map((c) => c.name)).not.toContain('no_orphan_staging');
        expect(health.checks.map((c) => c.name)).not.toContain('postgres_migration');
        expect(health.checks.map((c) => c.name)).not.toContain('command_receipt_bijection');
    });

    it('reports each unreachable store with its own remediation; the worst check (a corrupt ledger chain) sets the rollup', async () => {
        const broken: ClusterStores = {
            canonical: overlay(stores.canonical, { list: async () => { throw new Error('canonical down'); } }),
            artifact: overlay(stores.artifact, { list: async () => { throw new Error('artifact down'); } }),
            index: overlay(stores.index, { count: async () => { throw new Error('index down'); } }),
            ledger: overlay(stores.ledger, { listEvents: async () => { throw new Error('ledger down'); } }),
        };
        const health = await doctor(broken);
        // An unreadable ledger also fails the integrity-chain check as corrupt, which outranks unreachable.
        expect(check(health, 'ledger_integrity_chain').status).toBe('corrupt');
        expect(health.status).toBe('corrupt');

        const canonical = check(health, 'canonical_reachable');
        expect(canonical).toMatchObject({ status: 'unreachable', severity: 'error', store: 'canonical' });
        expect(canonical.message).toBe('Canonical store unreachable: canonical down');
        expect(canonical.nextSteps?.[0]).toContain('DB_CLUSTER_CANONICAL_BACKEND');

        expect(check(health, 'artifact_reachable').message).toBe('Artifact store unreachable: artifact down');

        const index = check(health, 'index_reachable');
        expect(index.message).toBe('Index store unreachable: index down');
        expect(index.repairAvailable).toBe(true);
        expect(index.suggestedCommand).toBe('db-cluster rebuild index');

        const ledger = check(health, 'ledger_reachable');
        expect(ledger.message).toBe('Ledger store unreachable: ledger down');
        expect(ledger.nextSteps?.[1]).toContain('db-cluster restore');

        // The index_populated probe swallows the same failure instead of throwing.
        expect(health.checks.map((c) => c.name)).not.toContain('index_populated');
        // The orphan check surfaces the ledger failure rather than hiding it.
        expect(check(health, 'no_orphaned_mutations')).toMatchObject({ status: 'unreachable' });
    });

    it('an empty index over populated truth is degraded and points at the rebuild', async () => {
        const kernel = new ClusterKernel(stores);
        await kernel.createEntity({ kind: 'note', name: 'x', attributes: {}, actorId: ACTOR });
        await stores.index.clear();
        const health = await doctor(stores);
        const populated = check(health, 'index_populated');
        expect(populated).toMatchObject({ status: 'degraded', severity: 'warning', repairAvailable: true });
        expect(populated.suggestedCommand).toBe('db-cluster rebuild index');
        expect(health.status).toBe('degraded');
    });

    it('a populated index reports its record count', async () => {
        const kernel = new ClusterKernel(stores);
        await kernel.createEntity({ kind: 'note', name: 'x', attributes: {}, actorId: ACTOR });
        expect(check(await doctor(stores), 'index_populated').message).toBe('Index contains 1 records.');
    });

    it('an empty index over an artifact-only cluster is also degraded', async () => {
        const kernel = new ClusterKernel(stores);
        await kernel.ingestArtifact({ filename: 'a.txt', content: Buffer.from('a'), mimeType: 'text/plain', actorId: ACTOR });
        await stores.index.clear();
        expect(check(await doctor(stores), 'index_populated').status).toBe('degraded');
    });

    it('onProgress receives every step with the same total, and a throwing callback does not abort', async () => {
        const steps: Array<[number, number, string]> = [];
        await doctor(stores, { onProgress: (c, t, m) => steps.push([c, t, String(m)]) });
        expect(steps.map((s) => s[0])).toEqual(steps.map((_, i) => i + 1));
        expect(new Set(steps.map((s) => s[1])).size).toBe(1);
        expect(steps[0][2]).toBe('canonical_reachable');
        expect(steps.map((s) => s[2])).toContain('ledger_integrity_chain');

        const health = await doctor(stores, { onProgress: () => { throw new Error('ui crashed'); } });
        expect(health.status).toBe('healthy');
    });
});

describe('doctor() — Postgres migration probe', () => {
    let dir: string;
    let stores: ClusterStores;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'cov-doctor-pg-'));
        stores = createLocalCluster(dir);
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('asks information_schema for the required tables and reports healthy when they exist', async () => {
        const seen: Array<{ text: string; values?: unknown[] }> = [];
        const pool = {
            query: async (text: string, values?: unknown[]) => {
                seen.push({ text, values });
                return { rows: [{ table_name: 'canonical_entities' }] };
            },
        };
        const health = await doctor(stores, { postgresPool: pool });
        expect(seen).toHaveLength(1);
        expect(seen[0].text).toContain('information_schema.tables');
        expect(seen[0].text).toContain('IN ($1)');
        expect(seen[0].values).toEqual(['canonical_entities']);
        expect(check(health, 'postgres_migration')).toMatchObject({
            status: 'healthy', store: 'migration',
            message: 'Postgres required tables exist: canonical_entities.',
        });
    });

    it('reports a missing required table as a missing/error check with remediation', async () => {
        const pool = { query: async () => ({ rows: [] }) };
        const health = await doctor(stores, { postgresPool: pool });
        const pg = check(health, 'postgres_migration');
        expect(pg).toMatchObject({ status: 'missing', severity: 'error' });
        expect(pg.message).toContain('Postgres required table(s) not found: canonical_entities.');
        expect(pg.nextSteps?.[1]).toContain('PostgresCanonicalStore.migrate()');
        expect(health.status).toBe('missing');
    });

    it('reports a failing Postgres connection as unreachable and scrubs filesystem paths from the message', async () => {
        const pool = {
            query: async () => { throw new Error('connect ENOENT /var/run/postgresql/.s.PGSQL.5432'); },
        };
        const health = await doctor(stores, { postgresPool: pool });
        const pg = check(health, 'postgres_migration');
        expect(pg.status).toBe('unreachable');
        expect(pg.message).toContain('Postgres health check failed: connect ENOENT');
        expect(pg.message).not.toContain('/var/run/postgresql');
    });
});

describe('doctor() — orphaned mutations', () => {
    let dir: string;
    let stores: ClusterStores;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'cov-doctor-orphan-'));
        stores = createLocalCluster(dir);
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    async function orphan(n: number) {
        for (let i = 0; i < n; i++) {
            await stores.ledger.append({
                action: 'mutation_orphaned', actorId: 'kernel', subjectId: `s${i}`, subjectStore: 'canonical', detail: {},
            });
        }
    }

    it('reports orphaned mutation events as degraded with the verify command', async () => {
        await orphan(2);
        const health = await doctor(stores);
        const c = check(health, 'no_orphaned_mutations');
        expect(c).toMatchObject({ status: 'degraded', severity: 'warning', suggestedCommand: 'db-cluster verify' });
        expect(c.message).toContain('2 orphaned mutation event(s) recorded.');
        expect(c.message).not.toContain('showing first');
        expect(health.status).toBe('degraded');
    });

    it('notes when the orphan count exceeds the 100-event sample', async () => {
        await orphan(101);
        const c = check(await doctor(stores), 'no_orphaned_mutations');
        expect(c.message).toContain('101 orphaned mutation event(s) recorded (showing first 100).');
    });
});

describe('doctor() — staging files and command queue', () => {
    let dir: string;
    let stores: ClusterStores;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'cov-doctor-staging-'));
        stores = createLocalCluster(join(dir, 'cluster'));
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    const hashOf = (s: string) => createHash('sha256').update(s).digest('hex');
    function stagingFile(dataDir: string, hash: string, ageMs: number) {
        const staging = join(dataDir, 'pending-content');
        mkdirSync(staging, { recursive: true });
        const p = join(staging, hash);
        writeFileSync(p, 'x');
        const when = new Date(Date.now() - ageMs);
        utimesSync(p, when, when);
    }
    const HOUR = 60 * 60 * 1000;

    it('flags old unreferenced staging files, ignoring young, referenced and non-hash entries', async () => {
        const dataDir = join(dir, 'data');
        const orphanHash = hashOf('orphan');
        const referencedHash = hashOf('referenced');
        stagingFile(dataDir, orphanHash, 3 * HOUR);
        stagingFile(dataDir, referencedHash, 3 * HOUR);
        stagingFile(dataDir, hashOf('young'), 1000);
        writeFileSync(join(dataDir, 'pending-content', 'notes.txt'), 'ignored');

        const queue = {
            list: (): Command[] => [{
                id: 'cmd-1', verb: 'ingest_artifact', targetStore: 'artifact',
                payload: { contentHash: referencedHash }, proposedAt: new Date().toISOString(),
                proposedBy: ACTOR, status: 'validated',
            }],
        };
        const health = await doctor(stores, { dataDir, commandQueue: queue });
        const c = check(health, 'no_orphan_staging');
        expect(c).toMatchObject({ status: 'degraded', severity: 'warning', store: 'cluster' });
        expect(c.message).toContain('1 orphan staging file(s) in pending-content/ (oldest 180 min)');
        expect(health.checks.map((x) => x.name)).toContain('command_receipt_bijection');
    });

    it('without a command queue every old staging file counts as an orphan', async () => {
        const dataDir = join(dir, 'data');
        stagingFile(dataDir, hashOf('a'), 2 * HOUR);
        stagingFile(dataDir, hashOf('b'), 5 * HOUR);
        const c = check(await doctor(stores, { dataDir }), 'no_orphan_staging');
        expect(c.status).toBe('degraded');
        expect(c.message).toContain('2 orphan staging file(s)');
        expect(c.message).toContain('(oldest 300 min)');
    });

    it('a command queue that throws is tolerated: the file is simply treated as unreferenced', async () => {
        const dataDir = join(dir, 'data');
        stagingFile(dataDir, hashOf('a'), 2 * HOUR);
        const queue = { list: (): Command[] => { throw new Error('queue locked'); } };
        const health = await doctor(stores, { dataDir, commandQueue: queue });
        expect(check(health, 'no_orphan_staging').status).toBe('degraded');
        // The bijection check surfaces the unreadable queue on its own.
        expect(check(health, 'command_receipt_bijection').status).toBe('corrupt');
    });

    it('is healthy when the directory is absent, empty, or not a directory', async () => {
        expect(check(await doctor(stores, { dataDir: join(dir, 'nowhere') }), 'no_orphan_staging').message)
            .toBe('No orphan staging files in pending-content/.');

        const emptyDir = join(dir, 'empty');
        mkdirSync(join(emptyDir, 'pending-content'), { recursive: true });
        expect(check(await doctor(stores, { dataDir: emptyDir }), 'no_orphan_staging').status).toBe('healthy');

        const fileDir = join(dir, 'filedir');
        mkdirSync(fileDir, { recursive: true });
        writeFileSync(join(fileDir, 'pending-content'), 'a file, not a dir');
        expect(check(await doctor(stores, { dataDir: fileDir }), 'no_orphan_staging').status).toBe('healthy');
    });

    it('turns a failure inside the staging check into an unreachable check instead of throwing', async () => {
        const health = await doctor(stores, { dataDir: 12345 as unknown as string });
        const c = check(health, 'no_orphan_staging');
        expect(c).toMatchObject({ status: 'unreachable', severity: 'error', store: 'cluster' });
        expect(c.message).toMatch(/^Orphan-staging check failed: /);
    });
});
