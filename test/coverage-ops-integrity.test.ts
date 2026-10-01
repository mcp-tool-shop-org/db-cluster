/**
 * Coverage — ops/integrity-checks: the shared checks behind doctor() and
 * verify(). Each check is driven into every status it can report, using real
 * local stores with individual methods overlaid, or hand-built record sets
 * for the pure chain function.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLocalCluster } from '../src/adapters/local/index.js';
import { ClusterKernel } from '../src/kernel/cluster-kernel.js';
import {
    checkIntegrityChain,
    checkArtifactContentIntegrity,
    checkLedgerIntegrityChain,
    checkCommandReceiptBijection,
    checkProvenanceReferencesValid,
    checkReceiptsProvenanceValid,
    sha256Hex,
} from '../src/ops/integrity-checks.js';
import type { IntegrityRecord } from '../src/ops/integrity-checks.js';
import type { ClusterStores } from '../src/contracts/index.js';
import type { Command } from '../src/types/command.js';

const ACTOR = 'operator';

function overlay<T extends object>(target: T, overrides: Record<string, unknown>): T {
    return new Proxy(target, {
        get(t, prop) {
            if (typeof prop === 'string' && prop in overrides) return overrides[prop];
            const value = Reflect.get(t, prop, t);
            return typeof value === 'function' ? value.bind(t) : value;
        },
    });
}

function committedCommand(id: string, status: Command['status'] = 'committed'): Command {
    return {
        id, verb: 'create_entity', targetStore: 'canonical', payload: {},
        proposedAt: new Date().toISOString(), proposedBy: ACTOR, status,
    };
}

describe('sha256Hex / checkIntegrityChain', () => {
    let dir: string;
    let stores: ClusterStores;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'cov-integrity-chain-'));
        stores = createLocalCluster(dir);
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('sha256Hex matches the known digest of an empty buffer', () => {
        expect(sha256Hex(Buffer.alloc(0))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    });

    it('accepts an untouched ledger and skips records that carry no integrityHash', async () => {
        for (const n of [1, 2, 3]) {
            await stores.ledger.append({ action: 'note', actorId: ACTOR, subjectId: `s${n}`, subjectStore: 'canonical', detail: { n } });
        }
        const events = (await stores.ledger.listEvents({})) as unknown as IntegrityRecord[];
        expect(checkIntegrityChain(events, 'event')).toEqual([]);

        // A legacy, unstamped record in the middle is skipped, not flagged.
        const legacy: IntegrityRecord = { id: 'legacy-1' };
        expect(checkIntegrityChain([events[0], legacy, events[1], events[2]], 'event')).toEqual([]);
    });

    it('flags an edited record and a reordered chain with distinct messages', async () => {
        for (const n of [1, 2, 3]) {
            await stores.ledger.append({ action: 'note', actorId: ACTOR, subjectId: `s${n}`, subjectStore: 'canonical', detail: { n } });
        }
        const events = (await stores.ledger.listEvents({})) as unknown as IntegrityRecord[];

        const edited = JSON.parse(JSON.stringify(events)) as IntegrityRecord[];
        (edited[1] as { detail: { n: number } }).detail.n = 999;
        const editedIssues = checkIntegrityChain(edited, 'event');
        expect(editedIssues).toHaveLength(1);
        expect(editedIssues[0]).toContain(`event ${events[1].id}: stored integrityHash does not match recomputed hash`);

        const dropped = [events[0], events[2]];
        const reorderIssues = checkIntegrityChain(dropped, 'receipt');
        expect(reorderIssues).toHaveLength(1);
        expect(reorderIssues[0]).toContain(`receipt ${events[2].id}: prevHash does not match the preceding record's integrityHash`);
    });
});

describe('checkArtifactContentIntegrity()', () => {
    let dir: string;
    let stores: ClusterStores;
    let kernel: ClusterKernel;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'cov-integrity-art-'));
        stores = createLocalCluster(dir);
        kernel = new ClusterKernel(stores);
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    async function ingest(name: string) {
        return (await kernel.ingestArtifact({
            filename: name, content: Buffer.from(`body of ${name}`), mimeType: 'text/plain', actorId: ACTOR,
        })).artifact;
    }

    it('is healthy when every sampled artifact hashes correctly (including an empty store)', async () => {
        expect((await checkArtifactContentIntegrity(stores, 10)).message).toBe('All 0 sampled artifact(s) hash to their recorded contentHash.');
        await ingest('a.txt');
        await ingest('b.txt');
        const check = await checkArtifactContentIntegrity(stores, 10);
        expect(check).toMatchObject({ name: 'artifact_content_integrity', status: 'healthy', severity: 'info' });
        expect(check.message).toBe('All 2 sampled artifact(s) hash to their recorded contentHash.');
    });

    it('reports tampered content as corrupt and names the affected artifacts (capped at five)', async () => {
        const arts = [];
        for (let i = 0; i < 7; i++) arts.push(await ingest(`f${i}.txt`));
        const tamper = overlay(stores.artifact, { getContent: async () => Buffer.from('wrong bytes') });
        const check = await checkArtifactContentIntegrity({ ...stores, artifact: tamper }, 100);
        expect(check.status).toBe('corrupt');
        expect(check.severity).toBe('error');
        expect(check.message).toContain('7 artifact(s) have on-disk content that does not hash');
        const listed = check.message.split('Affected: ')[1].replace(/\.$/, '').split(', ');
        expect(listed).toHaveLength(5);
        expect(listed.every((id) => arts.some((a) => a.id === id))).toBe(true);
        expect(check.suggestedCommand).toBe('db-cluster restore <backup.json>');
    });

    it('reports artifacts whose content is missing as corrupt with a distinct message', async () => {
        const a = await ingest('gone.txt');
        const gone = overlay(stores.artifact, { getContent: async () => null });
        const check = await checkArtifactContentIntegrity({ ...stores, artifact: gone }, 100);
        expect(check.status).toBe('corrupt');
        expect(check.message).toContain('1 artifact(s) have metadata but missing content bytes');
        expect(check.message).toContain(a.id);
    });

    it('counts a throwing content read as tampered and records the error name', async () => {
        const a = await ingest('throws.txt');
        const throwing = overlay(stores.artifact, {
            getContent: async () => {
                const e = new Error('hash mismatch on read');
                e.name = 'ContentReadIntegrityError';
                throw e;
            },
        });
        const check = await checkArtifactContentIntegrity({ ...stores, artifact: throwing }, 100);
        expect(check.status).toBe('corrupt');
        expect(check.message).toContain(`${a.id} (ContentReadIntegrityError)`);
    });

    it('reports unreachable when the artifact listing itself fails', async () => {
        const broken = overlay(stores.artifact, { list: async () => { throw new Error('listing failed'); } });
        const check = await checkArtifactContentIntegrity({ ...stores, artifact: broken }, 100);
        expect(check).toMatchObject({ status: 'unreachable', severity: 'error' });
        expect(check.message).toBe('Artifact content integrity verification failed: listing failed');
    });
});

describe('checkLedgerIntegrityChain()', () => {
    let dir: string;
    let stores: ClusterStores;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'cov-integrity-ledger-'));
        stores = createLocalCluster(dir);
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('is healthy for an intact ledger and for an empty one', async () => {
        const empty = await checkLedgerIntegrityChain(stores);
        expect(empty.status).toBe('healthy');
        expect(empty.message).toContain('0 event(s) + 0 receipt(s)');

        const ev = await stores.ledger.append({ action: 'a', actorId: ACTOR, subjectId: 's', subjectStore: 'canonical', detail: {} });
        await stores.ledger.appendReceipt({ commandId: 'c1', resultSummary: 'r', affectedIds: [], provenanceEventId: ev.id });
        const check = await checkLedgerIntegrityChain(stores);
        expect(check.status).toBe('healthy');
        expect(check.message).toContain('1 event(s) + 1 receipt(s)');
    });

    it('reports a tampered record as corrupt with details', async () => {
        await stores.ledger.append({ action: 'a', actorId: ACTOR, subjectId: 's', subjectStore: 'canonical', detail: { v: 1 } });
        const real = await stores.ledger.listEvents({});
        const edited = JSON.parse(JSON.stringify(real));
        edited[0].detail.v = 2;
        const ledger = overlay(stores.ledger, { listEvents: async () => edited });
        const check = await checkLedgerIntegrityChain({ ...stores, ledger });
        expect(check.status).toBe('corrupt');
        expect(check.message).toContain('1 ledger integrity violation(s) detected');
        expect(check.details).toContain(`event ${real[0].id}: stored integrityHash does not match`);
        expect(check.suggestedCommand).toBe('db-cluster restore <backup.json>');
    });

    it('reports unverified when records exist but none carries an integrityHash', async () => {
        const unstamped = [{
            id: 'e1', timestamp: new Date().toISOString(), action: 'a', actorId: ACTOR,
            subjectId: 's', subjectStore: 'canonical', detail: {}, owner: 'ledger',
        }];
        const ledger = overlay(stores.ledger, {
            listEvents: async () => unstamped,
            listReceipts: async () => [],
        });
        const check = await checkLedgerIntegrityChain({ ...stores, ledger });
        expect(check).toMatchObject({ status: 'unverified', severity: 'info' });
        expect(check.message).toContain('no record carries an integrityHash');
    });

    it('reports corrupt when the ledger cannot be read at all', async () => {
        const ledger = overlay(stores.ledger, { listEvents: async () => { throw new Error('events.json truncated'); } });
        const check = await checkLedgerIntegrityChain({ ...stores, ledger });
        expect(check.status).toBe('corrupt');
        expect(check.message).toBe('Ledger integrity verification failed (tamper or corruption): events.json truncated');
    });
});

describe('checkCommandReceiptBijection()', () => {
    let dir: string;
    let stores: ClusterStores;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'cov-integrity-bij-'));
        stores = createLocalCluster(dir);
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    async function receipt(commandId: string) {
        const ev = await stores.ledger.append({ action: 'a', actorId: ACTOR, subjectId: 's', subjectStore: 'canonical', detail: {} });
        return stores.ledger.appendReceipt({ commandId, resultSummary: 'r', affectedIds: [], provenanceEventId: ev.id });
    }

    it('is healthy when each committed or compensated command has exactly one receipt', async () => {
        await receipt('c1');
        await receipt('c2');
        const queue = { list: () => [committedCommand('c1'), committedCommand('c2', 'compensated'), committedCommand('c3', 'proposed')] };
        const check = await checkCommandReceiptBijection(stores, queue);
        expect(check.status).toBe('healthy');
        expect(check.message).toContain('2 committed command(s) each map to exactly one receipt and all 2 receipt(s)');
    });

    it('reports orphan receipts, receipt-less commands and duplicated receipts together', async () => {
        const orphan = await receipt('no-such-command');
        await receipt('dup');
        await receipt('dup');
        const queue = { list: () => [committedCommand('lonely'), committedCommand('dup')] };
        const check = await checkCommandReceiptBijection(stores, queue);
        expect(check.status).toBe('corrupt');
        expect(check.message).toContain('1 orphan receipt(s) whose commandId resolves to no committed command');
        expect(check.message).toContain(orphan.id);
        expect(check.message).toContain('1 committed command(s) with no receipt (e.g. lonely)');
        expect(check.message).toContain('1 committed command(s) with more than one receipt (e.g. dup)');
        expect(check.suggestedCommand).toBe('db-cluster receipts --limit 200');
    });

    it('reports a command queue that cannot be read as corrupt with the queue error', async () => {
        const queue = { list: (): Command[] => { throw new Error('queue file locked'); } };
        const check = await checkCommandReceiptBijection(stores, queue);
        expect(check.status).toBe('corrupt');
        expect(check.message).toBe('Command↔receipt bijection verification failed: command queue unreadable: queue file locked');
    });

    it('reports corrupt when the receipts cannot be listed', async () => {
        const ledger = overlay(stores.ledger, { listReceipts: async () => { throw new Error('receipts.json missing'); } });
        const check = await checkCommandReceiptBijection({ ...stores, ledger }, { list: () => [] });
        expect(check.status).toBe('corrupt');
        expect(check.message).toContain('receipts.json missing');
    });
});

describe('provenance reference checks', () => {
    let dir: string;
    let stores: ClusterStores;
    let kernel: ClusterKernel;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'cov-integrity-prov-'));
        stores = createLocalCluster(dir);
        kernel = new ClusterKernel(stores);
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('checkProvenanceReferencesValid: healthy, then stale when an event points at a missing subject, ignoring ledger/index subjects', async () => {
        await kernel.createEntity({ kind: 'note', name: 'real', attributes: {}, actorId: ACTOR });
        expect((await checkProvenanceReferencesValid(stores, 100)).status).toBe('healthy');

        await stores.ledger.append({ action: 'x', actorId: ACTOR, subjectId: 'ledger-subject', subjectStore: 'ledger', detail: {} });
        await stores.ledger.append({ action: 'x', actorId: ACTOR, subjectId: 'index-subject', subjectStore: 'index', detail: {} });
        expect((await checkProvenanceReferencesValid(stores, 100)).status).toBe('healthy');

        await stores.ledger.append({ action: 'x', actorId: ACTOR, subjectId: 'vanished', subjectStore: 'canonical', detail: {} });
        const stale = await checkProvenanceReferencesValid(stores, 100);
        expect(stale).toMatchObject({ status: 'stale', severity: 'warning' });
        expect(stale.message).toBe('1 provenance event(s) reference objects not found in canonical/artifact stores.');
        expect(stale.suggestedCommand).toBe('db-cluster verify --json');
    });

    it('checkProvenanceReferencesValid: reports unreachable when the ledger cannot be listed', async () => {
        const ledger = overlay(stores.ledger, { listEvents: async () => { throw new Error('ledger gone'); } });
        const check = await checkProvenanceReferencesValid({ ...stores, ledger }, 10);
        expect(check).toMatchObject({ status: 'unreachable', severity: 'error' });
        expect(check.message).toBe('Provenance verification failed: ledger gone');
    });

    it('checkReceiptsProvenanceValid: healthy, stale for a dangling provenanceEventId, unreachable on read failure', async () => {
        const ev = await stores.ledger.append({ action: 'a', actorId: ACTOR, subjectId: 's', subjectStore: 'canonical', detail: {} });
        await stores.ledger.appendReceipt({ commandId: 'c1', resultSummary: 'r', affectedIds: [], provenanceEventId: ev.id });
        expect((await checkReceiptsProvenanceValid(stores, 100)).status).toBe('healthy');

        await stores.ledger.appendReceipt({ commandId: 'c2', resultSummary: 'r', affectedIds: [], provenanceEventId: 'missing-event' });
        const stale = await checkReceiptsProvenanceValid(stores, 100);
        expect(stale).toMatchObject({ status: 'stale', severity: 'warning' });
        expect(stale.message).toBe('1 receipt(s) reference missing provenance events.');
        expect(stale.suggestedCommand).toBe('db-cluster receipts');

        const ledger = overlay(stores.ledger, { listReceipts: async () => { throw new Error('receipts unreadable'); } });
        const broken = await checkReceiptsProvenanceValid({ ...stores, ledger }, 100);
        expect(broken).toMatchObject({ status: 'unreachable', severity: 'error' });
        expect(broken.message).toBe('Receipt verification failed: receipts unreadable');
    });
});
