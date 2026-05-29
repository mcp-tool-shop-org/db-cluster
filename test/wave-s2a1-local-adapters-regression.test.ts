import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalArtifactStore } from '../src/adapters/local/local-artifact-store.js';
import { LocalCanonicalStore } from '../src/adapters/local/local-canonical-store.js';
import {
    LocalLedgerStore,
    ROTATE_MARKER_FILENAME,
} from '../src/adapters/local/local-ledger-store.js';
import {
    ContentReadIntegrityError,
    LedgerIntegrityError,
} from '../src/adapters/local/errors.js';
import { computeIntegrityHash } from '../src/types/integrity.js';

/**
 * Wave S2-A1 (Protocol-v2 amend) — Fix Agent 2: local adapters.
 *
 * Each finding probes the FULL invariant (both halves): the happy path that
 * must keep working AND the tamper/failure path that must now be caught.
 *
 * Findings:
 *  - PROV-001 — LocalArtifactStore.getContent re-hashes on-disk bytes and
 *    throws ContentReadIntegrityError when they no longer match contentHash.
 *  - PROV-004 — LocalLedgerStore stamps integrityHash + prevHash (two separate
 *    chains: events file, receipts file) on every write, and verifies on read
 *    (getEvent / getReceipt throw LedgerIntegrityError on tamper).
 *  - PROV-006 — LocalLedgerStore.rotate() is atomic across BOTH files via a
 *    crash-recovery marker; a partial rotation is completed/rolled back on the
 *    next load with NO events silently dropped.
 *  - PROV-002 — LocalCanonicalStore is append-a-version: create stamps v1,
 *    update appends v(N+1) retaining prior versions immutably, get returns the
 *    latest, listVersions/getVersion recover prior truth.
 */

let tmpDir: string;

beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'db-cluster-s2a1-'));
});

afterEach(() => {
    try {
        rmSync(tmpDir, { recursive: true, force: true });
    } catch {
        /* best-effort */
    }
});

describe('PROV-001 — LocalArtifactStore.getContent read-integrity', () => {
    it('returns bytes for an untampered artifact, then THROWS ContentReadIntegrityError once the on-disk blob is rewritten', async () => {
        const dir = join(tmpDir, 'artifact');
        const store = new LocalArtifactStore(dir);
        const body = Buffer.from('the original, authentic artifact bytes');
        const artifact = await store.ingest({
            filename: 'doc.md',
            content: body,
            mimeType: 'text/markdown',
        });

        // Half 1 (happy path preserved): untampered getContent returns the bytes.
        const ok = await store.getContent(artifact.id);
        expect(ok).not.toBeNull();
        expect(Buffer.compare(ok!, body)).toBe(0);

        // Tamper: rewrite the on-disk content blob in place (same path, new bytes).
        // The content file is addressed by contentHash under <dir>/content/.
        const blobPath = join(dir, 'content', artifact.contentHash);
        writeFileSync(blobPath, Buffer.from('tampered bytes — different content entirely'));

        // Half 2 (integrity enforced): a NEW store instance (so nothing is cached
        // around the read) must THROW rather than hand back the altered bytes.
        const reopened = new LocalArtifactStore(dir);
        await expect(reopened.getContent(artifact.id)).rejects.toBeInstanceOf(
            ContentReadIntegrityError,
        );

        // The typed error carries the artifact id + expected/actual hash and a
        // remediation hint, and must NOT leak the absolute storage path.
        try {
            await reopened.getContent(artifact.id);
            throw new Error('expected getContent to throw');
        } catch (err) {
            const e = err as ContentReadIntegrityError;
            expect(e).toBeInstanceOf(ContentReadIntegrityError);
            expect(e.artifactId).toBe(artifact.id);
            expect(e.expectedHash).toBe(artifact.contentHash);
            const actual = createHash('sha256')
                .update(readFileSync(blobPath))
                .digest('hex');
            expect(e.actualHash).toBe(actual);
            expect(typeof e.remediationHint).toBe('string');
            expect(e.remediationHint.length).toBeGreaterThan(0);
            // No absolute storagePath in the message (use the contentHash instead).
            expect(e.message).not.toContain(blobPath);
            expect(e.message).toContain(artifact.contentHash);
        }
    });
});

describe('PROV-004 — LocalLedgerStore integrityHash + prevHash chain + verify-on-read', () => {
    it('stamps a verifying integrityHash and a prevHash chain on appended events, and getEvent THROWS once a persisted event is hand-edited', async () => {
        const dir = join(tmpDir, 'ledger');
        const store = new LocalLedgerStore(dir);

        const e1 = await store.append({
            action: 'entity_created',
            actorId: 'tester',
            subjectId: 'subj-1',
            subjectStore: 'canonical',
            detail: { note: 'first' },
        });
        const e2 = await store.append({
            action: 'entity_updated',
            actorId: 'tester',
            subjectId: 'subj-1',
            subjectStore: 'canonical',
            detail: { note: 'second' },
        });

        // Half 1a: integrityHash present and self-consistent.
        expect(typeof e1.integrityHash).toBe('string');
        expect(e1.integrityHash).toHaveLength(64);
        expect(e1.integrityHash).toBe(computeIntegrityHash(e1 as unknown as Record<string, unknown>));
        // Genesis event has no predecessor.
        expect(e1.prevHash).toBeUndefined();
        // Half 1b: prevHash chains record N+1 to record N.
        expect(e2.prevHash).toBe(e1.integrityHash);
        expect(e2.integrityHash).toBe(computeIntegrityHash(e2 as unknown as Record<string, unknown>));

        // Verify-on-read accepts untampered records.
        const readBack = await store.getEvent(e2.id);
        expect(readBack).not.toBeNull();
        expect(readBack!.integrityHash).toBe(e2.integrityHash);

        // Tamper: hand-edit a persisted event line on disk (change detail) WITHOUT
        // recomputing the hash — exactly the attack tamper-evidence must catch.
        const eventsPath = join(dir, 'events.json');
        const lines = readFileSync(eventsPath, 'utf-8').split('\n').filter((l) => l.trim().length > 0);
        const idx = lines.findIndex((l) => (JSON.parse(l) as { id: string }).id === e2.id);
        expect(idx).toBeGreaterThanOrEqual(0);
        const tampered = JSON.parse(lines[idx]) as Record<string, unknown>;
        (tampered.detail as Record<string, unknown>).note = 'MUTATED';
        lines[idx] = JSON.stringify(tampered);
        writeFileSync(eventsPath, lines.join('\n') + '\n');

        // Half 2: a fresh store reading the tampered event THROWS.
        const reopened = new LocalLedgerStore(dir);
        await expect(reopened.getEvent(e2.id)).rejects.toBeInstanceOf(LedgerIntegrityError);
    });

    it('stamps + chains receipts independently of events, and getReceipt THROWS on a hand-edited resultSummary', async () => {
        const dir = join(tmpDir, 'ledger');
        const store = new LocalLedgerStore(dir);

        // Interleave an event so we prove receipts chain on their OWN file, not
        // against the events file.
        await store.append({
            action: 'noise',
            actorId: 'tester',
            subjectId: 's',
            subjectStore: 'ledger',
            detail: {},
        });
        const r1 = await store.appendReceipt({
            commandId: 'cmd-1',
            resultSummary: 'created subj-1',
            affectedIds: ['subj-1'],
            provenanceEventId: 'pe-1',
        });
        const r2 = await store.appendReceipt({
            commandId: 'cmd-2',
            resultSummary: 'updated subj-1',
            affectedIds: ['subj-1'],
            provenanceEventId: 'pe-2',
        });

        expect(r1.integrityHash).toHaveLength(64);
        expect(r1.integrityHash).toBe(computeIntegrityHash(r1 as unknown as Record<string, unknown>));
        expect(r1.prevHash).toBeUndefined(); // genesis of the receipts chain
        expect(r2.prevHash).toBe(r1.integrityHash);
        expect(r2.integrityHash).toBe(computeIntegrityHash(r2 as unknown as Record<string, unknown>));

        // Untampered read verifies.
        const ok = await store.getReceipt(r2.id);
        expect(ok!.integrityHash).toBe(r2.integrityHash);

        // Tamper the persisted receipt's resultSummary.
        const receiptsPath = join(dir, 'receipts.json');
        const lines = readFileSync(receiptsPath, 'utf-8')
            .split('\n')
            .filter((l) => l.trim().length > 0);
        const idx = lines.findIndex((l) => (JSON.parse(l) as { id: string }).id === r2.id);
        const tampered = JSON.parse(lines[idx]) as Record<string, unknown>;
        tampered.resultSummary = 'FRAUDULENT SUMMARY';
        lines[idx] = JSON.stringify(tampered);
        writeFileSync(receiptsPath, lines.join('\n') + '\n');

        const reopened = new LocalLedgerStore(dir);
        await expect(reopened.getReceipt(r2.id)).rejects.toBeInstanceOf(LedgerIntegrityError);
    });

    it('preserves the chain across a store reload (re-read of a genuine ledger does NOT false-alarm)', async () => {
        const dir = join(tmpDir, 'ledger');
        const store = new LocalLedgerStore(dir);
        const a = await store.append({
            action: 'a',
            actorId: 't',
            subjectId: 's',
            subjectStore: 'ledger',
            detail: {},
        });
        const b = await store.append({
            action: 'b',
            actorId: 't',
            subjectId: 's',
            subjectStore: 'ledger',
            detail: {},
        });
        const reopened = new LocalLedgerStore(dir);
        const ra = await reopened.getEvent(a.id);
        const rb = await reopened.getEvent(b.id);
        expect(ra!.integrityHash).toBe(a.integrityHash);
        expect(rb!.prevHash).toBe(ra!.integrityHash);
    });
});

describe('PROV-006 — LocalLedgerStore.rotate() atomic across both files', () => {
    it('does not drop events on the happy path (archived + retained account for every original record)', async () => {
        const dir = join(tmpDir, 'ledger');
        const store = new LocalLedgerStore(dir);

        // Two "old" events/receipts and one "new" each, split by a boundary.
        const old1 = await store.append({
            action: 'old1',
            actorId: 't',
            subjectId: 's',
            subjectStore: 'ledger',
            detail: {},
        });
        await store.appendReceipt({
            commandId: 'c-old',
            resultSummary: 'old receipt',
            affectedIds: [],
            provenanceEventId: old1.id,
        });
        // Boundary AFTER the old records, BEFORE the new ones.
        const boundary = new Date(Date.now() + 1).toISOString();
        // Ensure a wall-clock gap so the new records sort strictly after boundary.
        await new Promise((r) => setTimeout(r, 5));
        const new1 = await store.append({
            action: 'new1',
            actorId: 't',
            subjectId: 's',
            subjectStore: 'ledger',
            detail: {},
        });

        const result = await store.rotate(boundary);
        expect(result.archived).toBeGreaterThanOrEqual(1);

        // The new event is still live and still verifies.
        const stillThere = await store.getEvent(new1.id);
        expect(stillThere).not.toBeNull();

        // Nothing was lost: the archive dir holds the archived events; active
        // holds the retained. Sum of archived events on disk + active events
        // equals the original two events.
        const archiveDir = join(dir, 'ledger-archive');
        const archivedEventLines = readdirSync(archiveDir)
            .filter((f) => f.startsWith('events-') && f.endsWith('.ndjson'))
            .flatMap((f) =>
                readFileSync(join(archiveDir, f), 'utf-8')
                    .split('\n')
                    .filter((l) => l.trim().length > 0),
            );
        const activeEventLines = readFileSync(join(dir, 'events.json'), 'utf-8')
            .split('\n')
            .filter((l) => l.trim().length > 0);
        expect(archivedEventLines.length + activeEventLines.length).toBe(2);
    });

    it('recovers a crashed (partial) rotation on next load via the marker, dropping NO events', async () => {
        const dir = join(tmpDir, 'ledger');
        const store = new LocalLedgerStore(dir);

        // Seed three events; we will rotate the oldest two.
        const e1 = await store.append({
            action: 'e1',
            actorId: 't',
            subjectId: 's',
            subjectStore: 'ledger',
            detail: {},
        });
        await new Promise((r) => setTimeout(r, 3));
        const e2 = await store.append({
            action: 'e2',
            actorId: 't',
            subjectId: 's',
            subjectStore: 'ledger',
            detail: {},
        });
        await new Promise((r) => setTimeout(r, 3));
        const boundary = new Date().toISOString();
        await new Promise((r) => setTimeout(r, 3));
        const e3 = await store.append({
            action: 'e3',
            actorId: 't',
            subjectId: 's',
            subjectStore: 'ledger',
            detail: {},
        });

        // Simulate a CRASH mid-rotate: the active events file got rewritten to the
        // retained slice, the events archive landed, BUT the receipts side never
        // completed and the in-progress marker is still on disk. We reconstruct
        // exactly that on-disk state, then assert a fresh store recovers it
        // WITHOUT losing e1/e2 (they must be reachable in the archive) and with a
        // consistent active set (e3 only).
        const eventsPath = join(dir, 'events.json');
        const allLines = readFileSync(eventsPath, 'utf-8')
            .split('\n')
            .filter((l) => l.trim().length > 0);
        const lineFor = (id: string) =>
            allLines.find((l) => (JSON.parse(l) as { id: string }).id === id)!;
        const retained = [lineFor(e3.id)];
        const archived = [lineFor(e1.id), lineFor(e2.id)];

        // Write the archive that the (interrupted) rotate had already produced.
        const archiveDir = join(dir, 'ledger-archive');
        const { mkdirSync } = await import('node:fs');
        mkdirSync(archiveDir, { recursive: true });
        const archiveEventsPath = join(archiveDir, 'events-crashtest.ndjson');
        writeFileSync(archiveEventsPath, archived.join('\n') + '\n');

        // Active events rewritten to retained slice (the crash happened AFTER the
        // events rename but BEFORE receipts completion).
        writeFileSync(eventsPath, retained.join('\n') + '\n');

        // Drop the in-progress marker naming what was being rotated. The recovery
        // routine must read this and finish/verify the rotation deterministically.
        const markerPath = join(dir, ROTATE_MARKER_FILENAME);
        writeFileSync(
            markerPath,
            JSON.stringify({
                archiveId: 'crashtest',
                eventsArchivePath: archiveEventsPath,
                receiptsArchivePath: join(archiveDir, 'receipts-crashtest.ndjson'),
            }),
        );

        // Recover: constructing a new store must clear the marker and leave a
        // consistent ledger with NO dropped events.
        const recovered = new LocalLedgerStore(dir);

        // Marker must be gone after recovery.
        const afterFiles = readdirSync(dir);
        expect(afterFiles).not.toContain(ROTATE_MARKER_FILENAME);

        // e3 is live and verifies (no false integrity alarm).
        const liveE3 = await recovered.getEvent(e3.id);
        expect(liveE3).not.toBeNull();
        expect(liveE3!.id).toBe(e3.id);

        // e1 + e2 were NOT silently dropped: the archive still holds them.
        const archivedAfter = readdirSync(archiveDir)
            .filter((f) => f.startsWith('events-') && f.endsWith('.ndjson'))
            .flatMap((f) =>
                readFileSync(join(archiveDir, f), 'utf-8')
                    .split('\n')
                    .filter((l) => l.trim().length > 0)
                    .map((l) => (JSON.parse(l) as { id: string }).id),
            );
        expect(archivedAfter).toContain(e1.id);
        expect(archivedAfter).toContain(e2.id);

        // Total events accounted for across active + archive == 3 (none lost).
        const activeAfter = readFileSync(eventsPath, 'utf-8')
            .split('\n')
            .filter((l) => l.trim().length > 0)
            .map((l) => (JSON.parse(l) as { id: string }).id);
        const union = new Set([...activeAfter, ...archivedAfter]);
        expect(union.size).toBe(3);
        expect(union.has(e1.id)).toBe(true);
        expect(union.has(e2.id)).toBe(true);
        expect(union.has(e3.id)).toBe(true);
    });
});

describe('PROV-002 — LocalCanonicalStore append-a-version', () => {
    it('create stamps v1; two updates append v2/v3; get returns latest; listVersions/getVersion recover prior truth', async () => {
        const dir = join(tmpDir, 'canonical');
        const store = new LocalCanonicalStore(dir);

        const v1 = await store.create({
            kind: 'person',
            name: 'Alice',
            attributes: { role: 'engineer' },
        });
        expect(v1.version).toBe(1);

        const v2 = await store.update(v1.id, { name: 'Alice B.' });
        expect(v2.version).toBe(2);
        const v3 = await store.update(v1.id, { attributes: { role: 'staff' } });
        expect(v3.version).toBe(3);

        // get returns the LATEST version.
        const latest = await store.get(v1.id);
        expect(latest!.version).toBe(3);
        expect(latest!.name).toBe('Alice B.');
        expect(latest!.attributes).toEqual({ role: 'staff' });

        // listVersions returns all three, ascending.
        const versions = await store.listVersions(v1.id);
        expect(versions.map((e) => e.version)).toEqual([1, 2, 3]);

        // getVersion(id, 1) recovers the ORIGINAL truth — prior versions immutable.
        const original = await store.getVersion(v1.id, 1);
        expect(original!.name).toBe('Alice');
        expect(original!.attributes).toEqual({ role: 'engineer' });
        // v2 retained its own intermediate truth.
        const mid = await store.getVersion(v1.id, 2);
        expect(mid!.name).toBe('Alice B.');
        expect(mid!.attributes).toEqual({ role: 'engineer' }); // attributes not yet patched at v2

        // Unknown id → [] / null.
        expect(await store.listVersions('nope')).toEqual([]);
        expect(await store.getVersion('nope', 1)).toBeNull();
        expect(await store.getVersion(v1.id, 99)).toBeNull();

        // exists is true for any version present.
        expect(await store.exists(v1.id)).toBe(true);

        // list() returns the LATEST of each entity (one row per id).
        const listed = await store.list();
        expect(listed).toHaveLength(1);
        expect(listed[0].version).toBe(3);
    });

    it('persists ALL versions and reconstructs them across a reload', async () => {
        const dir = join(tmpDir, 'canonical');
        const store = new LocalCanonicalStore(dir);
        const v1 = await store.create({ kind: 'doc', name: 'Spec', attributes: { n: 1 } });
        await store.update(v1.id, { attributes: { n: 2 } });
        await store.update(v1.id, { attributes: { n: 3 } });

        const reopened = new LocalCanonicalStore(dir);
        const versions = await reopened.listVersions(v1.id);
        expect(versions.map((e) => e.version)).toEqual([1, 2, 3]);
        expect((await reopened.get(v1.id))!.version).toBe(3);
        expect((await reopened.getVersion(v1.id, 1))!.attributes).toEqual({ n: 1 });
    });

    it('importSnapshot preserves incoming version, defaulting to 1 when absent (legacy backup)', async () => {
        const dir = join(tmpDir, 'canonical');
        const store = new LocalCanonicalStore(dir);

        // Snapshot carrying an explicit version=5 must be preserved.
        const now = new Date().toISOString();
        const imported = await store.importSnapshot({
            id: 'ent-import-1',
            kind: 'thing',
            name: 'Imported',
            attributes: {},
            version: 5,
            createdAt: now,
            updatedAt: now,
            owner: 'canonical',
        });
        expect(imported.version).toBe(5);
        expect((await store.get('ent-import-1'))!.version).toBe(5);
        expect(await store.getVersion('ent-import-1', 5)).not.toBeNull();

        // Legacy backup with no version field → default to 1.
        const legacy = {
            id: 'ent-legacy-1',
            kind: 'thing',
            name: 'Legacy',
            attributes: {},
            createdAt: now,
            updatedAt: now,
            owner: 'canonical',
        } as unknown as Parameters<typeof store.importSnapshot>[0];
        const importedLegacy = await store.importSnapshot(legacy);
        expect(importedLegacy.version).toBe(1);
        expect((await store.get('ent-legacy-1'))!.version).toBe(1);
    });
});
