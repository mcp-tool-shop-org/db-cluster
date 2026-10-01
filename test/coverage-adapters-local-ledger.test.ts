/**
 * Coverage — LocalLedgerStore: receipt filtering and ordering, loading of
 * legacy and damaged on-disk files, torn-tail recovery, and recovery of an
 * interrupted rotation. Files are written and damaged directly in a temp
 * directory, then a fresh store instance is constructed over them.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalLedgerStore, ROTATE_MARKER_FILENAME } from '../src/adapters/local/local-ledger-store.js';

const ACTOR = 'operator';

function readNdjson(path: string): Array<Record<string, any>> {
    return readFileSync(path, 'utf-8')
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l));
}

describe('LocalLedgerStore', () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'cov-ledger-'));
    });
    afterEach(() => {
        vi.restoreAllMocks();
        rmSync(dir, { recursive: true, force: true });
    });

    async function seedEvents(store: LocalLedgerStore, n: number) {
        const out = [];
        for (let i = 0; i < n; i++) {
            out.push(await store.append({
                action: 'note', actorId: ACTOR, subjectId: `s${i}`, subjectStore: 'canonical', detail: { i },
            }));
        }
        return out;
    }

    describe('listReceipts', () => {
        it('filters by commandId, since and limit (the youngest N), preserving append order', async () => {
            const store = new LocalLedgerStore(dir);
            const ev = await store.append({ action: 'a', actorId: ACTOR, subjectId: 's', subjectStore: 'canonical', detail: {} });
            const r1 = await store.appendReceipt({ commandId: 'cmd-a', resultSummary: '1', affectedIds: [], provenanceEventId: ev.id });
            const r2 = await store.appendReceipt({ commandId: 'cmd-b', resultSummary: '2', affectedIds: [], provenanceEventId: ev.id });
            const r3 = await store.appendReceipt({ commandId: 'cmd-a', resultSummary: '3', affectedIds: [], provenanceEventId: ev.id });

            expect((await store.listReceipts()).map((r) => r.id)).toEqual([r1.id, r2.id, r3.id]);
            expect((await store.listReceipts({ commandId: 'cmd-a' })).map((r) => r.id)).toEqual([r1.id, r3.id]);
            expect((await store.listReceipts({ limit: 2 })).map((r) => r.id)).toEqual([r2.id, r3.id]);
            expect((await store.listReceipts({ commandId: 'cmd-a', limit: 1 })).map((r) => r.id)).toEqual([r3.id]);

            expect(await store.listReceipts({ since: '2999-01-01T00:00:00.000Z' })).toEqual([]);
            expect((await store.listReceipts({ since: '2000-01-01T00:00:00.000Z' })).map((r) => r.id)).toEqual([r1.id, r2.id, r3.id]);
            // `since` is inclusive of the boundary itself.
            expect((await store.listReceipts({ since: r2.committedAt })).map((r) => r.id)).toContain(r2.id);
        });
    });

    describe('loading existing files', () => {
        it('loads a legacy JSON-array events file and keeps appending in NDJSON', async () => {
            const seedStore = new LocalLedgerStore(join(dir, 'seed'));
            const [e1, e2] = await seedEvents(seedStore, 2);
            mkdirSync(join(dir, 'legacy'), { recursive: true });
            writeFileSync(join(dir, 'legacy', 'events.json'), JSON.stringify([e1, e2], null, 2));

            const store = new LocalLedgerStore(join(dir, 'legacy'));
            expect((await store.listEvents()).map((e) => e.id)).toEqual([e1.id, e2.id]);
            expect((await store.getEvent(e2.id))?.subjectId).toBe('s1');
        });

        it('an empty events file loads as an empty ledger', async () => {
            mkdirSync(join(dir, 'empty'), { recursive: true });
            writeFileSync(join(dir, 'empty', 'events.json'), '   \n');
            const store = new LocalLedgerStore(join(dir, 'empty'));
            expect(await store.listEvents()).toEqual([]);
            expect(await store.countEvents()).toBe(0);
        });

        it('a malformed legacy array file throws CorruptStoreError naming the file', () => {
            mkdirSync(join(dir, 'bad-array'), { recursive: true });
            const file = join(dir, 'bad-array', 'events.json');
            writeFileSync(file, '[{"id": "x"');
            let caught: unknown;
            try {
                new LocalLedgerStore(join(dir, 'bad-array'));
            } catch (e) {
                caught = e;
            }
            expect(caught).toMatchObject({ code: 'CORRUPT_STORE', name: 'CorruptStoreError' });
            expect(String((caught as Error).message)).toContain('events.json');
        });

        it('an events path that cannot be read as a file throws CorruptStoreError', () => {
            mkdirSync(join(dir, 'dir-as-file', 'events.json'), { recursive: true });
            expect(() => new LocalLedgerStore(join(dir, 'dir-as-file'))).toThrow(
                expect.objectContaining({ code: 'CORRUPT_STORE' }),
            );
        });

        it('an NDJSON file with no parseable line throws CorruptStoreError', () => {
            mkdirSync(join(dir, 'all-bad'), { recursive: true });
            writeFileSync(join(dir, 'all-bad', 'events.json'), 'garbage line one\nanother garbage line\n');
            expect(() => new LocalLedgerStore(join(dir, 'all-bad'))).toThrow(
                expect.objectContaining({ code: 'CORRUPT_STORE' }),
            );
        });

        it('an unparseable line in the middle of valid records is structural corruption, not a torn tail', async () => {
            const seedStore = new LocalLedgerStore(join(dir, 'seed'));
            const [e1, e2] = await seedEvents(seedStore, 2);
            mkdirSync(join(dir, 'middle'), { recursive: true });
            writeFileSync(
                join(dir, 'middle', 'events.json'),
                [JSON.stringify(e1), '{"torn":', JSON.stringify(e2)].join('\n') + '\n',
            );
            let caught: unknown;
            try {
                new LocalLedgerStore(join(dir, 'middle'));
            } catch (e) {
                caught = e;
            }
            expect(caught).toMatchObject({ code: 'CORRUPT_STORE' });
            expect(String((caught as Error).message)).toContain('structurally corrupt');
        });
    });

    describe('torn tail recovery', () => {
        it.each([
            ['a truncated JSON line', '{"id":"half-written","action":'],
            ['a non-object JSON value', '42'],
            ['an array line', '[1,2,3]'],
            ['a record with no id', '{"action":"orphan"}'],
        ])('drops %s at the tail, warns on stderr and records a recovery event', async (_label, badTail) => {
            const seedStore = new LocalLedgerStore(join(dir, 'seed'));
            const [e1, e2] = await seedEvents(seedStore, 2);
            const target = join(dir, 'torn');
            mkdirSync(target, { recursive: true });
            writeFileSync(join(target, 'events.json'), [JSON.stringify(e1), JSON.stringify(e2), badTail].join('\n') + '\n');
            const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

            const store = new LocalLedgerStore(target);
            const events = await store.listEvents();
            expect(events.map((e) => e.action)).toEqual(['note', 'note', 'ledger_tail_corruption_recovered']);
            expect(events[0].id).toBe(e1.id);
            expect(events[2]).toMatchObject({
                actorId: 'local-ledger-store',
                subjectStore: 'ledger',
                detail: { discardedLines: 1, file: join(target, 'events.json') },
            });
            // The recovery event is hash-chained onto the surviving tail.
            expect(events[2].prevHash).toBe(e2.integrityHash);
            const warning = stderr.mock.calls.map((c) => String(c[0])).join('');
            expect(warning).toContain('[ledger] tail corruption detected: discarded 1 line(s)');
        });
    });

    describe('interrupted rotation recovery', () => {
        function archive(name: string, records: unknown[]): string {
            const archiveDir = join(dir, 'ledger-archive');
            mkdirSync(archiveDir, { recursive: true });
            const p = join(archiveDir, name);
            writeFileSync(p, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
            return p;
        }

        it('removes a malformed rotate marker and loads the ledger untouched', async () => {
            const seedStore = new LocalLedgerStore(join(dir, 'seed'));
            const [e1] = await seedEvents(seedStore, 1);
            const target = join(dir, 'marker-bad');
            mkdirSync(target, { recursive: true });
            writeFileSync(join(target, 'events.json'), JSON.stringify(e1) + '\n');
            writeFileSync(join(target, ROTATE_MARKER_FILENAME), '{"archiveId":"x"}'); // no archive paths

            const store = new LocalLedgerStore(target);
            expect(existsSync(join(target, ROTATE_MARKER_FILENAME))).toBe(false);
            expect((await store.listEvents()).map((e) => e.id)).toEqual([e1.id]);
        });

        it('removes an unparseable rotate marker', () => {
            const target = join(dir, 'marker-garbage');
            mkdirSync(target, { recursive: true });
            writeFileSync(join(target, ROTATE_MARKER_FILENAME), 'not json at all');
            new LocalLedgerStore(target);
            expect(existsSync(join(target, ROTATE_MARKER_FILENAME))).toBe(false);
        });

        it('a valid marker dedups active records already in the archive, drops torn lines, and clears the marker', async () => {
            const seedStore = new LocalLedgerStore(join(dir, 'seed'));
            const [archived, kept] = await seedEvents(seedStore, 2);
            const eventsArchive = archive('events-x.ndjson', [archived]);
            const receiptsArchive = archive('receipts-x.ndjson', []);

            const target = dir; // the ledger-archive dir lives beside the active files
            writeFileSync(
                join(target, 'events.json'),
                [JSON.stringify(archived), '{"torn":', JSON.stringify(kept)].join('\n') + '\n',
            );
            writeFileSync(
                join(target, ROTATE_MARKER_FILENAME),
                JSON.stringify({ archiveId: 'x', eventsArchivePath: eventsArchive, receiptsArchivePath: receiptsArchive }),
            );

            const store = new LocalLedgerStore(target);
            expect(existsSync(join(target, ROTATE_MARKER_FILENAME))).toBe(false);
            expect((await store.listEvents()).map((e) => e.id)).toEqual([kept.id]);
            // The rewritten file holds only the surviving record, with no torn line.
            expect(readNdjson(join(target, 'events.json')).map((e) => e.id)).toEqual([kept.id]);
        });

        it('a marker whose archive is empty or absent leaves the active file alone', async () => {
            const seedStore = new LocalLedgerStore(join(dir, 'seed'));
            const [e1] = await seedEvents(seedStore, 1);
            writeFileSync(join(dir, 'events.json'), JSON.stringify(e1) + '\n');
            writeFileSync(
                join(dir, ROTATE_MARKER_FILENAME),
                JSON.stringify({
                    archiveId: 'y',
                    eventsArchivePath: join(dir, 'ledger-archive', 'missing-events.ndjson'),
                    receiptsArchivePath: join(dir, 'ledger-archive', 'missing-receipts.ndjson'),
                }),
            );
            const store = new LocalLedgerStore(dir);
            expect(existsSync(join(dir, ROTATE_MARKER_FILENAME))).toBe(false);
            expect((await store.listEvents()).map((e) => e.id)).toEqual([e1.id]);
        });

        it('rotate() archives old records and a restart sees only the retained ones', async () => {
            const store = new LocalLedgerStore(dir);
            const [old] = await seedEvents(store, 1);
            await new Promise((r) => setTimeout(r, 15));
            const boundary = new Date().toISOString();
            await new Promise((r) => setTimeout(r, 15));
            const [fresh] = await seedEvents(store, 1);

            const result = await store.rotate(boundary);
            expect(result.archived).toBe(1);
            expect(result.retained).toBe(1);
            expect(result.archiveFile).toBeDefined();
            expect(readNdjson(result.archiveFile!).map((e) => e.id)).toEqual([old.id]);

            const reopened = new LocalLedgerStore(dir);
            expect((await reopened.listEvents()).map((e) => e.id)).toEqual([fresh.id]);
            expect(existsSync(join(dir, ROTATE_MARKER_FILENAME))).toBe(false);
        });
    });
});
