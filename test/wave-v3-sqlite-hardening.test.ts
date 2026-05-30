/**
 * Wave V3 — SQLite adapter hardening tests (verifier-pass follow-ups).
 *
 * Two coordinator-added suites responding to the Wave V3 read-only verifier pass:
 *
 *  1. Canonical `list()` INSERTION-ORDER parity (finding F1). The verifier found
 *     that the SQLite canonical store ordered `list()` by `created_at` while the
 *     local store returns Map-insertion (creation) order — so under a tied
 *     `created_at` millisecond the two adapters returned a DIFFERENT ordering and,
 *     under `limit`, a DIFFERENT SUBSET. The fix orders by each id's first-version
 *     `rowid` (insertion order). This suite locks that in DETERMINISTICALLY by
 *     importing several entities that share one `created_at` but whose ids are NOT
 *     id-sorted in import order, then asserting the SQLite order equals the local
 *     order (and the limited subset matches) — which fails under the old
 *     created_at/id-ASC ordering and passes under insertion order.
 *
 *  2. Runtime SQL-injection safety. The repo's `test/sql-injection.test.ts` is
 *     Postgres-gated, so the SQLite adapter's injection safety had static coverage
 *     (the `sqlite-sql-safety.mjs` completeness scanner + the parity suite) but no
 *     EXECUTING test. This suite feeds injection payloads as DATA through every
 *     SQLite store's public methods and asserts they round-trip verbatim as
 *     literal values, no table is dropped/altered, and a tautology query does not
 *     leak rows — the dynamic confirmation that every query is parameterized.
 *
 * Gated on `better-sqlite3` being installed (skips cleanly otherwise, like the
 * Postgres-gated suites). Every SqliteDb is closed before `rmSync` (Windows holds
 * a file lock on an open connection).
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import type { Entity } from '../src/types/entity.js';
import { LocalCanonicalStore } from '../src/adapters/local/index.js';
import {
    SqliteDb,
    SqliteCanonicalStore,
    SqliteArtifactStore,
    SqliteIndexStore,
    SqliteLedgerStore,
} from '../src/adapters/sqlite/index.js';

let hasSqlite = false;
try {
    createRequire(import.meta.url).resolve('better-sqlite3');
    hasSqlite = true;
} catch {
    // better-sqlite3 not installed — skip the whole file, like the pg-gated suites.
}
const describeSqlite = hasSqlite ? describe : describe.skip;

describeSqlite('Wave V3 — canonical list() insertion-order parity (finding F1)', () => {
    it('SQLite list() matches local insertion order under a tied created_at (incl. the limited subset)', async () => {
        // All three share ONE created_at; import order (zzz, aaa, mmm) is
        // deliberately NOT id-sorted, so created_at-ASC + id-ASC ordering would
        // produce [aaa, mmm, zzz] (≠ import order) — the old, divergent behavior.
        const sameTs = '2026-05-29T12:00:00.000Z';
        const seed = (suffix: string, name: string): Entity => ({
            id: `e-${suffix}`,
            kind: 'k',
            name,
            attributes: {},
            version: 1,
            createdAt: sameTs,
            updatedAt: sameTs,
            owner: 'canonical',
        });
        const importOrder = [seed('zzz', 'Z'), seed('aaa', 'A'), seed('mmm', 'M')];
        const expectedIds = importOrder.map((e) => e.id); // ['e-zzz','e-aaa','e-mmm']

        const ldir = mkdtempSync(join(tmpdir(), 'v3-f1-local-'));
        const sdir = mkdtempSync(join(tmpdir(), 'v3-f1-sqlite-'));
        let db: SqliteDb | undefined;
        try {
            const local = new LocalCanonicalStore(join(ldir, 'canonical'));
            db = SqliteDb.open(join(sdir, 'cluster.db'));
            const sqlite = new SqliteCanonicalStore(db);

            for (const e of importOrder) {
                await local.importSnapshot(e);
                await sqlite.importSnapshot(e);
            }

            const localIds = (await local.list()).map((e) => e.id);
            const sqliteIds = (await sqlite.list()).map((e) => e.id);
            // Local returns creation/insertion order; SQLite must match it exactly.
            expect(localIds).toEqual(expectedIds);
            expect(sqliteIds).toEqual(localIds);

            // The sharpest F1 edge: the SUBSET under `limit` must also match
            // (created_at ordering would have returned [e-aaa, e-mmm] here).
            const localTop2 = (await local.list({ limit: 2 })).map((e) => e.id);
            const sqliteTop2 = (await sqlite.list({ limit: 2 })).map((e) => e.id);
            expect(sqliteTop2).toEqual(localTop2);
            expect(sqliteTop2).toEqual(['e-zzz', 'e-aaa']);
        } finally {
            db?.close();
            rmSync(ldir, { recursive: true, force: true });
            rmSync(sdir, { recursive: true, force: true });
        }
    });
});

describeSqlite('Wave V3 — SQLite adapter SQL-injection safety (runtime)', () => {
    const PAYLOADS = [
        `'; DROP TABLE canonical_entities;--`,
        `" OR "1"="1`,
        `'); DELETE FROM ledger_events;--`,
        `x'); DROP TABLE artifacts;--`,
        `%' OR '1'='1`,
    ];
    const EXPECTED_TABLES = [
        'canonical_entities',
        'artifacts',
        'artifact_content',
        'index_records',
        'ledger_events',
        'ledger_receipts',
        'ledger_events_archive',
        'ledger_receipts_archive',
    ];

    function tableNames(db: SqliteDb): Set<string> {
        const rows = db.connection
            .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
            .all() as { name: string }[];
        return new Set(rows.map((r) => r.name));
    }

    it('every store treats injection payloads as literal data; no table is dropped/altered', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'v3-inj-'));
        let db: SqliteDb | undefined;
        try {
            db = SqliteDb.open(join(dir, 'cluster.db'));
            const canonical = new SqliteCanonicalStore(db);
            const artifact = new SqliteArtifactStore(db);
            const index = new SqliteIndexStore(db);
            const ledger = new SqliteLedgerStore(db);

            for (const p of PAYLOADS) {
                // canonical — name / kind / attribute key+value carry the payload.
                const ent = await canonical.create({ kind: p, name: p, attributes: { [p]: p } });
                const gotEnt = await canonical.get(ent.id);
                expect(gotEnt?.name).toBe(p);
                expect(gotEnt?.kind).toBe(p);
                expect(gotEnt?.attributes[p]).toBe(p);

                // artifact — filename / mimeType carry the payload; content round-trips.
                const art = await artifact.ingest({
                    filename: p,
                    content: Buffer.from(p),
                    mimeType: `text/${p}`,
                });
                expect((await artifact.get(art.id))?.filename).toBe(p);
                expect((await artifact.getContent(art.id))?.toString()).toBe(p);

                // index — text / metadata / sourceId carry the payload; search is literal.
                const rec = await index.index({
                    sourceId: p,
                    sourceStore: 'canonical',
                    text: p,
                    metadata: { [p]: p },
                });
                expect((await index.get(rec.id))?.text).toBe(p);
                const hits = await index.search({ text: p });
                expect(hits.some((h) => h.id === rec.id)).toBe(true);

                // ledger — action / actorId / subjectId / detail carry the payload.
                const ev = await ledger.append({
                    action: p,
                    actorId: p,
                    subjectId: p,
                    subjectStore: 'canonical',
                    detail: { [p]: p },
                });
                const gotEv = await ledger.getEvent(ev.id);
                expect(gotEv?.action).toBe(p);
                expect(gotEv?.actorId).toBe(p);
                expect(gotEv?.detail[p]).toBe(p);
                const rc = await ledger.appendReceipt({
                    commandId: p,
                    resultSummary: p,
                    affectedIds: [p],
                    provenanceEventId: ev.id,
                });
                const gotRc = await ledger.getReceipt(rc.id);
                expect(gotRc?.commandId).toBe(p);
                expect(gotRc?.affectedIds).toEqual([p]);
            }

            // No table was dropped by any payload — all eight survive.
            const present = tableNames(db);
            for (const t of EXPECTED_TABLES) {
                expect(present.has(t)).toBe(true);
            }
            // No mass DELETE — exactly one row per payload landed in each store.
            expect(await canonical.list()).toHaveLength(PAYLOADS.length);
            expect(await ledger.listEvents()).toHaveLength(PAYLOADS.length);

            // A classic tautology string is treated as a literal substring, not SQL:
            // no record's text contains it, so it returns zero rows (not "all rows").
            const tautology = await index.search({ text: `nonexistent-zzz' OR '1'='1` });
            expect(tautology).toHaveLength(0);
        } finally {
            db?.close();
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
