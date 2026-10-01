/**
 * Regression — recovering from a torn ledger tail must leave the ledger
 * openable.
 *
 * LocalLedgerStore drops an unparseable tail line in memory when it loads, and
 * records a `ledger_tail_corruption_recovered` event. But it never repaired the
 * file: the audit event was appended AFTER the torn line (or glued onto it when
 * the torn line had no trailing newline), and a later receipt append did the
 * same to receipts.json. On the next start that torn line is "surrounded by
 * valid lines", which the loader treats as structural corruption and refuses
 * to open (CORRUPT_STORE). A crash recovery that bricks the ledger on the
 * following restart is not a recovery.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalLedgerStore } from '../src/adapters/local/local-ledger-store.js';

describe('LocalLedgerStore torn-tail recovery is durable', () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'cov-ledger-recovery-'));
        vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    });
    afterEach(() => {
        vi.restoreAllMocks();
        rmSync(dir, { recursive: true, force: true });
    });

    async function goodRecords() {
        const seed = new LocalLedgerStore(join(dir, 'seed'));
        const event = await seed.append({ action: 'a', actorId: 'op', subjectId: 's', subjectStore: 'canonical', detail: {} });
        const receipt = await seed.appendReceipt({ commandId: 'c1', resultSummary: 'r', affectedIds: [], provenanceEventId: event.id });
        return { event, receipt };
    }

    it.each([
        ['newline-terminated', '{"id":"half","action":\n'],
        ['unterminated', '{"id":"half","action":'],
    ])('a %s torn events tail: the ledger reopens repeatedly with one recovery event', async (_label, tail) => {
        const { event } = await goodRecords();
        const target = join(dir, 'torn-events');
        mkdirSync(target, { recursive: true });
        writeFileSync(join(target, 'events.json'), JSON.stringify(event) + '\n' + tail);

        const first = await new LocalLedgerStore(target).listEvents();
        expect(first.map((e) => e.action)).toEqual(['a', 'ledger_tail_corruption_recovered']);

        for (let i = 0; i < 3; i++) {
            const reopened = new LocalLedgerStore(target);
            expect((await reopened.listEvents()).map((e) => e.action)).toEqual(['a', 'ledger_tail_corruption_recovered']);
        }
        // The healed file holds only whole records.
        const lines = readFileSync(join(target, 'events.json'), 'utf-8').split('\n').filter((l) => l.trim());
        expect(lines).toHaveLength(2);
        for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    });

    it('a torn receipts tail: receipts appended afterwards survive a restart', async () => {
        const { event, receipt } = await goodRecords();
        const target = join(dir, 'torn-receipts');
        mkdirSync(target, { recursive: true });
        writeFileSync(join(target, 'events.json'), JSON.stringify(event) + '\n');
        writeFileSync(join(target, 'receipts.json'), JSON.stringify(receipt) + '\n{"id":"half-receipt","commandId":');

        const store = new LocalLedgerStore(target);
        const next = await store.appendReceipt({ commandId: 'c2', resultSummary: 'after recovery', affectedIds: [], provenanceEventId: event.id });
        expect((await store.listReceipts()).map((r) => r.id)).toEqual([receipt.id, next.id]);

        const reopened = new LocalLedgerStore(target);
        expect((await reopened.listReceipts()).map((r) => r.id)).toEqual([receipt.id, next.id]);
        expect((await reopened.listEvents()).filter((e) => e.action === 'ledger_tail_corruption_recovered')).toHaveLength(1);
    });
});
