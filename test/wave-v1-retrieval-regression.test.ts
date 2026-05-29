/**
 * Wave V1 — A3 regression: ranked retrieval, relevance score + snippet, RETR-006.
 *
 * The RetrievalPlanner is where the BM25 layer lives ABOVE search():
 *   broad candidate fetch → rank → filter(score>0) → paginate → resolve.
 * Pins:
 *  - RETR-001: resolved evidence is ordered by BM25 relevance
 *  - RETR-004: each ResolvedEvidence carries a numeric `score`; artifacts carry a
 *    `snippet` extracted ONLY via the integrity-checked getContent path
 *  - integrity boundary: tampered / unreadable content yields NO snippet (never a raw read)
 *  - RETR-005: offset paginates the RANKED result in the retrieval path
 *  - RETR-006: an indexed `ledger` (or otherwise unresolved) sourceStore surfaces MissingContext
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLocalCluster } from '../src/adapters/local/index.js';
import { ClusterKernel } from '../src/kernel/cluster-kernel.js';
import { RetrievalPlanner } from '../src/retrieval/retrieval-planner.js';
import type { ClusterStores } from '../src/contracts/index.js';

describe('Wave V1 — ranked retrieval + score/snippet (RETR-001/004/005/006)', () => {
    let cluster: ClusterStores;
    let kernel: ClusterKernel;
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'db-cluster-v1-retrieval-'));
        cluster = createLocalCluster(dir);
        kernel = new ClusterKernel(cluster, { dataDir: dir });
    });
    afterEach(() => {
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    it('ranks resolved entities by BM25 relevance and attaches numeric scores (RETR-001/004)', async () => {
        // Both 'Alpha …' entities substring-match 'alpha' (search() recall is
        // unchanged); BM25 then ORDERS them. 'Alpha Alpha' (tf=2, shorter doc)
        // must outrank 'Alpha Beta Gamma Delta' (tf=1, longer). 'Unrelated Topic'
        // does not contain 'alpha' → excluded by search()'s candidate match, not
        // by ranking.
        await kernel.createEntity({ kind: 'note', name: 'Alpha Alpha', attributes: {}, actorId: 'u' });
        await kernel.createEntity({ kind: 'note', name: 'Alpha Beta Gamma Delta', attributes: {}, actorId: 'u' });
        await kernel.createEntity({ kind: 'note', name: 'Unrelated Topic', attributes: {}, actorId: 'u' });

        const bundle = await kernel.retrieveBundle('Alpha');

        expect(bundle.resolvedEntities).toHaveLength(2);
        expect(bundle.resolvedEntities[0].object.name).toBe('Alpha Alpha');
        expect(typeof bundle.resolvedEntities[0].score).toBe('number');
        expect(bundle.resolvedEntities[0].score).toBeGreaterThan(bundle.resolvedEntities[1].score);
        expect(bundle.resolvedEntities[1].score).toBeGreaterThan(0);
        expect(bundle.indexRecords).toHaveLength(2);
    });

    it('attaches a content snippet for a text artifact via the integrity-checked path (RETR-004)', async () => {
        await kernel.ingestArtifact({
            filename: 'design.md',
            content: Buffer.from('# Federated Design\n\nThe system records provenance and receipts for every mutation.'),
            mimeType: 'text/markdown',
            actorId: 'u',
        });

        // Query a FILENAME term ('design') — at ingest the index text is
        // `${filename} [${mimeType}]` (rich content keyterms only land on
        // rebuild). The snippet, however, is drawn from CONTENT via getContent,
        // so asserting it contains a content-only word ('provenance', absent
        // from the index text) proves the snippet is the integrity-checked
        // content excerpt, not the index record text.
        const bundle = await kernel.retrieveBundle('design');
        expect(bundle.resolvedArtifacts.length).toBeGreaterThan(0);
        const art = bundle.resolvedArtifacts[0];
        expect(typeof art.score).toBe('number');
        expect(art.score).toBeGreaterThan(0);
        expect(art.snippet).toBeDefined();
        expect((art.snippet ?? '').toLowerCase()).toContain('provenance');
    });

    it('omits the snippet (never a raw read) when artifact content fails integrity', async () => {
        await kernel.ingestArtifact({
            filename: 'secret.md',
            content: Buffer.from('# Secret\n\nThe federated provenance ledger holds audit material.'),
            mimeType: 'text/markdown',
            actorId: 'u',
        });

        // (a) getContent THROWS a content-integrity error → snippet undefined, no throw.
        const throwingStores = {
            ...cluster,
            artifact: {
                get: cluster.artifact.get.bind(cluster.artifact),
                getContent: async () => {
                    const e = new Error('tampered') as Error & { code?: string };
                    e.name = 'ContentReadIntegrityError';
                    e.code = 'CONTENT_READ_INTEGRITY';
                    throw e;
                },
            },
        } as unknown as ClusterStores;
        const bThrow = await new RetrievalPlanner(throwingStores).plan('secret');
        expect(bThrow.resolvedArtifacts.length).toBeGreaterThan(0);
        expect(bThrow.resolvedArtifacts[0].snippet).toBeUndefined();

        // (b) getContent returns HASH-MISMATCHED bytes (adapter w/o verify-on-read) →
        //     planner's defense-in-depth re-hash rejects → snippet undefined.
        const tamperedStores = {
            ...cluster,
            artifact: {
                get: cluster.artifact.get.bind(cluster.artifact),
                getContent: async () => Buffer.from('totally different poisoned bytes that do not hash'),
            },
        } as unknown as ClusterStores;
        const bTamper = await new RetrievalPlanner(tamperedStores).plan('secret');
        expect(bTamper.resolvedArtifacts.length).toBeGreaterThan(0);
        expect(bTamper.resolvedArtifacts[0].snippet).toBeUndefined();
    });

    it('surfaces MissingContext for an indexed ledger record the planner does not resolve (RETR-006)', async () => {
        await cluster.index.index({
            sourceId: 'evt-xyz',
            sourceStore: 'ledger',
            text: 'ledger audit checkpoint alpha',
            metadata: {},
        });

        const bundle = await kernel.retrieveBundle('audit checkpoint');

        expect(bundle.missingContext.some((m) => m.store === 'ledger' && m.expectedId === 'evt-xyz')).toBe(true);
        // ledger records are NOT resolved as entity/artifact owner truth
        expect(bundle.resolvedEntities.every((e) => e.object.id !== 'evt-xyz')).toBe(true);
        expect(bundle.resolvedArtifacts.every((a) => a.object.id !== 'evt-xyz')).toBe(true);
    });

    it('paginates the RANKED result with offset (RETR-005)', async () => {
        for (let i = 0; i < 5; i++) {
            await kernel.createEntity({ kind: 'batch', name: `Item ${i}`, attributes: {}, actorId: 'u' });
        }

        const page0 = await kernel.retrieveBundle('batch', { limit: 2 } as { limit?: number; offset?: number });
        const page1 = await kernel.retrieveBundle('batch', { limit: 2, offset: 2 } as { limit?: number; offset?: number });

        expect(page0.indexRecords).toHaveLength(2);
        expect(page1.indexRecords).toHaveLength(2);

        const ids0 = page0.resolvedEntities.map((e) => e.object.id);
        const ids1 = page1.resolvedEntities.map((e) => e.object.id);
        expect(ids0.some((id) => ids1.includes(id))).toBe(false); // disjoint pages

        const pageEnd = await kernel.retrieveBundle('batch', { limit: 2, offset: 100 } as { limit?: number; offset?: number });
        expect(pageEnd.indexRecords).toHaveLength(0);
        expect(pageEnd.resolvedEntities).toHaveLength(0);
    });
});
