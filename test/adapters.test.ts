import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createLocalCluster } from '../src/adapters/local/index.js';
import type { ClusterStores } from '../src/contracts/index.js';

const TEST_DIR = join(import.meta.dirname, '.test-cluster');

describe('Wave 2 — Local Store Adapters', () => {
    let cluster: ClusterStores;

    beforeEach(() => {
        rmSync(TEST_DIR, { recursive: true, force: true });
        mkdirSync(TEST_DIR, { recursive: true });
        cluster = createLocalCluster(TEST_DIR);
    });

    afterEach(() => {
        rmSync(TEST_DIR, { recursive: true, force: true });
    });

    describe('Cluster factory', () => {
        it('returns exactly four required store domains', () => {
            expect(cluster).toHaveProperty('canonical');
            expect(cluster).toHaveProperty('artifact');
            expect(cluster).toHaveProperty('index');
            expect(cluster).toHaveProperty('ledger');
            expect(Object.keys(cluster)).toHaveLength(4);
        });
    });

    describe('Canonical store — stable entity records', () => {
        it('creates an entity with generated ID and timestamps', async () => {
            const entity = await cluster.canonical.create({
                kind: 'person',
                name: 'Alice',
                attributes: { role: 'engineer' },
            });
            expect(entity.id).toBeTruthy();
            expect(entity.owner).toBe('canonical');
            expect(entity.createdAt).toBeTruthy();
            expect(entity.updatedAt).toBeTruthy();
        });

        it('retrieves a created entity by ID', async () => {
            const created = await cluster.canonical.create({
                kind: 'document',
                name: 'Spec v1',
                attributes: {},
            });
            const found = await cluster.canonical.get(created.id);
            expect(found).toEqual(created);
        });

        it('lists and filters entities by kind', async () => {
            await cluster.canonical.create({ kind: 'person', name: 'A', attributes: {} });
            await cluster.canonical.create({ kind: 'org', name: 'B', attributes: {} });
            await cluster.canonical.create({ kind: 'person', name: 'C', attributes: {} });

            const people = await cluster.canonical.list({ kind: 'person' });
            expect(people).toHaveLength(2);
        });

        it('entities survive independently of index records', async () => {
            const entity = await cluster.canonical.create({
                kind: 'concept',
                name: 'Truth',
                attributes: {},
            });

            // Clear the index — entity must still exist
            await cluster.index.clear();

            const found = await cluster.canonical.get(entity.id);
            expect(found).toEqual(entity);
        });
    });

    describe('Artifact store — immutable write, versioning', () => {
        it('ingests an artifact with content hash', async () => {
            const artifact = await cluster.artifact.ingest({
                filename: 'source.md',
                content: Buffer.from('# Hello World'),
                mimeType: 'text/markdown',
            });
            expect(artifact.id).toBeTruthy();
            expect(artifact.contentHash).toBeTruthy();
            expect(artifact.version).toBe(1);
            expect(artifact.owner).toBe('artifact');
        });

        it('artifact overwrite is impossible — re-ingest creates a new version', async () => {
            const v1 = await cluster.artifact.ingest({
                filename: 'doc.md',
                content: Buffer.from('Version 1'),
                mimeType: 'text/markdown',
            });
            const v2 = await cluster.artifact.ingest({
                filename: 'doc.md',
                content: Buffer.from('Version 2'),
                mimeType: 'text/markdown',
            });

            // Different IDs, different versions
            expect(v1.id).not.toBe(v2.id);
            expect(v1.version).toBe(1);
            expect(v2.version).toBe(2);
            expect(v1.contentHash).not.toBe(v2.contentHash);

            // Both still exist
            const versions = await cluster.artifact.versions('doc.md');
            expect(versions).toHaveLength(2);
        });

        it('retrieves content by artifact ID', async () => {
            const artifact = await cluster.artifact.ingest({
                filename: 'test.txt',
                content: Buffer.from('hello'),
                mimeType: 'text/plain',
            });
            const content = await cluster.artifact.getContent(artifact.id);
            expect(content?.toString()).toBe('hello');
        });

        it('deduplicates identical content', async () => {
            const content = Buffer.from('same content');
            const a = await cluster.artifact.ingest({
                filename: 'a.txt',
                content,
                mimeType: 'text/plain',
            });
            const b = await cluster.artifact.ingest({
                filename: 'b.txt',
                content,
                mimeType: 'text/plain',
            });
            expect(a.contentHash).toBe(b.contentHash);
        });
    });

    describe('Index store — derivative, clear/rebuild-ready', () => {
        it('indexes a record and retrieves it by search', async () => {
            await cluster.index.index({
                sourceId: 'entity-123',
                sourceStore: 'canonical',
                text: 'Alice is an engineer',
                metadata: { kind: 'person' },
            });

            const results = await cluster.index.search({ text: 'engineer' });
            expect(results).toHaveLength(1);
            expect(results[0].sourceId).toBe('entity-123');
        });

        it('index can be cleared without deleting source truth', async () => {
            // Create source truth in canonical and artifact stores
            const entity = await cluster.canonical.create({
                kind: 'concept',
                name: 'Provenance',
                attributes: {},
            });
            const artifact = await cluster.artifact.ingest({
                filename: 'evidence.md',
                content: Buffer.from('evidence content'),
                mimeType: 'text/markdown',
            });

            // Index them
            await cluster.index.index({
                sourceId: entity.id,
                sourceStore: 'canonical',
                text: entity.name,
                metadata: {},
            });
            await cluster.index.index({
                sourceId: artifact.id,
                sourceStore: 'artifact',
                text: 'evidence content',
                metadata: {},
            });

            expect(await cluster.index.count()).toBe(2);

            // Clear the index
            await cluster.index.clear();
            expect(await cluster.index.count()).toBe(0);

            // Source truth survives
            expect(await cluster.canonical.get(entity.id)).toBeTruthy();
            expect(await cluster.artifact.get(artifact.id)).toBeTruthy();
        });

        it('filters by source store', async () => {
            await cluster.index.index({
                sourceId: 'e1',
                sourceStore: 'canonical',
                text: 'entity',
                metadata: {},
            });
            await cluster.index.index({
                sourceId: 'a1',
                sourceStore: 'artifact',
                text: 'artifact',
                metadata: {},
            });

            const canonicalOnly = await cluster.index.search({ sourceStore: 'canonical' });
            expect(canonicalOnly).toHaveLength(1);
            expect(canonicalOnly[0].sourceId).toBe('e1');
        });
    });

    describe('Ledger store — append-only, ordered history', () => {
        it('appends events in order and cannot update/delete', async () => {
            const e1 = await cluster.ledger.append({
                action: 'entity_created',
                actorId: 'user-1',
                subjectId: 'entity-1',
                subjectStore: 'canonical',
                detail: { name: 'Alice' },
            });
            const e2 = await cluster.ledger.append({
                action: 'artifact_ingested',
                actorId: 'user-1',
                subjectId: 'artifact-1',
                subjectStore: 'artifact',
                detail: { filename: 'doc.md' },
            });

            expect(e1.owner).toBe('ledger');
            expect(e1.timestamp <= e2.timestamp).toBe(true);

            const all = await cluster.ledger.listEvents();
            expect(all).toHaveLength(2);
            expect(all[0].id).toBe(e1.id);
            expect(all[1].id).toBe(e2.id);
        });

        it('traces lineage via parent chain', async () => {
            const root = await cluster.ledger.append({
                action: 'artifact_ingested',
                actorId: 'user-1',
                subjectId: 'a1',
                subjectStore: 'artifact',
                detail: {},
            });
            const child = await cluster.ledger.append({
                action: 'evidence_linked',
                actorId: 'user-1',
                subjectId: 'a1',
                subjectStore: 'artifact',
                detail: { linkedTo: 'e1' },
                parentEventId: root.id,
            });
            const grandchild = await cluster.ledger.append({
                action: 'entity_updated',
                actorId: 'user-1',
                subjectId: 'e1',
                subjectStore: 'canonical',
                detail: {},
                parentEventId: child.id,
            });

            const chain = await cluster.ledger.trace(grandchild.id);
            expect(chain).toHaveLength(3);
            expect(chain[0].id).toBe(grandchild.id);
            expect(chain[1].id).toBe(child.id);
            expect(chain[2].id).toBe(root.id);
        });

        it('appends receipts and retrieves by command ID', async () => {
            const receipt = await cluster.ledger.appendReceipt({
                commandId: 'cmd-1',
                resultSummary: 'Entity created successfully',
                affectedIds: ['entity-1'],
                provenanceEventId: 'event-1',
            });

            expect(receipt.id).toBeTruthy();
            expect(receipt.committedAt).toBeTruthy();

            const found = await cluster.ledger.listReceipts({ commandId: 'cmd-1' });
            expect(found).toHaveLength(1);
            expect(found[0].resultSummary).toBe('Entity created successfully');
        });

        it('ledger events are not exposed for update or delete', () => {
            // Structural proof: the adapter class has no update/delete methods
            const ledger = cluster.ledger;
            expect((ledger as any).update).toBeUndefined();
            expect((ledger as any).delete).toBeUndefined();
            expect((ledger as any).remove).toBeUndefined();
        });
    });
});
