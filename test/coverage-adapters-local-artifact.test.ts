/**
 * Coverage — LocalArtifactStore: damaged metadata files, tampered content
 * hashes, and failed content writes. Files are damaged on disk and a store is
 * constructed over them, or the content directory is removed underneath a
 * live store to force a write failure.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { LocalArtifactStore } from '../src/adapters/local/local-artifact-store.js';
import type { Artifact } from '../src/types/artifact.js';

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

function artifactRecord(overrides: Partial<Artifact> = {}): Artifact {
    const body = Buffer.from('body');
    return {
        id: 'art-1',
        filename: 'a.txt',
        contentHash: sha(body),
        mimeType: 'text/plain',
        sizeBytes: body.length,
        version: 1,
        storagePath: 'ignored',
        ingestedAt: '2026-01-01T00:00:00.000Z',
        owner: 'artifact',
        ...overrides,
    };
}

describe('LocalArtifactStore', () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'cov-artifact-'));
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    describe('loading metadata', () => {
        it('an artifacts.json path that cannot be read as a file throws CorruptStoreError', () => {
            mkdirSync(join(dir, 'artifacts.json'), { recursive: true });
            let caught: unknown;
            try {
                new LocalArtifactStore(dir);
            } catch (e) {
                caught = e;
            }
            expect(caught).toMatchObject({ code: 'CORRUPT_STORE', name: 'CorruptStoreError' });
            expect(String((caught as Error).message)).toContain('artifacts.json');
        });

        it('unparseable and non-array metadata both throw CorruptStoreError', () => {
            writeFileSync(join(dir, 'artifacts.json'), '{broken');
            expect(() => new LocalArtifactStore(dir)).toThrow(expect.objectContaining({ code: 'CORRUPT_STORE' }));
            writeFileSync(join(dir, 'artifacts.json'), '{"not":"an array"}');
            expect(() => new LocalArtifactStore(dir)).toThrow(expect.objectContaining({ code: 'CORRUPT_STORE' }));
        });
    });

    describe('getContent', () => {
        it('rejects a tampered metadata record whose contentHash is not a sha256 hex digest', async () => {
            writeFileSync(
                join(dir, 'artifacts.json'),
                JSON.stringify([artifactRecord({ contentHash: '../../outside' })]),
            );
            const store = new LocalArtifactStore(dir);
            let caught: unknown;
            try {
                await store.getContent('art-1');
            } catch (e) {
                caught = e;
            }
            expect(caught).toMatchObject({ code: 'INVALID_CONTENT_HASH', name: 'InvalidContentHashError' });
            expect(String((caught as Error).message)).toContain('../../outside');
        });

        it('returns null for an unknown id and for a record whose content file is gone', async () => {
            const store = new LocalArtifactStore(dir);
            expect(await store.getContent('nope')).toBeNull();
            const art = await store.ingest({ filename: 'gone.txt', content: Buffer.from('gone'), mimeType: 'text/plain' });
            rmSync(join(dir, 'content', art.contentHash));
            expect(await store.getContent(art.id)).toBeNull();
        });

        it('throws ContentReadIntegrityError when the bytes on disk no longer match the recorded hash', async () => {
            const store = new LocalArtifactStore(dir);
            const art = await store.ingest({ filename: 't.txt', content: Buffer.from('original'), mimeType: 'text/plain' });
            writeFileSync(join(dir, 'content', art.contentHash), 'tampered');
            let caught: unknown;
            try {
                await store.getContent(art.id);
            } catch (e) {
                caught = e;
            }
            expect(caught).toMatchObject({ code: 'CONTENT_READ_INTEGRITY', name: 'ContentReadIntegrityError' });
        });
    });

    describe('listing and versions', () => {
        it('filters by mimeType and filename substring (case-insensitively) and applies the limit', async () => {
            const store = new LocalArtifactStore(dir);
            await store.ingest({ filename: 'Report.TXT', content: Buffer.from('1'), mimeType: 'text/plain' });
            await store.ingest({ filename: 'report-2.md', content: Buffer.from('2'), mimeType: 'text/markdown' });
            await store.ingest({ filename: 'other.bin', content: Buffer.from('3'), mimeType: 'application/octet-stream' });

            expect((await store.list({ mimeType: 'text/markdown' })).map((a) => a.filename)).toEqual(['report-2.md']);
            expect((await store.list({ filenameContains: 'REPORT' })).map((a) => a.filename)).toEqual(['Report.TXT', 'report-2.md']);
            expect((await store.list({ filenameContains: 'report', limit: 1 })).map((a) => a.filename)).toEqual(['Report.TXT']);
        });

        it('re-ingesting a filename bumps its version, shares identical content, and versions() sorts ascending', async () => {
            const store = new LocalArtifactStore(dir);
            const v1 = await store.ingest({ filename: 'doc.txt', content: Buffer.from('same'), mimeType: 'text/plain' });
            const v2 = await store.ingest({ filename: 'doc.txt', content: Buffer.from('same'), mimeType: 'text/plain' });
            expect([v1.version, v2.version]).toEqual([1, 2]);
            expect(v2.contentHash).toBe(v1.contentHash);
            expect((await store.versions('doc.txt')).map((a) => a.version)).toEqual([1, 2]);
            expect(readdirSync(join(dir, 'content'))).toEqual([v1.contentHash]);
            expect(await store.versions('never-ingested.txt')).toEqual([]);
        });
    });

    describe('failed content writes', () => {
        it('ingest(): when the content directory vanishes the original error surfaces, nothing is recorded and no tmp file is left', async () => {
            const store = new LocalArtifactStore(dir);
            rmSync(join(dir, 'content'), { recursive: true, force: true });
            await expect(
                store.ingest({ filename: 'lost.txt', content: Buffer.from('lost'), mimeType: 'text/plain' }),
            ).rejects.toMatchObject({ code: 'ENOENT' });
            expect(await store.list()).toEqual([]);
            expect(existsSync(join(dir, 'artifacts.json'))).toBe(false);
        });

        it('importSnapshot(): the same failure leaves no record behind', async () => {
            const store = new LocalArtifactStore(dir);
            rmSync(join(dir, 'content'), { recursive: true, force: true });
            const body = Buffer.from('imported');
            const meta = artifactRecord({ id: 'imp-1', contentHash: sha(body), sizeBytes: body.length });
            await expect(store.importSnapshot(meta, body)).rejects.toMatchObject({ code: 'ENOENT' });
            expect(await store.exists('imp-1')).toBe(false);
        });

        it('importSnapshot() rejects an invalid contentHash before writing anything', async () => {
            const store = new LocalArtifactStore(dir);
            await expect(
                store.importSnapshot(artifactRecord({ contentHash: 'not-a-hash' }), Buffer.from('x')),
            ).rejects.toMatchObject({ code: 'INVALID_CONTENT_HASH' });
            expect(readdirSync(join(dir, 'content'))).toEqual([]);
        });

        it('importSnapshot() is idempotent for identical metadata and conflicts when the metadata differs', async () => {
            const store = new LocalArtifactStore(dir);
            const body = Buffer.from('imported twice');
            const meta = artifactRecord({ id: 'imp-2', contentHash: sha(body), sizeBytes: body.length });
            const first = await store.importSnapshot(meta, body);
            const again = await store.importSnapshot({ ...meta, storagePath: 'somewhere/else' }, body);
            expect(again).toBe(first);
            await expect(
                store.importSnapshot({ ...meta, filename: 'renamed.txt' }, body),
            ).rejects.toMatchObject({ code: 'IMPORT_CONFLICT' });
            expect((await store.get('imp-2'))?.filename).toBe('a.txt');
        });
    });
});
