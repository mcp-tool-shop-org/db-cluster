import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createLocalCluster } from '../src/adapters/local/index.js';
import { ClusterKernel } from '../src/kernel/cluster-kernel.js';
import { storeToSourceType, buildUri } from '../src/dashboard/dashboard-model.js';
import { inspectEntity, inspectIndexRecord, inspectCommandObject } from '../src/dashboard/inspector-data.js';
import type { DashboardObject } from '../src/dashboard/dashboard-model.js';
import type { ClusterStores } from '../src/contracts/index.js';

const TEST_DIR = join(import.meta.dirname, '.test-dashboard-model');

describe('Dashboard data model', () => {
    let kernel: ClusterKernel;
    let cluster: ClusterStores;

    beforeEach(() => {
        rmSync(TEST_DIR, { recursive: true, force: true });
        mkdirSync(TEST_DIR, { recursive: true });
        cluster = createLocalCluster(TEST_DIR);
        kernel = new ClusterKernel(cluster, { dataDir: TEST_DIR });
    });

    afterEach(() => {
        rmSync(TEST_DIR, { recursive: true, force: true });
    });

    describe('storeToSourceType', () => {
        it('maps canonical to owner-truth', () => {
            expect(storeToSourceType('canonical')).toBe('owner-truth');
        });

        it('maps artifact to source-truth', () => {
            expect(storeToSourceType('artifact')).toBe('source-truth');
        });

        it('maps index to derivative', () => {
            expect(storeToSourceType('index')).toBe('derivative');
        });

        it('maps ledger to append-only', () => {
            expect(storeToSourceType('ledger')).toBe('append-only');
        });
    });

    describe('buildUri', () => {
        it('builds a cluster URI', () => {
            expect(buildUri('canonical', 'entity', 'abc-123')).toBe('cluster://canonical/entity/abc-123');
        });
    });

    describe('inspectEntity', () => {
        it('returns a DashboardObject with owner-truth source type', async () => {
            const { entity } = await kernel.createEntity({
                kind: 'concept',
                name: 'TestConcept',
                attributes: { domain: 'testing' },
                actorId: 'user',
            });

            const dashboard = await inspectEntity(kernel, entity.id);

            expect(dashboard.type).toBe('entity');
            expect(dashboard.ownerStore).toBe('canonical');
            expect(dashboard.sourceType).toBe('owner-truth');
            expect(dashboard.name).toBe('TestConcept');
            expect(dashboard.uri).toContain('cluster://canonical/entity/');
            expect(dashboard.freshness).toBe('fresh');
            expect(dashboard.object).toHaveProperty('kind', 'concept');
            expect(dashboard.object).toHaveProperty('attributes');
        });

        it('includes provenance graph with nodes', async () => {
            const { entity } = await kernel.createEntity({
                kind: 'feature',
                name: 'GraphTest',
                attributes: {},
                actorId: 'user',
            });

            const dashboard = await inspectEntity(kernel, entity.id);

            expect(dashboard.provenanceGraph).toBeDefined();
            expect(dashboard.provenanceGraph.nodes).toBeDefined();
            expect(dashboard.provenanceGraph.edges).toBeDefined();
            expect(dashboard.provenanceGraph.warnings).toBeDefined();
        });

        it('includes receipts from kernel', async () => {
            const { entity } = await kernel.createEntity({
                kind: 'task',
                name: 'ReceiptTest',
                attributes: {},
                actorId: 'user',
            });

            const dashboard = await inspectEntity(kernel, entity.id);

            expect(dashboard.receipts).toBeDefined();
            expect(Array.isArray(dashboard.receipts)).toBe(true);
        });

        it('reports stale freshness when index is out of date', async () => {
            const { entity } = await kernel.createEntity({
                kind: 'concept',
                name: 'WillGoStale',
                attributes: {},
                actorId: 'user',
            });

            // Direct store write bypasses kernel auto-index
            await cluster.canonical.update(entity.id, { name: 'Changed' });

            const dashboard = await inspectEntity(kernel, entity.id);
            expect(dashboard.freshness).toBe('stale');
            expect(dashboard.warnings.length).toBeGreaterThan(0);
            expect(dashboard.warnings[0].type).toBe('stale_index');
        });
    });

    describe('inspectIndexRecord', () => {
        it('returns a DashboardObject with derivative source type', async () => {
            const { indexRecord } = await kernel.createEntity({
                kind: 'test',
                name: 'IndexTest',
                attributes: {},
                actorId: 'user',
            });

            const dashboard = await inspectIndexRecord(kernel, indexRecord.id);

            expect(dashboard.type).toBe('index_record');
            expect(dashboard.ownerStore).toBe('index');
            expect(dashboard.sourceType).toBe('derivative');
            expect(dashboard.freshness).toBe('fresh');
        });

        it('reports stale when source has changed', async () => {
            const { entity, indexRecord } = await kernel.createEntity({
                kind: 'test',
                name: 'StaleIndex',
                attributes: {},
                actorId: 'user',
            });

            // Direct write creates staleness
            await cluster.canonical.update(entity.id, { name: 'DifferentName' });

            const dashboard = await inspectIndexRecord(kernel, indexRecord.id);
            expect(dashboard.freshness).toBe('stale');
            expect(dashboard.warnings.some((w) => w.type === 'stale_index')).toBe(true);
        });
    });

    describe('inspectCommandObject', () => {
        it('returns a DashboardObject with command state', async () => {
            const { entity } = await kernel.createEntity({
                kind: 'test',
                name: 'CmdTarget',
                attributes: {},
                actorId: 'user',
            });

            const cmd = await kernel.proposeMutation({
                verb: 'update_entity',
                targetStore: 'canonical',
                payload: { entityId: entity.id, patch: { name: 'Updated' } },
                proposedBy: 'agent',
            });

            const dashboard = await inspectCommandObject(kernel, cmd.id);

            expect(dashboard.type).toBe('command');
            expect(dashboard.ownerStore).toBe('ledger');
            expect(dashboard.sourceType).toBe('append-only');
            expect(dashboard.commandState).toBeDefined();
            expect(dashboard.commandState!.status).toBe('proposed');
            expect(dashboard.commandState!.verb).toBe('update_entity');
            expect(dashboard.commandState!.proposedBy).toBe('agent');
        });

        it('shows rejected command with warning', async () => {
            const { entity } = await kernel.createEntity({
                kind: 'test',
                name: 'RejectTarget',
                attributes: {},
                actorId: 'user',
            });

            const cmd = await kernel.proposeMutation({
                verb: 'update_entity',
                targetStore: 'canonical',
                payload: { entityId: entity.id, patch: { name: 'Nope' } },
                proposedBy: 'agent',
            });
            await kernel.validateMutation(cmd.id);
            await kernel.rejectMutation(cmd.id, 'operator', 'Not appropriate');

            const dashboard = await inspectCommandObject(kernel, cmd.id);

            expect(dashboard.commandState!.status).toBe('rejected');
            expect(dashboard.warnings.some((w) => w.type === 'rejected_command')).toBe(true);
        });
    });

    describe('DashboardObject shape contract', () => {
        it('always includes uri, ownerStore, sourceType, and freshness', async () => {
            const { entity } = await kernel.createEntity({
                kind: 'test',
                name: 'ShapeTest',
                attributes: {},
                actorId: 'user',
            });

            const dashboard = await inspectEntity(kernel, entity.id);

            // Required fields per contract
            expect(dashboard).toHaveProperty('uri');
            expect(dashboard).toHaveProperty('id');
            expect(dashboard).toHaveProperty('type');
            expect(dashboard).toHaveProperty('name');
            expect(dashboard).toHaveProperty('ownerStore');
            expect(dashboard).toHaveProperty('sourceType');
            expect(dashboard).toHaveProperty('freshness');
            expect(dashboard).toHaveProperty('object');
            expect(dashboard).toHaveProperty('relationships');
            expect(dashboard).toHaveProperty('provenanceGraph');
            expect(dashboard).toHaveProperty('receipts');
            expect(dashboard).toHaveProperty('warnings');
        });
    });
});
