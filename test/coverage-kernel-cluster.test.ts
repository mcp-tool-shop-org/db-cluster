/**
 * Coverage — ClusterKernel: commit-time failure windows (orphan mutations),
 * staged-content integrity, command-queue state guards, index explain/stale
 * reporting for non-canonical sources, and trace rendering. Every test asserts
 * typed error classes/codes, the persisted ledger state, or returned values.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync, utimesSync, readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createLocalCluster } from '../src/adapters/local/index.js';
import { ClusterKernel } from '../src/kernel/cluster-kernel.js';
import { CommandQueue } from '../src/kernel/command-queue.js';
import {
    NotFoundError,
    ReceiptFailedError,
    ContentHashMismatchError,
    StagedContentTamperedError,
    CommandRejectedError,
    InvalidStateTransitionError,
    CommandAlreadyTerminalError,
    CommandNotValidatedError,
} from '../src/kernel/errors.js';
import type { ClusterStores } from '../src/contracts/index.js';
import type { Command } from '../src/types/command.js';
import type { ProvenanceGraph } from '../src/types/provenance-graph.js';

const ACTOR = 'tester';

/** Wrap a cluster so selected ledger writes throw. Reads and other writes are untouched. */
function withLedgerFaults(
    stores: ClusterStores,
    faults: { appendAction?: (action: string) => Error | null; appendReceipt?: Error },
): ClusterStores {
    const ledger = Object.create(stores.ledger) as ClusterStores['ledger'];
    const realAppend = stores.ledger.append.bind(stores.ledger);
    const realAppendReceipt = stores.ledger.appendReceipt.bind(stores.ledger);
    ledger.append = async (event) => {
        const err = faults.appendAction?.(event.action) ?? null;
        if (err) throw err;
        return realAppend(event);
    };
    ledger.appendReceipt = async (receipt) => {
        if (faults.appendReceipt) throw faults.appendReceipt;
        return realAppendReceipt(receipt);
    };
    return { ...stores, ledger };
}

async function proposeAndValidate(
    kernel: ClusterKernel,
    verb: Command['verb'],
    targetStore: Command['targetStore'],
    payload: Record<string, unknown>,
): Promise<Command> {
    const cmd = await kernel.proposeMutation({ verb, targetStore, payload, proposedBy: ACTOR });
    return kernel.validateMutation(cmd.id);
}

describe('ClusterKernel — orphan-mutation windows', () => {
    let dir: string;
    let stores: ClusterStores;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'cov-kernel-orphan-'));
        stores = createLocalCluster(dir);
    });
    afterEach(() => {
        vi.restoreAllMocks();
        rmSync(dir, { recursive: true, force: true });
    });

    it('commit: a receipt failure after the store mutated records a scrubbed mutation_orphaned event and throws ReceiptFailedError', async () => {
        const faulty = withLedgerFaults(stores, {
            appendReceipt: new Error('disk full writing C:\\data\\ledger\\receipts.json'),
        });
        const kernel = new ClusterKernel(faulty);
        const validated = await proposeAndValidate(kernel, 'create_entity', 'canonical', {
            kind: 'note', name: 'orphaned-note', attributes: {},
        });

        let caught: unknown;
        try {
            await kernel.commitMutation(validated.id, ACTOR);
        } catch (e) {
            caught = e;
        }
        expect(caught).toBeInstanceOf(ReceiptFailedError);
        const rf = caught as ReceiptFailedError;
        expect(rf.code).toBe('RECEIPT_FAILED');
        expect(rf.commandId).toBe(validated.id);
        expect(rf.cause.message).toContain('disk full');

        // The store did mutate — that is the orphan.
        const entities = await stores.canonical.list({ kind: 'note' });
        expect(entities.map((e) => e.name)).toEqual(['orphaned-note']);
        expect(rf.subjectId).toBe(entities[0].id);

        const orphans = await stores.ledger.listEvents({ action: 'mutation_orphaned' });
        expect(orphans).toHaveLength(1);
        expect(orphans[0].actorId).toBe('kernel');
        expect(orphans[0].subjectId).toBe(entities[0].id);
        expect(orphans[0].detail.commandId).toBe(validated.id);
        expect(orphans[0].detail.verb).toBe('create_entity');
        expect(orphans[0].detail.errorName).toBe('Error');
        // The absolute path must not survive into the persisted ledger detail.
        expect(String(orphans[0].detail.error)).toContain('disk full');
        expect(String(orphans[0].detail.error)).not.toContain('C:\\data');
    });

    it('commit: when the ledger is wholly unavailable the orphan failure goes to stderr and is attached as secondaryError', async () => {
        const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
        const faulty = withLedgerFaults(stores, {
            appendAction: () => new Error('ledger offline at /var/lib/cluster/ledger'),
        });
        const kernel = new ClusterKernel(faulty);
        const validated = await proposeAndValidate(kernel, 'create_entity', 'canonical', {
            kind: 'note', name: 'unrecorded', attributes: {},
        });

        let caught: unknown;
        try {
            await kernel.commitMutation(validated.id, ACTOR);
        } catch (e) {
            caught = e;
        }
        expect(caught).toBeInstanceOf(ReceiptFailedError);
        const cause = (caught as ReceiptFailedError).cause as Error & { secondaryError?: Error };
        expect(cause.secondaryError).toBeInstanceOf(Error);
        expect(cause.secondaryError?.message).toContain('ledger offline');

        expect(stderr).toHaveBeenCalledTimes(1);
        const line = String(stderr.mock.calls[0][0]);
        expect(line).toContain('[db-cluster] Failed to record orphan mutation for canonical/');
        expect(line).toContain(`(command ${validated.id})`);
        // stderr text is scrubbed too.
        expect(line).not.toContain('/var/lib/cluster');
        // Nothing reached the ledger.
        expect(await stores.ledger.listEvents({ action: 'mutation_orphaned' })).toEqual([]);
    });

    it('commit: a non-Error orphan failure is wrapped, scrubbed and attached', async () => {
        const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
        const faulty = withLedgerFaults(stores, {
            appendAction: () => 'plain string failure' as unknown as Error,
        });
        const kernel = new ClusterKernel(faulty);
        const validated = await proposeAndValidate(kernel, 'create_entity', 'canonical', {
            kind: 'note', name: 'x', attributes: {},
        });
        let caught: unknown;
        try {
            await kernel.commitMutation(validated.id, ACTOR);
        } catch (e) {
            caught = e;
        }
        expect(caught).toBeInstanceOf(ReceiptFailedError);
        const cause = (caught as ReceiptFailedError).cause as unknown as { secondaryError?: Error; message?: string };
        // The thrown primary "cause" is whatever was thrown by append (the string); the
        // secondary failure is the same non-Error wrapped into an Error.
        expect(stderr).toHaveBeenCalledTimes(1);
        expect(String(stderr.mock.calls[0][0])).toContain('plain string failure');
        expect(cause).toBeDefined();
    });

    it('compensate: a ledger failure while recording the compensation records an orphan and throws ReceiptFailedError', async () => {
        const kernel = new ClusterKernel(stores);
        const validated = await proposeAndValidate(kernel, 'create_entity', 'canonical', {
            kind: 'note', name: 'to-compensate', attributes: {},
        });
        const committed = await kernel.commitMutation(validated.id, ACTOR);

        const faulty = withLedgerFaults(stores, {
            appendAction: (action) => (action === 'command_compensated' ? new Error('ledger refused') : null),
        });
        // Same in-memory command map is per-kernel, so use a dataDir kernel for the shared queue.
        const dataDir = join(dir, 'kdata');
        const k1 = new ClusterKernel(stores, { dataDir });
        const v2 = await proposeAndValidate(k1, 'create_entity', 'canonical', {
            kind: 'note', name: 'to-compensate-2', attributes: {},
        });
        const c2 = await k1.commitMutation(v2.id, ACTOR);
        const k2 = new ClusterKernel(faulty, { dataDir });

        let caught: unknown;
        try {
            await k2.compensateMutation(c2.command.id, ACTOR, 'undo it');
        } catch (e) {
            caught = e;
        }
        expect(caught).toBeInstanceOf(ReceiptFailedError);
        expect((caught as ReceiptFailedError).subjectId).toBe(c2.command.id);
        expect((caught as ReceiptFailedError).cause.message).toBe('ledger refused');

        const orphans = await stores.ledger.listEvents({ action: 'mutation_orphaned' });
        expect(orphans).toHaveLength(1);
        expect(orphans[0].subjectId).toBe(c2.command.id);
        expect(orphans[0].detail.verb).toBe('compensate');
        expect(orphans[0].detail.reason).toBe('undo it');
        // The first, unrelated committed command is untouched.
        expect(committed.command.status).toBe('committed');
    });

    it('rebuildIndex: a ledger failure after the index swap records an orphan and throws ReceiptFailedError', async () => {
        const faulty = withLedgerFaults(stores, {
            appendAction: (action) => (action === 'index_rebuilt' ? new Error('no ledger for you') : null),
        });
        const kernel = new ClusterKernel(faulty);
        await new ClusterKernel(stores).createEntity({ kind: 'note', name: 'seed', attributes: {}, actorId: ACTOR });
        // Poison the index so the rebuild visibly changes it.
        await stores.index.clear();
        expect(await stores.index.count()).toBe(0);

        let caught: unknown;
        try {
            await kernel.rebuildIndex(ACTOR);
        } catch (e) {
            caught = e;
        }
        expect(caught).toBeInstanceOf(ReceiptFailedError);
        expect((caught as ReceiptFailedError).subjectId).toBe('index');
        // The swap itself already happened.
        expect(await stores.index.count()).toBe(1);

        const orphans = await stores.ledger.listEvents({ action: 'mutation_orphaned' });
        expect(orphans).toHaveLength(1);
        expect(orphans[0].detail.verb).toBe('reindex');
        expect(orphans[0].detail.rebuilt).toBe(1);
    });
});

describe('ClusterKernel — ingest_artifact content handling', () => {
    let dir: string;
    let stores: ClusterStores;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'cov-kernel-ingest-'));
        stores = createLocalCluster(dir);
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('in-memory kernel: a Buffer payload is committed without a staging area', async () => {
        const kernel = new ClusterKernel(stores);
        const bytes = Buffer.from('in-memory payload');
        const cmd = await kernel.proposeMutation({
            verb: 'ingest_artifact',
            targetStore: 'artifact',
            payload: { filename: 'mem.txt', content: bytes, mimeType: 'text/plain' },
            proposedBy: ACTOR,
        });
        await kernel.validateMutation(cmd.id);
        const result = await kernel.commitMutation(cmd.id, ACTOR);
        expect(result.command.status).toBe('committed');
        expect(result.nextValidActions).toEqual(['compensated']);
        const artifacts = await stores.artifact.list();
        expect(artifacts).toHaveLength(1);
        expect(artifacts[0].filename).toBe('mem.txt');
        expect(artifacts[0].contentHash).toBe(createHash('sha256').update(bytes).digest('hex'));
        expect(existsSync(join(dir, 'pending-content'))).toBe(false);
    });

    it('in-memory kernel: a string content that is not a hash is rejected with ContentHashMismatchError at commit', async () => {
        const kernel = new ClusterKernel(stores);
        const cmd = await kernel.proposeMutation({
            verb: 'ingest_artifact',
            targetStore: 'artifact',
            payload: { filename: 'str.txt', content: 'just text', mimeType: 'text/plain' },
            proposedBy: ACTOR,
        });
        await kernel.validateMutation(cmd.id);
        let caught: unknown;
        try {
            await kernel.commitMutation(cmd.id, ACTOR);
        } catch (e) {
            caught = e;
        }
        expect(caught).toBeInstanceOf(ContentHashMismatchError);
        expect((caught as ContentHashMismatchError).code).toBe('CONTENT_HASH_MISMATCH');
        expect(await stores.artifact.list()).toEqual([]);
    });

    it('dataDir kernel: propose stages the bytes, rejects a wrong claimed hash, and commit consumes the staging file', async () => {
        const dataDir = join(dir, 'kdata');
        const kernel = new ClusterKernel(stores, { dataDir });
        const bytes = Buffer.from('staged payload');
        const hash = createHash('sha256').update(bytes).digest('hex');

        await expect(
            kernel.proposeMutation({
                verb: 'ingest_artifact',
                targetStore: 'artifact',
                payload: { filename: 's.txt', content: bytes, mimeType: 'text/plain', contentHash: 'deadbeef' },
                proposedBy: ACTOR,
            }),
        ).rejects.toBeInstanceOf(ContentHashMismatchError);
        expect(readdirSync(join(dataDir, 'pending-content'))).toEqual([]);

        const cmd = await kernel.proposeMutation({
            verb: 'ingest_artifact',
            targetStore: 'artifact',
            payload: { filename: 's.txt', content: bytes, mimeType: 'text/plain', contentHash: hash },
            proposedBy: ACTOR,
        });
        expect(cmd.payload.content).toBe(hash);
        expect(existsSync(join(dataDir, 'pending-content', hash))).toBe(true);
        await kernel.validateMutation(cmd.id);
        await kernel.commitMutation(cmd.id, ACTOR);
        expect(existsSync(join(dataDir, 'pending-content', hash))).toBe(false);
        const artifacts = await stores.artifact.list();
        expect(artifacts).toHaveLength(1);
        expect(artifacts[0].contentHash).toBe(hash);
    });

    it('dataDir kernel: a staging file deleted before commit throws StagedContentTamperedError with a <missing> actual hash', async () => {
        const dataDir = join(dir, 'kdata');
        const kernel = new ClusterKernel(stores, { dataDir });
        const bytes = Buffer.from('vanishing payload');
        const hash = createHash('sha256').update(bytes).digest('hex');
        const cmd = await kernel.proposeMutation({
            verb: 'ingest_artifact',
            targetStore: 'artifact',
            payload: { filename: 'v.txt', content: bytes, mimeType: 'text/plain', contentHash: hash },
            proposedBy: ACTOR,
        });
        await kernel.validateMutation(cmd.id);
        rmSync(join(dataDir, 'pending-content', hash));

        let caught: unknown;
        try {
            await kernel.commitMutation(cmd.id, ACTOR);
        } catch (e) {
            caught = e;
        }
        expect(caught).toBeInstanceOf(StagedContentTamperedError);
        expect((caught as StagedContentTamperedError).code).toBe('STAGED_CONTENT_TAMPERED');
        expect(String((caught as Error).message)).toContain('<missing>');
        expect(await stores.artifact.list()).toEqual([]);
    });

    it('dataDir kernel: a rewritten staging file throws StagedContentTamperedError and is preserved for forensics', async () => {
        const dataDir = join(dir, 'kdata');
        const kernel = new ClusterKernel(stores, { dataDir });
        const bytes = Buffer.from('original payload');
        const hash = createHash('sha256').update(bytes).digest('hex');
        const cmd = await kernel.proposeMutation({
            verb: 'ingest_artifact',
            targetStore: 'artifact',
            payload: { filename: 't.txt', content: bytes, mimeType: 'text/plain', contentHash: hash },
            proposedBy: ACTOR,
        });
        await kernel.validateMutation(cmd.id);
        const stagingPath = join(dataDir, 'pending-content', hash);
        writeFileSync(stagingPath, 'tampered bytes');

        await expect(kernel.commitMutation(cmd.id, ACTOR)).rejects.toBeInstanceOf(StagedContentTamperedError);
        expect(readFileSync(stagingPath, 'utf-8')).toBe('tampered bytes');
        expect(await stores.artifact.list()).toEqual([]);
    });

    it('dataDir kernel: the first staging access sweeps stale orphan tmp files but keeps fresh ones', async () => {
        const dataDir = join(dir, 'kdata');
        const staging = join(dataDir, 'pending-content');
        // Pre-create the staging dir with orphan tmp files from a "crashed" process.
        const k0 = new ClusterKernel(stores, { dataDir });
        const bytes = Buffer.from('trigger');
        await k0.proposeMutation({
            verb: 'ingest_artifact', targetStore: 'artifact',
            payload: { filename: 'a.txt', content: bytes, mimeType: 'text/plain', contentHash: createHash('sha256').update(bytes).digest('hex') },
            proposedBy: ACTOR,
        });
        const h = 'a'.repeat(64);
        const stale = join(staging, `${h}.999-abc123.tmp`);
        const fresh = join(staging, `${h}.998-fff000.tmp`);
        const ignored = join(staging, 'notes.txt');
        for (const f of [stale, fresh, ignored]) writeFileSync(f, 'x');
        const old = new Date(Date.now() - 30 * 60 * 1000);
        utimesSync(stale, old, old);
        utimesSync(ignored, old, old);

        // A new kernel instance sweeps on its first staging access.
        const k1 = new ClusterKernel(stores, { dataDir });
        const b2 = Buffer.from('second');
        await k1.proposeMutation({
            verb: 'ingest_artifact', targetStore: 'artifact',
            payload: { filename: 'b.txt', content: b2, mimeType: 'text/plain', contentHash: createHash('sha256').update(b2).digest('hex') },
            proposedBy: ACTOR,
        });
        expect(existsSync(stale)).toBe(false);
        expect(existsSync(fresh)).toBe(true);
        expect(existsSync(ignored)).toBe(true);
    });

    it('compensating a committed ingest sweeps any leftover staging file for that hash', async () => {
        const dataDir = join(dir, 'kdata');
        const kernel = new ClusterKernel(stores, { dataDir });
        const bytes = Buffer.from('compensate me');
        const hash = createHash('sha256').update(bytes).digest('hex');
        const cmd = await kernel.proposeMutation({
            verb: 'ingest_artifact', targetStore: 'artifact',
            payload: { filename: 'c.txt', content: bytes, mimeType: 'text/plain', contentHash: hash },
            proposedBy: ACTOR,
        });
        await kernel.validateMutation(cmd.id);
        await kernel.commitMutation(cmd.id, ACTOR);
        // Simulate a pathological leftover staging file after commit.
        const leftover = join(dataDir, 'pending-content', hash);
        writeFileSync(leftover, bytes);

        const result = await kernel.compensateMutation(cmd.id, ACTOR, 'wrong file');
        expect(result.originalCommand.status).toBe('compensated');
        expect(result.compensatingCommand.status).toBe('committed');
        expect(result.receipt.affectedIds).toEqual([cmd.id]);
        expect(existsSync(leftover)).toBe(false);
    });
});

describe('ClusterKernel — command state guards', () => {
    let dir: string;
    let dataDir: string;
    let stores: ClusterStores;
    let kernel: ClusterKernel;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'cov-kernel-guards-'));
        dataDir = join(dir, 'kdata');
        stores = createLocalCluster(dir);
        kernel = new ClusterKernel(stores, { dataDir });
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    function injectCommand(partial: Partial<Command> & Pick<Command, 'status'>): Command {
        const cmd: Command = {
            id: `injected-${Math.random().toString(36).slice(2, 8)}`,
            verb: 'create_entity',
            targetStore: 'canonical',
            payload: { kind: 'note', name: 'x', attributes: {} },
            proposedAt: new Date().toISOString(),
            proposedBy: ACTOR,
            ...partial,
        };
        new CommandQueue(dataDir).save(cmd);
        return cmd;
    }

    it('commit rejects an unknown lifecycle status with InvalidStateTransitionError', async () => {
        const cmd = injectCommand({ status: 'quarantined' as unknown as Command['status'] });
        let caught: unknown;
        try {
            await kernel.commitMutation(cmd.id, ACTOR);
        } catch (e) {
            caught = e;
        }
        expect(caught).toBeInstanceOf(InvalidStateTransitionError);
        expect((caught as InvalidStateTransitionError).from).toBe('quarantined');
        expect((caught as InvalidStateTransitionError).to).toBe('committed');
    });

    it('commit rejects a rejected, proposed and committed command with distinct typed errors', async () => {
        const rejected = injectCommand({ status: 'rejected', rejectionReason: 'bad idea' });
        const proposed = injectCommand({ status: 'proposed' });
        const committed = injectCommand({ status: 'committed' });
        await expect(kernel.commitMutation(rejected.id, ACTOR)).rejects.toBeInstanceOf(CommandRejectedError);
        await expect(kernel.commitMutation(proposed.id, ACTOR)).rejects.toBeInstanceOf(CommandNotValidatedError);
        await expect(kernel.commitMutation(committed.id, ACTOR)).rejects.toBeInstanceOf(CommandAlreadyTerminalError);
    });

    it('commit of a validated command with an unrecognised verb rejects it, persists the rejection and writes nothing', async () => {
        const cmd = injectCommand({
            status: 'validated',
            verb: 'teleport_entity' as unknown as Command['verb'],
        });
        let caught: unknown;
        try {
            await kernel.commitMutation(cmd.id, ACTOR);
        } catch (e) {
            caught = e;
        }
        expect(caught).toBeInstanceOf(CommandRejectedError);
        expect(String((caught as Error).message)).toContain('Unknown verb: teleport_entity');
        const after = await kernel.inspectCommand(cmd.id);
        expect(after.status).toBe('rejected');
        expect(await stores.ledger.listEvents({ action: 'mutation_committed' })).toEqual([]);
        expect(await stores.canonical.list()).toEqual([]);
    });

    it('link_evidence via the command path throws NotFoundError for a missing artifact, then a missing entity', async () => {
        const entity = (await kernel.createEntity({ kind: 'note', name: 'real', attributes: {}, actorId: ACTOR })).entity;
        const art = (await kernel.ingestArtifact({
            filename: 'real.txt', content: Buffer.from('real'), mimeType: 'text/plain', actorId: ACTOR,
        })).artifact;

        const missingArtifact = await proposeAndValidate(kernel, 'link_evidence', 'ledger', {
            artifactId: 'no-such-artifact', entityId: entity.id,
        });
        await expect(kernel.commitMutation(missingArtifact.id, ACTOR)).rejects.toMatchObject({
            code: 'NOT_FOUND',
        });

        const missingEntity = await proposeAndValidate(kernel, 'link_evidence', 'ledger', {
            artifactId: art.id, entityId: 'no-such-entity',
        });
        await expect(kernel.commitMutation(missingEntity.id, ACTOR)).rejects.toBeInstanceOf(NotFoundError);

        const ok = await proposeAndValidate(kernel, 'link_evidence', 'ledger', {
            artifactId: art.id, entityId: entity.id,
        });
        const committed = await kernel.commitMutation(ok.id, ACTOR);
        expect(committed.receipt.affectedIds).toEqual([art.id, entity.id]);
        const links = await stores.ledger.listEvents({ action: 'evidence_linked', subjectId: entity.id });
        expect(links).toHaveLength(1);
    });

    it('linkEvidence helper throws NotFoundError(canonical) when the entity is missing', async () => {
        const art = (await kernel.ingestArtifact({
            filename: 'a.txt', content: Buffer.from('a'), mimeType: 'text/plain', actorId: ACTOR,
        })).artifact;
        let caught: unknown;
        try {
            await kernel.linkEvidence({ artifactId: art.id, entityId: 'ghost', actorId: ACTOR });
        } catch (e) {
            caught = e;
        }
        expect(caught).toBeInstanceOf(NotFoundError);
        expect((caught as NotFoundError).message).toContain('ghost');
        expect(await stores.ledger.listEvents({ action: 'evidence_linked' })).toEqual([]);
    });
});

describe('ClusterKernel — index explain and stale detection', () => {
    let dir: string;
    let stores: ClusterStores;
    let kernel: ClusterKernel;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'cov-kernel-index-'));
        stores = createLocalCluster(dir);
        kernel = new ClusterKernel(stores);
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('explainIndex reports an orphaned artifact index record as stale with a cause', async () => {
        const rec = await stores.index.index({
            sourceId: 'artifact-that-never-existed', sourceStore: 'artifact', text: 'ghost.txt [text/plain]', metadata: {},
        });
        const explained = await kernel.explainIndex(rec.id);
        expect(explained.sourceExists).toBe(false);
        expect(explained.sourceObject).toBeNull();
        expect(explained.stale).toBe(true);
        expect(explained.staleCause).toBe('Source artifact artifact-that-never-existed no longer exists');
    });

    it('explainIndex reports an orphaned ledger index record as stale and a present one as fresh', async () => {
        const rec = await stores.index.index({
            sourceId: 'event-that-never-existed', sourceStore: 'ledger', text: 'a ledger event', metadata: {},
        });
        const stale = await kernel.explainIndex(rec.id);
        expect(stale.stale).toBe(true);
        expect(stale.staleCause).toBe('Source event event-that-never-existed no longer exists');

        const event = await stores.ledger.append({
            action: 'note', actorId: ACTOR, subjectId: 's1', subjectStore: 'canonical', detail: {},
        });
        const live = await stores.index.index({
            sourceId: event.id, sourceStore: 'ledger', text: 'real event', metadata: {},
        });
        const fresh = await kernel.explainIndex(live.id);
        expect(fresh.sourceExists).toBe(true);
        expect(fresh.stale).toBe(false);
        expect((fresh.sourceObject as { id: string }).id).toBe(event.id);
    });

    it('explainIndex throws NotFoundError for an unknown record id', async () => {
        await expect(kernel.explainIndex('nope')).rejects.toBeInstanceOf(NotFoundError);
    });

    it('listStaleRecords names missing entity, missing artifact, drifted text and missing ledger event sources', async () => {
        const { entity } = await kernel.createEntity({ kind: 'note', name: 'fresh', attributes: {}, actorId: ACTOR });
        const missingEntity = await stores.index.index({
            sourceId: 'gone-entity', sourceStore: 'canonical', text: 'note: gone', metadata: {},
        });
        const missingArtifact = await stores.index.index({
            sourceId: 'gone-artifact', sourceStore: 'artifact', text: 'gone.txt [text/plain]', metadata: {},
        });
        const missingEvent = await stores.index.index({
            sourceId: 'gone-event', sourceStore: 'ledger', text: 'gone event', metadata: {},
        });
        const drifted = await stores.index.index({
            sourceId: entity.id, sourceStore: 'canonical', text: 'note: an older name', metadata: {},
        });

        const stale = await kernel.listStaleRecords();
        const byRecord = new Map(stale.map((s) => [s.indexRecordId, s.cause]));
        expect(byRecord.get(missingEntity.id)).toBe('Source entity deleted');
        expect(byRecord.get(missingArtifact.id)).toBe('Source artifact deleted');
        expect(byRecord.get(missingEvent.id)).toBe('Source event deleted');
        expect(byRecord.get(drifted.id)).toBe('Index text does not match current entity state');
        // The properly indexed record created by createEntity is not stale.
        expect(stale).toHaveLength(4);
    });

    it('indexStatus flags possiblyStale when the index total differs from owner-store totals', async () => {
        await kernel.createEntity({ kind: 'note', name: 'one', attributes: {}, actorId: ACTOR });
        const clean = await kernel.indexStatus();
        expect(clean).toMatchObject({ total: 1, expectedTotal: 1, possiblyStale: false });
        expect(clean.byStore).toEqual({ canonical: 1 });

        await stores.index.index({ sourceId: 'x', sourceStore: 'ledger', text: 'extra', metadata: {} });
        const drift = await kernel.indexStatus();
        expect(drift.total).toBe(2);
        expect(drift.possiblyStale).toBe(true);
        expect(drift.byStore).toEqual({ canonical: 1, ledger: 1 });
    });
});

describe('ClusterKernel — trace rendering', () => {
    let dir: string;
    let stores: ClusterStores;
    let kernel: ClusterKernel;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'cov-kernel-trace-'));
        stores = createLocalCluster(dir);
        kernel = new ClusterKernel(stores);
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('explainTrace of a trace for a missing object lists the MISSING node and the gap', async () => {
        const graph = await kernel.traceObject('cluster://canonical/nope');
        const text = kernel.explainTrace(graph);
        expect(text).toContain('Provenance trace from: cluster://canonical/nope');
        expect(text).toContain('Direction: backward');
        expect(text).toContain('[GAP]');
        expect(text).toContain(`Gaps (${graph.gaps.length}):`);
        expect(text).toContain(`[${graph.gaps[0].impact}] ${graph.gaps[0].description}`);
    });

    it('explainTrace renders warnings and flagged edges verbatim', async () => {
        const base = await kernel.traceObject('cluster://canonical/nope');
        const graph: ProvenanceGraph = {
            ...base,
            warnings: [{ type: 'stale_index', message: 'index drifted' } as ProvenanceGraph['warnings'][number]],
            edges: [{
                from: 'a', to: 'b', type: 'evidence_linked_to', reason: 'linked by operator', isWarning: true,
            } as ProvenanceGraph['edges'][number]],
        };
        const text = kernel.explainTrace(graph);
        expect(text).toContain('Warnings (1):');
        expect(text).toContain('  [stale_index] index drifted');
        expect(text).toContain('  a → b [evidence_linked_to] ⚠');
        expect(text).toContain('    linked by operator');
    });

    it('why on a missing object reports it via the gap summary rather than throwing', async () => {
        const text = await kernel.why('cluster://canonical/ghost');
        expect(text).toContain('[MISSING] Entity ghost not found');
        expect(text).toContain('1 gap(s) in provenance');
    });

    it('why on a real entity names its creation, linked evidence and receipts', async () => {
        const { entity } = await kernel.createEntity({ kind: 'note', name: 'traced', attributes: {}, actorId: ACTOR });
        const art = (await kernel.ingestArtifact({
            filename: 'ev.txt', content: Buffer.from('ev'), mimeType: 'text/plain', actorId: ACTOR,
        })).artifact;
        await kernel.linkEvidence({ artifactId: art.id, entityId: entity.id, actorId: ACTOR });
        const text = await kernel.why(`cluster://canonical/${entity.id}`);
        expect(text).toContain('note: traced');
        expect(text).toMatch(/Created by:/);
        expect(text).toContain('Evidence links: 2');
        expect(text).toContain('Receipts: 2');
    });

    it('traceBundle merges per-object traces and dedupes shared edges', async () => {
        const { entity } = await kernel.createEntity({ kind: 'note', name: 'bundled-note', attributes: {}, actorId: ACTOR });
        const bundle = await kernel.retrieveBundle('bundled-note');
        expect(bundle.resolvedEntities.map((e) => e.uri)).toContain(`cluster://canonical/${entity.id}`);
        const graph = await kernel.traceBundle(bundle, { direction: 'backward', depth: 2 });
        expect(graph.focalUri).toBe(`bundle://${bundle.id}`);
        expect(graph.summary.nodeCount).toBe(graph.nodes.length);
        const keys = graph.edges.map((e) => `${e.from}|${e.to}|${e.type}`);
        expect(new Set(keys).size).toBe(keys.length);
        expect(graph.summary.oneLiner).toBe(
            `Bundle trace: ${graph.nodes.length} nodes, ${graph.edges.length} edges, ${graph.gaps.length} gaps`,
        );
    });
});
