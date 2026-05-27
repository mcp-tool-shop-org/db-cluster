/**
 * Wave A4 — Stores domain regression nets (Stage B Wave B1 audit closes).
 *
 * Pins three behaviours surfaced by the Stage B proactive-health audit that
 * the Stage A waves missed:
 *
 *  - STORES-B-001 — Multi-process .tmp race. All four local adapters write to
 *    `${path}.tmp` (fixed suffix); two processes hitting persist() simultaneously
 *    truncate each other's writes silently. Fix: random-suffix tmp paths +
 *    orphan-cleanup helper called from each adapter's constructor.
 *
 *  - STORES-B-003 — Silent first-write-wins on import* with no content
 *    comparison. A tampered backup with a matching ID but altered fields was
 *    silently masked. Fix: compare incoming vs existing content (excluding the
 *    store-stamped `owner`); throw ImportConflictError on mismatch; idempotent
 *    when identical.
 *
 *  - STORES-B-015 — LocalLedgerStore.trace() infinite loop on cyclic parent
 *    chain. A tampered ledger where A→B→A produces infinite loop. Fix: cycle
 *    detection with a visited Set; throw LedgerCycleDetectedError loudly so
 *    corrupted ledgers do not silently truncate the trace.
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
    mkdtempSync,
    mkdirSync,
    rmSync,
    existsSync,
    readdirSync,
    writeFileSync,
    utimesSync,
    readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalCanonicalStore } from '../src/adapters/local/local-canonical-store.js';
import { LocalLedgerStore } from '../src/adapters/local/local-ledger-store.js';
import { LocalIndexStore } from '../src/adapters/local/local-index-store.js';
import { LocalArtifactStore } from '../src/adapters/local/local-artifact-store.js';
import {
    ImportConflictError,
    LedgerCycleDetectedError,
} from '../src/adapters/local/errors.js';
import type { ProvenanceEvent } from '../src/types/provenance-event.js';

describe('Wave A4 — Stores regression nets', () => {
    // ─── STORES-B-001 — Random-suffix tmp paths + orphan cleanup ─────────
    //
    // Pre-fix all four local adapters write to `${path}.tmp` (a fixed
    // suffix). When two processes call persist() concurrently they race on
    // the same tmp file — last writer wins, the other process's data is
    // silently lost. Fix: include process.pid and random suffix in the tmp
    // path so concurrent writers never collide.
    //
    // Companion problem: random-suffix tmp files accumulate if the process
    // dies between writeFileSync and renameSync. Fix: at constructor time,
    // sweep the data directory for orphan tmp files older than a few minutes
    // and unlink them. Don't delete young tmp files — those may belong to an
    // actively-writing sibling process.

    describe('STORES-B-001 — random tmp suffix per persist call', () => {
        // Helper — assert a source body uses some form of random-suffix tmp
        // path. Accept either an inline pattern (process.pid + random/uuid)
        // OR a helper-function call (buildRandomTmpPath). Either way the
        // load-bearing property is "no fixed `${target}.tmp` literal in the
        // persist body" — both shapes prove it.
        function assertUsesRandomTmpSuffix(block: string, label: string): void {
            const usesHelper = /buildRandomTmpPath\s*\(/.test(block);
            const inlinePid = /process\.pid/.test(block);
            const inlineRandom = /Math\.random|randomUUID|randomBytes/.test(block);
            const usesInline = inlinePid && inlineRandom;
            const usesRename = /\brenameSync\b/.test(block);
            // Fixed-suffix `.tmp` literal MUST be gone — the regression we
            // are guarding against is exactly this string.
            const fixedSuffixPattern = /\$\{[^}]+\}\.tmp\b/;
            const hasFixedSuffix = fixedSuffixPattern.test(block);
            expect(
                (usesHelper || usesInline) && usesRename && !hasFixedSuffix,
                `${label} must use random tmp suffix ` +
                    `(helper=${usesHelper}, inlinePid+rand=${usesInline}, rename=${usesRename}, ` +
                    `hasFixedSuffix=${hasFixedSuffix}).\nBlock:\n${block}`,
            ).toBe(true);
        }

        it('LocalCanonicalStore.persist uses a distinct tmp path each call', async () => {
            const dir = mkdtempSync(join(tmpdir(), 'wave-a4-canonical-tmp-'));
            try {
                const store = new LocalCanonicalStore(dir);
                const filePath = join(dir, 'entities.json');
                const fixedTmp = `${filePath}.tmp`;

                // Source-level invariant: random tmp suffix in persist body.
                const src = readFileSync(
                    join(process.cwd(), 'src/adapters/local/local-canonical-store.ts'),
                    'utf-8',
                );
                const persistStart = src.indexOf('private persist(');
                expect(persistStart, 'persist() body not found').toBeGreaterThan(-1);
                const persistEnd = src.indexOf('\n    }', persistStart) + 6;
                const persistBlock = src.slice(persistStart, persistEnd);
                assertUsesRandomTmpSuffix(persistBlock, 'LocalCanonicalStore.persist');

                // Runtime: persist actually creates the file successfully —
                // we exercise the path-uniqueness in spirit by running two
                // consecutive persists.
                await store.create({ kind: 'document', name: 'A', attributes: {} });
                await store.create({ kind: 'document', name: 'B', attributes: {} });
                expect(existsSync(filePath)).toBe(true);
                // No orphan `.tmp` left behind by either persist's renameSync.
                const entries = readdirSync(dir);
                const tmpStragglers = entries.filter((n) => n.endsWith('.tmp'));
                expect(
                    tmpStragglers,
                    `unexpected .tmp orphans after clean persist: ${JSON.stringify(entries)}`,
                ).toEqual([]);
                // The fixed-suffix tmp path must NOT exist (regression check).
                expect(existsSync(fixedTmp)).toBe(false);
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });

        it('LocalLedgerStore.persistEvents and persistReceipts use random tmp suffix', async () => {
            const src = readFileSync(
                join(process.cwd(), 'src/adapters/local/local-ledger-store.ts'),
                'utf-8',
            );
            for (const methodName of ['persistEvents', 'persistReceipts']) {
                const start = src.indexOf(`private ${methodName}(`);
                expect(start, `${methodName} body not found`).toBeGreaterThan(-1);
                const end = src.indexOf('\n    }', start) + 6;
                const block = src.slice(start, end);
                assertUsesRandomTmpSuffix(block, `LocalLedgerStore.${methodName}`);
            }
        });

        it('LocalIndexStore.persist uses random tmp suffix', async () => {
            const src = readFileSync(
                join(process.cwd(), 'src/adapters/local/local-index-store.ts'),
                'utf-8',
            );
            const start = src.indexOf('private persist(');
            expect(start, 'persist() body not found').toBeGreaterThan(-1);
            const end = src.indexOf('\n    }', start) + 6;
            const block = src.slice(start, end);
            assertUsesRandomTmpSuffix(block, 'LocalIndexStore.persist');
        });

        it('LocalArtifactStore.persist and content writes use random tmp suffix', async () => {
            const src = readFileSync(
                join(process.cwd(), 'src/adapters/local/local-artifact-store.ts'),
                'utf-8',
            );
            // persist() body
            const persistStart = src.indexOf('private persist(');
            expect(persistStart, 'persist() body not found').toBeGreaterThan(-1);
            const persistEnd = src.indexOf('\n    }', persistStart) + 6;
            const persistBlock = src.slice(persistStart, persistEnd);
            assertUsesRandomTmpSuffix(persistBlock, 'LocalArtifactStore.persist');

            // ingest() content path
            const ingestStart = src.indexOf('async ingest(');
            expect(ingestStart, 'ingest() body not found').toBeGreaterThan(-1);
            const ingestEnd = src.indexOf('async versions(');
            const ingestBlock = src.slice(ingestStart, ingestEnd);
            assertUsesRandomTmpSuffix(ingestBlock, 'LocalArtifactStore.ingest content write');

            // importSnapshot() content path
            const importStart = src.indexOf('async importSnapshot(');
            expect(importStart, 'importSnapshot() body not found').toBeGreaterThan(-1);
            const importEnd = src.indexOf('private load(');
            const importBlock = src.slice(importStart, importEnd);
            assertUsesRandomTmpSuffix(
                importBlock,
                'LocalArtifactStore.importSnapshot content write',
            );
        });

        // Behaviour probe: multiple persist calls write distinct tmp files.
        // We spy on writeFileSync by reading the data dir mid-persist isn't
        // feasible synchronously, but we can verify the property by checking
        // that two separate persists succeed without errors and the file is
        // present at the end.
        it('two consecutive persists on the same store both succeed (random suffix avoids collision)', async () => {
            const dir = mkdtempSync(join(tmpdir(), 'wave-a4-collision-'));
            try {
                const store = new LocalCanonicalStore(dir);
                // Back-to-back creates → two persist() calls in flight on the
                // same store. With a random suffix neither can clobber the
                // other's tmp file.
                await store.create({ kind: 'document', name: 'First', attributes: {} });
                await store.create({ kind: 'document', name: 'Second', attributes: {} });
                const all = await store.list({});
                expect(all).toHaveLength(2);
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });
    });

    describe('STORES-B-001 — orphan tmp cleanup at constructor', () => {
        it('removes orphan random-suffix .tmp files older than the threshold', async () => {
            const dir = mkdtempSync(join(tmpdir(), 'wave-a4-orphan-cleanup-'));
            try {
                // Plant an orphan tmp file matching the random-suffix pattern.
                // Format: `${baseName}.${pid}-${rand}.tmp`
                const fakeOrphan = join(dir, 'entities.json.99999-abc123.tmp');
                writeFileSync(fakeOrphan, '[]');
                // Backdate it well past the 5-minute threshold (10 minutes ago).
                const tenMinAgo = (Date.now() - 10 * 60 * 1000) / 1000;
                utimesSync(fakeOrphan, tenMinAgo, tenMinAgo);
                expect(existsSync(fakeOrphan)).toBe(true);

                // Constructing the adapter should sweep the orphan.
                new LocalCanonicalStore(dir);

                expect(
                    existsSync(fakeOrphan),
                    'orphan .tmp older than threshold should be removed by constructor sweep',
                ).toBe(false);
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });

        it('keeps young random-suffix .tmp files within the threshold (sibling process may be writing)', async () => {
            const dir = mkdtempSync(join(tmpdir(), 'wave-a4-orphan-young-'));
            try {
                // Plant a YOUNG orphan tmp file (mtime = now). It might
                // belong to an actively-writing sibling process; the sweep
                // must NOT delete it.
                const youngTmp = join(dir, 'entities.json.99999-xyz789.tmp');
                writeFileSync(youngTmp, '[]');
                // utimes to NOW (within threshold)
                const now = Date.now() / 1000;
                utimesSync(youngTmp, now, now);

                new LocalCanonicalStore(dir);

                expect(
                    existsSync(youngTmp),
                    'young .tmp file within threshold MUST be kept (sibling process may be writing)',
                ).toBe(true);
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });

        it('cleanup runs for every local adapter at construction', async () => {
            // Each adapter passes its own basename to the cleanup helper.
            // Plant a matching orphan in each store's dir and assert removed.
            const root = mkdtempSync(join(tmpdir(), 'wave-a4-all-adapters-cleanup-'));
            try {
                const canonicalDir = join(root, 'canonical');
                const ledgerDir = join(root, 'ledger');
                const indexDir = join(root, 'index');
                const artifactDir = join(root, 'artifact');
                mkdirSync(canonicalDir, { recursive: true });
                mkdirSync(ledgerDir, { recursive: true });
                mkdirSync(indexDir, { recursive: true });
                mkdirSync(artifactDir, { recursive: true });

                const oldMtime = (Date.now() - 10 * 60 * 1000) / 1000;

                // Plant orphans matching each adapter's basenames.
                const canonicalOrphan = join(canonicalDir, 'entities.json.111-aaa.tmp');
                const eventsOrphan = join(ledgerDir, 'events.json.222-bbb.tmp');
                const receiptsOrphan = join(ledgerDir, 'receipts.json.333-ccc.tmp');
                const indexOrphan = join(indexDir, 'index-records.json.444-ddd.tmp');
                const artifactOrphan = join(artifactDir, 'artifacts.json.555-eee.tmp');

                for (const p of [
                    canonicalOrphan,
                    eventsOrphan,
                    receiptsOrphan,
                    indexOrphan,
                    artifactOrphan,
                ]) {
                    writeFileSync(p, '[]');
                    utimesSync(p, oldMtime, oldMtime);
                }

                new LocalCanonicalStore(canonicalDir);
                new LocalLedgerStore(ledgerDir);
                new LocalIndexStore(indexDir);
                new LocalArtifactStore(artifactDir);

                expect(existsSync(canonicalOrphan)).toBe(false);
                expect(existsSync(eventsOrphan)).toBe(false);
                expect(existsSync(receiptsOrphan)).toBe(false);
                expect(existsSync(indexOrphan)).toBe(false);
                expect(existsSync(artifactOrphan)).toBe(false);
            } finally {
                rmSync(root, { recursive: true, force: true });
            }
        });

        it('cleanup ignores unrelated files (does not delete the main JSON file or stranger files)', async () => {
            const dir = mkdtempSync(join(tmpdir(), 'wave-a4-cleanup-safe-'));
            try {
                // Plant non-tmp files. The sweep regex matches only
                // `${baseName}.\d+-[a-z0-9]+\.tmp`. Other files must survive.
                const realFile = join(dir, 'entities.json');
                const noiseFile = join(dir, 'README.txt');
                const wrongPatternFile = join(dir, 'entities.json.tmp'); // fixed-suffix (pre-fix legacy)
                const oldMtime = (Date.now() - 10 * 60 * 1000) / 1000;
                writeFileSync(realFile, '[]');
                writeFileSync(noiseFile, 'hello');
                writeFileSync(wrongPatternFile, '[]');
                utimesSync(wrongPatternFile, oldMtime, oldMtime);

                new LocalCanonicalStore(dir);

                expect(
                    existsSync(realFile),
                    'main JSON must not be deleted by orphan sweep',
                ).toBe(true);
                expect(
                    existsSync(noiseFile),
                    'unrelated files must not be deleted',
                ).toBe(true);
                // The fixed-suffix `entities.json.tmp` is the LEGACY orphan
                // pattern — we DO accept either result (sweep or skip) but
                // since our regex requires `.\d+-[a-z0-9]+\.tmp`, this file
                // should NOT match. Assert it survives.
                expect(
                    existsSync(wrongPatternFile),
                    'fixed-suffix legacy .tmp is outside the random-suffix sweep regex; survives',
                ).toBe(true);
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });
    });

    // ─── STORES-B-003 — Content-comparison on import* ────────────────────
    //
    // Pre-fix every import* method silently returned the existing record
    // when the ID matched, with no comparison of the incoming content. A
    // tampered backup with a matching ID but altered fields was silently
    // masked. Fix: compare incoming vs existing content excluding owner;
    // throw ImportConflictError on mismatch; preserve idempotency when
    // content is identical.

    describe('STORES-B-003 — importEvent content conflict detection', () => {
        it('identical re-import is idempotent (no throw, returns existing)', async () => {
            const dir = mkdtempSync(join(tmpdir(), 'wave-a4-import-event-idem-'));
            try {
                const store = new LocalLedgerStore(dir);
                const event: ProvenanceEvent = {
                    id: '11111111-1111-1111-1111-111111111111',
                    timestamp: '2026-05-27T00:00:00.000Z',
                    action: 'entity_created',
                    actorId: 'operator',
                    subjectId: 'entity-abc',
                    subjectStore: 'canonical',
                    detail: { note: 'first' },
                    owner: 'ledger',
                };
                const first = await store.importEvent(event);
                expect(first.id).toBe(event.id);

                // Re-import with byte-identical content: must NOT throw, must
                // return the existing record.
                const second = await store.importEvent({ ...event });
                expect(second.id).toBe(event.id);
                expect(second.detail).toEqual({ note: 'first' });
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });

        it('importEvent throws ImportConflictError when an existing event has different content', async () => {
            const dir = mkdtempSync(join(tmpdir(), 'wave-a4-import-event-conflict-'));
            try {
                const store = new LocalLedgerStore(dir);
                const base: ProvenanceEvent = {
                    id: '22222222-2222-2222-2222-222222222222',
                    timestamp: '2026-05-27T00:00:00.000Z',
                    action: 'entity_created',
                    actorId: 'operator',
                    subjectId: 'entity-xyz',
                    subjectStore: 'canonical',
                    detail: { note: 'original' },
                    owner: 'ledger',
                };
                await store.importEvent(base);

                // Same id, different action — tampered backup.
                const tampered: ProvenanceEvent = {
                    ...base,
                    action: 'entity_updated', // differs
                };
                await expect(store.importEvent(tampered)).rejects.toThrow(ImportConflictError);
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });
    });

    describe('STORES-B-003 — importReceipt content conflict detection', () => {
        it('identical re-import is idempotent', async () => {
            const dir = mkdtempSync(join(tmpdir(), 'wave-a4-import-receipt-idem-'));
            try {
                const store = new LocalLedgerStore(dir);
                const receipt = {
                    id: '33333333-3333-3333-3333-333333333333',
                    commandId: 'cmd-abc',
                    committedAt: '2026-05-27T00:00:00.000Z',
                    resultSummary: 'ok',
                    affectedIds: ['entity-1'],
                    provenanceEventId: 'evt-1',
                };
                await store.importReceipt(receipt);
                // Identical re-import: idempotent, no throw.
                const second = await store.importReceipt({ ...receipt });
                expect(second.id).toBe(receipt.id);
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });

        it('importReceipt throws ImportConflictError on content mismatch', async () => {
            const dir = mkdtempSync(join(tmpdir(), 'wave-a4-import-receipt-conflict-'));
            try {
                const store = new LocalLedgerStore(dir);
                const base = {
                    id: '44444444-4444-4444-4444-444444444444',
                    commandId: 'cmd-base',
                    committedAt: '2026-05-27T00:00:00.000Z',
                    resultSummary: 'original',
                    affectedIds: ['entity-1'],
                    provenanceEventId: 'evt-1',
                };
                await store.importReceipt(base);
                const tampered = { ...base, resultSummary: 'tampered' };
                await expect(store.importReceipt(tampered)).rejects.toThrow(
                    ImportConflictError,
                );
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });
    });

    describe('STORES-B-003 — canonical.importSnapshot content conflict detection', () => {
        it('identical re-import is idempotent', async () => {
            const dir = mkdtempSync(join(tmpdir(), 'wave-a4-import-canonical-idem-'));
            try {
                const store = new LocalCanonicalStore(dir);
                const entity = {
                    id: '55555555-5555-5555-5555-555555555555',
                    kind: 'document',
                    name: 'idem-doc',
                    attributes: { tag: 'v1' },
                    createdAt: '2026-05-27T00:00:00.000Z',
                    updatedAt: '2026-05-27T00:00:00.000Z',
                    owner: 'canonical' as const,
                };
                await store.importSnapshot(entity);
                const second = await store.importSnapshot({ ...entity });
                expect(second.id).toBe(entity.id);
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });

        it('canonical.importSnapshot throws ImportConflictError on content mismatch', async () => {
            const dir = mkdtempSync(join(tmpdir(), 'wave-a4-import-canonical-conflict-'));
            try {
                const store = new LocalCanonicalStore(dir);
                const base = {
                    id: '66666666-6666-6666-6666-666666666666',
                    kind: 'document',
                    name: 'original-name',
                    attributes: {},
                    createdAt: '2026-05-27T00:00:00.000Z',
                    updatedAt: '2026-05-27T00:00:00.000Z',
                    owner: 'canonical' as const,
                };
                await store.importSnapshot(base);
                const tampered = { ...base, name: 'tampered-name' };
                await expect(store.importSnapshot(tampered)).rejects.toThrow(
                    ImportConflictError,
                );
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });
    });

    describe('STORES-B-003 — artifact.importSnapshot content conflict detection', () => {
        const content = Buffer.from('artifact body for B-003 tests');
        const contentHash = createHash('sha256').update(content).digest('hex');

        it('identical re-import is idempotent', async () => {
            const dir = mkdtempSync(join(tmpdir(), 'wave-a4-import-artifact-idem-'));
            try {
                const store = new LocalArtifactStore(dir);
                const meta = {
                    id: '77777777-7777-7777-7777-777777777777',
                    filename: 'idem.bin',
                    contentHash,
                    mimeType: 'application/octet-stream',
                    sizeBytes: content.length,
                    version: 1,
                    storagePath: join(dir, 'content', contentHash),
                    ingestedAt: '2026-05-27T00:00:00.000Z',
                    owner: 'artifact' as const,
                };
                await store.importSnapshot(meta, content);
                const second = await store.importSnapshot({ ...meta }, content);
                expect(second.id).toBe(meta.id);
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });

        it('artifact.importSnapshot throws ImportConflictError on content mismatch', async () => {
            const dir = mkdtempSync(join(tmpdir(), 'wave-a4-import-artifact-conflict-'));
            try {
                const store = new LocalArtifactStore(dir);
                const base = {
                    id: '88888888-8888-8888-8888-888888888888',
                    filename: 'original.bin',
                    contentHash,
                    mimeType: 'application/octet-stream',
                    sizeBytes: content.length,
                    version: 1,
                    storagePath: join(dir, 'content', contentHash),
                    ingestedAt: '2026-05-27T00:00:00.000Z',
                    owner: 'artifact' as const,
                };
                await store.importSnapshot(base, content);
                const tampered = { ...base, filename: 'tampered.bin' };
                await expect(
                    store.importSnapshot(tampered, content),
                ).rejects.toThrow(ImportConflictError);
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });
    });

    // ─── STORES-B-015 — LedgerStore.trace cycle detection ────────────────
    //
    // Pre-fix LocalLedgerStore.trace() walked parentEventId without cycle
    // detection. A tampered ledger where A→B→A produced an infinite loop.
    // Fix: track visited ids in a Set; on revisit throw
    // LedgerCycleDetectedError so corrupted ledgers are loud, not silent.

    describe('STORES-B-015 — trace cycle detection', () => {
        it('throws LedgerCycleDetectedError when parentEventId forms a cycle (A→B→A)', async () => {
            const dir = mkdtempSync(join(tmpdir(), 'wave-a4-trace-cycle-'));
            try {
                const store = new LocalLedgerStore(dir);

                // Append two real events first.
                const a = await store.append({
                    action: 'entity_created',
                    actorId: 'op',
                    subjectId: 'subj-A',
                    subjectStore: 'canonical',
                    detail: {},
                });
                const b = await store.append({
                    action: 'entity_updated',
                    actorId: 'op',
                    subjectId: 'subj-A',
                    subjectStore: 'canonical',
                    detail: {},
                    parentEventId: a.id,
                });

                // Now poison the chain: make A's parent point back to B,
                // creating A→B→A. Mutate via the private events array — this
                // simulates an on-disk tamper that load() would happily parse.
                const eventsArr = (store as unknown as { events: ProvenanceEvent[] }).events;
                const indexOfA = eventsArr.findIndex((e) => e.id === a.id);
                expect(indexOfA).toBeGreaterThan(-1);
                eventsArr[indexOfA] = { ...eventsArr[indexOfA], parentEventId: b.id };

                // trace(b.id) walks b → a → b → a → ... pre-fix. Post-fix it
                // detects the revisit and throws.
                await expect(store.trace(b.id)).rejects.toThrow(LedgerCycleDetectedError);
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });

        it('throws LedgerCycleDetectedError when an event points at itself (self-cycle)', async () => {
            const dir = mkdtempSync(join(tmpdir(), 'wave-a4-trace-self-cycle-'));
            try {
                const store = new LocalLedgerStore(dir);
                const a = await store.append({
                    action: 'entity_created',
                    actorId: 'op',
                    subjectId: 'subj-S',
                    subjectStore: 'canonical',
                    detail: {},
                });
                // Poison: a.parentEventId = a.id
                const eventsArr = (store as unknown as { events: ProvenanceEvent[] }).events;
                const idx = eventsArr.findIndex((e) => e.id === a.id);
                eventsArr[idx] = { ...eventsArr[idx], parentEventId: a.id };

                await expect(store.trace(a.id)).rejects.toThrow(LedgerCycleDetectedError);
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });

        it('linear chain A→B→C still traces correctly (no false positive)', async () => {
            const dir = mkdtempSync(join(tmpdir(), 'wave-a4-trace-linear-'));
            try {
                const store = new LocalLedgerStore(dir);
                const a = await store.append({
                    action: 'entity_created',
                    actorId: 'op',
                    subjectId: 'subj-L',
                    subjectStore: 'canonical',
                    detail: {},
                });
                const b = await store.append({
                    action: 'entity_updated',
                    actorId: 'op',
                    subjectId: 'subj-L',
                    subjectStore: 'canonical',
                    detail: {},
                    parentEventId: a.id,
                });
                const c = await store.append({
                    action: 'entity_updated',
                    actorId: 'op',
                    subjectId: 'subj-L',
                    subjectStore: 'canonical',
                    detail: {},
                    parentEventId: b.id,
                });

                const chain = await store.trace(c.id);
                expect(chain).toHaveLength(3);
                expect(chain.map((e) => e.id)).toEqual([c.id, b.id, a.id]);
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });

        it('LedgerCycleDetectedError exposes the visited event-id path for diagnostics', async () => {
            const dir = mkdtempSync(join(tmpdir(), 'wave-a4-trace-cycle-path-'));
            try {
                const store = new LocalLedgerStore(dir);
                const a = await store.append({
                    action: 'entity_created',
                    actorId: 'op',
                    subjectId: 'subj-D',
                    subjectStore: 'canonical',
                    detail: {},
                });
                const b = await store.append({
                    action: 'entity_updated',
                    actorId: 'op',
                    subjectId: 'subj-D',
                    subjectStore: 'canonical',
                    detail: {},
                    parentEventId: a.id,
                });
                const eventsArr = (store as unknown as { events: ProvenanceEvent[] }).events;
                const idx = eventsArr.findIndex((e) => e.id === a.id);
                eventsArr[idx] = { ...eventsArr[idx], parentEventId: b.id };

                try {
                    await store.trace(b.id);
                    expect.fail('expected LedgerCycleDetectedError');
                } catch (err) {
                    expect(err).toBeInstanceOf(LedgerCycleDetectedError);
                    const cycle = (err as LedgerCycleDetectedError).eventIds;
                    expect(Array.isArray(cycle)).toBe(true);
                    expect(cycle.length).toBeGreaterThan(0);
                    // The repeat element MUST be in the path.
                    expect(cycle.some((id) => id === a.id || id === b.id)).toBe(true);
                }
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });
    });
});
