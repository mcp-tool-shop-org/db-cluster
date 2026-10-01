/**
 * Coverage — dashboard ops model (buildOpsModel): overall health roll-up,
 * orphan/total event counting and its degraded signal, index health maths,
 * and repair-suggestion assembly. Real local stores underneath, the kernel
 * argument is the structural subset buildOpsModel documents.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLocalCluster } from '../src/adapters/local/index.js';
import { ClusterKernel } from '../src/kernel/cluster-kernel.js';
import type { IndexStatusResult } from '../src/kernel/cluster-kernel.js';
import { buildOpsModel } from '../src/dashboard/ops-model.js';
import type { ClusterStores } from '../src/contracts/index.js';

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

function kernelStub(overrides: {
    indexStatus?: Partial<IndexStatusResult>;
    stale?: unknown[];
    receipts?: unknown[];
} = {}) {
    const status: IndexStatusResult = { total: 0, byStore: {}, expectedTotal: 0, possiblyStale: false, ...overrides.indexStatus };
    return {
        indexStatus: async () => status,
        listStaleRecords: async () => overrides.stale ?? [],
        listReceipts: async () => overrides.receipts ?? [],
    };
}

describe('buildOpsModel()', () => {
    let dir: string;
    let stores: ClusterStores;
    let kernel: ClusterKernel;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'cov-opsmodel-'));
        stores = createLocalCluster(dir);
        kernel = new ClusterKernel(stores);
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('a healthy cluster reports healthy with real event and receipt counts and no repair suggestions', async () => {
        await kernel.createEntity({ kind: 'note', name: 'one', attributes: {}, actorId: ACTOR });
        const model = await buildOpsModel(stores, kernel);
        expect(model.overall).toBe('healthy');
        expect(model.provenanceHealth.totalEvents).toBe(1);
        expect(model.provenanceHealth.totalReceipts).toBe(1);
        expect(model.provenanceHealth.orphanEvents).toBe(0);
        expect(model.provenanceHealth.degradedReason).toBeUndefined();
        expect(model.repairSuggestions).toEqual([]);
        expect(model.indexHealth).toEqual({ total: 1, fresh: 1, stale: 0, missing: 0 });
        expect(model.artifactIntegrity).toEqual({ total: 1, verified: 1, corrupt: 0 });
        expect(model.stores.map((s) => s.store).sort()).toEqual(['artifact', 'canonical', 'index', 'ledger']);
        expect(new Date(model.lastChecked).toString()).not.toBe('Invalid Date');
    });

    it('orphaned mutations degrade the cluster and add an investigation suggestion and reason', async () => {
        for (let i = 0; i < 2; i++) {
            await stores.ledger.append({ action: 'mutation_orphaned', actorId: 'kernel', subjectId: `s${i}`, subjectStore: 'canonical', detail: {} });
        }
        const model = await buildOpsModel(stores, kernel);
        expect(model.overall).toBe('degraded');
        expect(model.provenanceHealth.orphanEvents).toBe(2);
        expect(model.provenanceHealth.degradedReason).toBe('2 mutation_orphaned event(s) detected — see verify --json');
        const suggestion = model.repairSuggestions.find((s) => s.action === 'investigate_orphaned');
        expect(suggestion).toMatchObject({ command: 'db-cluster verify --json', severity: 'warn' });
        expect(suggestion?.description).toContain('2 mutation_orphaned event(s)');
    });

    it('an unavailable orphan count yields null, a degraded cluster and an error-severity suggestion', async () => {
        const ledger = overlay(stores.ledger, {
            countEvents: async (filter?: { action?: string }) => {
                if (filter?.action === 'mutation_orphaned') throw new Error('count failed');
                return 7;
            },
        });
        const model = await buildOpsModel({ ...stores, ledger }, kernelStub());
        expect(model.provenanceHealth.orphanEvents).toBeNull();
        expect(model.provenanceHealth.totalEvents).toBe(7);
        expect(model.provenanceHealth.degradedReason).toBe('orphan_count_unavailable');
        expect(model.overall).toBe('degraded');
        const suggestion = model.repairSuggestions.find((s) => s.action === 'investigate_orphan_count_unavailable');
        expect(suggestion).toMatchObject({ command: 'db-cluster verify --json', severity: 'error' });
    });

    it('a failing total-event count is reported as null rather than zero', async () => {
        const ledger = overlay(stores.ledger, {
            countEvents: async (filter?: { action?: string }) => {
                if (filter?.action) return 0;
                throw new Error('total count failed');
            },
        });
        const model = await buildOpsModel({ ...stores, ledger }, kernelStub());
        expect(model.provenanceHealth.totalEvents).toBeNull();
        expect(model.provenanceHealth.orphanEvents).toBe(0);
        expect(model.overall).toBe('healthy');
    });

    it('an unreachable store makes the cluster unhealthy and is listed with its message', async () => {
        const canonical = overlay(stores.canonical, { list: async () => { throw new Error('canonical down'); } });
        const model = await buildOpsModel({ ...stores, canonical }, kernelStub());
        expect(model.overall).toBe('unhealthy');
        const row = model.stores.find((s) => s.store === 'canonical');
        expect(row).toEqual({ store: 'canonical', status: 'unhealthy', message: 'Canonical store unreachable: canonical down' });
    });

    it('stale index records degrade the cluster and add a rebuild suggestion; fresh counts are clamped at zero', async () => {
        const stale = [{ sourceId: 'a' }, { sourceId: 'b' }, { sourceId: 'c' }];
        const model = await buildOpsModel(stores, kernelStub({ indexStatus: { total: 2, expectedTotal: 5 }, stale }));
        expect(model.overall).toBe('degraded');
        expect(model.indexHealth).toEqual({ total: 2, fresh: 0, stale: 3, missing: 3 });
        expect(model.repairSuggestions[0]).toEqual({
            action: 'rebuild_index',
            command: 'db-cluster rebuild index',
            description: '3 stale index record(s) detected',
            severity: 'warn',
        });
    });

    it('surfaces a failing check\'s own suggested command and ignores repairable checks that carry none', async () => {
        // Index populated check: empty index over populated truth is degraded + repairable + has a command.
        await kernel.createEntity({ kind: 'note', name: 'x', attributes: {}, actorId: ACTOR });
        await stores.index.clear();
        const model = await buildOpsModel(stores, kernel);
        const repair = model.repairSuggestions.find((s) => s.action === 'repair_index_populated');
        expect(repair).toMatchObject({
            command: 'db-cluster rebuild index',
            severity: 'warn',
        });
        expect(repair?.description).toContain('Index is empty but canonical/artifact stores have records');
    });

    it('an unreachable index store produces an error-severity repair suggestion', async () => {
        const index = overlay(stores.index, { count: async () => { throw new Error('index down'); } });
        const model = await buildOpsModel({ ...stores, index }, kernelStub());
        expect(model.overall).toBe('unhealthy');
        const repair = model.repairSuggestions.find((s) => s.action === 'repair_index_reachable');
        expect(repair).toMatchObject({ command: 'db-cluster rebuild index', severity: 'error' });
    });

    it('forwards dataDir and commandQueue so the staging and bijection checks run', async () => {
        const model = await buildOpsModel(stores, kernelStub(), { dataDir: dir, commandQueue: { list: () => [] } });
        // Doctor ran with both options; the ops model itself stays healthy.
        expect(model.overall).toBe('healthy');
    });
});
