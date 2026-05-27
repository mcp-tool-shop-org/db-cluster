import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLocalCluster } from '../src/adapters/local/index.js';
import { ClusterKernel } from '../src/kernel/cluster-kernel.js';
import { ClusterResolver, ResolveError } from '../src/resolver/index.js';
import { formatClusterUri, uriForObject } from '../src/uri/index.js';
import type { ClusterStores } from '../src/contracts/index.js';

describe('ClusterResolver', () => {
    let cluster: ClusterStores;
    let kernel: ClusterKernel;
    let resolver: ClusterResolver;
    let TEST_DIR: string;

    beforeEach(() => {
        TEST_DIR = mkdtempSync(join(tmpdir(), 'db-cluster-resolver-'));
        cluster = createLocalCluster(TEST_DIR);
        kernel = new ClusterKernel(cluster, { dataDir: TEST_DIR });
        resolver = new ClusterResolver(cluster);
    });

    afterEach(() => {
        try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
    });

    describe('resolve entities', () => {
        it('resolves a canonical entity by URI', async () => {
            const { entity } = await kernel.createEntity({
                kind: 'concept',
                name: 'Truth',
                attributes: { domain: 'db' },
                actorId: 'user-1',
            });
            const uri = formatClusterUri('canonical', entity.id);
            const resolved = await resolver.resolve(uri);

            expect(resolved.kind).toBe('entity');
            expect(resolved.store).toBe('canonical');
            expect(resolved.uri).toBe(uri);
            if (resolved.kind === 'entity') {
                expect(resolved.object.id).toBe(entity.id);
                expect(resolved.object.name).toBe('Truth');
                expect(resolved.object.owner).toBe('canonical');
            }
        });
    });

    describe('resolve artifacts', () => {
        it('resolves an artifact by URI', async () => {
            const { artifact } = await kernel.ingestArtifact({
                filename: 'doc.md',
                content: Buffer.from('# Doc'),
                mimeType: 'text/markdown',
                actorId: 'user-1',
            });
            const uri = formatClusterUri('artifact', artifact.id);
            const resolved = await resolver.resolve(uri);

            expect(resolved.kind).toBe('artifact');
            expect(resolved.store).toBe('artifact');
            if (resolved.kind === 'artifact') {
                expect(resolved.object.filename).toBe('doc.md');
                expect(resolved.object.owner).toBe('artifact');
            }
        });
    });

    describe('resolve index records', () => {
        it('resolves an index record by URI', async () => {
            const { indexRecord } = await kernel.createEntity({
                kind: 'test',
                name: 'Indexed',
                attributes: {},
                actorId: 'user-1',
            });
            const uri = formatClusterUri('index', indexRecord.id);
            const resolved = await resolver.resolve(uri);

            expect(resolved.kind).toBe('index-record');
            expect(resolved.store).toBe('index');
            if (resolved.kind === 'index-record') {
                expect(resolved.object.sourceStore).toBe('canonical');
            }
        });
    });

    describe('resolve provenance events', () => {
        it('resolves a ledger event by URI', async () => {
            const { provenance } = await kernel.createEntity({
                kind: 'test',
                name: 'Traced',
                attributes: {},
                actorId: 'user-1',
            });
            const uri = formatClusterUri('ledger', provenance.id);
            const resolved = await resolver.resolve(uri);

            expect(resolved.kind).toBe('event');
            expect(resolved.store).toBe('ledger');
            if (resolved.kind === 'event') {
                expect(resolved.object.action).toBe('entity_created');
                expect(resolved.object.owner).toBe('ledger');
            }
        });
    });

    describe('resolve receipts', () => {
        it('resolves a receipt by URI', async () => {
            const { receipt } = await kernel.createEntity({
                kind: 'test',
                name: 'Receipted',
                attributes: {},
                actorId: 'user-1',
            });
            const uri = formatClusterUri('receipt', receipt.id);
            const resolved = await resolver.resolve(uri);

            expect(resolved.kind).toBe('receipt');
            expect(resolved.store).toBe('receipt');
            if (resolved.kind === 'receipt') {
                expect(resolved.object.commandId).toBeTruthy();
            }
        });
    });

    describe('error handling', () => {
        it('throws ResolveError for missing entity', async () => {
            const uri = formatClusterUri('canonical', 'nonexistent');
            await expect(resolver.resolve(uri)).rejects.toThrow(ResolveError);
            await expect(resolver.resolve(uri)).rejects.toThrow('Entity not found');
        });

        it('throws ResolveError for missing artifact', async () => {
            const uri = formatClusterUri('artifact', 'ghost');
            await expect(resolver.resolve(uri)).rejects.toThrow(ResolveError);
        });

        it('throws ResolveError for missing event', async () => {
            const uri = formatClusterUri('ledger', 'no-event');
            await expect(resolver.resolve(uri)).rejects.toThrow(ResolveError);
        });

        it('throws ClusterUriError for malformed URI', async () => {
            await expect(resolver.resolve('not-a-uri')).rejects.toThrow();
        });
    });

    describe('tryResolve', () => {
        it('returns null for missing objects', async () => {
            const result = await resolver.tryResolve(formatClusterUri('canonical', 'missing'));
            expect(result).toBeNull();
        });

        it('returns resolved object when found', async () => {
            const { entity } = await kernel.createEntity({
                kind: 'test',
                name: 'Findable',
                attributes: {},
                actorId: 'user-1',
            });
            const result = await resolver.tryResolve(formatClusterUri('canonical', entity.id));
            expect(result).not.toBeNull();
            expect(result!.kind).toBe('entity');
        });
    });

    describe('resolveAll', () => {
        it('resolves multiple URIs in order', async () => {
            const { entity } = await kernel.createEntity({
                kind: 'test',
                name: 'First',
                attributes: {},
                actorId: 'user-1',
            });
            const { artifact } = await kernel.ingestArtifact({
                filename: 'second.txt',
                content: Buffer.from('second'),
                mimeType: 'text/plain',
                actorId: 'user-1',
            });

            const results = await resolver.resolveAll([
                formatClusterUri('canonical', entity.id),
                formatClusterUri('artifact', artifact.id),
            ]);

            expect(results).toHaveLength(2);
            expect(results[0].kind).toBe('entity');
            expect(results[1].kind).toBe('artifact');
        });

        it('throws on first missing URI in batch', async () => {
            await expect(
                resolver.resolveAll([
                    formatClusterUri('canonical', 'missing-1'),
                    formatClusterUri('artifact', 'missing-2'),
                ]),
            ).rejects.toThrow(ResolveError);
        });
    });

    describe('integration with uriForObject', () => {
        it('uriForObject output resolves back to the same object', async () => {
            const { entity } = await kernel.createEntity({
                kind: 'roundtrip',
                name: 'Full Circle',
                attributes: { proof: true },
                actorId: 'user-1',
            });
            const uri = uriForObject(entity);
            const resolved = await resolver.resolve(uri);

            expect(resolved.kind).toBe('entity');
            if (resolved.kind === 'entity') {
                expect(resolved.object.id).toBe(entity.id);
                expect(resolved.object.name).toBe('Full Circle');
            }
        });
    });
});
