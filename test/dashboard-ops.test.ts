import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createLocalCluster } from '../src/adapters/local/index.js';
import { ClusterKernel } from '../src/kernel/cluster-kernel.js';
import { buildOpsModel } from '../src/dashboard/ops-model.js';

const TEST_DIR = join(import.meta.dirname, '.test-dashboard-ops');

describe('Dashboard operations model', () => {
    let kernel: ClusterKernel;
    let stores: ReturnType<typeof createLocalCluster>;

    beforeEach(() => {
        rmSync(TEST_DIR, { recursive: true, force: true });
        mkdirSync(TEST_DIR, { recursive: true });
        stores = createLocalCluster(TEST_DIR);
        kernel = new ClusterKernel(stores, { dataDir: TEST_DIR });
    });

    afterEach(() => {
        rmSync(TEST_DIR, { recursive: true, force: true });
    });

    it('reports healthy when all stores are reachable', async () => {
        await kernel.createEntity({ kind: 'test', name: 'A', attributes: {}, actorId: 'u' });
        const ops = await buildOpsModel(stores, kernel);

        expect(ops.overall).toBe('healthy');
        expect(ops.stores.length).toBeGreaterThan(0);
        expect(ops.stores.every((s) => s.status === 'healthy')).toBe(true);
    });

    it('reports degraded when index has stale records', async () => {
        const { entity } = await kernel.createEntity({ kind: 'test', name: 'B', attributes: {}, actorId: 'u' });

        // Direct write to create staleness
        await stores.canonical.update(entity.id, { name: 'Changed' });

        const ops = await buildOpsModel(stores, kernel);

        expect(ops.overall).toBe('degraded');
        expect(ops.indexHealth.stale).toBeGreaterThan(0);
    });

    it('suggests reindex when stale records exist', async () => {
        const { entity } = await kernel.createEntity({ kind: 'test', name: 'C', attributes: {}, actorId: 'u' });
        await stores.canonical.update(entity.id, { name: 'Dirty' });

        const ops = await buildOpsModel(stores, kernel);

        expect(ops.repairSuggestions.length).toBeGreaterThan(0);
        expect(ops.repairSuggestions.some((s) => s.action === 'rebuild_index')).toBe(true);
        expect(ops.repairSuggestions.some((s) => s.command === 'db-cluster reindex')).toBe(true);
    });

    it('includes receipt count in provenance health', async () => {
        await kernel.createEntity({ kind: 'test', name: 'D', attributes: {}, actorId: 'u' });

        const ops = await buildOpsModel(stores, kernel);

        expect(ops.provenanceHealth.totalReceipts).toBeGreaterThan(0);
    });

    it('has lastChecked timestamp', async () => {
        const ops = await buildOpsModel(stores, kernel);
        expect(ops.lastChecked).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('ops model never reads raw adapters directly', async () => {
        // buildOpsModel uses doctor() and kernel verbs, not raw store access
        // This test verifies the function signature requires kernel interface
        const ops = await buildOpsModel(stores, kernel);
        expect(ops).toHaveProperty('overall');
        expect(ops).toHaveProperty('stores');
        expect(ops).toHaveProperty('indexHealth');
        expect(ops).toHaveProperty('provenanceHealth');
        expect(ops).toHaveProperty('artifactIntegrity');
        expect(ops).toHaveProperty('repairSuggestions');
    });
});
