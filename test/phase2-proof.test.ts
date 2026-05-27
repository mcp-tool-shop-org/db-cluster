import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLocalCluster } from '../src/adapters/local/index.js';
import { ClusterKernel } from '../src/kernel/cluster-kernel.js';
import { ClusterResolver, ResolveError } from '../src/resolver/index.js';
import {
    parseClusterUri,
    formatClusterUri,
    uriForObject,
    isClusterUri,
    ClusterUriError,
} from '../src/uri/index.js';
import type { ClusterStores } from '../src/contracts/index.js';

describe('Phase 2 — Proof Tests', () => {
    let cluster: ClusterStores;
    let kernel: ClusterKernel;
    let resolver: ClusterResolver;
    let TEST_DIR: string;

    beforeEach(() => {
        TEST_DIR = mkdtempSync(join(tmpdir(), 'db-cluster-phase2-proof-'));
        cluster = createLocalCluster(TEST_DIR);
        kernel = new ClusterKernel(cluster, { dataDir: TEST_DIR });
        resolver = new ClusterResolver(cluster);
    });

    afterEach(() => {
        try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
    });

    describe('URI roundtrip: parse → format → resolve', () => {
        it('entity: format → parse → resolve returns owner truth', async () => {
            const { entity } = await kernel.createEntity({
                kind: 'proof',
                name: 'Roundtrip Entity',
                attributes: { test: true },
                actorId: 'user-1',
            });

            const uri = formatClusterUri('canonical', entity.id);
            const parsed = parseClusterUri(uri);
            expect(parsed.store).toBe('canonical');
            expect(parsed.id).toBe(entity.id);

            const resolved = await resolver.resolve(uri);
            expect(resolved.kind).toBe('entity');
            if (resolved.kind === 'entity') {
                expect(resolved.object.name).toBe('Roundtrip Entity');
                expect(resolved.object.owner).toBe('canonical');
            }
        });

        it('artifact: uriForObject → resolve returns owner truth', async () => {
            const { artifact } = await kernel.ingestArtifact({
                filename: 'roundtrip.pdf',
                content: Buffer.from('PDF content'),
                mimeType: 'application/pdf',
                actorId: 'user-1',
            });

            const uri = uriForObject(artifact);
            expect(isClusterUri(uri)).toBe(true);

            const resolved = await resolver.resolve(uri);
            expect(resolved.kind).toBe('artifact');
            if (resolved.kind === 'artifact') {
                expect(resolved.object.filename).toBe('roundtrip.pdf');
                expect(resolved.object.owner).toBe('artifact');
            }
        });

        it('provenance event: format → resolve returns ledger truth', async () => {
            const { provenance } = await kernel.createEntity({
                kind: 'test',
                name: 'Traced',
                attributes: {},
                actorId: 'user-1',
            });

            const uri = formatClusterUri('ledger', provenance.id);
            const resolved = await resolver.resolve(uri);
            expect(resolved.kind).toBe('event');
            if (resolved.kind === 'event') {
                expect(resolved.object.action).toBe('entity_created');
            }
        });
    });

    describe('Resolver returns owner truth, not index projection', () => {
        it('resolve(canonical URI) reads from canonical store after index is destroyed', async () => {
            const { entity } = await kernel.createEntity({
                kind: 'important',
                name: 'Survives',
                attributes: { critical: true },
                actorId: 'user-1',
            });

            // Destroy index entirely
            await cluster.index.clear();

            // Resolve still works — goes to owner store, not index
            const uri = formatClusterUri('canonical', entity.id);
            const resolved = await resolver.resolve(uri);
            expect(resolved.kind).toBe('entity');
            if (resolved.kind === 'entity') {
                expect(resolved.object.name).toBe('Survives');
                expect(resolved.object.attributes).toEqual({ critical: true });
            }
        });

        it('resolve(artifact URI) reads content from artifact store', async () => {
            const { artifact } = await kernel.ingestArtifact({
                filename: 'evidence.md',
                content: Buffer.from('# Critical evidence'),
                mimeType: 'text/markdown',
                actorId: 'user-1',
            });

            // Destroy index
            await cluster.index.clear();

            // Artifact still resolves
            const resolved = await resolver.resolve(formatClusterUri('artifact', artifact.id));
            expect(resolved.kind).toBe('artifact');
            if (resolved.kind === 'artifact') {
                expect(resolved.object.filename).toBe('evidence.md');
            }
        });
    });

    describe('Rebuild produces identical index', () => {
        it('index content after rebuild matches original population', async () => {
            // Populate
            await kernel.createEntity({ kind: 'a', name: 'Alpha', attributes: {}, actorId: 'u' });
            await kernel.createEntity({ kind: 'b', name: 'Beta', attributes: {}, actorId: 'u' });
            await kernel.ingestArtifact({
                filename: 'source.txt',
                content: Buffer.from('source'),
                mimeType: 'text/plain',
                actorId: 'u',
            });

            // Snapshot search behavior
            const findAlpha = await kernel.findSources({ query: 'Alpha' });
            const findSource = await kernel.findSources({ query: 'source' });

            // Destroy and rebuild
            await cluster.index.clear();
            await kernel.rebuildIndex('u');

            // Same find results
            const findAlpha2 = await kernel.findSources({ query: 'Alpha' });
            const findSource2 = await kernel.findSources({ query: 'source' });

            expect(findAlpha2.resolvedEntities).toHaveLength(findAlpha.resolvedEntities.length);
            expect(findAlpha2.resolvedEntities[0].name).toBe('Alpha');
            expect(findSource2.resolvedArtifacts).toHaveLength(findSource.resolvedArtifacts.length);
            expect(findSource2.resolvedArtifacts[0].filename).toBe('source.txt');
        });

        it('rebuild after mutation produces fresh index without staleness', async () => {
            const { entity } = await kernel.createEntity({
                kind: 'test',
                name: 'Original',
                attributes: {},
                actorId: 'u',
            });

            // Direct store write bypasses kernel auto-index → creates staleness
            await cluster.canonical.update(entity.id, { name: 'Mutated' });

            // Before rebuild: stale
            expect((await kernel.listStaleRecords()).length).toBeGreaterThan(0);

            // Rebuild
            await kernel.rebuildIndex('u');

            // After rebuild: no staleness
            expect(await kernel.listStaleRecords()).toHaveLength(0);

            // Find uses new name
            const found = await kernel.findSources({ query: 'Mutated' });
            expect(found.resolvedEntities).toHaveLength(1);
            expect(found.resolvedEntities[0].name).toBe('Mutated');
        });
    });

    describe('Stale detection catches edits that bypass index', () => {
        it('entity renamed via direct store write makes original index record stale', async () => {
            const { entity, indexRecord } = await kernel.createEntity({
                kind: 'test',
                name: 'BeforeRename',
                attributes: {},
                actorId: 'u',
            });

            // Rename directly on store (bypasses kernel auto-index)
            await cluster.canonical.update(entity.id, { name: 'AfterRename' });

            // Explain detects stale
            const explanation = await kernel.explainIndex(indexRecord.id);
            expect(explanation.stale).toBe(true);
            expect(explanation.sourceExists).toBe(true);
            expect(explanation.staleCause).toContain('does not match');
        });

        it('entity created outside kernel makes index status report stale', async () => {
            await kernel.createEntity({ kind: 'a', name: 'Through Kernel', attributes: {}, actorId: 'u' });

            // Bypass kernel — write directly to canonical store
            await cluster.canonical.create({ kind: 'b', name: 'Rogue', attributes: {} });

            // Status detects mismatch
            const status = await kernel.indexStatus();
            expect(status.possiblyStale).toBe(true);
            expect(status.total).toBe(1); // only the kernel-created one
            expect(status.expectedTotal).toBe(2);
        });
    });

    describe('Explain traces to owner store', () => {
        it('explain names the specific source truth object', async () => {
            const { entity, indexRecord } = await kernel.createEntity({
                kind: 'concept',
                name: 'Named Source',
                attributes: { important: true },
                actorId: 'u',
            });

            const explanation = await kernel.explainIndex(indexRecord.id);
            expect(explanation.sourceId).toBe(entity.id);
            expect(explanation.sourceStore).toBe('canonical');
            expect(explanation.sourceObject).not.toBeNull();
            if (explanation.sourceObject && 'name' in explanation.sourceObject) {
                expect(explanation.sourceObject.name).toBe('Named Source');
            }
        });

        it('explain for artifact names the source artifact', async () => {
            const { artifact, indexRecord } = await kernel.ingestArtifact({
                filename: 'traced.md',
                content: Buffer.from('traced content'),
                mimeType: 'text/markdown',
                actorId: 'u',
            });

            const explanation = await kernel.explainIndex(indexRecord.id);
            expect(explanation.sourceId).toBe(artifact.id);
            expect(explanation.sourceStore).toBe('artifact');
            expect(explanation.sourceExists).toBe(true);
        });
    });

    describe('Cross-store identity stable across restart', () => {
        it('URI formatted in one kernel resolves in another', async () => {
            // First kernel instance
            const { entity } = await kernel.createEntity({
                kind: 'persistent',
                name: 'Cross-Process',
                attributes: { proof: true },
                actorId: 'u',
            });
            const entityUri = uriForObject(entity);

            const { artifact } = await kernel.ingestArtifact({
                filename: 'persist.txt',
                content: Buffer.from('persistent truth'),
                mimeType: 'text/plain',
                actorId: 'u',
            });
            const artifactUri = uriForObject(artifact);

            // Second kernel instance — new objects, same data dir
            const cluster2 = createLocalCluster(TEST_DIR);
            const resolver2 = new ClusterResolver(cluster2);

            // Resolve from second instance
            const resolvedEntity = await resolver2.resolve(entityUri);
            expect(resolvedEntity.kind).toBe('entity');
            if (resolvedEntity.kind === 'entity') {
                expect(resolvedEntity.object.name).toBe('Cross-Process');
            }

            const resolvedArtifact = await resolver2.resolve(artifactUri);
            expect(resolvedArtifact.kind).toBe('artifact');
            if (resolvedArtifact.kind === 'artifact') {
                expect(resolvedArtifact.object.filename).toBe('persist.txt');
            }
        });

        it('index rebuild in second instance produces same find results', async () => {
            await kernel.createEntity({
                kind: 'durable',
                name: 'Persistent Entity',
                attributes: {},
                actorId: 'u',
            });

            // Second instance: destroy and rebuild
            const cluster2 = createLocalCluster(TEST_DIR);
            const kernel2 = new ClusterKernel(cluster2, { dataDir: TEST_DIR });

            await cluster2.index.clear();
            await kernel2.rebuildIndex('u');

            const found = await kernel2.findSources({ query: 'Persistent' });
            expect(found.resolvedEntities).toHaveLength(1);
            expect(found.resolvedEntities[0].name).toBe('Persistent Entity');
        });
    });
});
