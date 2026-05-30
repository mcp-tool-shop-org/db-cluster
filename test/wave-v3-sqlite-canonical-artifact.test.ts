/**
 * Wave V3 — SQLite canonical + artifact store tests (agent A1).
 *
 * Proves SqliteCanonicalStore and SqliteArtifactStore are behaviorally
 * IDENTICAL to their local counterparts (LocalCanonicalStore /
 * LocalArtifactStore): same return shapes, same thrown error TYPES, same
 * null/empty semantics, same append-a-version model.
 *
 * Gating: mirrors the foundation test (`wave-v3-sqlite-foundation.test.ts`) —
 * resolve `better-sqlite3` (without loading it) and `describe.skip` when absent.
 *
 * Windows file-lock discipline: every test that opens a SqliteDb closes it in a
 * `finally` BEFORE `rmSync`-ing the temp dir (an open handle keeps a lock on the
 * db file + WAL sidecars; rmSync would throw EBUSY otherwise).
 */

import { describe, it, expect } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteDb } from '../src/adapters/sqlite/sqlite-db.js';
import { SqliteCanonicalStore } from '../src/adapters/sqlite/sqlite-canonical-store.js';
import { SqliteArtifactStore } from '../src/adapters/sqlite/sqlite-artifact-store.js';
import {
    CANONICAL_TABLE,
    ARTIFACTS_TABLE,
    ARTIFACT_CONTENT_TABLE,
} from '../src/adapters/sqlite/schema.js';
import {
    InvalidContentHashError,
    ContentReadIntegrityError,
    ImportConflictError,
} from '../src/adapters/local/errors.js';
import type { Entity } from '../src/types/entity.js';
import type { Artifact } from '../src/types/artifact.js';

/** True iff better-sqlite3 resolves on this machine (does not load it). */
function hasSqlite(): boolean {
    try {
        createRequire(import.meta.url).resolve('better-sqlite3');
        return true;
    } catch {
        return false;
    }
}

const describeSqlite = hasSqlite() ? describe : describe.skip;

/** Open a fresh db in a fresh temp dir. Returns the handles + a disposer that
 *  closes the db THEN removes the dir (close-before-rm — Windows lock rule). */
function freshStore(): {
    dir: string;
    db: SqliteDb;
    canonical: SqliteCanonicalStore;
    artifacts: SqliteArtifactStore;
    dispose: () => void;
} {
    const dir = mkdtempSync(join(tmpdir(), 'wave-v3-a1-'));
    const db = SqliteDb.open(join(dir, 'cluster.db'));
    const canonical = new SqliteCanonicalStore(db);
    const artifacts = new SqliteArtifactStore(db);
    const dispose = () => {
        db.close();
        rmSync(dir, { recursive: true, force: true });
    };
    return { dir, db, canonical, artifacts, dispose };
}

describeSqlite('Wave V3 — SqliteCanonicalStore (local parity)', () => {
    it('create() stamps id/version=1/owner/timestamps and ignores caller-supplied id/version/owner', async () => {
        const { canonical, dispose } = freshStore();
        try {
            const created = await canonical.create({
                kind: 'concept',
                name: 'Alpha',
                attributes: { a: 1 },
                // Caller attempts to override stamped fields via a raw cast.
                id: 'CALLER-ID',
                version: 99,
                owner: 'canonical',
                createdAt: '1999-01-01T00:00:00Z',
                updatedAt: '1999-01-01T00:00:00Z',
            } as unknown as Parameters<typeof canonical.create>[0]);

            expect(created.id).not.toBe('CALLER-ID');
            expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
            expect(created.version).toBe(1);
            expect(created.owner).toBe('canonical');
            expect(created.kind).toBe('concept');
            expect(created.name).toBe('Alpha');
            expect(created.attributes).toEqual({ a: 1 });
            expect(created.createdAt).toBe(created.updatedAt);
            expect(created.createdAt).not.toBe('1999-01-01T00:00:00Z');

            // get() returns the latest (only) version.
            const got = await canonical.get(created.id);
            expect(got).toEqual(created);
        } finally {
            dispose();
        }
    });

    it('get() returns null for an unknown id; exists() reflects presence', async () => {
        const { canonical, dispose } = freshStore();
        try {
            expect(await canonical.get('nope')).toBeNull();
            expect(await canonical.exists('nope')).toBe(false);
            const e = await canonical.create({ kind: 'k', name: 'n', attributes: {} });
            expect(await canonical.exists(e.id)).toBe(true);
        } finally {
            dispose();
        }
    });

    it('update() appends version N+1, retains prior versions, restamps updatedAt', async () => {
        const { canonical, dispose } = freshStore();
        try {
            const v1 = await canonical.create({
                kind: 'concept',
                name: 'Orig',
                attributes: { x: 1 },
            });
            const v2 = await canonical.update(v1.id, { name: 'Renamed', attributes: { x: 2 } });

            expect(v2.version).toBe(2);
            expect(v2.id).toBe(v1.id);
            expect(v2.kind).toBe('concept'); // carried forward
            expect(v2.name).toBe('Renamed');
            expect(v2.attributes).toEqual({ x: 2 });
            expect(v2.createdAt).toBe(v1.createdAt); // carried forward
            expect(v2.owner).toBe('canonical');

            // get() now returns the latest (v2).
            expect(await canonical.get(v1.id)).toEqual(v2);

            // Prior version is RETAINED and unchanged.
            const fetchedV1 = await canonical.getVersion(v1.id, 1);
            expect(fetchedV1).toEqual(v1);

            // listVersions returns both ascending.
            const versions = await canonical.listVersions(v1.id);
            expect(versions.map((e) => e.version)).toEqual([1, 2]);
            expect(versions[0]).toEqual(v1);
            expect(versions[1]).toEqual(v2);

            // A partial patch carries forward the unpatched field.
            const v3 = await canonical.update(v1.id, { name: 'Third' });
            expect(v3.version).toBe(3);
            expect(v3.attributes).toEqual({ x: 2 }); // carried from v2
            expect(v3.name).toBe('Third');
        } finally {
            dispose();
        }
    });

    it('update() throws a plain Error on an unknown id (local + postgres parity)', async () => {
        const { canonical, dispose } = freshStore();
        try {
            await expect(canonical.update('ghost', { name: 'x' })).rejects.toThrow(
                'Entity not found: ghost',
            );
        } finally {
            dispose();
        }
    });

    it('getVersion() returns null for an unknown id or missing version', async () => {
        const { canonical, dispose } = freshStore();
        try {
            expect(await canonical.getVersion('ghost', 1)).toBeNull();
            const e = await canonical.create({ kind: 'k', name: 'n', attributes: {} });
            expect(await canonical.getVersion(e.id, 5)).toBeNull();
            expect(await canonical.getVersion(e.id, 1)).toEqual(e);
        } finally {
            dispose();
        }
    });

    it('listVersions() returns [] for an unknown id', async () => {
        const { canonical, dispose } = freshStore();
        try {
            expect(await canonical.listVersions('ghost')).toEqual([]);
        } finally {
            dispose();
        }
    });

    it('list() returns one row per id (the latest version), filtered by kind/nameContains/limit', async () => {
        const { canonical, dispose } = freshStore();
        try {
            const a = await canonical.create({ kind: 'concept', name: 'Apple', attributes: {} });
            const b = await canonical.create({ kind: 'concept', name: 'Banana', attributes: {} });
            const c = await canonical.create({ kind: 'place', name: 'Cherry', attributes: {} });
            // Version a up twice — list must still show ONE row for a, at the latest.
            await canonical.update(a.id, { name: 'Apricot' });

            const all = await canonical.list();
            expect(all).toHaveLength(3); // one per id, not per version
            const aRow = all.find((e) => e.id === a.id)!;
            expect(aRow.name).toBe('Apricot');
            expect(aRow.version).toBe(2);

            // Deterministic order: INSERTION order (each id's first-version
            // rowid), matching LocalCanonicalStore's Map-insertion (creation)
            // order EXACTLY — including when entities tie on a created_at
            // millisecond (Wave V3 parity finding F1; the SQLite store orders by
            // MIN(rowid) per id, NOT created_at, so the limited subset matches
            // local too). a, b, c were created in that order.
            const expectedOrder = [a.id, b.id, c.id];
            expect(all.map((e) => e.id)).toEqual(expectedOrder);
            // And the set is exactly {a, b, c}.
            expect(new Set(all.map((e) => e.id))).toEqual(new Set([a.id, b.id, c.id]));

            // kind filter (exact).
            const concepts = await canonical.list({ kind: 'concept' });
            expect(concepts.map((e) => e.id).sort()).toEqual([a.id, b.id].sort());

            // nameContains is case-insensitive substring (matches local toLowerCase().includes).
            const cherries = await canonical.list({ nameContains: 'CHER' });
            expect(cherries.map((e) => e.id)).toEqual([c.id]);

            // limit applies AFTER the insertion ordering — the first 2 of the
            // creation-order sequence [a, b, c].
            const limited = await canonical.list({ limit: 2 });
            expect(limited).toHaveLength(2);
            expect(limited.map((e) => e.id)).toEqual(expectedOrder.slice(0, 2));
        } finally {
            dispose();
        }
    });

    it('importSnapshot() is idempotent on a byte-identical re-import', async () => {
        const { canonical, dispose } = freshStore();
        try {
            const snap: Entity = {
                id: randomUUID(),
                kind: 'concept',
                name: 'Imported',
                attributes: { k: 'v' },
                version: 3,
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-02T00:00:00.000Z',
                owner: 'canonical',
            };
            const first = await canonical.importSnapshot(snap);
            expect(first.id).toBe(snap.id);
            expect(first.version).toBe(3); // incoming version preserved
            expect(first.createdAt).toBe(snap.createdAt);
            expect(first.updatedAt).toBe(snap.updatedAt);
            expect(first.attributes).toEqual({ k: 'v' });

            // Re-import the IDENTICAL snapshot — returns existing, no throw, no dup row.
            const second = await canonical.importSnapshot({ ...snap });
            expect(second).toEqual(first);

            const versions = await canonical.listVersions(snap.id);
            expect(versions).toHaveLength(1);
        } finally {
            dispose();
        }
    });

    it('importSnapshot() throws ImportConflictError on a tampered re-import (same id+version, different content)', async () => {
        const { canonical, dispose } = freshStore();
        try {
            const id = randomUUID();
            const base: Entity = {
                id,
                kind: 'concept',
                name: 'Stable',
                attributes: { a: 1 },
                version: 1,
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z',
                owner: 'canonical',
            };
            await canonical.importSnapshot(base);

            // Same (id, version) but altered content → ImportConflictError.
            const tampered: Entity = { ...base, name: 'TAMPERED' };
            await expect(canonical.importSnapshot(tampered)).rejects.toBeInstanceOf(
                ImportConflictError,
            );

            // owner-only difference is NOT a conflict (owner excluded from compare).
            const ownerOnly: Entity = { ...base, owner: 'canonical' };
            await expect(canonical.importSnapshot(ownerOnly)).resolves.toMatchObject({ id });
        } finally {
            dispose();
        }
    });

    it('importSnapshot() appends a NEW version of an existing id', async () => {
        const { canonical, dispose } = freshStore();
        try {
            const id = randomUUID();
            const v1: Entity = {
                id,
                kind: 'concept',
                name: 'V1',
                attributes: {},
                version: 1,
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z',
                owner: 'canonical',
            };
            const v2: Entity = { ...v1, name: 'V2', version: 2, updatedAt: '2026-01-02T00:00:00.000Z' };
            await canonical.importSnapshot(v1);
            await canonical.importSnapshot(v2);

            const versions = await canonical.listVersions(id);
            expect(versions.map((e) => e.version)).toEqual([1, 2]);
            expect((await canonical.get(id))!.name).toBe('V2');
        } finally {
            dispose();
        }
    });

    it('importSnapshot() defaults a missing version to 1', async () => {
        const { canonical, dispose } = freshStore();
        try {
            const id = randomUUID();
            const legacy = {
                id,
                kind: 'concept',
                name: 'Legacy',
                attributes: {},
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z',
                owner: 'canonical',
            } as unknown as Entity; // no version field
            const stored = await canonical.importSnapshot(legacy);
            expect(stored.version).toBe(1);
        } finally {
            dispose();
        }
    });
});

describeSqlite('Wave V3 — SqliteArtifactStore (local parity)', () => {
    it('ingest() stamps fields and getContent() round-trips the bytes', async () => {
        const { artifacts, dispose } = freshStore();
        try {
            const content = Buffer.from('hello world', 'utf-8');
            const art = await artifacts.ingest({
                filename: 'greeting.txt',
                content,
                mimeType: 'text/plain',
            });

            expect(art.id).toMatch(/^[0-9a-f-]{36}$/);
            expect(art.filename).toBe('greeting.txt');
            expect(art.mimeType).toBe('text/plain');
            expect(art.sizeBytes).toBe(content.length);
            expect(art.version).toBe(1);
            expect(art.owner).toBe('artifact');
            expect(art.contentHash).toBe(createHash('sha256').update(content).digest('hex'));
            expect(art.storagePath).toBe(`sqlite:${art.contentHash}`);

            // get() returns metadata.
            expect(await artifacts.get(art.id)).toEqual(art);

            // getContent() returns the exact bytes.
            const buf = await artifacts.getContent(art.id);
            expect(buf).not.toBeNull();
            expect(Buffer.isBuffer(buf)).toBe(true);
            expect(buf!.equals(content)).toBe(true);
        } finally {
            dispose();
        }
    });

    it('get()/getContent() return null for an unknown id; exists() reflects presence', async () => {
        const { artifacts, dispose } = freshStore();
        try {
            expect(await artifacts.get('nope')).toBeNull();
            expect(await artifacts.getContent('nope')).toBeNull();
            expect(await artifacts.exists('nope')).toBe(false);
            const art = await artifacts.ingest({
                filename: 'f.bin',
                content: Buffer.from([1, 2, 3]),
                mimeType: 'application/octet-stream',
            });
            expect(await artifacts.exists(art.id)).toBe(true);
        } finally {
            dispose();
        }
    });

    it('ingest() versions per-filename; versions() returns them ascending by version', async () => {
        const { artifacts, dispose } = freshStore();
        try {
            const v1 = await artifacts.ingest({
                filename: 'doc.md',
                content: Buffer.from('one'),
                mimeType: 'text/markdown',
            });
            const v2 = await artifacts.ingest({
                filename: 'doc.md',
                content: Buffer.from('two'),
                mimeType: 'text/markdown',
            });
            const other = await artifacts.ingest({
                filename: 'other.md',
                content: Buffer.from('x'),
                mimeType: 'text/markdown',
            });

            expect(v1.version).toBe(1);
            expect(v2.version).toBe(2);
            expect(other.version).toBe(1);

            const versions = await artifacts.versions('doc.md');
            expect(versions.map((a) => a.version)).toEqual([1, 2]);
            expect(versions.map((a) => a.id)).toEqual([v1.id, v2.id]);

            expect(await artifacts.versions('missing.md')).toEqual([]);
        } finally {
            dispose();
        }
    });

    it('list() filters by mimeType/filenameContains/limit, ordered by insertion (rowid ASC)', async () => {
        const { artifacts, dispose } = freshStore();
        try {
            const a = await artifacts.ingest({
                filename: 'alpha.txt',
                content: Buffer.from('a'),
                mimeType: 'text/plain',
            });
            const b = await artifacts.ingest({
                filename: 'beta.png',
                content: Buffer.from('b'),
                mimeType: 'image/png',
            });
            const c = await artifacts.ingest({
                filename: 'gamma.txt',
                content: Buffer.from('c'),
                mimeType: 'text/plain',
            });

            const all = await artifacts.list();
            expect(all.map((x) => x.id)).toEqual([a.id, b.id, c.id]); // insertion order

            const txt = await artifacts.list({ mimeType: 'text/plain' });
            expect(txt.map((x) => x.id)).toEqual([a.id, c.id]);

            const beta = await artifacts.list({ filenameContains: 'BET' }); // case-insensitive
            expect(beta.map((x) => x.id)).toEqual([b.id]);

            const limited = await artifacts.list({ limit: 2 });
            expect(limited.map((x) => x.id)).toEqual([a.id, b.id]);
        } finally {
            dispose();
        }
    });

    it('ingesting identical bytes twice dedups the content blob (one artifact_content row)', async () => {
        const { db, artifacts, dispose } = freshStore();
        try {
            const content = Buffer.from('shared bytes', 'utf-8');
            const a = await artifacts.ingest({
                filename: 'a.txt',
                content,
                mimeType: 'text/plain',
            });
            const b = await artifacts.ingest({
                filename: 'b.txt',
                content,
                mimeType: 'text/plain',
            });
            // Distinct artifacts...
            expect(a.id).not.toBe(b.id);
            // ...but ONE shared content row (same hash).
            expect(a.contentHash).toBe(b.contentHash);

            const metaCount = db.connection
                .prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM ${ARTIFACTS_TABLE}`)
                .get();
            expect(metaCount?.n).toBe(2);

            const contentCount = db.connection
                .prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM ${ARTIFACT_CONTENT_TABLE}`)
                .get();
            expect(contentCount?.n).toBe(1);

            // Both still read back the correct bytes.
            expect((await artifacts.getContent(a.id))!.equals(content)).toBe(true);
            expect((await artifacts.getContent(b.id))!.equals(content)).toBe(true);
        } finally {
            dispose();
        }
    });

    it('getContent() throws ContentReadIntegrityError when the on-disk blob is corrupted', async () => {
        const { db, artifacts, dispose } = freshStore();
        try {
            const content = Buffer.from('original', 'utf-8');
            const art = await artifacts.ingest({
                filename: 'tamper.txt',
                content,
                mimeType: 'text/plain',
            });

            // Hand-corrupt the blob via the raw connection — the metadata's
            // contentHash still claims the ORIGINAL hash, so the re-hash mismatches.
            db.connection
                .prepare(`UPDATE ${ARTIFACT_CONTENT_TABLE} SET bytes = ? WHERE content_hash = ?`)
                .run(Buffer.from('CORRUPTED', 'utf-8'), art.contentHash);

            await expect(artifacts.getContent(art.id)).rejects.toBeInstanceOf(
                ContentReadIntegrityError,
            );
        } finally {
            dispose();
        }
    });

    it('getContent() throws InvalidContentHashError when metadata contentHash is shape-invalid', async () => {
        const { db, artifacts, dispose } = freshStore();
        try {
            const art = await artifacts.ingest({
                filename: 'badhash.txt',
                content: Buffer.from('x'),
                mimeType: 'text/plain',
            });

            // Corrupt the metadata row's content_hash to a non-64-hex value.
            db.connection
                .prepare(`UPDATE ${ARTIFACTS_TABLE} SET content_hash = ? WHERE id = ?`)
                .run('../escape', art.id);

            await expect(artifacts.getContent(art.id)).rejects.toBeInstanceOf(
                InvalidContentHashError,
            );
        } finally {
            dispose();
        }
    });

    it('getContent() returns null when the content row is missing (content moved/absent parity)', async () => {
        const { db, artifacts, dispose } = freshStore();
        try {
            const art = await artifacts.ingest({
                filename: 'gone.txt',
                content: Buffer.from('bye'),
                mimeType: 'text/plain',
            });
            // Delete the content blob but keep the (valid-hash) metadata.
            db.connection
                .prepare(`DELETE FROM ${ARTIFACT_CONTENT_TABLE} WHERE content_hash = ?`)
                .run(art.contentHash);

            expect(await artifacts.getContent(art.id)).toBeNull();
        } finally {
            dispose();
        }
    });

    it('importSnapshot() preserves id, rewrites storagePath, and is idempotent on identical re-import', async () => {
        const { artifacts, dispose } = freshStore();
        try {
            const content = Buffer.from('snapshot bytes', 'utf-8');
            const hash = createHash('sha256').update(content).digest('hex');
            const meta: Artifact = {
                id: randomUUID(),
                filename: 'snap.txt',
                contentHash: hash,
                mimeType: 'text/plain',
                sizeBytes: content.length,
                version: 2,
                storagePath: '/some/foreign/cluster/path', // will be rewritten
                ingestedAt: '2026-01-01T00:00:00.000Z',
                owner: 'artifact',
            };
            const stored = await artifacts.importSnapshot(meta, content);
            expect(stored.id).toBe(meta.id);
            expect(stored.version).toBe(2); // preserved
            expect(stored.ingestedAt).toBe(meta.ingestedAt); // preserved
            expect(stored.storagePath).toBe(`sqlite:${hash}`); // rewritten
            expect(stored.owner).toBe('artifact');

            // Content reads back.
            expect((await artifacts.getContent(meta.id))!.equals(content)).toBe(true);

            // Idempotent re-import (storagePath differs but is excluded from compare).
            const again = await artifacts.importSnapshot(
                { ...meta, storagePath: '/yet/another/path' },
                content,
            );
            expect(again.id).toBe(meta.id);
        } finally {
            dispose();
        }
    });

    it('importSnapshot() throws ImportConflictError on id collision with different content', async () => {
        const { artifacts, dispose } = freshStore();
        try {
            const content = Buffer.from('first', 'utf-8');
            const hash = createHash('sha256').update(content).digest('hex');
            const meta: Artifact = {
                id: randomUUID(),
                filename: 'conflict.txt',
                contentHash: hash,
                mimeType: 'text/plain',
                sizeBytes: content.length,
                version: 1,
                storagePath: 'whatever',
                ingestedAt: '2026-01-01T00:00:00.000Z',
                owner: 'artifact',
            };
            await artifacts.importSnapshot(meta, content);

            // Same id, different filename → conflict.
            await expect(
                artifacts.importSnapshot({ ...meta, filename: 'RENAMED.txt' }, content),
            ).rejects.toBeInstanceOf(ImportConflictError);
        } finally {
            dispose();
        }
    });

    it('importSnapshot() throws InvalidContentHashError when the contentHash is shape-invalid', async () => {
        const { artifacts, dispose } = freshStore();
        try {
            const content = Buffer.from('x', 'utf-8');
            const meta: Artifact = {
                id: randomUUID(),
                filename: 'bad.txt',
                contentHash: 'not-a-valid-hash',
                mimeType: 'text/plain',
                sizeBytes: 1,
                version: 1,
                storagePath: 'whatever',
                ingestedAt: '2026-01-01T00:00:00.000Z',
                owner: 'artifact',
            };
            await expect(artifacts.importSnapshot(meta, content)).rejects.toBeInstanceOf(
                InvalidContentHashError,
            );
        } finally {
            dispose();
        }
    });
});
