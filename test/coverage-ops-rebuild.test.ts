/**
 * Coverage — ops/rebuild: rebuildIndex staging, integrity refusal, swap
 * failure and dry-run behaviour; checkStale orphan/missing detection.
 * Faults are injected by overlaying individual store methods on real local
 * stores, so everything else behaves as in production.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLocalCluster } from '../src/adapters/local/index.js';
import { ClusterKernel } from '../src/kernel/cluster-kernel.js';
import { rebuildIndex, checkStale } from '../src/ops/rebuild.js';
import type { ClusterStores } from '../src/contracts/index.js';

const ACTOR = 'operator';

function overlay<T extends object>(target: T, overrides: Record<string, unknown>): T {
    return new Proxy(target, {
        get(t, prop) {
            if (typeof prop === 'string' && prop in overrides) return overrides[prop];
            const value = Reflect.get(t, prop, t);
            return typeof value === 'function' ? value.bind(t) : value;
        },
    });
}

describe('rebuildIndex()', () => {
    let dir: string;
    let stores: ClusterStores;
    let kernel: ClusterKernel;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'cov-rebuild-'));
        stores = createLocalCluster(dir);
        kernel = new ClusterKernel(stores);
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    async function ingest(filename: string, body: string, mimeType: string) {
        return (await kernel.ingestArtifact({ filename, content: Buffer.from(body), mimeType, actorId: ACTOR })).artifact;
    }

    it('rebuilds entity and artifact records; text artifacts are content-indexed and binary ones are named by version', async () => {
        const { entity } = await kernel.createEntity({ kind: 'note', name: 'alpha', attributes: { tier: 'gold' }, actorId: ACTOR });
        const textArt = await ingest('notes.md', '# Heading\nuniquebodyword appears here', 'text/markdown');
        const binArt = await ingest('blob.bin', 'binary-ish', 'application/octet-stream');
        await stores.index.clear();

        const progress: Array<[number, number, string | undefined]> = [];
        const result = await rebuildIndex(stores, { onProgress: (c, t, m) => progress.push([c, t, m]) });
        expect(result).toEqual({ rebuilt: 3, removed: 0, errors: [], dryRun: false });
        expect(progress[progress.length - 1]).toEqual([3, 3, 'atomic swap complete']);

        const records = await stores.index.search({});
        const byId = new Map(records.map((r) => [r.sourceId, r]));
        expect(byId.get(entity.id)?.text).toBe('note: alpha');
        expect(byId.get(entity.id)?.metadata).toMatchObject({ kind: 'note', tier: 'gold' });
        expect(byId.get(textArt.id)?.text).toContain('uniquebodyword');
        expect(byId.get(binArt.id)?.text).toBe(`blob.bin v${binArt.version}`);
        expect(byId.get(binArt.id)?.metadata).toMatchObject({ filename: 'blob.bin', mimeType: 'application/octet-stream' });
    });

    it('dry run stages and counts but never swaps the live index', async () => {
        await kernel.createEntity({ kind: 'note', name: 'beta', attributes: {}, actorId: ACTOR });
        await stores.index.clear();
        const progress: string[] = [];
        const result = await rebuildIndex(stores, { dryRun: true, onProgress: (_c, _t, m) => progress.push(String(m)) });
        expect(result).toEqual({ rebuilt: 1, removed: 0, errors: [], dryRun: true });
        expect(await stores.index.count()).toBe(0);
        expect(progress[progress.length - 1]).toBe('dry-run complete');
    });

    it('a throwing onProgress callback never aborts the rebuild', async () => {
        await kernel.createEntity({ kind: 'note', name: 'gamma', attributes: {}, actorId: ACTOR });
        const result = await rebuildIndex(stores, { onProgress: () => { throw new Error('sink failed'); } });
        expect(result.rebuilt).toBe(1);
        expect(result.errors).toEqual([]);
    });

    it('refuses to index an artifact whose returned bytes do not hash to the recorded contentHash', async () => {
        const good = await ingest('good.txt', 'good body', 'text/plain');
        const bad = await ingest('bad.txt', 'original body', 'text/plain');
        const poisoned = overlay(stores.artifact, {
            getContent: async (id: string) =>
                id === bad.id ? Buffer.from('poisoned body') : stores.artifact.getContent(id),
        });
        const result = await rebuildIndex({ ...stores, artifact: poisoned });
        expect(result.rebuilt).toBe(1);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toContain(`Refusing to index artifact ${bad.id} (bad.txt)`);
        expect(result.errors[0]).toContain('tampered blob');
        const indexed = (await stores.index.search({})).map((r) => r.sourceId);
        expect(indexed).toEqual([good.id]);
    });

    it('recognises integrity failures thrown by the adapter by error name or by code', async () => {
        const a = await ingest('a.txt', 'aaa', 'text/plain');
        const b = await ingest('b.txt', 'bbb', 'text/plain');
        const c = await ingest('c.txt', 'ccc', 'text/plain');
        const faulty = overlay(stores.artifact, {
            getContent: async (id: string) => {
                if (id === a.id) {
                    const e = new Error('hash drift');
                    e.name = 'ContentReadIntegrityError';
                    throw e;
                }
                if (id === b.id) {
                    const e = new Error('path escape') as Error & { code: string };
                    e.code = 'INVALID_CONTENT_HASH';
                    throw e;
                }
                return stores.artifact.getContent(id);
            },
        });
        const result = await rebuildIndex({ ...stores, artifact: faulty });
        expect(result.rebuilt).toBe(1);
        expect(result.errors).toHaveLength(2);
        expect(result.errors.every((e) => e.startsWith('Refusing to index artifact'))).toBe(true);
        expect(result.errors.some((e) => e.includes('hash drift'))).toBe(true);
        expect(result.errors.some((e) => e.includes('path escape'))).toBe(true);
        expect((await stores.index.search({})).map((r) => r.sourceId)).toEqual([c.id]);
    });

    it('reports a non-integrity artifact read failure as a generic staging error', async () => {
        const a = await ingest('a.txt', 'aaa', 'text/plain');
        const faulty = overlay(stores.artifact, {
            getContent: async () => { throw new Error('transient io blip'); },
        });
        const result = await rebuildIndex({ ...stores, artifact: faulty });
        expect(result.rebuilt).toBe(0);
        expect(result.errors).toEqual([`Failed to stage artifact ${a.id}: transient io blip`]);
    });

    it('a null content read falls back to the filename/version text', async () => {
        const a = await ingest('missing.txt', 'bytes', 'text/plain');
        const gone = overlay(stores.artifact, { getContent: async () => null });
        const result = await rebuildIndex({ ...stores, artifact: gone });
        expect(result.rebuilt).toBe(1);
        const rec = (await stores.index.search({})).find((r) => r.sourceId === a.id);
        expect(rec?.text).toBe(`missing.txt v${a.version}`);
    });

    it('reports an entity that cannot be staged and keeps going', async () => {
        const good = (await kernel.createEntity({ kind: 'note', name: 'fine', attributes: {}, actorId: ACTOR })).entity;
        const booby = {
            id: 'booby-trapped',
            kind: 'note',
            get name(): string { throw new Error('getter exploded'); },
            attributes: {},
        };
        const canonical = overlay(stores.canonical, {
            list: async () => [booby, good],
        });
        const result = await rebuildIndex({ ...stores, canonical });
        expect(result.rebuilt).toBe(1);
        expect(result.errors).toEqual(['Failed to stage entity booby-trapped: getter exploded']);
    });

    it('surfaces an index swap failure in errors[] after staging succeeded', async () => {
        await kernel.createEntity({ kind: 'note', name: 'delta', attributes: {}, actorId: ACTOR });
        const index = overlay(stores.index, {
            replaceAll: async () => { throw new Error('rename failed'); },
        });
        const result = await rebuildIndex({ ...stores, index });
        expect(result.rebuilt).toBe(1);
        expect(result.errors).toEqual(['Atomic index swap failed: rename failed']);
    });
});

describe('checkStale()', () => {
    let dir: string;
    let stores: ClusterStores;
    let kernel: ClusterKernel;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'cov-stale-'));
        stores = createLocalCluster(dir);
        kernel = new ClusterKernel(stores);
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('returns an empty list for an index in sync with owner truth', async () => {
        await kernel.createEntity({ kind: 'note', name: 'in-sync', attributes: {}, actorId: ACTOR });
        expect(await checkStale(stores)).toEqual([]);
    });

    it('reports orphan canonical, artifact and ledger index records and unindexed entities, each with the fix command', async () => {
        const { entity } = await kernel.createEntity({ kind: 'note', name: 'unindexed-soon', attributes: {}, actorId: ACTOR });
        // Drop the entity's index record so it is "missing_from_index".
        const records = await stores.index.search({});
        for (const r of records) await stores.index.remove(r.id);
        await stores.index.index({ sourceId: 'ghost-entity', sourceStore: 'canonical', text: 'x', metadata: {} });
        await stores.index.index({ sourceId: 'ghost-artifact', sourceStore: 'artifact', text: 'x', metadata: {} });
        await stores.index.index({ sourceId: 'ghost-event', sourceStore: 'ledger', text: 'x', metadata: {} });

        const stale = await checkStale(stores);
        expect(stale.every((s) => s.suggestedCommand === 'db-cluster rebuild index')).toBe(true);
        const summary = stale.map((s) => `${s.type}:${s.sourceStore}:${s.sourceId}`).sort();
        expect(summary).toEqual([
            'missing_from_index:canonical:' + entity.id,
            'orphan_index_record:artifact:ghost-artifact',
            'orphan_index_record:canonical:ghost-entity',
            'orphan_index_record:ledger:ghost-event',
        ].sort());
        const ledgerMsg = stale.find((s) => s.sourceStore === 'ledger')!.message;
        expect(ledgerMsg).toBe('Index record references non-existent ledger event ghost-event');
        const missing = stale.find((s) => s.type === 'missing_from_index')!;
        expect(missing.message).toBe(`Entity ${entity.id} (note: unindexed-soon) not indexed`);
    });

    it('treats a ledger read that throws as present, not orphaned', async () => {
        await stores.index.index({ sourceId: 'tampered-event', sourceStore: 'ledger', text: 'x', metadata: {} });
        const ledger = overlay(stores.ledger, {
            getEvent: async () => { throw new Error('integrity hash mismatch'); },
        });
        expect(await checkStale({ ...stores, ledger })).toEqual([]);
    });
});
