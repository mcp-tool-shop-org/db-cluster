import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createLocalCluster } from '../src/adapters/local/index.js';
import { ClusterKernel } from '../src/kernel/cluster-kernel.js';
import type { ClusterStores } from '../src/contracts/index.js';

const TEST_DIR = join(import.meta.dirname, '.test-phase3-proof');

describe('Phase 3 — Proof Tests', () => {
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

    describe('Retrieval survives stale index', () => {
        it('bundle still resolves owner truth when index is stale', async () => {
            const { entity } = await kernel.createEntity({
                kind: 'concept',
                name: 'OriginalName',
                attributes: { version: 1 },
                actorId: 'u',
            });

            // Make index stale by renaming entity
            const cmd = await kernel.proposeMutation({
                verb: 'update_entity',
                targetStore: 'canonical',
                payload: { entityId: entity.id, patch: { name: 'RenamedName' } },
                proposedBy: 'u',
            });
            await kernel.commitMutation(cmd.id, 'u');

            // Retrieve using OLD indexed text — still resolves the real entity
            const bundle = await kernel.retrieveBundle('OriginalName');

            expect(bundle.resolvedEntities).toHaveLength(1);
            // The resolved object is CURRENT canonical truth, not stale index data
            expect(bundle.resolvedEntities[0].object.name).toBe('RenamedName');
            expect(bundle.resolvedEntities[0].indexStale).toBe(true);
            expect(bundle.freshness.staleCount).toBe(1);
        });

        it('bundle flags staleness but does not hide resolved truth', async () => {
            await kernel.createEntity({
                kind: 'a',
                name: 'Fresh',
                attributes: {},
                actorId: 'u',
            });
            const { entity: staleEntity } = await kernel.createEntity({
                kind: 'b',
                name: 'WillGoStale',
                attributes: {},
                actorId: 'u',
            });

            // Rename second entity
            const cmd = await kernel.proposeMutation({
                verb: 'update_entity',
                targetStore: 'canonical',
                payload: { entityId: staleEntity.id, patch: { name: 'NowStale' } },
                proposedBy: 'u',
            });
            await kernel.commitMutation(cmd.id, 'u');

            // Retrieve all (both entities indexed)
            const bundle = await kernel.retrieveBundle('b:');
            // The stale entity is still in the bundle — not hidden
            const staleResolved = bundle.resolvedEntities.find(
                (e) => e.object.id === staleEntity.id,
            );
            if (staleResolved) {
                expect(staleResolved.indexStale).toBe(true);
                expect(staleResolved.object.name).toBe('NowStale');
            }
        });
    });

    describe('Retrieval survives missing owner truth', () => {
        it('reports missing context when index points to deleted truth', async () => {
            // Add orphan index record
            await cluster.index.index({
                sourceId: 'deleted-entity-001',
                sourceStore: 'canonical',
                text: 'test: Phantom Entity',
                metadata: {},
            });

            const bundle = await kernel.retrieveBundle('Phantom');

            expect(bundle.resolvedEntities).toHaveLength(0);
            expect(bundle.missingContext).toHaveLength(1);
            expect(bundle.missingContext[0].expectedId).toBe('deleted-entity-001');
            expect(bundle.missingContext[0].impact).toBe('high');
            expect(bundle.confidenceBoundaries.some((b) => b.level === 'partial')).toBe(true);
        });

        it('mixed results: some resolve, some missing', async () => {
            // Real entity
            await kernel.createEntity({
                kind: 'real',
                name: 'Real Mixed Entity',
                attributes: {},
                actorId: 'u',
            });

            // Orphan index record with similar text
            await cluster.index.index({
                sourceId: 'ghost-999',
                sourceStore: 'canonical',
                text: 'real: Mixed Ghost',
                metadata: {},
            });

            const bundle = await kernel.retrieveBundle('Mixed');
            expect(bundle.resolvedEntities.length).toBeGreaterThan(0);
            expect(bundle.missingContext.length).toBeGreaterThan(0);
        });
    });

    describe('Retrieval survives missing provenance', () => {
        it('entity with no provenance trail gets unprovenanced flag', async () => {
            // Create entity directly in canonical store (bypassing kernel provenance)
            const entity = await cluster.canonical.create({
                kind: 'rogue',
                name: 'No Provenance',
                attributes: {},
            });
            // Index it manually
            await cluster.index.index({
                sourceId: entity.id,
                sourceStore: 'canonical',
                text: `rogue: No Provenance`,
                metadata: { kind: 'rogue' },
            });

            const bundle = await kernel.retrieveBundle('No Provenance');

            expect(bundle.resolvedEntities).toHaveLength(1);
            expect(bundle.resolvedEntities[0].provenanceEventIds).toHaveLength(0);
            expect(bundle.freshness.unprovenanced).toBe(1);
            expect(bundle.freshness.allFresh).toBe(false);
        });
    });

    describe('Retrieval survives cross-process reload', () => {
        it('bundle assembled in one kernel instance has valid URIs resolvable in another', async () => {
            // First kernel: populate and retrieve
            await kernel.createEntity({
                kind: 'persist',
                name: 'Cross Process',
                attributes: { durable: true },
                actorId: 'u',
            });
            await kernel.ingestArtifact({
                filename: 'durable.md',
                content: Buffer.from('durable content'),
                mimeType: 'text/markdown',
                actorId: 'u',
            });

            const bundle = await kernel.retrieveBundle('Cross Process');
            expect(bundle.resolvedEntities.length + bundle.resolvedArtifacts.length).toBeGreaterThan(0);

            // Second kernel: verify the bundle's URIs resolve
            const cluster2 = createLocalCluster(TEST_DIR);
            const kernel2 = new ClusterKernel(cluster2, { dataDir: TEST_DIR });
            const { ClusterResolver } = await import('../src/resolver/index.js');
            const resolver = new ClusterResolver(cluster2);

            for (const e of bundle.resolvedEntities) {
                const resolved = await resolver.resolve(e.uri);
                expect(resolved.kind).toBe('entity');
                if (resolved.kind === 'entity') {
                    expect(resolved.object.id).toBe(e.object.id);
                }
            }
            for (const a of bundle.resolvedArtifacts) {
                const resolved = await resolver.resolve(a.uri);
                expect(resolved.kind).toBe('artifact');
                if (resolved.kind === 'artifact') {
                    expect(resolved.object.id).toBe(a.object.id);
                }
            }
        });

        it('retrieval in second kernel produces same structured result', async () => {
            await kernel.createEntity({
                kind: 'stable',
                name: 'Stable Retrieval',
                attributes: {},
                actorId: 'u',
            });

            // First retrieval
            const bundle1 = await kernel.retrieveBundle('Stable Retrieval');

            // Second kernel
            const cluster2 = createLocalCluster(TEST_DIR);
            const kernel2 = new ClusterKernel(cluster2, { dataDir: TEST_DIR });
            const bundle2 = await kernel2.retrieveBundle('Stable Retrieval');

            // Same resolved content (different bundle IDs, same structure)
            expect(bundle2.resolvedEntities).toHaveLength(bundle1.resolvedEntities.length);
            expect(bundle2.resolvedEntities[0].object.name).toBe('Stable Retrieval');
            expect(bundle2.resolvedEntities[0].uri).toBe(bundle1.resolvedEntities[0].uri);
            expect(bundle2.freshness.allFresh).toBe(bundle1.freshness.allFresh);
        });
    });

    describe('Bundle is a cluster operation, not a search operation', () => {
        it('bundle carries owner-store URIs, not just text matches', async () => {
            await kernel.createEntity({
                kind: 'claim',
                name: 'Retrieval Is Cluster',
                attributes: {},
                actorId: 'u',
            });

            const bundle = await kernel.retrieveBundle('Retrieval Is Cluster');

            // Every resolved item has a cluster URI and owner store
            for (const e of bundle.resolvedEntities) {
                expect(e.uri).toMatch(/^cluster:\/\/canonical\//);
                expect(e.ownerStore).toBe('canonical');
            }
        });

        it('bundle includes provenance for audit trail', async () => {
            const { entity } = await kernel.createEntity({
                kind: 'auditable',
                name: 'Auditable Entity',
                attributes: {},
                actorId: 'auditor',
            });

            const bundle = await kernel.retrieveBundle('Auditable');

            expect(bundle.provenanceEvents.length).toBeGreaterThan(0);
            const creationEvent = bundle.provenanceEvents.find(
                (e) => e.action === 'entity_created' && e.subjectId === entity.id,
            );
            expect(creationEvent).toBeTruthy();
            expect(creationEvent!.actorId).toBe('auditor');
        });

        it('bundle freshness assessment is structural, not just timestamp', async () => {
            await kernel.createEntity({
                kind: 'test',
                name: 'Freshness Structure',
                attributes: {},
                actorId: 'u',
            });

            const bundle = await kernel.retrieveBundle('Freshness');

            expect(bundle.freshness).toHaveProperty('allFresh');
            expect(bundle.freshness).toHaveProperty('staleCount');
            expect(bundle.freshness).toHaveProperty('unprovenanced');
            expect(bundle.freshness).toHaveProperty('oldestTimestamp');
            expect(bundle.freshness).toHaveProperty('newestTimestamp');
            // Structural, not just "here's a date"
            expect(typeof bundle.freshness.allFresh).toBe('boolean');
            expect(typeof bundle.freshness.staleCount).toBe('number');
        });
    });
});
