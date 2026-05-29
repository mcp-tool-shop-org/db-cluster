/**
 * Wave V1 — A2 regression: IndexStore offset pagination + candidate semantics (RETR-005).
 *
 * The store's search() stays a CANDIDATE matcher (substring filter, adapter/
 * insertion order). It does NOT rank — BM25 ranking is a layer above search()
 * in the retrieval path. These tests pin:
 *  - offset slices the post-filter candidate window
 *  - offset ABSENT ≡ pre-offset behavior (existence-probe + fetch-all identical)
 *  - offset composes with text + sourceStore filters
 *  - search() returns insertion order, never relevance order (no ranking here)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalIndexStore } from '../src/adapters/local/local-index-store.js';

describe('Wave V1 — IndexStore offset pagination (RETR-005)', () => {
    let dir: string;
    let store: LocalIndexStore;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'db-cluster-v1-store-'));
        store = new LocalIndexStore(dir);
    });
    afterEach(() => {
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    async function seed(n: number): Promise<void> {
        for (let i = 0; i < n; i++) {
            await store.index({
                sourceId: `s${i}`,
                sourceStore: 'canonical',
                text: `doc ${i} alpha`,
                metadata: { i },
            });
        }
    }

    it('offset absent preserves existence-probe and fetch-all behavior', async () => {
        await seed(5);
        const probe = await store.search({ limit: 1 });
        expect(probe).toHaveLength(1);
        expect(probe[0].sourceId).toBe('s0');

        const all = await store.search({ limit: 100000 });
        expect(all.map((r) => r.sourceId)).toEqual(['s0', 's1', 's2', 's3', 's4']);

        const allNoLimit = await store.search({});
        expect(allNoLimit).toHaveLength(5);
    });

    it('offset + limit slices the candidate window in insertion order', async () => {
        await seed(5);
        const page = await store.search({ offset: 2, limit: 2 });
        expect(page.map((r) => r.sourceId)).toEqual(['s2', 's3']);
    });

    it('offset without limit returns the tail', async () => {
        await seed(5);
        const tail = await store.search({ offset: 3 });
        expect(tail.map((r) => r.sourceId)).toEqual(['s3', 's4']);
    });

    it('offset past the end yields an empty page', async () => {
        await seed(3);
        expect(await store.search({ offset: 10, limit: 5 })).toEqual([]);
    });

    it('negative/zero offset is treated as no skip', async () => {
        await seed(3);
        expect((await store.search({ offset: 0, limit: 2 })).map((r) => r.sourceId)).toEqual(['s0', 's1']);
        // defensive: a negative offset must not slice from the end
        expect((await store.search({ offset: -5, limit: 2 })).map((r) => r.sourceId)).toEqual(['s0', 's1']);
    });

    it('offset applies AFTER text + sourceStore filtering (candidate semantics preserved)', async () => {
        await store.index({ sourceId: 'a0', sourceStore: 'canonical', text: 'alpha one', metadata: {} });
        await store.index({ sourceId: 'a1', sourceStore: 'artifact', text: 'alpha two', metadata: {} });
        await store.index({ sourceId: 'a2', sourceStore: 'canonical', text: 'alpha three', metadata: {} });
        await store.index({ sourceId: 'a3', sourceStore: 'canonical', text: 'beta four', metadata: {} });

        // canonical AND substring 'alpha' → [a0, a2] in insertion order; offset 1 → [a2]
        const r = await store.search({ sourceStore: 'canonical', text: 'alpha', offset: 1 });
        expect(r.map((x) => x.sourceId)).toEqual(['a2']);
    });

    it('search() returns insertion order, NOT relevance order (no ranking in the store)', async () => {
        await store.index({ sourceId: 'p', sourceStore: 'canonical', text: 'zzz alpha', metadata: {} });
        await store.index({ sourceId: 'q', sourceStore: 'canonical', text: 'alpha alpha alpha', metadata: {} });
        // If the store ranked, 'q' (tf=3) would precede 'p' (tf=1). It must not —
        // ranking is a layer ABOVE search().
        const r = await store.search({ text: 'alpha' });
        expect(r.map((x) => x.sourceId)).toEqual(['p', 'q']);
    });
});
