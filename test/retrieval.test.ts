import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createLocalCluster } from '../src/adapters/local/index.js';
import { ClusterKernel } from '../src/kernel/cluster-kernel.js';
import type { ClusterStores } from '../src/contracts/index.js';

const TEST_DIR = join(import.meta.dirname, '.test-retrieval');

describe('Retrieval Planner and Evidence Bundles', () => {
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

    describe('retrieveBundle', () => {
        it('returns a structured EvidenceBundle, not a list of hits', async () => {
            await kernel.createEntity({
                kind: 'concept',
                name: 'Federated Truth',
                attributes: { domain: 'architecture' },
                actorId: 'u',
            });
            await kernel.ingestArtifact({
                filename: 'design.md',
                content: Buffer.from('# Federated design doc'),
                mimeType: 'text/markdown',
                actorId: 'u',
            });

            const bundle = await kernel.retrieveBundle('Federated');

            expect(bundle.id).toBeTruthy();
            expect(bundle.query).toBe('Federated');
            expect(bundle.assembledAt).toBeTruthy();
            expect(bundle.resolvedEntities.length + bundle.resolvedArtifacts.length).toBeGreaterThan(0);
            expect(bundle.indexRecords.length).toBeGreaterThan(0);
            expect(bundle.freshness).toBeDefined();
            expect(bundle.missingContext).toBeDefined();
            expect(bundle.confidenceBoundaries).toBeDefined();
        });

        it('resolves entities to canonical truth with URIs', async () => {
            const { entity } = await kernel.createEntity({
                kind: 'thesis',
                name: 'Owner Truth',
                attributes: { confidence: 'high' },
                actorId: 'u',
            });

            const bundle = await kernel.retrieveBundle('Owner');

            expect(bundle.resolvedEntities).toHaveLength(1);
            const resolved = bundle.resolvedEntities[0];
            expect(resolved.object.id).toBe(entity.id);
            expect(resolved.uri).toBe(`cluster://canonical/${entity.id}`);
            expect(resolved.ownerStore).toBe('canonical');
            expect(resolved.indexStale).toBe(false);
        });

        it('resolves artifacts with provenance attached', async () => {
            const { artifact } = await kernel.ingestArtifact({
                filename: 'evidence.pdf',
                content: Buffer.from('evidence content'),
                mimeType: 'application/pdf',
                actorId: 'u',
            });

            const bundle = await kernel.retrieveBundle('evidence');

            expect(bundle.resolvedArtifacts).toHaveLength(1);
            const resolved = bundle.resolvedArtifacts[0];
            expect(resolved.object.id).toBe(artifact.id);
            expect(resolved.uri).toBe(`cluster://artifact/${artifact.id}`);
            expect(resolved.provenanceEventIds.length).toBeGreaterThan(0);
        });

        it('includes provenance events supporting resolved objects', async () => {
            await kernel.createEntity({
                kind: 'test',
                name: 'Traced Entity',
                attributes: {},
                actorId: 'u',
            });

            const bundle = await kernel.retrieveBundle('Traced');

            expect(bundle.provenanceEvents.length).toBeGreaterThan(0);
            expect(bundle.provenanceEvents.some((e) => e.action === 'entity_created')).toBe(true);
        });

        it('detects stale index records in resolved entities', async () => {
            const { entity } = await kernel.createEntity({
                kind: 'test',
                name: 'Original',
                attributes: {},
                actorId: 'u',
            });

            // Rename entity (makes index stale)
            const cmd = await kernel.proposeMutation({
                verb: 'update_entity',
                targetStore: 'canonical',
                payload: { entityId: entity.id, patch: { name: 'Renamed' } },
                proposedBy: 'u',
            });
            await kernel.commitMutation(cmd.id, 'u');

            // Retrieve using old name (still in index)
            const bundle = await kernel.retrieveBundle('Original');

            expect(bundle.resolvedEntities).toHaveLength(1);
            expect(bundle.resolvedEntities[0].indexStale).toBe(true);
            expect(bundle.freshness.allFresh).toBe(false);
            expect(bundle.freshness.staleCount).toBe(1);
        });

        it('reports missing context when source truth is gone', async () => {
            // Create entity through kernel (indexes it)
            await kernel.createEntity({
                kind: 'ephemeral',
                name: 'Will Disappear',
                attributes: {},
                actorId: 'u',
            });

            // Get the index records directly and find the one for our entity
            const records = await cluster.index.search({ text: 'Will Disappear' });
            expect(records).toHaveLength(1);

            // Simulate truth deletion: clear canonical store data for this entity
            // We need to remove from canonical without clearing index
            // Instead, let's add an index record pointing to a nonexistent entity
            await cluster.index.index({
                sourceId: 'deleted-entity-xyz',
                sourceStore: 'canonical',
                text: 'test: Ghost Entity',
                metadata: { kind: 'test' },
            });

            const bundle = await kernel.retrieveBundle('Ghost Entity');
            expect(bundle.missingContext.length).toBeGreaterThan(0);
            expect(bundle.missingContext[0].impact).toBe('high');
            expect(bundle.missingContext[0].store).toBe('canonical');
        });

        it('returns empty bundle for no-match query', async () => {
            const bundle = await kernel.retrieveBundle('nonexistent-xyz-123');

            expect(bundle.resolvedEntities).toHaveLength(0);
            expect(bundle.resolvedArtifacts).toHaveLength(0);
            expect(bundle.indexRecords).toHaveLength(0);
            expect(bundle.confidenceBoundaries.some(
                (b) => b.level === 'unverified' && b.claim.includes('No index records'),
            )).toBe(true);
        });

        it('respects limit option', async () => {
            // Create several entities
            for (let i = 0; i < 5; i++) {
                await kernel.createEntity({
                    kind: 'batch',
                    name: `Item ${i}`,
                    attributes: {},
                    actorId: 'u',
                });
            }

            const bundle = await kernel.retrieveBundle('batch', { limit: 2 });
            expect(bundle.indexRecords.length).toBeLessThanOrEqual(2);
        });
    });

    describe('explainRetrieval', () => {
        it('produces a human-readable explanation of a bundle', async () => {
            await kernel.createEntity({
                kind: 'concept',
                name: 'Explainable',
                attributes: {},
                actorId: 'u',
            });
            await kernel.ingestArtifact({
                filename: 'explainable.md',
                content: Buffer.from('explainable content'),
                mimeType: 'text/markdown',
                actorId: 'u',
            });

            const bundle = await kernel.retrieveBundle('Explainable');
            const explanation = await kernel.explainRetrieval(bundle);

            expect(explanation.bundleId).toBe(bundle.id);
            expect(explanation.resolvedCount).toBeGreaterThan(0);
            expect(explanation.indexCandidates).toBeGreaterThan(0);
            expect(explanation.summary).toContain('Explainable');
            expect(explanation.summary).toContain('Resolved:');
            expect(explanation.summary).toContain('Freshness:');
        });

        it('explanation reflects missing context', async () => {
            // Create orphan index record
            await cluster.index.index({
                sourceId: 'orphan-id',
                sourceStore: 'canonical',
                text: 'test: Orphan Record',
                metadata: {},
            });

            const bundle = await kernel.retrieveBundle('Orphan');
            const explanation = await kernel.explainRetrieval(bundle);

            expect(explanation.missingCount).toBeGreaterThan(0);
            expect(explanation.summary).toContain('Missing context');
        });

        it('explanation reflects all-fresh state', async () => {
            await kernel.createEntity({
                kind: 'fresh',
                name: 'Pristine',
                attributes: {},
                actorId: 'u',
            });

            const bundle = await kernel.retrieveBundle('Pristine');
            const explanation = await kernel.explainRetrieval(bundle);

            expect(explanation.allFresh).toBe(true);
            expect(explanation.summary).toContain('ALL FRESH');
        });
    });

    describe('confidence boundaries', () => {
        it('verified when all candidates resolve', async () => {
            await kernel.createEntity({
                kind: 'test',
                name: 'Fully Verified',
                attributes: {},
                actorId: 'u',
            });

            const bundle = await kernel.retrieveBundle('Fully Verified');

            expect(bundle.confidenceBoundaries.some(
                (b) => b.level === 'verified',
            )).toBe(true);
        });

        it('partial when some candidates cannot resolve', async () => {
            await cluster.index.index({
                sourceId: 'missing-source',
                sourceStore: 'canonical',
                text: 'test: Partial Confidence',
                metadata: {},
            });

            const bundle = await kernel.retrieveBundle('Partial Confidence');

            expect(bundle.confidenceBoundaries.some(
                (b) => b.level === 'partial',
            )).toBe(true);
        });

        it('reports stale boundary when index records are stale', async () => {
            const { entity } = await kernel.createEntity({
                kind: 'test',
                name: 'WillBeStale',
                attributes: {},
                actorId: 'u',
            });

            const cmd = await kernel.proposeMutation({
                verb: 'update_entity',
                targetStore: 'canonical',
                payload: { entityId: entity.id, patch: { name: 'NowStale' } },
                proposedBy: 'u',
            });
            await kernel.commitMutation(cmd.id, 'u');

            const bundle = await kernel.retrieveBundle('WillBeStale');

            expect(bundle.confidenceBoundaries.some(
                (b) => b.level === 'partial' && b.claim.includes('stale'),
            )).toBe(true);
        });
    });
});
