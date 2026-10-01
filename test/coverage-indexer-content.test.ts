/**
 * Coverage — content indexer (src/indexing/content-indexer.ts).
 *
 * `indexArtifactContent` is the path that decides what text reaches the search
 * index, and it carries a security invariant (PROV-001): bytes whose sha256 does
 * not match the recorded contentHash must NEVER be indexed. These tests drive it
 * against hand-built stores so each branch is exercised deterministically:
 *
 *  - text / markdown / .txt artifacts are indexed by filename + headings + key
 *    terms; binary artifacts only by filename and version;
 *  - the defense-in-depth re-hash refuses tampered bytes even when the store
 *    itself does not throw;
 *  - integrity errors thrown by the store are recognised by `name` or `code`
 *    (not `instanceof`) and reported distinctly from ordinary failures;
 *  - one bad artifact never stops the rest from being indexed.
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { indexArtifactContent, buildArtifactIndexText } from '../src/indexing/content-indexer.js';
import type { ClusterStores } from '../src/contracts/index.js';
import type { Artifact } from '../src/types/artifact.js';

function sha(buf: Buffer): string {
    return createHash('sha256').update(buf).digest('hex');
}

function makeArtifact(over: Partial<Artifact> & { id: string; filename: string }, content: Buffer): Artifact {
    return {
        contentHash: sha(content),
        mimeType: 'application/octet-stream',
        sizeBytes: content.length,
        version: 1,
        storagePath: `/store/${over.id}`,
        ingestedAt: '2026-01-01T00:00:00.000Z',
        owner: 'artifact',
        ...over,
    };
}

interface IndexCall {
    sourceId: string;
    sourceStore: string;
    text: string;
    metadata: Record<string, unknown>;
}

/** Stores whose artifact side serves canned content (or throws) and whose index side records calls. */
function stubStores(
    artifacts: Artifact[],
    contentFor: (id: string) => Buffer | null | Error,
): { stores: ClusterStores; calls: IndexCall[] } {
    const calls: IndexCall[] = [];
    const stores = {
        artifact: {
            list: async () => artifacts,
            getContent: async (id: string) => {
                const c = contentFor(id);
                if (c instanceof Error) throw c;
                return c;
            },
        },
        index: {
            index: async (rec: IndexCall) => {
                calls.push(rec);
                return { ...rec, id: `idx-${calls.length}`, indexedAt: 'now', owner: 'index' };
            },
        },
    } as unknown as ClusterStores;
    return { stores, calls };
}

describe('buildArtifactIndexText', () => {
    const md: Artifact = makeArtifact({ id: 'a1', filename: 'plan.md', mimeType: 'text/markdown' }, Buffer.from(''));

    it('puts the filename first, then headings joined with " | ", then key terms', () => {
        const text = buildArtifactIndexText(md, '# Alpha Plan\n## Beta Stage\nrollout rollout rollout migration');
        expect(text.startsWith('plan.md Alpha Plan | Beta Stage ')).toBe(true);
        expect(text).toContain('rollout');
        // most frequent key term comes before the rarer one
        expect(text.indexOf('rollout')).toBeLessThan(text.indexOf('migration'));
    });

    it('extracts headings for a .md filename even when the mime type is not markdown', () => {
        const art = { ...md, mimeType: 'text/plain' };
        expect(buildArtifactIndexText(art, '# Heading Only')).toContain('Heading Only');
    });

    it('does not extract headings from non-markdown text but still indexes its key terms', () => {
        const art = { ...md, filename: 'notes.txt', mimeType: 'text/plain' };
        const text = buildArtifactIndexText(art, '# not-a-heading deployment deployment');
        expect(text).not.toContain(' | ');
        expect(text).toContain('deployment');
    });

    it('returns just the filename when the content has no headings and no key terms', () => {
        expect(buildArtifactIndexText(md, 'a an the')).toBe('plan.md');
    });
});

describe('indexArtifactContent — what gets indexed', () => {
    it('indexes text artifacts by content and binary artifacts by filename+version only', async () => {
        const mdBody = Buffer.from('# Release Notes\nshipping shipping artifacts');
        const txtBody = Buffer.from('plain quarterly summary summary');
        const binBody = Buffer.from([0, 1, 2, 3, 250]);
        const artifacts = [
            makeArtifact({ id: 'md', filename: 'release.md', mimeType: 'text/markdown', version: 2 }, mdBody),
            makeArtifact({ id: 'txt', filename: 'summary.txt', mimeType: 'application/octet-stream' }, txtBody),
            makeArtifact({ id: 'bin', filename: 'blob.bin', mimeType: 'application/octet-stream', version: 4 }, binBody),
        ];
        const bodies: Record<string, Buffer> = { md: mdBody, txt: txtBody, bin: binBody };
        const { stores, calls } = stubStores(artifacts, (id) => bodies[id]);

        const result = await indexArtifactContent(stores);

        expect(result).toEqual({ indexed: 3, errors: [] });
        expect(calls.map((c) => c.sourceId)).toEqual(['md', 'txt', 'bin']);
        for (const c of calls) expect(c.sourceStore).toBe('artifact');

        const md = calls[0];
        expect(md.text).toContain('release.md');
        expect(md.text).toContain('Release Notes');
        expect(md.text).toContain('shipping');
        expect(md.metadata).toEqual({ filename: 'release.md', mimeType: 'text/markdown', version: 2 });

        // .txt is treated as text by extension even with a generic mime type
        expect(calls[1].text).toContain('summary');
        expect(calls[1].text).toContain('quarterly');

        // binary: filename and version only — none of the bytes leak into the text
        expect(calls[2].text).toBe('blob.bin v4');
    });

    it('indexes by filename and version when the store has no content for a text artifact', async () => {
        const art = makeArtifact({ id: 'gone', filename: 'ghost.md', mimeType: 'text/markdown', version: 3 }, Buffer.from('x'));
        const { stores, calls } = stubStores([art], () => null);

        const result = await indexArtifactContent(stores);

        expect(result).toEqual({ indexed: 1, errors: [] });
        expect(calls[0].text).toBe('ghost.md v3');
    });

    it('returns zero indexed and no errors for an empty cluster', async () => {
        const { stores, calls } = stubStores([], () => null);
        expect(await indexArtifactContent(stores)).toEqual({ indexed: 0, errors: [] });
        expect(calls).toEqual([]);
    });
});

describe('indexArtifactContent — integrity refusal (PROV-001)', () => {
    it('re-hashes the returned bytes and REFUSES to index when they do not match contentHash', async () => {
        const original = Buffer.from('# Trusted\ntrusted content');
        const art = makeArtifact({ id: 'tampered', filename: 'doc.md', mimeType: 'text/markdown' }, original);
        // The store does not throw — it simply returns different bytes.
        const { stores, calls } = stubStores([art], () => Buffer.from('# Poisoned\npoisoned payload'));

        const result = await indexArtifactContent(stores);

        expect(result.indexed).toBe(0);
        expect(calls).toEqual([]); // poisoned text never reached the index
        expect(result.errors).toHaveLength(1);
        const msg = result.errors[0];
        expect(msg).toContain('Refusing to index artifact tampered (doc.md)');
        expect(msg).toContain('content integrity check failed');
        expect(msg).toContain(`recorded contentHash=${art.contentHash}`);
        expect(msg).toContain(`sha256(on-disk bytes)=${sha(Buffer.from('# Poisoned\npoisoned payload'))}`);
    });

    it('recognises a store-thrown integrity error by its name', async () => {
        const art = makeArtifact({ id: 'n', filename: 'a.md', mimeType: 'text/markdown' }, Buffer.from('x'));
        const err = new Error('hash mismatch on disk');
        err.name = 'ContentReadIntegrityError';
        const { stores, calls } = stubStores([art], () => err);

        const result = await indexArtifactContent(stores);

        expect(result.indexed).toBe(0);
        expect(calls).toEqual([]);
        expect(result.errors[0]).toContain('Refusing to index artifact n (a.md)');
        expect(result.errors[0]).toContain('hash mismatch on disk');
    });

    it('recognises an InvalidContentHash error by its name too', async () => {
        const art = makeArtifact({ id: 'h', filename: 'b.md', mimeType: 'text/markdown' }, Buffer.from('x'));
        const err = new Error('bad hash shape');
        err.name = 'InvalidContentHashError';
        const { stores } = stubStores([art], () => err);

        const result = await indexArtifactContent(stores);
        expect(result.errors[0]).toContain('Refusing to index artifact h (b.md)');
    });

    it.each(['CONTENT_READ_INTEGRITY', 'INVALID_CONTENT_HASH'])(
        'recognises an integrity error by its code (%s) even with a generic name',
        async (code) => {
            const art = makeArtifact({ id: 'c', filename: 'c.md', mimeType: 'text/markdown' }, Buffer.from('x'));
            const err = Object.assign(new Error('coded failure'), { code });
            const { stores, calls } = stubStores([art], () => err);

            const result = await indexArtifactContent(stores);

            expect(calls).toEqual([]);
            expect(result.errors[0]).toContain('Refusing to index artifact c (c.md)');
            expect(result.errors[0]).toContain('coded failure');
        },
    );

    it('reports an ordinary failure as "Failed to index", not as an integrity refusal', async () => {
        const art = makeArtifact({ id: 'o', filename: 'o.md', mimeType: 'text/markdown' }, Buffer.from('x'));
        const err = Object.assign(new Error('disk on fire'), { code: 'EIO' });
        const { stores } = stubStores([art], () => err);

        const result = await indexArtifactContent(stores);

        expect(result.indexed).toBe(0);
        expect(result.errors).toEqual(['Failed to index artifact o: disk on fire']);
        expect(result.errors[0]).not.toContain('Refusing');
    });

    it('treats a thrown non-object value (no name/code) as an ordinary failure', async () => {
        const art = makeArtifact({ id: 's', filename: 's.md', mimeType: 'text/markdown' }, Buffer.from('x'));
        const stores = {
            artifact: {
                list: async () => [art],
                getContent: async () => {
                    throw Object.assign(new Error('plain'), { name: 42, code: 7 });
                },
            },
            index: { index: async () => undefined },
        } as unknown as ClusterStores;

        const result = await indexArtifactContent(stores);
        expect(result.errors).toEqual(['Failed to index artifact s: plain']);
    });

    it('keeps indexing the healthy artifacts around a refused one', async () => {
        const good1 = Buffer.from('# One\nalpha alpha');
        const good2 = Buffer.from('# Two\nbeta beta');
        const arts = [
            makeArtifact({ id: 'g1', filename: 'one.md', mimeType: 'text/markdown' }, good1),
            makeArtifact({ id: 'bad', filename: 'bad.md', mimeType: 'text/markdown' }, Buffer.from('expected')),
            makeArtifact({ id: 'g2', filename: 'two.md', mimeType: 'text/markdown' }, good2),
        ];
        const bodies: Record<string, Buffer> = { g1: good1, bad: Buffer.from('swapped'), g2: good2 };
        const { stores, calls } = stubStores(arts, (id) => bodies[id]);

        const result = await indexArtifactContent(stores);

        expect(result.indexed).toBe(2);
        expect(calls.map((c) => c.sourceId)).toEqual(['g1', 'g2']);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toContain('artifact bad');
    });
});
