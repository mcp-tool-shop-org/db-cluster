/**
 * Wave V3 — SQLite index + ledger store tests (agent A2).
 *
 * These stores must be behaviourally IDENTICAL to the local adapters
 * (LocalIndexStore / LocalLedgerStore) — drop-in substitutable. The tests below
 * assert that parity directly, plus the integrity round-trip that makes the
 * SQLite ledger cross-adapter verifiable (a record this store writes hashes
 * identically to one the local store writes, because both route through the
 * single-source-of-truth computeIntegrityHash).
 *
 * Gating: needs the native better-sqlite3 driver. Skipped gracefully when
 * absent — same idiom as test/wave-v3-sqlite-foundation.test.ts (resolve the
 * optional module; do NOT fake the require).
 *
 * Per-test lifecycle: mkdtempSync temp dir → SqliteDb.open(dir/cluster.db) →
 * build store → finally { db.close() BEFORE rmSync (Windows file lock) }.
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteDb } from '../src/adapters/sqlite/sqlite-db.js';
import { SqliteIndexStore } from '../src/adapters/sqlite/sqlite-index-store.js';
import { SqliteLedgerStore } from '../src/adapters/sqlite/sqlite-ledger-store.js';
import { LEDGER_EVENTS_TABLE } from '../src/adapters/sqlite/schema.js';
import { computeIntegrityHash } from '../src/types/integrity.js';
import { LedgerIntegrityError } from '../src/adapters/local/errors.js';
import type { ProvenanceEvent } from '../src/types/provenance-event.js';

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

/** Open a fresh db in a fresh temp dir; returns the db + a cleanup fn. */
function freshDb(): { db: SqliteDb; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), 'wave-v3-il-'));
    const db = SqliteDb.open(join(dir, 'cluster.db'));
    return {
        db,
        cleanup: () => {
            // Close BEFORE rmSync — an open connection holds a Windows file lock.
            db.close();
            rmSync(dir, { recursive: true, force: true });
        },
    };
}

describeSqlite('Wave V3 — SqliteIndexStore (parity with LocalIndexStore)', () => {
    it('index(record) → search candidate by text', async () => {
        const { db, cleanup } = freshDb();
        try {
            const store = new SqliteIndexStore(db);
            const rec = await store.index({
                sourceId: 'src-1',
                sourceStore: 'canonical',
                text: 'The quick brown fox',
                metadata: { kind: 'concept' },
            });
            expect(rec.id).toBeTruthy();
            expect(rec.owner).toBe('index');
            expect(typeof rec.indexedAt).toBe('string');

            // Case-insensitive substring match against text.
            const hits = await store.search({ text: 'BROWN' });
            expect(hits.map((h) => h.id)).toEqual([rec.id]);
            // No match → empty array (never null).
            expect(await store.search({ text: 'zebra' })).toEqual([]);
        } finally {
            cleanup();
        }
    });

    it('search matches against JSON.stringify(metadata) like local', async () => {
        const { db, cleanup } = freshDb();
        try {
            const store = new SqliteIndexStore(db);
            const rec = await store.index({
                sourceId: 's',
                sourceStore: 'artifact',
                text: 'no keyword here',
                metadata: { tag: 'findme-via-metadata' },
            });
            // text query hits because metadata JSON contains the substring.
            const hits = await store.search({ text: 'findme-via-metadata' });
            expect(hits.map((h) => h.id)).toEqual([rec.id]);
        } finally {
            cleanup();
        }
    });

    it('search metadata filter is shallow-equal per key', async () => {
        const { db, cleanup } = freshDb();
        try {
            const store = new SqliteIndexStore(db);
            const a = await store.index({
                sourceId: 'a',
                sourceStore: 'canonical',
                text: 'alpha',
                metadata: { team: 'red', tier: 1 },
            });
            await store.index({
                sourceId: 'b',
                sourceStore: 'canonical',
                text: 'beta',
                metadata: { team: 'blue', tier: 1 },
            });
            const reds = await store.search({ metadata: { team: 'red' } });
            expect(reds.map((r) => r.id)).toEqual([a.id]);
            // Multiple keys all must match.
            expect(await store.search({ metadata: { team: 'red', tier: 2 } })).toEqual([]);
        } finally {
            cleanup();
        }
    });

    it('search returns candidates in INSERTION ORDER (no ranking)', async () => {
        const { db, cleanup } = freshDb();
        try {
            const store = new SqliteIndexStore(db);
            const ids: string[] = [];
            // Insert several rows that ALL match the same query. A ranking layer
            // would reorder by relevance; search() must return write order.
            for (let i = 0; i < 5; i++) {
                const r = await store.index({
                    sourceId: `s${i}`,
                    sourceStore: 'canonical',
                    text: `match token ${i}`,
                    metadata: { i },
                });
                ids.push(r.id);
            }
            const hits = await store.search({ text: 'match token' });
            expect(hits.map((h) => h.id)).toEqual(ids);
        } finally {
            cleanup();
        }
    });

    it('search offset/limit compose over the post-filter candidate set', async () => {
        const { db, cleanup } = freshDb();
        try {
            const store = new SqliteIndexStore(db);
            const ids: string[] = [];
            for (let i = 0; i < 6; i++) {
                const r = await store.index({
                    sourceId: `s${i}`,
                    sourceStore: 'canonical',
                    text: `row ${i}`,
                    metadata: {},
                });
                ids.push(r.id);
            }
            // offset 2, limit 2 → ids[2], ids[3].
            const page = await store.search({ text: 'row', offset: 2, limit: 2 });
            expect(page.map((h) => h.id)).toEqual([ids[2], ids[3]]);
            // offset only (no limit) → skip leading.
            const rest = await store.search({ text: 'row', offset: 4 });
            expect(rest.map((h) => h.id)).toEqual([ids[4], ids[5]]);
            // negative/zero offset ≡ no skip (existence-probe parity).
            expect((await store.search({ text: 'row', offset: -3, limit: 1 })).map((h) => h.id)).toEqual([
                ids[0],
            ]);
        } finally {
            cleanup();
        }
    });

    it('search sourceStore prefilter narrows candidates', async () => {
        const { db, cleanup } = freshDb();
        try {
            const store = new SqliteIndexStore(db);
            const canon = await store.index({
                sourceId: 'c',
                sourceStore: 'canonical',
                text: 'shared',
                metadata: {},
            });
            await store.index({
                sourceId: 'a',
                sourceStore: 'artifact',
                text: 'shared',
                metadata: {},
            });
            const onlyCanon = await store.search({ text: 'shared', sourceStore: 'canonical' });
            expect(onlyCanon.map((r) => r.id)).toEqual([canon.id]);
        } finally {
            cleanup();
        }
    });

    it('embedding round-trips (present → array; absent → undefined, never null)', async () => {
        const { db, cleanup } = freshDb();
        try {
            const store = new SqliteIndexStore(db);
            const withEmb = await store.index({
                sourceId: 'e1',
                sourceStore: 'canonical',
                text: 'has embedding',
                metadata: {},
                embedding: [0.1, 0.2, 0.3],
            });
            const noEmb = await store.index({
                sourceId: 'e2',
                sourceStore: 'canonical',
                text: 'no embedding',
                metadata: {},
            });
            const gotWith = await store.get(withEmb.id);
            const gotNo = await store.get(noEmb.id);
            expect(gotWith?.embedding).toEqual([0.1, 0.2, 0.3]);
            // Absent embedding: the KEY must be absent (undefined), not null.
            expect(gotNo).not.toBeNull();
            expect('embedding' in (gotNo as object)).toBe(false);
            expect(gotNo?.embedding).toBeUndefined();
        } finally {
            cleanup();
        }
    });

    it('get(id) returns null for a missing id', async () => {
        const { db, cleanup } = freshDb();
        try {
            const store = new SqliteIndexStore(db);
            expect(await store.get('nope')).toBeNull();
        } finally {
            cleanup();
        }
    });

    it('remove and clear delete rows; count tracks size', async () => {
        const { db, cleanup } = freshDb();
        try {
            const store = new SqliteIndexStore(db);
            const a = await store.index({ sourceId: 'a', sourceStore: 'canonical', text: 'a', metadata: {} });
            await store.index({ sourceId: 'b', sourceStore: 'canonical', text: 'b', metadata: {} });
            expect(await store.count()).toBe(2);
            await store.remove(a.id);
            expect(await store.count()).toBe(1);
            expect(await store.get(a.id)).toBeNull();
            await store.clear();
            expect(await store.count()).toBe(0);
        } finally {
            cleanup();
        }
    });

    it('replaceAll atomically swaps the record set and re-stamps ids', async () => {
        const { db, cleanup } = freshDb();
        try {
            const store = new SqliteIndexStore(db);
            const old = await store.index({ sourceId: 'old', sourceStore: 'canonical', text: 'old', metadata: {} });
            await store.replaceAll([
                { sourceId: 'n1', sourceStore: 'canonical', text: 'new one', metadata: { k: 1 } },
                { sourceId: 'n2', sourceStore: 'artifact', text: 'new two', metadata: { k: 2 } },
            ]);
            expect(await store.count()).toBe(2);
            // Old record is gone (replaced, not merged).
            expect(await store.get(old.id)).toBeNull();
            // New records are searchable in insertion order with fresh ids.
            const all = await store.search({});
            expect(all.map((r) => r.sourceId)).toEqual(['n1', 'n2']);
            expect(all.every((r) => r.owner === 'index')).toBe(true);
        } finally {
            cleanup();
        }
    });

    it('replaceAll([]) empties the store', async () => {
        const { db, cleanup } = freshDb();
        try {
            const store = new SqliteIndexStore(db);
            await store.index({ sourceId: 'x', sourceStore: 'canonical', text: 'x', metadata: {} });
            await store.replaceAll([]);
            expect(await store.count()).toBe(0);
        } finally {
            cleanup();
        }
    });
});

describeSqlite('Wave V3 — SqliteLedgerStore (parity + integrity round-trip)', () => {
    const baseEvent = {
        action: 'entity_created',
        actorId: 'actor-1',
        subjectId: 'subj-1',
        subjectStore: 'canonical' as const,
        detail: { note: 'first' },
    };

    it('append → getEvent round-trips with verify-on-read', async () => {
        const { db, cleanup } = freshDb();
        try {
            const store = new SqliteLedgerStore(db);
            const ev = await store.append(baseEvent);
            expect(ev.id).toBeTruthy();
            expect(ev.owner).toBe('ledger');
            expect(typeof ev.timestamp).toBe('string');
            expect(ev.integrityHash).toMatch(/^[a-f0-9]{64}$/);

            const got = await store.getEvent(ev.id);
            expect(got).not.toBeNull();
            expect(got).toEqual(ev);
            // detail round-trips via JSON.
            expect(got?.detail).toEqual({ note: 'first' });
            // getEvent for a missing id → null.
            expect(await store.getEvent('missing')).toBeNull();
        } finally {
            cleanup();
        }
    });

    it('CROSS-ADAPTER HASH EQUALITY: stored integrity_hash == computeIntegrityHash(domain record)', async () => {
        const { db, cleanup } = freshDb();
        try {
            const store = new SqliteLedgerStore(db);
            const ev = await store.append(baseEvent);

            // The stored column value, read raw via the connection.
            const row = db.connection
                .prepare(`SELECT integrity_hash, prev_hash FROM ${LEDGER_EVENTS_TABLE} WHERE id = ?`)
                .get(ev.id) as { integrity_hash: string; prev_hash: string | null };

            // Independently compute the canonical hash over the SAME domain
            // record the local store would build (genesis → no prevHash key).
            // computeIntegrityHash strips integrityHash before hashing, so pass
            // the full returned event. This is byte-for-byte what
            // LocalLedgerStore.stampEventIntegrity computes for the same logical
            // record — both call the identical single-source-of-truth helper.
            const expected = computeIntegrityHash(ev as unknown as Record<string, unknown>);
            expect(row.integrity_hash).toBe(expected);
            expect(ev.integrityHash).toBe(expected);

            // Genesis: prev_hash column is NULL and the returned record omits the key.
            expect(row.prev_hash).toBeNull();
            expect('prevHash' in ev).toBe(false);

            // Reconstruct the domain record by hand (no seq, no prevHash) and
            // confirm it hashes the same — proves `seq` is excluded and the
            // round-trip is faithful.
            const handBuilt: ProvenanceEvent = {
                id: ev.id,
                timestamp: ev.timestamp,
                action: baseEvent.action,
                actorId: baseEvent.actorId,
                subjectId: baseEvent.subjectId,
                subjectStore: baseEvent.subjectStore,
                detail: baseEvent.detail,
                owner: 'ledger',
                integrityHash: 'ignored-stripped-before-hash',
            };
            expect(computeIntegrityHash(handBuilt as unknown as Record<string, unknown>)).toBe(
                expected,
            );
        } finally {
            cleanup();
        }
    });

    it('genesis event has no prevHash; second event prevHash == first integrityHash', async () => {
        const { db, cleanup } = freshDb();
        try {
            const store = new SqliteLedgerStore(db);
            const first = await store.append(baseEvent);
            const second = await store.append({ ...baseEvent, action: 'entity_updated' });

            expect('prevHash' in first).toBe(false);
            expect(second.prevHash).toBe(first.integrityHash);

            // Both verify on read.
            expect(await store.getEvent(first.id)).toEqual(first);
            expect(await store.getEvent(second.id)).toEqual(second);
        } finally {
            cleanup();
        }
    });

    it('getEvent throws LedgerIntegrityError after a row is hand-edited', async () => {
        const { db, cleanup } = freshDb();
        try {
            const store = new SqliteLedgerStore(db);
            const ev = await store.append(baseEvent);
            // Tamper directly via the raw connection — change a hashed field
            // WITHOUT recomputing integrity_hash.
            db.connection
                .prepare(`UPDATE ${LEDGER_EVENTS_TABLE} SET action = 'tampered' WHERE id = ?`)
                .run(ev.id);
            await expect(store.getEvent(ev.id)).rejects.toBeInstanceOf(LedgerIntegrityError);
        } finally {
            cleanup();
        }
    });

    it('listEvents filters + limit=last-N, ascending; countEvents has no limit', async () => {
        const { db, cleanup } = freshDb();
        try {
            const store = new SqliteLedgerStore(db);
            const e1 = await store.append({ ...baseEvent, action: 'a', subjectId: 'X' });
            const e2 = await store.append({ ...baseEvent, action: 'b', subjectId: 'X' });
            const e3 = await store.append({ ...baseEvent, action: 'a', subjectId: 'Y' });

            // subjectId filter.
            const forX = await store.listEvents({ subjectId: 'X' });
            expect(forX.map((e) => e.id)).toEqual([e1.id, e2.id]);
            // action filter.
            const actionA = await store.listEvents({ action: 'a' });
            expect(actionA.map((e) => e.id)).toEqual([e1.id, e3.id]);
            // limit = last N, still ascending.
            const lastTwo = await store.listEvents({ limit: 2 });
            expect(lastTwo.map((e) => e.id)).toEqual([e2.id, e3.id]);
            // countEvents ignores any sampling limit.
            expect(await store.countEvents()).toBe(3);
            expect(await store.countEvents({ action: 'a' })).toBe(2);
        } finally {
            cleanup();
        }
    });

    it('listEvents since filters by timestamp >=', async () => {
        const { db, cleanup } = freshDb();
        try {
            const store = new SqliteLedgerStore(db);
            const e1 = await store.append(baseEvent);
            // Use the first event's own timestamp as the boundary: since == e1.ts
            // keeps e1 (>=) and everything after.
            const e2 = await store.append({ ...baseEvent, action: 'later' });
            const since = await store.listEvents({ since: e1.timestamp });
            expect(since.map((e) => e.id)).toEqual([e1.id, e2.id]);
            // A boundary strictly after both drops everything.
            const future = await store.listEvents({ since: '2999-01-01T00:00:00.000Z' });
            expect(future).toEqual([]);
        } finally {
            cleanup();
        }
    });

    it('appendReceipt chains separately and verifies on read', async () => {
        const { db, cleanup } = freshDb();
        try {
            const store = new SqliteLedgerStore(db);
            const r1 = await store.appendReceipt({
                commandId: 'cmd-1',
                resultSummary: 'ok',
                affectedIds: ['x', 'y'],
                provenanceEventId: 'ev-1',
            });
            const r2 = await store.appendReceipt({
                commandId: 'cmd-2',
                resultSummary: 'ok2',
                affectedIds: [],
                provenanceEventId: 'ev-2',
            });
            // Receipts have NO owner field.
            expect('owner' in r1).toBe(false);
            expect('prevHash' in r1).toBe(false); // genesis
            expect(r2.prevHash).toBe(r1.integrityHash); // chained
            // Verify-on-read + affectedIds JSON round-trip.
            const got = await store.getReceipt(r1.id);
            expect(got).toEqual(r1);
            expect(got?.affectedIds).toEqual(['x', 'y']);
            // listReceipts in append order, commandId filter, last-N limit.
            const forCmd1 = await store.listReceipts({ commandId: 'cmd-1' });
            expect(forCmd1.map((r) => r.id)).toEqual([r1.id]);
            const lastOne = await store.listReceipts({ limit: 1 });
            expect(lastOne.map((r) => r.id)).toEqual([r2.id]);
        } finally {
            cleanup();
        }
    });

    it('trace walks the parent chain toward root', async () => {
        const { db, cleanup } = freshDb();
        try {
            const store = new SqliteLedgerStore(db);
            const root = await store.append(baseEvent);
            const mid = await store.append({ ...baseEvent, parentEventId: root.id });
            const leaf = await store.append({ ...baseEvent, parentEventId: mid.id });
            const chain = await store.trace(leaf.id);
            expect(chain.map((e) => e.id)).toEqual([leaf.id, mid.id, root.id]);
        } finally {
            cleanup();
        }
    });

    it('importEvent preserves integrityHash + prevHash verbatim, is idempotent, conflicts loudly', async () => {
        const { db, cleanup } = freshDb();
        try {
            // Source store: produce a genuine chained pair to import.
            const srcSetup = freshDb();
            const srcStore = new SqliteLedgerStore(srcSetup.db);
            const g = await srcStore.append(baseEvent);
            const h = await srcStore.append({ ...baseEvent, action: 'second' });
            srcSetup.cleanup();

            const store = new SqliteLedgerStore(db);
            const importedG = await store.importEvent(g);
            const importedH = await store.importEvent(h);
            // Verbatim preservation of id/timestamp/integrityHash/prevHash.
            expect(importedG.id).toBe(g.id);
            expect(importedG.timestamp).toBe(g.timestamp);
            expect(importedG.integrityHash).toBe(g.integrityHash);
            expect(importedH.prevHash).toBe(h.prevHash);
            expect(importedH.prevHash).toBe(g.integrityHash);
            // Survives verify-on-read in the destination store.
            expect(await store.getEvent(g.id)).toEqual(g);
            expect(await store.getEvent(h.id)).toEqual(h);

            // Idempotent: byte-identical re-import returns existing, no duplicate.
            const again = await store.importEvent(g);
            expect(again.id).toBe(g.id);
            expect(await store.countEvents()).toBe(2);

            // Conflict: same id, DIFFERENT content, but a SELF-CONSISTENT hash
            // over that different content (so integrity reconciliation passes and
            // the content-diff check is what fires). A record whose hash did NOT
            // match its mutated content would instead trip verify-on-restore
            // (LedgerIntegrityError) — that ordering is asserted separately below.
            const conflicting: ProvenanceEvent = {
                ...g,
                action: 'mutated-content',
                integrityHash: '',
            };
            conflicting.integrityHash = computeIntegrityHash(
                conflicting as unknown as Record<string, unknown>,
            );
            await expect(store.importEvent(conflicting)).rejects.toMatchObject({
                code: 'IMPORT_CONFLICT',
            });
        } finally {
            cleanup();
        }
    });

    it('importEvent verifies a present-but-wrong hash (tampered backup) loudly', async () => {
        const { db, cleanup } = freshDb();
        try {
            const store = new SqliteLedgerStore(db);
            // A snapshot whose integrityHash does NOT match its content.
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
            await expect(store.importEvent(bad)).rejects.toBeInstanceOf(LedgerIntegrityError);
        } finally {
            cleanup();
        }
    });

    it('importEvent computes a hash for a legacy hash-less backup', async () => {
        const { db, cleanup } = freshDb();
        try {
            const store = new SqliteLedgerStore(db);
            const legacy = {
                id: 'legacy-1',
                timestamp: '2026-01-02T00:00:00.000Z',
                action: 'create',
                actorId: 'a',
                subjectId: 's',
                subjectStore: 'canonical',
                detail: { v: 1 },
                owner: 'ledger',
                integrityHash: '', // absent/empty → compute on import
            } as ProvenanceEvent;
            const imported = await store.importEvent(legacy);
            expect(imported.integrityHash).toMatch(/^[a-f0-9]{64}$/);
            // And it now verifies on read.
            expect(await store.getEvent('legacy-1')).toEqual(imported);
        } finally {
            cleanup();
        }
    });

    it('importReceipt preserves verbatim + idempotent', async () => {
        const { db, cleanup } = freshDb();
        try {
            const srcSetup = freshDb();
            const srcStore = new SqliteLedgerStore(srcSetup.db);
            const r = await srcStore.appendReceipt({
                commandId: 'c',
                resultSummary: 's',
                affectedIds: ['a'],
                provenanceEventId: 'p',
            });
            srcSetup.cleanup();

            const store = new SqliteLedgerStore(db);
            const imported = await store.importReceipt(r);
            expect(imported.id).toBe(r.id);
            expect(imported.committedAt).toBe(r.committedAt);
            expect(imported.integrityHash).toBe(r.integrityHash);
            expect(await store.getReceipt(r.id)).toEqual(r);
            // Idempotent.
            await store.importReceipt(r);
            expect((await store.listReceipts()).length).toBe(1);
        } finally {
            cleanup();
        }
    });

    it('rotate archives old events, retains recent, and trace truncates at the boundary', async () => {
        const { db, cleanup } = freshDb();
        try {
            const store = new SqliteLedgerStore(db);
            // Import events with controlled timestamps so we know which side of
            // the boundary each lands on. Build a genuine chain so verify passes.
            const oldRoot = makeChainedEvent({
                id: 'old-root',
                timestamp: '2026-01-01T00:00:00.000Z',
                action: 'create',
                prev: undefined,
            });
            await store.importEvent(oldRoot);
            const oldChild = makeChainedEvent({
                id: 'old-child',
                timestamp: '2026-01-02T00:00:00.000Z',
                action: 'update',
                parentEventId: 'old-root',
                prev: oldRoot.integrityHash,
            });
            await store.importEvent(oldChild);
            const recent = makeChainedEvent({
                id: 'recent',
                timestamp: '2026-03-01T00:00:00.000Z',
                action: 'update',
                parentEventId: 'old-child',
                prev: oldChild.integrityHash,
            });
            await store.importEvent(recent);

            // Rotate at a boundary between old-child and recent.
            const result = await store.rotate('2026-02-01T00:00:00.000Z');
            expect(result.archived).toBe(2); // old-root + old-child
            expect(result.retained).toBe(1); // recent
            expect(result.archiveFile).toContain('sqlite:');
            expect(result.archiveFile).toContain('ledger_events_archive');

            // Archived events are no longer in the active store.
            expect(await store.getEvent('old-root')).toBeNull();
            expect(await store.getEvent('old-child')).toBeNull();
            expect(await store.getEvent('recent')).not.toBeNull();

            // trace from `recent` truncates at the youngest unarchived event —
            // its parent (old-child) is archived, so the chain is just [recent].
            const chain = await store.trace('recent');
            expect(chain.map((e) => e.id)).toEqual(['recent']);
        } finally {
            cleanup();
        }
    });

    it('rotate is a no-op (archived=0) when nothing predates the boundary', async () => {
        const { db, cleanup } = freshDb();
        try {
            const store = new SqliteLedgerStore(db);
            await store.append(baseEvent); // timestamp = now
            // Boundary far in the past → nothing to archive; retained = total.
            const result = await store.rotate('2000-01-01T00:00:00.000Z');
            expect(result.archived).toBe(0);
            expect(result.retained).toBe(1);
            expect(result.archiveFile).toBeUndefined();
        } finally {
            cleanup();
        }
    });

    it('rotate validates input: InvalidRotateTimestampError / RotateBoundaryInFutureError', async () => {
        const { db, cleanup } = freshDb();
        try {
            const store = new SqliteLedgerStore(db);
            await expect(store.rotate('not-a-date')).rejects.toMatchObject({
                code: 'INVALID_ROTATE_TIMESTAMP',
            });
            await expect(store.rotate('')).rejects.toMatchObject({
                code: 'INVALID_ROTATE_TIMESTAMP',
            });
            await expect(store.rotate('2999-12-31T23:59:59.000Z')).rejects.toMatchObject({
                code: 'ROTATE_BOUNDARY_IN_FUTURE',
            });
        } finally {
            cleanup();
        }
    });
});

/**
 * Build a genuine (self-consistent) ProvenanceEvent for import — the
 * integrityHash is computed over the same domain record the store would build,
 * so importEvent's verify-on-restore passes and the imported record survives
 * verify-on-read. `prev` is the predecessor's integrityHash (undefined for a
 * genesis event); it is INCLUDED in the hash exactly like a live append.
 */
function makeChainedEvent(args: {
    id: string;
    timestamp: string;
    action: string;
    parentEventId?: string;
    prev?: string;
}): ProvenanceEvent {
    const record: ProvenanceEvent = {
        id: args.id,
        timestamp: args.timestamp,
        action: args.action,
        actorId: 'actor',
        subjectId: 'subj',
        subjectStore: 'canonical',
        detail: {},
        owner: 'ledger',
        integrityHash: '',
        ...(args.parentEventId !== undefined ? { parentEventId: args.parentEventId } : {}),
        ...(args.prev !== undefined ? { prevHash: args.prev } : {}),
    };
    record.integrityHash = computeIntegrityHash(record as unknown as Record<string, unknown>);
    return record;
}
