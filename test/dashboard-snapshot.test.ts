import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLocalCluster } from '../src/adapters/local/index.js';
import { ClusterKernel } from '../src/kernel/cluster-kernel.js';
import { generateSnapshot, type DashboardSnapshot } from '../scripts/dashboard-snapshot.js';

describe('Dashboard snapshot generation', () => {
    let snapshot: DashboardSnapshot;
    let TEST_DIR: string;

    beforeAll(async () => {
        TEST_DIR = mkdtempSync(join(tmpdir(), 'db-cluster-dashboard-snapshot-'));
        const cluster = createLocalCluster(TEST_DIR);
        const kernel = new ClusterKernel(cluster, { dataDir: TEST_DIR });

        // Populate a small dogfood cluster
        await kernel.createEntity({ kind: 'project', name: 'db-cluster', attributes: { phase: 12 }, actorId: 'user' });
        await kernel.createEntity({ kind: 'phase', name: 'Phase 12 Repair', attributes: { status: 'complete' }, actorId: 'user' });
        await kernel.createEntity({ kind: 'finding', name: 'restore() gap', attributes: { severity: 'high' }, actorId: 'user' });

        await kernel.ingestArtifact({
            filename: 'README.md',
            content: Buffer.from('# db-cluster\n\nA data control plane.'),
            mimeType: 'text/markdown',
            actorId: 'user',
        });

        // Create a command lifecycle
        const { entity } = await kernel.createEntity({ kind: 'decision', name: 'Use disk queue', attributes: {}, actorId: 'user' });
        const cmd = await kernel.proposeMutation({
            verb: 'update_entity',
            targetStore: 'canonical',
            payload: { entityId: entity.id, patch: { attributes: { rationale: 'no stale cache' } } },
            proposedBy: 'agent',
        });
        await kernel.validateMutation(cmd.id);
        await kernel.approveMutation(cmd.id, 'operator');
        await kernel.commitMutation(cmd.id, 'operator');

        // Generate snapshot
        snapshot = await generateSnapshot(TEST_DIR);
    });

    afterAll(() => {
        try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
    });

    it('snapshot contains objects from the cluster', () => {
        expect(snapshot.objects.length).toBeGreaterThan(0);
    });

    it('snapshot includes at least one entity with owner-truth', () => {
        const entity = snapshot.objects.find((o) => o.type === 'entity');
        expect(entity).toBeDefined();
        expect(entity!.ownerStore).toBe('canonical');
        expect(entity!.sourceType).toBe('owner-truth');
    });

    it('snapshot includes at least one index record labeled derivative', () => {
        const indexObj = snapshot.objects.find((o) => o.type === 'index_record');
        expect(indexObj).toBeDefined();
        expect(indexObj!.ownerStore).toBe('index');
        expect(indexObj!.sourceType).toBe('derivative');
    });

    it('snapshot includes at least one command with lifecycle state', () => {
        const cmd = snapshot.objects.find((o) => o.type === 'command');
        expect(cmd).toBeDefined();
        expect(cmd!.commandState).toBeDefined();
        expect(cmd!.commandState!.status).toBe('committed');
    });

    it('snapshot includes operations data', () => {
        expect(snapshot.operations).toBeDefined();
        expect(snapshot.operations.doctorStatus).toBeDefined();
        expect(snapshot.operations.indexStatus).toBeDefined();
    });

    it('snapshot has generatedAt timestamp', () => {
        expect(snapshot.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('every object has required DashboardObject fields', () => {
        for (const obj of snapshot.objects) {
            expect(obj).toHaveProperty('uri');
            expect(obj).toHaveProperty('id');
            expect(obj).toHaveProperty('type');
            expect(obj).toHaveProperty('ownerStore');
            expect(obj).toHaveProperty('sourceType');
            expect(obj).toHaveProperty('freshness');
            expect(obj).toHaveProperty('object');
            expect(obj).toHaveProperty('relationships');
            expect(obj).toHaveProperty('provenanceGraph');
            expect(obj).toHaveProperty('receipts');
            expect(obj).toHaveProperty('warnings');
        }
    });

    it('provenance graphs have nodes and edges arrays', () => {
        for (const obj of snapshot.objects) {
            expect(Array.isArray(obj.provenanceGraph.nodes)).toBe(true);
            expect(Array.isArray(obj.provenanceGraph.edges)).toBe(true);
            expect(Array.isArray(obj.provenanceGraph.warnings)).toBe(true);
        }
    });
});
