/**
 * Wave V3 — PARAMETERIZED store-contract conformance, run over BOTH backends.
 *
 * The gold standard for substitutability (agent A4): the full store contract is
 * asserted ONCE and executed against BOTH the local adapter and the sqlite
 * adapter. The LOCAL run is the ground truth — it MUST pass, which proves the
 * assertion itself is correct (local is the known-good reference). The SQLITE
 * run (added only when the optional better-sqlite3 driver resolves) proves
 * parity: a divergence shows up as a test that passes for `[local]` but fails
 * for `[sqlite]`.
 *
 * What "identical behaviour" means here, asserted per store:
 *  - return SHAPES (the stamped record fields, owner literals, version numbers),
 *  - null-vs-throw (absent reads return `null`; unknown-id update throws),
 *  - empty-array shapes (no match → `[]`, never `null`),
 *  - ORDERING (listVersions ascending, list created-order, search insertion
 *    order with NO ranking, listEvents append order, limit = last-N),
 *  - error TYPES (ImportConflictError / ContentReadIntegrityError /
 *    InvalidContentHashError / LedgerIntegrityError / LedgerCycleDetectedError /
 *    InvalidRotateTimestampError / RotateBoundaryInFutureError).
 *
 * IMPORTANT scope note (kickoff): every contract test uses WELL-FORMED records.
 * No test depends on local's incidental tolerance of a malformed record (e.g.
 * an event with a missing `actorId`): that is a type-contract violation, and
 * sqlite correctly rejects it (NOT NULL) while local silently mis-stores it.
 * That strictness difference is ACCEPTED and explicitly out of scope.
 *
 * Tamper operations (corrupt-a-content-blob, hand-edit-a-ledger-row, plant a
 * trace cycle) are inherently backend-specific — a filesystem write vs a SQL
 * UPDATE. They are factored onto the per-backend StoreSet as raw-storage helpers
 * so the ASSERTION (`rejects … ContentReadIntegrityError`) is still written once
 * and the only thing that differs between backends is how the bytes get
 * corrupted underneath.
 *
 * Gating: the sqlite backend is added to the matrix only when better-sqlite3
 * resolves (same idiom as the Postgres-gated and other V3 suites). Local always
 * runs. Per-backend teardown closes the SqliteDb BEFORE rmSync (Windows file
 * lock on the .db / -wal / -shm sidecars).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    LocalCanonicalStore,
    LocalArtifactStore,
    LocalIndexStore,
    LocalLedgerStore,
} from '../src/adapters/local/index.js';
import {
    SqliteDb,
    SqliteCanonicalStore,
    SqliteArtifactStore,
    SqliteIndexStore,
    SqliteLedgerStore,
    ARTIFACT_CONTENT_TABLE,
    LEDGER_EVENTS_TABLE,
} from '../src/adapters/sqlite/index.js';
import {
    ContentReadIntegrityError,
    LedgerIntegrityError,
    ImportConflictError,
    InvalidContentHashError,
    LedgerCycleDetectedError,
    InvalidRotateTimestampError,
    RotateBoundaryInFutureError,
} from '../src/adapters/local/errors.js';
import { computeIntegrityHash } from '../src/types/integrity.js';

import type { CanonicalStore } from '../src/contracts/canonical-store.js';
import type { ArtifactStore } from '../src/contracts/artifact-store.js';
import type { IndexStore } from '../src/contracts/index-store.js';
import type { LedgerStore } from '../src/contracts/ledger-store.js';
import type { Entity } from '../src/types/entity.js';
import type { Artifact } from '../src/types/artifact.js';
import type { ProvenanceEvent } from '../src/types/provenance-event.js';

/** True iff better-sqlite3 resolves on this machine (does NOT load it). */
let hasSqlite = false;
try {
    createRequire(import.meta.url).resolve('better-sqlite3');
    hasSqlite = true;
} catch {
    /* sqlite backend dropped from the matrix; local still runs */
}

/**
 * The four stores for one backend, plus the lifecycle + raw-storage hooks the
 * contract tests need. `teardown()` releases all handles (closes the SqliteDb
 * BEFORE removing the temp dir). The tamper hooks reach into the backend's raw
 * substrate so a single written assertion can be exercised against both.
 */
interface StoreSet {
    canonical: CanonicalStore;
    artifact: ArtifactStore;
    index: IndexStore;
    ledger: LedgerStore;
    teardown(): void;

    /**
     * Corrupt the stored content bytes for a given content hash WITHOUT touching
     * the metadata's recorded contentHash (so getContent's gate-2 read-integrity
     * check must fire). Local: overwrite the on-disk content-addressed file.
     * Sqlite: UPDATE the artifact_content row's BLOB.
     */
    corruptArtifactContent(contentHash: string, replacement: Buffer): void;

    /**
     * Hand-edit a hashed field of a stored ledger event WITHOUT recomputing its
     * integrity hash, then return a ledger store that observes the edit. Local
     * loads events into memory at construction, so the edit is written to the
     * NDJSON file and a FRESH store is returned over the same dir. Sqlite reads
     * each row from the DB on demand, so the same store handle observes the
     * UPDATE and is returned as-is.
     */
    tamperEventActionAndReopen(id: string): LedgerStore;

    /**
     * Plant a parent-chain cycle (A.parentEventId = B, B.parentEventId = A) and
     * return a ledger store that observes it. `trace()` does NOT verify-on-read,
     * so the cycle is surfaced by the visited-set guard, not by integrity. Local
     * rewrites the NDJSON + returns a fresh store; sqlite UPDATEs both rows +
     * returns the same handle.
     */
    plantTraceCycleAndReopen(idA: string, idB: string): LedgerStore;
}

/** Build a local-backed StoreSet in a fresh temp dir. */
function localStores(): StoreSet {
    const dir = mkdtempSync(join(tmpdir(), 'v3-parity-local-'));
    const canonicalDir = join(dir, 'canonical');
    const artifactDir = join(dir, 'artifact');
    const indexDir = join(dir, 'index');
    const ledgerDir = join(dir, 'ledger');
    return {
        canonical: new LocalCanonicalStore(canonicalDir),
        artifact: new LocalArtifactStore(artifactDir),
        index: new LocalIndexStore(indexDir),
        ledger: new LocalLedgerStore(ledgerDir),
        teardown() {
            rmSync(dir, { recursive: true, force: true });
        },
        corruptArtifactContent(contentHash: string, replacement: Buffer) {
            // Content is stored content-addressed at <artifactDir>/content/<hash>.
            const contentPath = join(artifactDir, 'content', contentHash);
            writeFileSync(contentPath, replacement);
        },
        tamperEventActionAndReopen(id: string): LedgerStore {
            const eventsPath = join(ledgerDir, 'events.json');
            const lines = readFileSync(eventsPath, 'utf-8').split('\n');
            const rewritten = lines.map((line) => {
                if (line.trim().length === 0) return line;
                const obj = JSON.parse(line) as ProvenanceEvent;
                if (obj.id === id) {
                    obj.action = 'tampered'; // hashed field changed, hash left stale
                    return JSON.stringify(obj);
                }
                return line;
            });
            writeFileSync(eventsPath, rewritten.join('\n'));
            // Fresh store re-loads the tampered NDJSON into memory.
            return new LocalLedgerStore(ledgerDir);
        },
        plantTraceCycleAndReopen(idA: string, idB: string): LedgerStore {
            const eventsPath = join(ledgerDir, 'events.json');
            const lines = readFileSync(eventsPath, 'utf-8').split('\n');
            const rewritten = lines.map((line) => {
                if (line.trim().length === 0) return line;
                const obj = JSON.parse(line) as ProvenanceEvent;
                if (obj.id === idA) {
                    obj.parentEventId = idB; // A -> B
                    return JSON.stringify(obj);
                }
                if (obj.id === idB) {
                    obj.parentEventId = idA; // B -> A  (cycle)
                    return JSON.stringify(obj);
                }
                return line;
            });
            writeFileSync(eventsPath, rewritten.join('\n'));
            return new LocalLedgerStore(ledgerDir);
        },
    };
}

/** Build a sqlite-backed StoreSet (a single shared SqliteDb). */
function sqliteStores(): StoreSet {
    const dir = mkdtempSync(join(tmpdir(), 'v3-parity-sqlite-'));
    const db = SqliteDb.open(join(dir, 'cluster.db'));
    return {
        canonical: new SqliteCanonicalStore(db),
        artifact: new SqliteArtifactStore(db),
        index: new SqliteIndexStore(db),
        ledger: new SqliteLedgerStore(db),
        teardown() {
            // Close BEFORE rmSync — an open connection holds a Windows file lock
            // on the db file and its -wal / -shm sidecars.
            db.close();
            rmSync(dir, { recursive: true, force: true });
        },
        corruptArtifactContent(contentHash: string, replacement: Buffer) {
            db.connection
                .prepare(`UPDATE ${ARTIFACT_CONTENT_TABLE} SET bytes = ? WHERE content_hash = ?`)
                .run(replacement, contentHash);
        },
        tamperEventActionAndReopen(id: string): LedgerStore {
            db.connection
                .prepare(`UPDATE ${LEDGER_EVENTS_TABLE} SET action = 'tampered' WHERE id = ?`)
                .run(id);
            // The store reads the row from the DB on each getEvent — same handle.
            return new SqliteLedgerStore(db);
        },
        plantTraceCycleAndReopen(idA: string, idB: string): LedgerStore {
            const stmt = db.connection.prepare(
                `UPDATE ${LEDGER_EVENTS_TABLE} SET parent_event_id = ? WHERE id = ?`,
            );
            stmt.run(idB, idA); // A -> B
            stmt.run(idA, idB); // B -> A  (cycle)
            return new SqliteLedgerStore(db);
        },
    };
}

const BACKENDS: Array<[string, () => StoreSet]> = [
    ['local', localStores],
    ...(hasSqlite ? [['sqlite', sqliteStores] as [string, () => StoreSet]] : []),
];

// A genuine, self-consistent ProvenanceEvent for import paths — its
// integrityHash is computed over the same domain record the live append would
// build (genesis omits prevHash). Survives verify-on-restore AND verify-on-read.
function makeChainedEvent(args: {
    id: string;
    timestamp: string;
    action: string;
    actorId?: string;
    subjectId?: string;
    parentEventId?: string;
    prev?: string;
    detail?: Record<string, unknown>;
}): ProvenanceEvent {
    const record: ProvenanceEvent = {
        id: args.id,
        timestamp: args.timestamp,
        action: args.action,
        actorId: args.actorId ?? 'actor',
        subjectId: args.subjectId ?? 'subj',
        subjectStore: 'canonical',
        detail: args.detail ?? {},
        owner: 'ledger',
        integrityHash: '',
        ...(args.parentEventId !== undefined ? { parentEventId: args.parentEventId } : {}),
        ...(args.prev !== undefined ? { prevHash: args.prev } : {}),
    };
    record.integrityHash = computeIntegrityHash(record as unknown as Record<string, unknown>);
    return record;
}

for (const [name, make] of BACKENDS) {
    describe(`store contract parity [${name}]`, () => {
        let s: StoreSet;
        beforeEach(() => {
            s = make();
        });
        afterEach(() => {
            s.teardown();
        });

        // ════════════════════════════ CANONICAL ════════════════════════════
        describe('canonical', () => {
            it('create stamps id/version=1/owner/timestamps; get returns the latest', async () => {
                const e = await s.canonical.create({
                    kind: 'finding',
                    name: 'Alpha',
                    attributes: { a: 1 },
                });
                expect(e.id).toBeTruthy();
                expect(e.version).toBe(1);
                expect(e.owner).toBe('canonical');
                expect(typeof e.createdAt).toBe('string');
                expect(typeof e.updatedAt).toBe('string');
                expect(e.attributes).toEqual({ a: 1 });

                const got = await s.canonical.get(e.id);
                expect(got).toEqual(e);
            });

            it('update appends version N+1; prior versions retained; listVersions ascending; getVersion exact', async () => {
                const v1 = await s.canonical.create({
                    kind: 'finding',
                    name: 'Original',
                    attributes: { stage: 'a' },
                });
                const v2 = await s.canonical.update(v1.id, { name: 'Renamed' });
                expect(v2.version).toBe(2);
                expect(v2.name).toBe('Renamed');
                // id / kind / createdAt / owner carry forward; updatedAt restamped.
                expect(v2.id).toBe(v1.id);
                expect(v2.kind).toBe(v1.kind);
                expect(v2.createdAt).toBe(v1.createdAt);
                expect(v2.owner).toBe('canonical');

                const v3 = await s.canonical.update(v1.id, { attributes: { stage: 'c' } });
                expect(v3.version).toBe(3);
                // patch applies on top of latest; name carries from v2.
                expect(v3.name).toBe('Renamed');
                expect(v3.attributes).toEqual({ stage: 'c' });

                // get → latest only.
                const latest = await s.canonical.get(v1.id);
                expect(latest?.version).toBe(3);

                // listVersions → every version ascending by version.
                const versions = await s.canonical.listVersions(v1.id);
                expect(versions.map((e) => e.version)).toEqual([1, 2, 3]);
                // Prior versions retained immutably (v1 content unchanged).
                expect(versions[0].name).toBe('Original');
                expect(versions[0].attributes).toEqual({ stage: 'a' });

                // getVersion → exact version.
                const exactlyV2 = await s.canonical.getVersion(v1.id, 2);
                expect(exactlyV2).toEqual(v2);
                expect(await s.canonical.getVersion(v1.id, 99)).toBeNull();
            });

            it('update on an unknown id throws (plain Error, not a typed adapter error)', async () => {
                await expect(s.canonical.update('does-not-exist', { name: 'x' })).rejects.toThrow(
                    /not found/i,
                );
            });

            it('list returns one row per id (latest) with kind / nameContains / limit filters', async () => {
                const a = await s.canonical.create({ kind: 'finding', name: 'Apple', attributes: {} });
                await s.canonical.update(a.id, { name: 'Apricot' }); // a now has 2 versions
                const b = await s.canonical.create({ kind: 'concept', name: 'Banana', attributes: {} });
                await s.canonical.create({ kind: 'finding', name: 'Cherry', attributes: {} });

                const all = await s.canonical.list();
                // One row PER id (not per version) — 3 ids despite 4 versions total.
                expect(all.length).toBe(3);
                // The row for `a` is its LATEST version.
                const rowForA = all.find((e) => e.id === a.id);
                expect(rowForA?.name).toBe('Apricot');
                expect(rowForA?.version).toBe(2);

                // kind filter.
                const findings = await s.canonical.list({ kind: 'finding' });
                expect(findings.map((e) => e.name).sort()).toEqual(['Apricot', 'Cherry']);

                // nameContains is a case-insensitive substring.
                const ap = await s.canonical.list({ nameContains: 'ap' });
                expect(ap.map((e) => e.name).sort()).toEqual(['Apricot']);
                expect((await s.canonical.list({ nameContains: 'BANANA' })).map((e) => e.id)).toEqual([
                    b.id,
                ]);

                // limit caps count.
                expect((await s.canonical.list({ limit: 1 })).length).toBe(1);
            });

            it('exists reflects any version; get/getVersion return null (not throw) when absent', async () => {
                expect(await s.canonical.exists('nope')).toBe(false);
                expect(await s.canonical.get('nope')).toBeNull();
                expect(await s.canonical.getVersion('nope', 1)).toBeNull();
                expect(await s.canonical.listVersions('nope')).toEqual([]);

                const e = await s.canonical.create({ kind: 'finding', name: 'X', attributes: {} });
                expect(await s.canonical.exists(e.id)).toBe(true);
            });

            it('importSnapshot is idempotent on an identical re-import', async () => {
                const snapshot: Entity = {
                    id: 'fixed-entity',
                    kind: 'finding',
                    name: 'Snapshot',
                    attributes: { k: 'v' },
                    version: 1,
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                    owner: 'canonical',
                };
                const first = await s.canonical.importSnapshot(snapshot);
                expect(first.id).toBe('fixed-entity');
                expect(first.version).toBe(1);
                // Re-import identical → returns existing, no duplicate version.
                const again = await s.canonical.importSnapshot(snapshot);
                expect(again.id).toBe('fixed-entity');
                expect((await s.canonical.listVersions('fixed-entity')).length).toBe(1);
            });

            it('importSnapshot throws ImportConflictError on same (id,version) with different content', async () => {
                const base: Entity = {
                    id: 'conflict-entity',
                    kind: 'finding',
                    name: 'First',
                    attributes: {},
                    version: 1,
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                    owner: 'canonical',
                };
                await s.canonical.importSnapshot(base);
                const tampered: Entity = { ...base, name: 'Altered' };
                await expect(s.canonical.importSnapshot(tampered)).rejects.toBeInstanceOf(
                    ImportConflictError,
                );
            });

            it('importSnapshot rebuilds multi-version history (distinct versions of one id)', async () => {
                const mk = (version: number, name: string): Entity => ({
                    id: 'multi',
                    kind: 'finding',
                    name,
                    attributes: {},
                    version,
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                    owner: 'canonical',
                });
                await s.canonical.importSnapshot(mk(2, 'v2'));
                await s.canonical.importSnapshot(mk(1, 'v1'));
                const versions = await s.canonical.listVersions('multi');
                // Stored ascending regardless of import order.
                expect(versions.map((e) => e.version)).toEqual([1, 2]);
                // get → highest version.
                expect((await s.canonical.get('multi'))?.version).toBe(2);
            });
        });

        // ════════════════════════════ ARTIFACT ═════════════════════════════
        describe('artifact', () => {
            const ingest = (filename: string, body: string, mimeType = 'text/plain') =>
                s.artifact.ingest({ filename, content: Buffer.from(body), mimeType });

            it('ingest stamps fields + content-addresses; getContent round-trips bytes', async () => {
                const content = Buffer.from('hello world');
                const a = await s.artifact.ingest({
                    filename: 'doc.txt',
                    content,
                    mimeType: 'text/plain',
                });
                expect(a.id).toBeTruthy();
                expect(a.owner).toBe('artifact');
                expect(a.version).toBe(1);
                expect(a.sizeBytes).toBe(content.length);
                // contentHash is sha256 of the bytes (content addressing).
                expect(a.contentHash).toBe(createHash('sha256').update(content).digest('hex'));
                expect(typeof a.ingestedAt).toBe('string');

                const round = await s.artifact.getContent(a.id);
                expect(round).not.toBeNull();
                expect(Buffer.compare(round as Buffer, content)).toBe(0);

                // Metadata fetch (no content).
                const meta = await s.artifact.get(a.id);
                expect(meta).toEqual(a);
            });

            it('get / getContent return null for an unknown id; exists is false', async () => {
                expect(await s.artifact.get('nope')).toBeNull();
                expect(await s.artifact.getContent('nope')).toBeNull();
                expect(await s.artifact.exists('nope')).toBe(false);
            });

            it('getContent throws ContentReadIntegrityError after the stored bytes are corrupted', async () => {
                const a = await ingest('corruptme.txt', 'authentic bytes');
                // Corrupt the stored content WITHOUT touching the recorded
                // contentHash — gate-2 read-integrity must fire on both backends.
                s.corruptArtifactContent(a.contentHash, Buffer.from('TAMPERED payload bytes'));
                await expect(s.artifact.getContent(a.id)).rejects.toBeInstanceOf(
                    ContentReadIntegrityError,
                );
            });

            it('versions(filename) returns all versions ascending by version', async () => {
                const v1 = await ingest('report.md', 'rev 1');
                const v2 = await ingest('report.md', 'rev 2');
                const v3 = await ingest('report.md', 'rev 3');
                expect(v1.version).toBe(1);
                expect(v2.version).toBe(2);
                expect(v3.version).toBe(3);
                const vs = await s.artifact.versions('report.md');
                expect(vs.map((a) => a.version)).toEqual([1, 2, 3]);
                expect(await s.artifact.versions('never-ingested')).toEqual([]);
            });

            it('list applies mimeType / filenameContains / limit filters', async () => {
                await ingest('a.txt', 'one', 'text/plain');
                await ingest('b.md', 'two', 'text/markdown');
                await ingest('cat.txt', 'three', 'text/plain');

                const txt = await s.artifact.list({ mimeType: 'text/plain' });
                expect(txt.map((a) => a.filename).sort()).toEqual(['a.txt', 'cat.txt']);

                const containsA = await s.artifact.list({ filenameContains: 'a' });
                // 'a.txt' and 'cat.txt' both contain 'a'.
                expect(containsA.map((a) => a.filename).sort()).toEqual(['a.txt', 'cat.txt']);

                expect((await s.artifact.list({ limit: 1 })).length).toBe(1);
            });

            it('importSnapshot is idempotent + throws InvalidContentHashError on a shape-invalid hash', async () => {
                const content = Buffer.from('imported artifact bytes');
                const contentHash = createHash('sha256').update(content).digest('hex');
                const meta: Artifact = {
                    id: 'fixed-artifact',
                    filename: 'imp.bin',
                    contentHash,
                    mimeType: 'application/octet-stream',
                    sizeBytes: content.length,
                    version: 1,
                    storagePath: 'whatever-rewritten-on-import',
                    ingestedAt: '2026-01-01T00:00:00.000Z',
                    owner: 'artifact',
                };
                const imported = await s.artifact.importSnapshot(meta, content);
                expect(imported.id).toBe('fixed-artifact');
                // Idempotent on identical re-import (storagePath excluded from the
                // compare on both adapters).
                const again = await s.artifact.importSnapshot(meta, content);
                expect(again.id).toBe('fixed-artifact');

                // Shape-invalid contentHash → InvalidContentHashError (path-traversal
                // defence), validated BEFORE the blob store is touched.
                const badHashMeta: Artifact = {
                    ...meta,
                    id: 'bad-hash-artifact',
                    contentHash: '../../escape',
                };
                await expect(
                    s.artifact.importSnapshot(badHashMeta, content),
                ).rejects.toBeInstanceOf(InvalidContentHashError);
            });

            it('importSnapshot throws ImportConflictError on same id with different metadata', async () => {
                const content = Buffer.from('conflict artifact');
                const contentHash = createHash('sha256').update(content).digest('hex');
                const meta: Artifact = {
                    id: 'conflict-artifact',
                    filename: 'c.bin',
                    contentHash,
                    mimeType: 'application/octet-stream',
                    sizeBytes: content.length,
                    version: 1,
                    storagePath: 's',
                    ingestedAt: '2026-01-01T00:00:00.000Z',
                    owner: 'artifact',
                };
                await s.artifact.importSnapshot(meta, content);
                // Same id, different filename (a non-excluded field) → conflict.
                const tampered: Artifact = { ...meta, filename: 'different.bin' };
                await expect(s.artifact.importSnapshot(tampered, content)).rejects.toBeInstanceOf(
                    ImportConflictError,
                );
            });
        });

        // ═════════════════════════════ INDEX ═══════════════════════════════
        describe('index', () => {
            it('index → search candidate by text and by metadata-JSON substring', async () => {
                const rec = await s.index.index({
                    sourceId: 'src-1',
                    sourceStore: 'canonical',
                    text: 'The quick brown fox',
                    metadata: { kind: 'concept' },
                });
                expect(rec.id).toBeTruthy();
                expect(rec.owner).toBe('index');
                expect(typeof rec.indexedAt).toBe('string');

                // Case-insensitive substring on text.
                expect((await s.index.search({ text: 'BROWN' })).map((h) => h.id)).toEqual([rec.id]);
                // Substring also matches against JSON.stringify(metadata).
                expect((await s.index.search({ text: 'concept' })).map((h) => h.id)).toEqual([rec.id]);
                // No match → empty array, never null.
                expect(await s.index.search({ text: 'zebra' })).toEqual([]);
            });

            it('search returns candidates in INSERTION order (NO ranking)', async () => {
                // Three records all matching the same token, where a naive
                // term-frequency ranker would reorder by relevance: r2 mentions
                // the token THREE times, r0 once. Insertion order must win.
                const r0 = await s.index.index({
                    sourceId: 's0',
                    sourceStore: 'canonical',
                    text: 'token here',
                    metadata: {},
                });
                const r1 = await s.index.index({
                    sourceId: 's1',
                    sourceStore: 'canonical',
                    text: 'nothing relevant but token',
                    metadata: {},
                });
                const r2 = await s.index.index({
                    sourceId: 's2',
                    sourceStore: 'canonical',
                    text: 'token token token saturated',
                    metadata: {},
                });
                const hits = await s.index.search({ text: 'token' });
                // A ranker would put r2 first; insertion order keeps r0,r1,r2.
                expect(hits.map((h) => h.id)).toEqual([r0.id, r1.id, r2.id]);
            });

            it('search offset/limit compose over the post-filter candidate set', async () => {
                const ids: string[] = [];
                for (let i = 0; i < 6; i++) {
                    const r = await s.index.index({
                        sourceId: `s${i}`,
                        sourceStore: 'canonical',
                        text: `row ${i}`,
                        metadata: {},
                    });
                    ids.push(r.id);
                }
                expect((await s.index.search({ text: 'row', offset: 2, limit: 2 })).map((h) => h.id)).toEqual(
                    [ids[2], ids[3]],
                );
                // offset only.
                expect((await s.index.search({ text: 'row', offset: 4 })).map((h) => h.id)).toEqual([
                    ids[4],
                    ids[5],
                ]);
                // negative/zero offset ≡ no skip (existence-probe parity).
                expect(
                    (await s.index.search({ text: 'row', offset: -3, limit: 1 })).map((h) => h.id),
                ).toEqual([ids[0]]);
            });

            it('search sourceStore prefilter + metadata shallow-equal', async () => {
                const canon = await s.index.index({
                    sourceId: 'c',
                    sourceStore: 'canonical',
                    text: 'shared',
                    metadata: { team: 'red', tier: 1 },
                });
                await s.index.index({
                    sourceId: 'a',
                    sourceStore: 'artifact',
                    text: 'shared',
                    metadata: { team: 'red', tier: 1 },
                });
                // sourceStore narrows to canonical only.
                expect(
                    (await s.index.search({ text: 'shared', sourceStore: 'canonical' })).map((r) => r.id),
                ).toEqual([canon.id]);
                // metadata shallow-equal per key; all keys must match.
                const reds = await s.index.search({ metadata: { team: 'red' } });
                expect(reds.map((r) => r.sourceId).sort()).toEqual(['a', 'c']);
                expect(await s.index.search({ metadata: { team: 'red', tier: 2 } })).toEqual([]);
            });

            it('embedding round-trips (present → array; absent → key omitted, never null)', async () => {
                const withEmb = await s.index.index({
                    sourceId: 'e1',
                    sourceStore: 'canonical',
                    text: 'has embedding',
                    metadata: {},
                    embedding: [0.1, 0.2, 0.3],
                });
                const noEmb = await s.index.index({
                    sourceId: 'e2',
                    sourceStore: 'canonical',
                    text: 'no embedding',
                    metadata: {},
                });
                expect((await s.index.get(withEmb.id))?.embedding).toEqual([0.1, 0.2, 0.3]);
                const gotNo = await s.index.get(noEmb.id);
                expect(gotNo).not.toBeNull();
                expect('embedding' in (gotNo as object)).toBe(false);
                expect(gotNo?.embedding).toBeUndefined();
            });

            it('get returns null when absent; remove / clear delete; count tracks size', async () => {
                expect(await s.index.get('nope')).toBeNull();
                const a = await s.index.index({ sourceId: 'a', sourceStore: 'canonical', text: 'a', metadata: {} });
                await s.index.index({ sourceId: 'b', sourceStore: 'canonical', text: 'b', metadata: {} });
                expect(await s.index.count()).toBe(2);
                await s.index.remove(a.id);
                expect(await s.index.count()).toBe(1);
                expect(await s.index.get(a.id)).toBeNull();
                await s.index.clear();
                expect(await s.index.count()).toBe(0);
            });

            it('replaceAll atomically swaps the set, re-stamps ids, preserves insertion order', async () => {
                const old = await s.index.index({ sourceId: 'old', sourceStore: 'canonical', text: 'old', metadata: {} });
                await s.index.replaceAll([
                    { sourceId: 'n1', sourceStore: 'canonical', text: 'new one', metadata: { k: 1 } },
                    { sourceId: 'n2', sourceStore: 'artifact', text: 'new two', metadata: { k: 2 } },
                ]);
                expect(await s.index.count()).toBe(2);
                expect(await s.index.get(old.id)).toBeNull(); // replaced, not merged
                const all = await s.index.search({});
                expect(all.map((r) => r.sourceId)).toEqual(['n1', 'n2']);
                expect(all.every((r) => r.owner === 'index')).toBe(true);
                // replaceAll([]) empties.
                await s.index.replaceAll([]);
                expect(await s.index.count()).toBe(0);
            });
        });

        // ═════════════════════════════ LEDGER ══════════════════════════════
        describe('ledger', () => {
            const baseEvent = {
                action: 'entity_created',
                actorId: 'actor-1',
                subjectId: 'subj-1',
                subjectStore: 'canonical' as const,
                detail: { note: 'first' },
            };

            it('append → getEvent round-trips with verify-on-read; getEvent null when absent', async () => {
                const ev = await s.ledger.append(baseEvent);
                expect(ev.id).toBeTruthy();
                expect(ev.owner).toBe('ledger');
                expect(typeof ev.timestamp).toBe('string');
                expect(ev.integrityHash).toMatch(/^[a-f0-9]{64}$/);

                const got = await s.ledger.getEvent(ev.id);
                expect(got).toEqual(ev);
                expect(got?.detail).toEqual({ note: 'first' });
                expect(await s.ledger.getEvent('missing')).toBeNull();
            });

            it('genesis event has no prevHash; second event prevHash === first integrityHash', async () => {
                const first = await s.ledger.append(baseEvent);
                const second = await s.ledger.append({ ...baseEvent, action: 'entity_updated' });
                // CONTRACT-RELEVANT fact: the genesis event has no prior-hash —
                // `prevHash` is undefined. We assert the VALUE, not key presence:
                // local stamps `prevHash: undefined` (key present, value undefined)
                // while sqlite OMITS the key. Both serialize and hash IDENTICALLY
                // (JSON.stringify + computeIntegrityHash both drop undefined-valued
                // keys), so this representation difference is invisible at the
                // contract boundary — `'prevHash' in record` would over-specify it.
                expect(first.prevHash).toBeUndefined();
                expect(second.prevHash).toBe(first.integrityHash);
                // Both verify on read.
                expect(await s.ledger.getEvent(first.id)).toEqual(first);
                expect(await s.ledger.getEvent(second.id)).toEqual(second);
            });

            it('listEvents append order + subjectId/action/since/limit(last-N) filters; countEvents has no limit', async () => {
                const e1 = await s.ledger.append({ ...baseEvent, action: 'a', subjectId: 'X' });
                const e2 = await s.ledger.append({ ...baseEvent, action: 'b', subjectId: 'X' });
                const e3 = await s.ledger.append({ ...baseEvent, action: 'a', subjectId: 'Y' });

                // Full list in append order.
                expect((await s.ledger.listEvents()).map((e) => e.id)).toEqual([e1.id, e2.id, e3.id]);
                // subjectId filter.
                expect((await s.ledger.listEvents({ subjectId: 'X' })).map((e) => e.id)).toEqual([
                    e1.id,
                    e2.id,
                ]);
                // action filter.
                expect((await s.ledger.listEvents({ action: 'a' })).map((e) => e.id)).toEqual([
                    e1.id,
                    e3.id,
                ]);
                // since filter: e1's own timestamp keeps e1 (>=) and everything after.
                expect((await s.ledger.listEvents({ since: e1.timestamp })).map((e) => e.id)).toEqual([
                    e1.id,
                    e2.id,
                    e3.id,
                ]);
                expect(await s.ledger.listEvents({ since: '2999-01-01T00:00:00.000Z' })).toEqual([]);
                // limit = LAST N, still ascending.
                expect((await s.ledger.listEvents({ limit: 2 })).map((e) => e.id)).toEqual([e2.id, e3.id]);
                // countEvents ignores any sampling limit.
                expect(await s.ledger.countEvents()).toBe(3);
                expect(await s.ledger.countEvents({ action: 'a' })).toBe(2);
                expect(await s.ledger.countEvents({ subjectId: 'X' })).toBe(2);
            });

            it('trace walks the parent chain toward root', async () => {
                const root = await s.ledger.append(baseEvent);
                const mid = await s.ledger.append({ ...baseEvent, parentEventId: root.id });
                const leaf = await s.ledger.append({ ...baseEvent, parentEventId: mid.id });
                const chain = await s.ledger.trace(leaf.id);
                expect(chain.map((e) => e.id)).toEqual([leaf.id, mid.id, root.id]);
                // trace of an unknown leaf → empty.
                expect(await s.ledger.trace('unknown')).toEqual([]);
            });

            it('trace throws LedgerCycleDetectedError on a planted parent cycle', async () => {
                const a = await s.ledger.append({ ...baseEvent, action: 'A' });
                const b = await s.ledger.append({ ...baseEvent, action: 'B', parentEventId: a.id });
                // Plant A -> B -> A through the backend's raw storage; get a store
                // that observes the cycle. trace does NOT verify-on-read, so the
                // visited-set guard is what fires.
                const tampered = s.plantTraceCycleAndReopen(a.id, b.id);
                await expect(tampered.trace(b.id)).rejects.toBeInstanceOf(LedgerCycleDetectedError);
            });

            it('appendReceipt chains separately; getReceipt verify-on-read; filters', async () => {
                const r1 = await s.ledger.appendReceipt({
                    commandId: 'cmd-1',
                    resultSummary: 'ok',
                    affectedIds: ['x', 'y'],
                    provenanceEventId: 'ev-1',
                });
                const r2 = await s.ledger.appendReceipt({
                    commandId: 'cmd-2',
                    resultSummary: 'ok2',
                    affectedIds: [],
                    provenanceEventId: 'ev-2',
                });
                // Receipts have NO owner field on EITHER adapter (the Receipt
                // type has none — both omit it). This is a true contract fact, so
                // the key-presence probe is correct here.
                expect('owner' in r1).toBe(false);
                // Genesis receipt has no prior-hash — assert the VALUE (undefined),
                // not key presence, for the same representation-difference reason
                // as the genesis event above (local explicit-undefined vs sqlite
                // omitted; identical under serialization + hashing).
                expect(r1.prevHash).toBeUndefined(); // genesis
                expect(r2.prevHash).toBe(r1.integrityHash); // chained
                expect(r1.integrityHash).toMatch(/^[a-f0-9]{64}$/);

                const got = await s.ledger.getReceipt(r1.id);
                expect(got).toEqual(r1);
                expect(got?.affectedIds).toEqual(['x', 'y']);
                expect(await s.ledger.getReceipt('missing')).toBeNull();

                // listReceipts append order, commandId filter, last-N limit.
                expect((await s.ledger.listReceipts()).map((r) => r.id)).toEqual([r1.id, r2.id]);
                expect((await s.ledger.listReceipts({ commandId: 'cmd-1' })).map((r) => r.id)).toEqual([
                    r1.id,
                ]);
                expect((await s.ledger.listReceipts({ limit: 1 })).map((r) => r.id)).toEqual([r2.id]);
            });

            it('getEvent throws LedgerIntegrityError after a stored row/line is hand-edited', async () => {
                const ev = await s.ledger.append(baseEvent);
                // Hand-edit a hashed field WITHOUT recomputing the hash, then read
                // via a store that observes the edit.
                const tampered = s.tamperEventActionAndReopen(ev.id);
                await expect(tampered.getEvent(ev.id)).rejects.toBeInstanceOf(LedgerIntegrityError);
            });

            it('importEvent/importReceipt preserve integrityHash+prevHash verbatim, idempotent, conflict loudly', async () => {
                // Build a genuine chained pair (self-consistent hashes) to import.
                const g = makeChainedEvent({
                    id: 'imp-g',
                    timestamp: '2026-01-01T00:00:00.000Z',
                    action: 'create',
                });
                const h = makeChainedEvent({
                    id: 'imp-h',
                    timestamp: '2026-01-02T00:00:00.000Z',
                    action: 'update',
                    parentEventId: 'imp-g',
                    prev: g.integrityHash,
                });
                const importedG = await s.ledger.importEvent(g);
                const importedH = await s.ledger.importEvent(h);
                // Verbatim preservation.
                expect(importedG.id).toBe('imp-g');
                expect(importedG.timestamp).toBe(g.timestamp);
                expect(importedG.integrityHash).toBe(g.integrityHash);
                expect(importedH.prevHash).toBe(g.integrityHash);
                // Survive verify-on-read in the destination store.
                expect(await s.ledger.getEvent('imp-g')).toEqual(g);
                expect(await s.ledger.getEvent('imp-h')).toEqual(h);

                // Idempotent: byte-identical re-import returns existing, no dup.
                const again = await s.ledger.importEvent(g);
                expect(again.id).toBe('imp-g');
                expect(await s.ledger.countEvents()).toBe(2);

                // Conflict: same id, DIFFERENT content but a SELF-CONSISTENT hash
                // over that content (so integrity reconciliation passes and the
                // content-diff check is what fires).
                const conflicting = makeChainedEvent({
                    id: 'imp-g',
                    timestamp: g.timestamp,
                    action: 'mutated-content',
                });
                await expect(s.ledger.importEvent(conflicting)).rejects.toBeInstanceOf(
                    ImportConflictError,
                );

                // Receipts: same discipline.
                const receipt = (() => {
                    const rec = {
                        id: 'imp-r',
                        commandId: 'c',
                        committedAt: '2026-01-03T00:00:00.000Z',
                        resultSummary: 's',
                        affectedIds: ['a'],
                        provenanceEventId: 'p',
                        integrityHash: '',
                    };
                    rec.integrityHash = computeIntegrityHash(rec as unknown as Record<string, unknown>);
                    return rec;
                })();
                const importedR = await s.ledger.importReceipt(receipt);
                expect(importedR.id).toBe('imp-r');
                expect(importedR.integrityHash).toBe(receipt.integrityHash);
                expect(await s.ledger.getReceipt('imp-r')).toEqual(receipt);
                await s.ledger.importReceipt(receipt); // idempotent
                expect((await s.ledger.listReceipts()).length).toBe(1);
            });

            it('importEvent verifies a present-but-wrong hash (tampered backup) loudly', async () => {
                const bad: ProvenanceEvent = {
                    id: 'bak-1',
                    timestamp: '2026-01-01T00:00:00.000Z',
                    action: 'create',
                    actorId: 'a',
                    subjectId: 's',
                    subjectStore: 'canonical',
                    detail: {},
                    owner: 'ledger',
                    integrityHash: 'f'.repeat(64), // wrong on purpose
                };
                await expect(s.ledger.importEvent(bad)).rejects.toBeInstanceOf(LedgerIntegrityError);
            });

            it('rotate archives old + retains recent + trace truncates at the boundary + returns the right counts', async () => {
                // Import controlled-timestamp events so we know which side of the
                // boundary each lands on. Genuine chain so verify passes.
                const oldRoot = makeChainedEvent({
                    id: 'old-root',
                    timestamp: '2026-01-01T00:00:00.000Z',
                    action: 'create',
                });
                await s.ledger.importEvent(oldRoot);
                const oldChild = makeChainedEvent({
                    id: 'old-child',
                    timestamp: '2026-01-02T00:00:00.000Z',
                    action: 'update',
                    parentEventId: 'old-root',
                    prev: oldRoot.integrityHash,
                });
                await s.ledger.importEvent(oldChild);
                const recent = makeChainedEvent({
                    id: 'recent',
                    timestamp: '2026-03-01T00:00:00.000Z',
                    action: 'update',
                    parentEventId: 'old-child',
                    prev: oldChild.integrityHash,
                });
                await s.ledger.importEvent(recent);

                const result = await s.ledger.rotate('2026-02-01T00:00:00.000Z');
                expect(result.archived).toBe(2); // old-root + old-child
                expect(result.retained).toBe(1); // recent
                expect(result.archiveFile).toBeTruthy();

                // Archived events no longer in the active store.
                expect(await s.ledger.getEvent('old-root')).toBeNull();
                expect(await s.ledger.getEvent('old-child')).toBeNull();
                expect(await s.ledger.getEvent('recent')).not.toBeNull();

                // trace from `recent` truncates: its parent (old-child) is archived.
                expect((await s.ledger.trace('recent')).map((e) => e.id)).toEqual(['recent']);
            });

            it('rotate is a no-op (archived=0) when nothing predates the boundary; retained=total', async () => {
                await s.ledger.append(baseEvent); // timestamp = now
                const result = await s.ledger.rotate('2000-01-01T00:00:00.000Z');
                expect(result.archived).toBe(0);
                expect(result.retained).toBe(1);
                expect(result.archiveFile).toBeUndefined();
            });

            it('rotate input validation: InvalidRotateTimestampError / RotateBoundaryInFutureError', async () => {
                await expect(s.ledger.rotate('not-a-date')).rejects.toBeInstanceOf(
                    InvalidRotateTimestampError,
                );
                await expect(s.ledger.rotate('')).rejects.toBeInstanceOf(InvalidRotateTimestampError);
                await expect(s.ledger.rotate('2999-12-31T23:59:59.000Z')).rejects.toBeInstanceOf(
                    RotateBoundaryInFutureError,
                );
            });
        });
    });
}

// A guard so the file is never silently a no-op if the matrix construction
// regresses: local must always be present.
describe('parity matrix sanity', () => {
    it('always includes the local backend; includes sqlite iff the driver resolves', () => {
        expect(BACKENDS.map(([n]) => n)).toContain('local');
        expect(BACKENDS.some(([n]) => n === 'sqlite')).toBe(hasSqlite);
        // Keep `existsSync` referenced — it documents the storage substrate the
        // local tamper helpers write to (the import is load-bearing for them).
        expect(typeof existsSync).toBe('function');
    });
});
