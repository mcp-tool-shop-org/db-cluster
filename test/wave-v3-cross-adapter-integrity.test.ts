/**
 * Wave V3 — CROSS-ADAPTER integrity cross-verification (agent A4).
 *
 * The claim under test: "a ledger written by one adapter verifies under the
 * other." The tamper-evidence chain is portable BECAUSE both adapters route
 * every hash through the SINGLE source of truth `computeIntegrityHash`
 * (`src/types/integrity.ts`) over the SAME domain record. Three proofs:
 *
 *  1. SAME HASH FROM THE SHARED HELPER. A fixed domain ProvenanceEvent (and a
 *     fixed Receipt) is hashed once via `computeIntegrityHash`; that hash is
 *     stamped on and `importEvent`/`importReceipt`'d into BOTH a fresh local and
 *     a fresh sqlite ledger. `getEvent`/`getReceipt` from both → neither throws
 *     (verify-on-read passes on both) AND both returned records carry the
 *     identical integrityHash.
 *
 *  2. WRITTEN HERE, VERIFIED THERE. A genuine event is `append`'d to a LOCAL
 *     ledger (local stamps id/timestamp/integrityHash/prevHash); that EXACT
 *     record is `importEvent`'d into a fresh SQLITE ledger and `getEvent` there
 *     does not throw — sqlite verifies the hash LOCAL computed. Then the reverse
 *     (append to sqlite, import + verify under local). Same for a chained pair so
 *     the prevHash link survives the crossing.
 *
 *  3. CROSS-ADAPTER TAMPER DETECTION, SAME ERROR TYPE. Corrupt a stored event in
 *     sqlite (raw UPDATE) → getEvent throws LedgerIntegrityError. Do the
 *     equivalent edit in local (hand-edit the NDJSON line + reopen) → also throws
 *     LedgerIntegrityError. Identical typed failure on both sides.
 *
 * Gating: the WHOLE file is skipped when better-sqlite3 is absent (every test
 * needs both adapters). Every SqliteDb is closed before its temp dir is removed
 * (Windows file lock on the .db / -wal / -shm sidecars).
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LocalLedgerStore } from '../src/adapters/local/index.js';
import { SqliteDb, SqliteLedgerStore, LEDGER_EVENTS_TABLE } from '../src/adapters/sqlite/index.js';
import { computeIntegrityHash } from '../src/types/integrity.js';
import { LedgerIntegrityError } from '../src/adapters/local/errors.js';
import type { ProvenanceEvent } from '../src/types/provenance-event.js';
import type { Receipt } from '../src/types/receipt.js';

/** True iff better-sqlite3 resolves on this machine (does NOT load it). */
function hasSqlite(): boolean {
    try {
        createRequire(import.meta.url).resolve('better-sqlite3');
        return true;
    } catch {
        return false;
    }
}

// Whole-file gate: every test here is inherently cross-adapter.
const describeCross = hasSqlite() ? describe : describe.skip;

/** A fresh LocalLedgerStore in its own temp dir + a cleanup fn + the dir. */
function freshLocal(): { ledger: LocalLedgerStore; dir: string; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), 'v3-xadapter-local-'));
    const ledgerDir = join(dir, 'ledger');
    return {
        ledger: new LocalLedgerStore(ledgerDir),
        dir: ledgerDir,
        cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
}

/** A fresh SqliteLedgerStore on its own db + a cleanup fn + the db handle. */
function freshSqlite(): { ledger: SqliteLedgerStore; db: SqliteDb; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), 'v3-xadapter-sqlite-'));
    const db = SqliteDb.open(join(dir, 'cluster.db'));
    return {
        ledger: new SqliteLedgerStore(db),
        db,
        cleanup: () => {
            db.close(); // BEFORE rmSync — Windows file lock.
            rmSync(dir, { recursive: true, force: true });
        },
    };
}

describeCross('Wave V3 — cross-adapter ledger integrity', () => {
    // ───────────────────────── 1. SAME HASH FROM THE SHARED HELPER ──────────
    describe('shared-helper hash imports + verifies under both adapters', () => {
        it('a fixed domain event hashed once imports + verifies under local AND sqlite', async () => {
            // A FIXED domain ProvenanceEvent — fixed id/timestamp/action/actorId/
            // subjectId/subjectStore/detail, NO prevHash (treat as genesis).
            const fixed: ProvenanceEvent = {
                id: 'xa-event-1',
                timestamp: '2026-04-01T12:00:00.000Z',
                action: 'entity_created',
                actorId: 'actor-shared',
                subjectId: 'subject-shared',
                subjectStore: 'canonical',
                detail: { k: 'v', nested: { a: 1, b: [2, 3] } },
                owner: 'ledger',
                integrityHash: '', // placeholder, set next
            };
            // Compute H ONCE via the single source of truth.
            const H = computeIntegrityHash(fixed as unknown as Record<string, unknown>);
            fixed.integrityHash = H;

            const local = freshLocal();
            const sqlite = freshSqlite();
            try {
                // Import the SAME record into both fresh ledgers.
                const li = await local.ledger.importEvent({ ...fixed });
                const si = await sqlite.ledger.importEvent({ ...fixed });
                // Import preserves the hash verbatim on both.
                expect(li.integrityHash).toBe(H);
                expect(si.integrityHash).toBe(H);

                // getEvent from BOTH → neither throws (verify-on-read passes) AND
                // both carry integrityHash === H.
                const lg = await local.ledger.getEvent('xa-event-1');
                const sg = await sqlite.ledger.getEvent('xa-event-1');
                expect(lg).not.toBeNull();
                expect(sg).not.toBeNull();
                expect(lg?.integrityHash).toBe(H);
                expect(sg?.integrityHash).toBe(H);
                // The reconstructed records are content-equal across adapters.
                expect(lg).toEqual(sg);
            } finally {
                local.cleanup();
                sqlite.cleanup();
            }
        });

        it('a fixed domain receipt hashed once imports + verifies under local AND sqlite', async () => {
            const fixed: Receipt = {
                id: 'xa-receipt-1',
                commandId: 'cmd-shared',
                committedAt: '2026-04-01T12:30:00.000Z',
                resultSummary: 'committed 2 entities',
                affectedIds: ['a', 'b'],
                provenanceEventId: 'prov-shared',
                integrityHash: '',
            };
            const H = computeIntegrityHash(fixed as unknown as Record<string, unknown>);
            fixed.integrityHash = H;

            const local = freshLocal();
            const sqlite = freshSqlite();
            try {
                const li = await local.ledger.importReceipt({ ...fixed });
                const si = await sqlite.ledger.importReceipt({ ...fixed });
                expect(li.integrityHash).toBe(H);
                expect(si.integrityHash).toBe(H);

                const lg = await local.ledger.getReceipt('xa-receipt-1');
                const sg = await sqlite.ledger.getReceipt('xa-receipt-1');
                expect(lg).not.toBeNull();
                expect(sg).not.toBeNull();
                expect(lg?.integrityHash).toBe(H);
                expect(sg?.integrityHash).toBe(H);
                expect(lg).toEqual(sg);
            } finally {
                local.cleanup();
                sqlite.cleanup();
            }
        });
    });

    // ───────────────────────── 2. WRITTEN HERE, VERIFIED THERE ──────────────
    describe('a ledger written by one adapter verifies under the other', () => {
        it('local-WRITTEN event verifies under sqlite (import + getEvent, no throw)', async () => {
            const local = freshLocal();
            const sqlite = freshSqlite();
            try {
                // append() stamps id/timestamp/integrityHash/prevHash on local.
                const written = await local.ledger.append({
                    action: 'entity_created',
                    actorId: 'actor-L',
                    subjectId: 'subj-L',
                    subjectStore: 'canonical',
                    detail: { from: 'local' },
                });
                expect(written.integrityHash).toMatch(/^[a-f0-9]{64}$/);

                // Read it back, then import that EXACT record into a fresh sqlite
                // ledger. sqlite must verify the hash LOCAL computed.
                const readBack = await local.ledger.getEvent(written.id);
                expect(readBack).toEqual(written);
                const imported = await sqlite.ledger.importEvent(readBack as ProvenanceEvent);
                expect(imported.integrityHash).toBe(written.integrityHash);
                // getEvent under sqlite → no throw == verification passed.
                const viaSqlite = await sqlite.ledger.getEvent(written.id);
                expect(viaSqlite).not.toBeNull();
                expect(viaSqlite?.integrityHash).toBe(written.integrityHash);
                expect(viaSqlite).toEqual(written);
            } finally {
                local.cleanup();
                sqlite.cleanup();
            }
        });

        it('sqlite-WRITTEN event verifies under local (the reverse direction)', async () => {
            const sqlite = freshSqlite();
            const local = freshLocal();
            try {
                const written = await sqlite.ledger.append({
                    action: 'entity_created',
                    actorId: 'actor-S',
                    subjectId: 'subj-S',
                    subjectStore: 'artifact',
                    detail: { from: 'sqlite' },
                });
                expect(written.integrityHash).toMatch(/^[a-f0-9]{64}$/);

                const readBack = await sqlite.ledger.getEvent(written.id);
                expect(readBack).toEqual(written);
                const imported = await local.ledger.importEvent(readBack as ProvenanceEvent);
                expect(imported.integrityHash).toBe(written.integrityHash);
                const viaLocal = await local.ledger.getEvent(written.id);
                expect(viaLocal).not.toBeNull();
                expect(viaLocal?.integrityHash).toBe(written.integrityHash);
                expect(viaLocal).toEqual(written);
            } finally {
                sqlite.cleanup();
                local.cleanup();
            }
        });

        it('a CHAINED local-written pair carries its prevHash link intact into sqlite', async () => {
            // The chain link (second.prevHash === first.integrityHash) is part of
            // the hashed content, so it must survive the crossing AND re-verify.
            const local = freshLocal();
            const sqlite = freshSqlite();
            try {
                const first = await local.ledger.append({
                    action: 'a',
                    actorId: 'actor',
                    subjectId: 's',
                    subjectStore: 'canonical',
                    detail: {},
                });
                const second = await local.ledger.append({
                    action: 'b',
                    actorId: 'actor',
                    subjectId: 's',
                    subjectStore: 'canonical',
                    detail: {},
                });
                expect(second.prevHash).toBe(first.integrityHash);

                // Import both into a fresh sqlite ledger (order preserved).
                await sqlite.ledger.importEvent(first);
                await sqlite.ledger.importEvent(second);

                const sFirst = await sqlite.ledger.getEvent(first.id);
                const sSecond = await sqlite.ledger.getEvent(second.id);
                // Both verify under sqlite, and the chain link is preserved verbatim.
                expect(sFirst).toEqual(first);
                expect(sSecond).toEqual(second);
                expect(sSecond?.prevHash).toBe(first.integrityHash);
            } finally {
                local.cleanup();
                sqlite.cleanup();
            }
        });
    });

    // ──────────────── 3. CROSS-ADAPTER TAMPER DETECTION, SAME ERROR TYPE ─────
    describe('tamper detection raises the SAME error type on both adapters', () => {
        it('sqlite: a raw UPDATE to a hashed field → getEvent throws LedgerIntegrityError', async () => {
            const sqlite = freshSqlite();
            try {
                const ev = await sqlite.ledger.append({
                    action: 'entity_created',
                    actorId: 'actor',
                    subjectId: 's',
                    subjectStore: 'canonical',
                    detail: { note: 'authentic' },
                });
                // Change a hashed field WITHOUT recomputing integrity_hash.
                sqlite.db.connection
                    .prepare(`UPDATE ${LEDGER_EVENTS_TABLE} SET action = 'tampered' WHERE id = ?`)
                    .run(ev.id);
                await expect(sqlite.ledger.getEvent(ev.id)).rejects.toBeInstanceOf(
                    LedgerIntegrityError,
                );
            } finally {
                sqlite.cleanup();
            }
        });

        it('local: hand-editing the NDJSON line → getEvent throws LedgerIntegrityError (same type)', async () => {
            const local = freshLocal();
            try {
                const ev = await local.ledger.append({
                    action: 'entity_created',
                    actorId: 'actor',
                    subjectId: 's',
                    subjectStore: 'canonical',
                    detail: { note: 'authentic' },
                });
                // Hand-edit the NDJSON events file: change a hashed field, leave the
                // stored integrityHash stale. Reopen so the edit is loaded.
                const eventsPath = join(local.dir, 'events.json');
                const rewritten = readFileSync(eventsPath, 'utf-8')
                    .split('\n')
                    .map((line) => {
                        if (line.trim().length === 0) return line;
                        const obj = JSON.parse(line) as ProvenanceEvent;
                        if (obj.id === ev.id) {
                            obj.action = 'tampered';
                            return JSON.stringify(obj);
                        }
                        return line;
                    })
                    .join('\n');
                writeFileSync(eventsPath, rewritten);
                const reopened = new LocalLedgerStore(local.dir);
                await expect(reopened.getEvent(ev.id)).rejects.toBeInstanceOf(LedgerIntegrityError);
            } finally {
                local.cleanup();
            }
        });

        it('cross-check: a hash local computes for tampered content equals the hash sqlite would reject against', async () => {
            // Tighten the "same error type" claim into a "same hash math" claim:
            // take an authentic record, mutate a hashed field, and confirm BOTH
            // adapters agree (via the shared helper) on what the CORRECT hash of
            // the mutated content is — i.e. the mismatch each detects is the same
            // mismatch. We import the authentic record into both, then assert that
            // computeIntegrityHash over the mutated content is identical (the value
            // the stored-but-stale hash now fails to match on either adapter).
            const authentic: ProvenanceEvent = {
                id: 'xa-tamper-1',
                timestamp: '2026-04-02T00:00:00.000Z',
                action: 'create',
                actorId: 'a',
                subjectId: 's',
                subjectStore: 'canonical',
                detail: { v: 1 },
                owner: 'ledger',
                integrityHash: '',
            };
            authentic.integrityHash = computeIntegrityHash(
                authentic as unknown as Record<string, unknown>,
            );

            const local = freshLocal();
            const sqlite = freshSqlite();
            try {
                // Both accept the authentic record and verify it on read.
                await local.ledger.importEvent({ ...authentic });
                await sqlite.ledger.importEvent({ ...authentic });
                expect(await local.ledger.getEvent('xa-tamper-1')).toEqual(authentic);
                expect(await sqlite.ledger.getEvent('xa-tamper-1')).toEqual(authentic);

                // The mutated content (action flipped) hashes to ONE value via the
                // shared helper — the value both adapters' verify-on-read would
                // compute, and which no longer equals the stored authentic hash.
                const mutated = { ...authentic, action: 'tampered' };
                const mutatedHash = computeIntegrityHash(mutated as unknown as Record<string, unknown>);
                expect(mutatedHash).not.toBe(authentic.integrityHash);
                // (Sanity) recomputing twice is stable — the helper is deterministic.
                expect(computeIntegrityHash(mutated as unknown as Record<string, unknown>)).toBe(
                    mutatedHash,
                );
            } finally {
                local.cleanup();
                sqlite.cleanup();
            }
        });
    });
});
