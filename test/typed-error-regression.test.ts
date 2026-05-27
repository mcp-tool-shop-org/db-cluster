/**
 * Typed-error regression nets — TESTS-R004.
 *
 * Wave A1 introduced five typed errors / write-path mechanisms that landed in
 * code without a failing-on-removal regression test. If any of these is reverted
 * the production behaviour silently breaks (subtle data loss, no visible test
 * fail). This file is the always-on net.
 *
 * Coverage:
 *  - ReceiptFailedError + mutation_orphaned event (KERNEL-005)
 *  - CorruptStoreError (STORES-005)
 *  - ImportSnapshotNotSupportedError (STORES-003)
 *  - LocalLedgerStore.importEvent / importReceipt idempotency (STORES-002)
 *
 * Entity-ID preservation (STORES-001) is asserted in phase12-proof.test.ts
 * Proof 12 — see STORES-R001 note there.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalCluster } from '../src/adapters/local/index.js';
import { LocalCanonicalStore } from '../src/adapters/local/local-canonical-store.js';
import { LocalIndexStore } from '../src/adapters/local/local-index-store.js';
import { LocalLedgerStore } from '../src/adapters/local/local-ledger-store.js';
import { ClusterKernel } from '../src/kernel/cluster-kernel.js';
import { ReceiptFailedError } from '../src/kernel/errors.js';
import { CorruptStoreError } from '../src/adapters/local/errors.js';
import { ImportSnapshotNotSupportedError } from '../src/ops/errors.js';
import { backup, restore } from '../src/ops/backup.js';
import type { ProvenanceEvent } from '../src/types/provenance-event.js';
import type { Receipt } from '../src/types/receipt.js';

describe('TESTS-R004 — Typed error / write-path regression nets', () => {
    // ─── ReceiptFailedError + mutation_orphaned event (KERNEL-005) ────────
    //
    // The kernel wraps the post-mutation provenance/receipt sequence in
    // try/catch. On failure it (a) attempts a `mutation_orphaned` ledger event
    // and (b) throws ReceiptFailedError. If the kernel ever reverts to no
    // try/catch (or the event-name is changed/lost), the store ends up dirty
    // without an inspectable receipt and no test catches it.

    describe('ReceiptFailedError + mutation_orphaned event (KERNEL-005)', () => {
        it('createEntity throws ReceiptFailedError when post-mutation provenance fails AND records mutation_orphaned', async () => {
            const dir = mkdtempSync(join(tmpdir(), 'tests-r004-receipt-'));
            const stores = createLocalCluster(dir);
            const kernel = new ClusterKernel(stores, { dataDir: dir });

            // Track calls into ledger.append so we can both fail the
            // post-mutation provenance write AND verify the orphan write
            // was attempted (or recorded).
            const realAppend = stores.ledger.append.bind(stores.ledger);
            const calls: Array<{ action: string }> = [];
            let firstAppendFailed = false;
            stores.ledger.append = async (event: any) => {
                calls.push({ action: event.action });
                // First append after the entity is the post-mutation provenance
                // (action: entity_created). Fail it. Subsequent appends (the
                // orphan-record path) succeed.
                if (event.action === 'entity_created' && !firstAppendFailed) {
                    firstAppendFailed = true;
                    throw new Error('synthetic ledger failure');
                }
                return realAppend(event);
            };

            await expect(
                kernel.createEntity({
                    kind: 'document',
                    name: 'OrphanedEntity',
                    attributes: {},
                    actorId: 'operator',
                }),
            ).rejects.toThrow(ReceiptFailedError);

            // The kernel should have ATTEMPTED to write the orphan event
            // either before throwing. The orphan path emits action ==
            // 'mutation_orphaned'.
            const orphanAppendAttempts = calls.filter((c) => c.action === 'mutation_orphaned');
            expect(orphanAppendAttempts.length).toBeGreaterThan(0);

            // And the orphan event was persisted in the ledger.
            const events = await stores.ledger.listEvents({});
            const orphanEvents = events.filter((e) => e.action === 'mutation_orphaned');
            expect(orphanEvents.length).toBeGreaterThan(0);

            rmSync(dir, { recursive: true, force: true });
        });
    });

    // ─── CorruptStoreError (STORES-005) ───────────────────────────────────
    //
    // Adapters now wrap load() in try/catch around JSON.parse and throw
    // CorruptStoreError with the file path in the message. If the wrap is
    // ever removed, constructor would throw a bare SyntaxError instead and
    // the recovery path (typed error catch in ops/) would not match.

    describe('CorruptStoreError (STORES-005)', () => {
        it('LocalCanonicalStore throws CorruptStoreError on corrupt entities.json', () => {
            const dir = mkdtempSync(join(tmpdir(), 'tests-r004-corrupt-c-'));
            mkdirSync(dir, { recursive: true });
            const filePath = join(dir, 'entities.json');
            writeFileSync(filePath, '{this is not valid json at all', 'utf-8');

            try {
                expect(() => new LocalCanonicalStore(dir)).toThrow(CorruptStoreError);
                try {
                    new LocalCanonicalStore(dir);
                } catch (err) {
                    expect(err).toBeInstanceOf(CorruptStoreError);
                    expect((err as CorruptStoreError).filePath).toBe(filePath);
                    expect((err as Error).message).toContain(filePath);
                }
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });

        it('LocalIndexStore throws CorruptStoreError on corrupt index-records.json', () => {
            const dir = mkdtempSync(join(tmpdir(), 'tests-r004-corrupt-i-'));
            mkdirSync(dir, { recursive: true });
            const filePath = join(dir, 'index-records.json');
            writeFileSync(filePath, 'not json', 'utf-8');

            try {
                expect(() => new LocalIndexStore(dir)).toThrow(CorruptStoreError);
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });
    });

    // ─── ImportSnapshotNotSupportedError (STORES-003) ─────────────────────
    //
    // backup.ts requires every adapter to implement the import* hook for the
    // store it owns. If the hook is missing, restore() fails LOUDLY before
    // mutating anything — the previous silent ingest() fallback shredded
    // original IDs and broke provenance chains.

    describe('ImportSnapshotNotSupportedError (STORES-003)', () => {
        it('restore throws ImportSnapshotNotSupportedError when canonical adapter lacks importSnapshot', async () => {
            const srcDir = mkdtempSync(join(tmpdir(), 'tests-r004-iss-src-'));
            const tgtDir = mkdtempSync(join(tmpdir(), 'tests-r004-iss-tgt-'));

            const srcStores = createLocalCluster(srcDir);
            const kernel = new ClusterKernel(srcStores, { dataDir: srcDir });
            await kernel.createEntity({
                kind: 'document',
                name: 'Doc1',
                attributes: {},
                actorId: 'operator',
            });
            const data = await backup(srcStores);

            // Build a fresh target cluster, then strip importSnapshot off
            // the canonical adapter so restore must fall back / fail loudly.
            const tgtStores = createLocalCluster(tgtDir);
            // @ts-expect-error — runtime simulation of an adapter that
            // doesn't implement the optional hook.
            tgtStores.canonical.importSnapshot = undefined;

            await expect(restore(tgtStores, data)).rejects.toThrow(ImportSnapshotNotSupportedError);

            rmSync(srcDir, { recursive: true, force: true });
            rmSync(tgtDir, { recursive: true, force: true });
        });

        it('restore throws ImportSnapshotNotSupportedError when ledger adapter lacks importEvent', async () => {
            const srcDir = mkdtempSync(join(tmpdir(), 'tests-r004-iss-evt-src-'));
            const tgtDir = mkdtempSync(join(tmpdir(), 'tests-r004-iss-evt-tgt-'));

            const srcStores = createLocalCluster(srcDir);
            const kernel = new ClusterKernel(srcStores, { dataDir: srcDir });
            await kernel.createEntity({
                kind: 'document',
                name: 'Doc',
                attributes: {},
                actorId: 'operator',
            });
            const data = await backup(srcStores);
            // Sanity — there must be ledger events to import for this probe to fire.
            expect(data.events.length).toBeGreaterThan(0);

            const tgtStores = createLocalCluster(tgtDir);
            // @ts-expect-error — runtime simulation of an adapter without importEvent.
            tgtStores.ledger.importEvent = undefined;

            await expect(restore(tgtStores, data)).rejects.toThrow(ImportSnapshotNotSupportedError);

            rmSync(srcDir, { recursive: true, force: true });
            rmSync(tgtDir, { recursive: true, force: true });
        });
    });

    // ─── importEvent / importReceipt idempotency (STORES-002) ─────────────
    //
    // Restore must be idempotent — re-running it against the same target must
    // not double-insert events or receipts. The pre-fix `append()` /
    // `appendReceipt()` assigned fresh UUIDs every call, so re-runs silently
    // duplicated history. import* preserves the original id; the second
    // attempt is a no-op.

    describe('importEvent / importReceipt idempotency (STORES-002)', () => {
        it('restore twice into same target keeps event + receipt counts stable', async () => {
            const srcDir = mkdtempSync(join(tmpdir(), 'tests-r004-idemp-src-'));
            const tgtDir = mkdtempSync(join(tmpdir(), 'tests-r004-idemp-tgt-'));

            const srcStores = createLocalCluster(srcDir);
            const kernel = new ClusterKernel(srcStores, { dataDir: srcDir });
            await kernel.ingestArtifact({
                filename: 'doc.md',
                content: Buffer.from('content'),
                mimeType: 'text/markdown',
                actorId: 'operator',
            });
            await kernel.createEntity({
                kind: 'document',
                name: 'Doc',
                attributes: {},
                actorId: 'operator',
            });
            const data = await backup(srcStores);
            expect(data.events.length).toBeGreaterThan(0);
            expect(data.receipts.length).toBeGreaterThan(0);

            const tgtStores = createLocalCluster(tgtDir);

            // First restore — events + receipts land.
            await restore(tgtStores, data);
            const eventsAfterFirst = await tgtStores.ledger.listEvents({});
            const receiptsAfterFirst = await tgtStores.ledger.listReceipts({});

            // Second restore — must be a no-op, counts unchanged.
            await restore(tgtStores, data);
            const eventsAfterSecond = await tgtStores.ledger.listEvents({});
            const receiptsAfterSecond = await tgtStores.ledger.listReceipts({});

            expect(eventsAfterSecond.length).toBe(eventsAfterFirst.length);
            expect(receiptsAfterSecond.length).toBe(receiptsAfterFirst.length);

            // IDs must match exactly — proves importEvent / importReceipt
            // preserved the original id and the second run found them.
            expect(eventsAfterSecond.map((e) => e.id).sort()).toEqual(
                eventsAfterFirst.map((e) => e.id).sort(),
            );
            expect(receiptsAfterSecond.map((r) => r.id).sort()).toEqual(
                receiptsAfterFirst.map((r) => r.id).sort(),
            );

            rmSync(srcDir, { recursive: true, force: true });
            rmSync(tgtDir, { recursive: true, force: true });
        });

        it('LocalLedgerStore.importEvent preserves original id and timestamp', async () => {
            const dir = mkdtempSync(join(tmpdir(), 'tests-r004-import-evt-'));
            const ledger = new LocalLedgerStore(dir);

            const event: ProvenanceEvent = {
                id: 'evt-fixed-uuid-1234',
                timestamp: '2024-01-01T00:00:00.000Z',
                action: 'entity_created',
                actorId: 'operator',
                subjectId: 'subj-1',
                subjectStore: 'canonical',
                owner: 'ledger',
                detail: { kind: 'document' },
            };

            const imported = await ledger.importEvent(event);
            expect(imported.id).toBe('evt-fixed-uuid-1234');
            expect(imported.timestamp).toBe('2024-01-01T00:00:00.000Z');

            // Second import is idempotent — same id, no duplication.
            await ledger.importEvent(event);
            const events = await ledger.listEvents({});
            expect(events.length).toBe(1);

            rmSync(dir, { recursive: true, force: true });
        });

        it('LocalLedgerStore.importReceipt preserves original id and committedAt', async () => {
            const dir = mkdtempSync(join(tmpdir(), 'tests-r004-import-rcp-'));
            const ledger = new LocalLedgerStore(dir);

            const receipt: Receipt = {
                id: 'rcp-fixed-uuid-1234',
                committedAt: '2024-01-01T00:00:00.000Z',
                commandId: 'cmd-1',
                provenanceEventId: 'evt-1',
                affectedIds: ['subj-1'],
                resultSummary: 'Created entity test.',
            };

            const imported = await ledger.importReceipt(receipt);
            expect(imported.id).toBe('rcp-fixed-uuid-1234');
            expect(imported.committedAt).toBe('2024-01-01T00:00:00.000Z');

            // Second import is idempotent.
            await ledger.importReceipt(receipt);
            const receipts = await ledger.listReceipts({});
            expect(receipts.length).toBe(1);

            rmSync(dir, { recursive: true, force: true });
        });
    });
});
