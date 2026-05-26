import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createLocalCluster } from '../src/adapters/local/index.js';
import { ClusterKernel } from '../src/kernel/cluster-kernel.js';
import { NotFoundError } from '../src/kernel/errors.js';
import type { ClusterStores } from '../src/contracts/index.js';

const TEST_DIR = join(import.meta.dirname, '.test-explain');

describe('Index explain and stale detection', () => {
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

    describe('explainIndex', () => {
        it('explains a fresh entity index record', async () => {
            const { entity, indexRecord } = await kernel.createEntity({
                kind: 'concept',
                name: 'Freshness',
                attributes: { x: 1 },
                actorId: 'u',
            });

            const explanation = await kernel.explainIndex(indexRecord.id);
            expect(explanation.indexRecordId).toBe(indexRecord.id);
            expect(explanation.sourceId).toBe(entity.id);
            expect(explanation.sourceStore).toBe('canonical');
            expect(explanation.sourceExists).toBe(true);
            expect(explanation.stale).toBe(false);
            expect(explanation.sourceObject).not.toBeNull();
        });

        it('explains a fresh artifact index record', async () => {
            const { artifact, indexRecord } = await kernel.ingestArtifact({
                filename: 'doc.md',
                content: Buffer.from('content'),
                mimeType: 'text/markdown',
                actorId: 'u',
            });

            const explanation = await kernel.explainIndex(indexRecord.id);
            expect(explanation.sourceId).toBe(artifact.id);
            expect(explanation.sourceStore).toBe('artifact');
            expect(explanation.sourceExists).toBe(true);
            expect(explanation.stale).toBe(false);
        });

        it('detects stale when entity was renamed', async () => {
            const { entity, indexRecord } = await kernel.createEntity({
                kind: 'test',
                name: 'Original',
                attributes: {},
                actorId: 'u',
            });

            // Mutate the entity name through command
            const cmd = await kernel.proposeMutation({
                verb: 'update_entity',
                targetStore: 'canonical',
                payload: { entityId: entity.id, patch: { name: 'Renamed' } },
                proposedBy: 'u',
            });
            await kernel.commitMutation(cmd.id, 'u');

            // Index record still has old text
            const explanation = await kernel.explainIndex(indexRecord.id);
            expect(explanation.stale).toBe(true);
            expect(explanation.staleCause).toContain('does not match');
            expect(explanation.sourceExists).toBe(true);
        });

        it('throws NotFoundError for unknown record ID', async () => {
            await expect(kernel.explainIndex('nonexistent')).rejects.toThrow(NotFoundError);
        });
    });

    describe('listStaleRecords', () => {
        it('returns empty for fresh cluster', async () => {
            await kernel.createEntity({ kind: 'a', name: 'X', attributes: {}, actorId: 'u' });
            await kernel.ingestArtifact({
                filename: 'f.txt',
                content: Buffer.from('x'),
                mimeType: 'text/plain',
                actorId: 'u',
            });

            const stale = await kernel.listStaleRecords();
            expect(stale).toHaveLength(0);
        });

        it('detects stale record after entity rename', async () => {
            const { entity } = await kernel.createEntity({
                kind: 'test',
                name: 'Before',
                attributes: {},
                actorId: 'u',
            });

            // Rename via command
            const cmd = await kernel.proposeMutation({
                verb: 'update_entity',
                targetStore: 'canonical',
                payload: { entityId: entity.id, patch: { name: 'After' } },
                proposedBy: 'u',
            });
            await kernel.commitMutation(cmd.id, 'u');

            const stale = await kernel.listStaleRecords();
            expect(stale.length).toBeGreaterThan(0);
            expect(stale[0].cause).toContain('does not match');
        });

        it('rebuild clears all staleness', async () => {
            const { entity } = await kernel.createEntity({
                kind: 'test',
                name: 'Original',
                attributes: {},
                actorId: 'u',
            });

            // Rename to create staleness
            const cmd = await kernel.proposeMutation({
                verb: 'update_entity',
                targetStore: 'canonical',
                payload: { entityId: entity.id, patch: { name: 'Changed' } },
                proposedBy: 'u',
            });
            await kernel.commitMutation(cmd.id, 'u');

            // Confirm stale
            expect((await kernel.listStaleRecords()).length).toBeGreaterThan(0);

            // Rebuild
            await kernel.rebuildIndex('u');

            // No more staleness
            const staleAfter = await kernel.listStaleRecords();
            expect(staleAfter).toHaveLength(0);
        });
    });
});
