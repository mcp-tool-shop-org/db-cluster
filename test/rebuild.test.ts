import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createLocalCluster } from '../src/adapters/local/index.js';
import { ClusterKernel } from '../src/kernel/cluster-kernel.js';
import type { ClusterStores } from '../src/contracts/index.js';

const TEST_DIR = join(import.meta.dirname, '.test-rebuild');

describe('Index rebuild and status', () => {
    let cluster: ClusterStores;
    let kernel: ClusterKernel;

    beforeEach(() => {
        rmSync(TEST_DIR, { recursive: true, force: true });
        mkdirSync(TEST_DIR, { recursive: true });
        cluster = createLocalCluster(TEST_DIR);
        kernel = new ClusterKernel(cluster, { dataDir: TEST_DIR });
    });

    afterEach(() => {
        rmSync(TEST_DIR, { recursive: true, force: true });
    });

    describe('rebuildIndex', () => {
        it('rebuilds empty index from empty cluster', async () => {
            const result = await kernel.rebuildIndex('user-1');
            expect(result.rebuilt).toBe(0);
            expect(result.provenance.action).toBe('index_rebuilt');
            expect(result.receipt).toBeTruthy();
        });

        it('rebuilds index from canonical and artifact stores', async () => {
            // Populate
            await kernel.createEntity({ kind: 'a', name: 'One', attributes: {}, actorId: 'u' });
            await kernel.createEntity({ kind: 'b', name: 'Two', attributes: {}, actorId: 'u' });
            await kernel.ingestArtifact({
                filename: 'f.txt',
                content: Buffer.from('x'),
                mimeType: 'text/plain',
                actorId: 'u',
            });

            // Destroy index
            await cluster.index.clear();
            expect(await cluster.index.count()).toBe(0);

            // Rebuild
            const result = await kernel.rebuildIndex('u');
            expect(result.rebuilt).toBe(3);
            expect(await cluster.index.count()).toBe(3);
        });

        it('rebuild produces records that resolve back to owner stores', async () => {
            const { entity } = await kernel.createEntity({
                kind: 'test',
                name: 'Findable',
                attributes: { x: 1 },
                actorId: 'u',
            });

            // Destroy and rebuild
            await cluster.index.clear();
            await kernel.rebuildIndex('u');

            // Find still works
            const found = await kernel.findSources({ query: 'Findable' });
            expect(found.resolvedEntities).toHaveLength(1);
            expect(found.resolvedEntities[0].id).toBe(entity.id);
        });

        it('rebuild is idempotent — same result on double rebuild', async () => {
            await kernel.createEntity({ kind: 'a', name: 'X', attributes: {}, actorId: 'u' });
            await kernel.ingestArtifact({
                filename: 'y.md',
                content: Buffer.from('y'),
                mimeType: 'text/markdown',
                actorId: 'u',
            });

            const r1 = await kernel.rebuildIndex('u');
            const r2 = await kernel.rebuildIndex('u');
            expect(r1.rebuilt).toBe(r2.rebuilt);
            expect(await cluster.index.count()).toBe(2);
        });

        it('rebuild emits provenance and receipt', async () => {
            const result = await kernel.rebuildIndex('u');
            expect(result.provenance.action).toBe('index_rebuilt');
            expect(result.provenance.actorId).toBe('u');
            expect(result.receipt.resultSummary).toContain('Index rebuilt');
        });
    });

    describe('indexStatus', () => {
        it('reports zero for empty cluster', async () => {
            const status = await kernel.indexStatus();
            expect(status.total).toBe(0);
            expect(status.expectedTotal).toBe(0);
            expect(status.possiblyStale).toBe(false);
        });

        it('reports correct counts after population', async () => {
            await kernel.createEntity({ kind: 'a', name: 'One', attributes: {}, actorId: 'u' });
            await kernel.ingestArtifact({
                filename: 'f.txt',
                content: Buffer.from('x'),
                mimeType: 'text/plain',
                actorId: 'u',
            });

            const status = await kernel.indexStatus();
            expect(status.total).toBe(2);
            expect(status.expectedTotal).toBe(2);
            expect(status.byStore['canonical']).toBe(1);
            expect(status.byStore['artifact']).toBe(1);
            expect(status.possiblyStale).toBe(false);
        });

        it('detects staleness when index is cleared', async () => {
            await kernel.createEntity({ kind: 'a', name: 'X', attributes: {}, actorId: 'u' });
            await cluster.index.clear();

            const status = await kernel.indexStatus();
            expect(status.total).toBe(0);
            expect(status.expectedTotal).toBe(1);
            expect(status.possiblyStale).toBe(true);
        });

        it('detects staleness when entity added without re-index', async () => {
            await kernel.createEntity({ kind: 'a', name: 'X', attributes: {}, actorId: 'u' });

            // Manually add a canonical entity bypassing kernel (simulating drift)
            await cluster.canonical.create({ kind: 'b', name: 'Y', attributes: {} });

            const status = await kernel.indexStatus();
            // Index has 1 (from kernel.createEntity), canonical has 2
            expect(status.total).toBe(1);
            expect(status.expectedTotal).toBe(2);
            expect(status.possiblyStale).toBe(true);
        });
    });
});
