/**
 * Coverage — ops/backup: backup file output and overwrite guard, staging
 * capture, and restore's failure and advisory paths (missing import hooks,
 * conflicting records, bad staging entries, dry-run, command queue).
 * Assertions are on returned values, typed errors and files on disk.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
    mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createLocalCluster } from '../src/adapters/local/index.js';
import { ClusterKernel } from '../src/kernel/cluster-kernel.js';
import { CommandQueue } from '../src/kernel/command-queue.js';
import { backup, restore } from '../src/ops/backup.js';
import type { ClusterBackup } from '../src/ops/backup.js';
import { ImportSnapshotNotSupportedError } from '../src/ops/errors.js';
import { BackupTargetExistsError } from '../src/adapters/local/errors.js';
import type { ClusterStores } from '../src/contracts/index.js';

const ACTOR = 'operator';
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

/** Return `target` with selected members replaced; everything else delegates to the real object. */
function overlay<T extends object>(target: T, overrides: Record<string, unknown>): T {
    return new Proxy(target, {
        get(t, prop) {
            if (typeof prop === 'string' && prop in overrides) return overrides[prop];
            const value = Reflect.get(t, prop, t);
            return typeof value === 'function' ? value.bind(t) : value;
        },
    });
}

async function seed(stores: ClusterStores) {
    const kernel = new ClusterKernel(stores);
    const { entity } = await kernel.createEntity({ kind: 'note', name: 'seed-note', attributes: { a: 1 }, actorId: ACTOR });
    const { artifact } = await kernel.ingestArtifact({
        filename: 'seed.txt', content: Buffer.from('seed content'), mimeType: 'text/plain', actorId: ACTOR,
    });
    await kernel.linkEvidence({ artifactId: artifact.id, entityId: entity.id, actorId: ACTOR });
    return { entity, artifact };
}

describe('backup()', () => {
    let dir: string;
    let stores: ClusterStores;

    beforeEach(async () => {
        dir = mkdtempSync(join(tmpdir(), 'cov-backup-'));
        stores = createLocalCluster(join(dir, 'cluster'));
        await seed(stores);
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('writes outputPath, refuses to overwrite without force, and overwrites with force', async () => {
        const out = join(dir, 'snap.json');
        const progress: Array<[number, number, string | undefined]> = [];
        const first = await backup(stores, {
            outputPath: out,
            onProgress: (c, t, m) => progress.push([c, t, m]),
        });
        expect(JSON.parse(readFileSync(out, 'utf-8')).entities).toHaveLength(first.entities.length);
        const last = progress[progress.length - 1];
        expect(last[0]).toBe(last[1]);
        expect(last[2]).toBe(`wrote ${out}`);

        let caught: unknown;
        try {
            await backup(stores, { outputPath: out });
        } catch (e) {
            caught = e;
        }
        expect(caught).toBeInstanceOf(BackupTargetExistsError);
        expect((caught as BackupTargetExistsError).code).toBe('BACKUP_TARGET_EXISTS');
        // The refused attempt left the earlier file intact.
        expect(JSON.parse(readFileSync(out, 'utf-8')).createdAt).toBe(first.createdAt);

        const second = await backup(stores, { outputPath: out, force: true });
        expect(JSON.parse(readFileSync(out, 'utf-8')).createdAt).toBe(second.createdAt);
    });

    it('includeContent=false omits artifact bytes; a throwing onProgress never breaks the backup', async () => {
        const data = await backup(stores, {
            includeContent: false,
            onProgress: () => { throw new Error('progress sink exploded'); },
        });
        expect(data.artifactSnapshots).toHaveLength(1);
        expect(data.artifactSnapshots![0].contentBase64).toBeUndefined();
        expect(data.entities).toHaveLength(1);
    });

    it('includes a command snapshot when a command queue is supplied', async () => {
        const dataDir = join(dir, 'cluster');
        const kernel = new ClusterKernel(stores, { dataDir });
        const cmd = await kernel.proposeMutation({
            verb: 'create_entity', targetStore: 'canonical',
            payload: { kind: 'note', name: 'queued', attributes: {} }, proposedBy: ACTOR,
        });
        const data = await backup(stores, { commandQueue: new CommandQueue(dataDir) });
        expect(data.commands?.map((c) => c.id)).toEqual([cmd.id]);
    });

    it('captures only hash-named staging files and omits tmp files', async () => {
        const dataDir = join(dir, 'data');
        const staging = join(dataDir, 'pending-content');
        mkdirSync(staging, { recursive: true });
        const bytes = Buffer.from('staged bytes');
        const hash = sha(bytes);
        writeFileSync(join(staging, hash), bytes);
        writeFileSync(join(staging, `${hash}.123-abc.tmp`), 'tmp noise');
        writeFileSync(join(staging, 'README.txt'), 'not a hash');

        const data = await backup(stores, { dataDir });
        expect(data.staging).toEqual([{ contentHash: hash, content: bytes.toString('base64') }]);
    });

    it('leaves staging undefined when pending-content is empty or is not a directory', async () => {
        const emptyDir = join(dir, 'empty');
        mkdirSync(join(emptyDir, 'pending-content'), { recursive: true });
        expect((await backup(stores, { dataDir: emptyDir })).staging).toBeUndefined();

        const weirdDir = join(dir, 'weird');
        mkdirSync(weirdDir, { recursive: true });
        // A regular file squatting on the staging path: existsSync is true, readdir throws.
        writeFileSync(join(weirdDir, 'pending-content'), 'i am a file');
        expect((await backup(stores, { dataDir: weirdDir })).staging).toBeUndefined();

        expect((await backup(stores, { dataDir: join(dir, 'never-created') })).staging).toBeUndefined();
    });
});

describe('restore()', () => {
    let dir: string;
    let source: ClusterStores;
    let target: ClusterStores;
    let data: ClusterBackup;
    let seeded: Awaited<ReturnType<typeof seed>>;

    beforeEach(async () => {
        dir = mkdtempSync(join(tmpdir(), 'cov-restore-'));
        source = createLocalCluster(join(dir, 'source'));
        target = createLocalCluster(join(dir, 'target'));
        seeded = await seed(source);
        data = await backup(source);
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('rejects an unsupported backup version before touching anything', async () => {
        await expect(restore(target, { ...data, version: 2 } as unknown as ClusterBackup)).rejects.toThrow(
            'Unsupported backup version: 2',
        );
        expect(await target.canonical.list()).toEqual([]);
    });

    it('restores with original ids, then a second restore skips everything idempotently', async () => {
        const first = await restore(target, data);
        expect(first.dryRun).toBe(false);
        expect(first.entities).toMatchObject({ created: 1, skipped: 0, errors: [] });
        expect(first.artifacts).toMatchObject({ created: 1, skipped: 0, errors: [] });
        expect(first.events.created).toBe(data.events.length);
        expect(first.receipts.created).toBe(data.receipts.length);
        expect(first.summary).toBe(
            `entities: 1 created, 0 skipped, 0 errored; artifacts: 1 created, 0 skipped, 0 errored; ` +
            `events: ${data.events.length} created, 0 skipped, 0 errored; ` +
            `receipts: ${data.receipts.length} created, 0 skipped, 0 errored`,
        );
        expect((await target.canonical.get(seeded.entity.id))?.name).toBe('seed-note');
        expect((await target.artifact.getContent(seeded.artifact.id))?.toString()).toBe('seed content');

        const second = await restore(target, data);
        expect(second.entities).toMatchObject({ created: 0, skipped: 1 });
        expect(second.artifacts).toMatchObject({ created: 0, skipped: 1 });
        expect(second.events.skipped).toBe(data.events.length);
        expect(second.receipts.skipped).toBe(data.receipts.length);
        expect(second.summary).toContain('entities: 0 created, 1 skipped, 0 errored');
    });

    it('dry run reports what would happen without writing and says the index rebuild was skipped', async () => {
        const progress: number[] = [];
        const result = await restore(target, data, { dryRun: true, onProgress: (c) => progress.push(c) });
        expect(result.dryRun).toBe(true);
        expect(result.entities.created).toBe(1);
        expect(result.artifacts.created).toBe(1);
        expect(result.warnings).toContain('dry-run: index rebuild skipped');
        expect(result.summary.startsWith('[DRY RUN] ')).toBe(true);
        expect(await target.canonical.list()).toEqual([]);
        expect(await target.artifact.list()).toEqual([]);
        expect(await target.ledger.listEvents()).toEqual([]);
        expect(await target.index.count()).toBe(0);
        expect(progress.length).toBeGreaterThan(0);
    });

    it('restoring over a tampered existing record reports per-record conflicts instead of masking them', async () => {
        await restore(target, data);
        const tampered: ClusterBackup = JSON.parse(JSON.stringify(data));
        tampered.entities[0].name = 'renamed-by-attacker';
        tampered.events[0].actorId = 'someone-else';
        tampered.receipts[0].resultSummary = 'forged summary';
        tampered.artifactSnapshots![0].metadata.filename = 'forged.txt';

        const result = await restore(target, tampered);
        expect(result.entities.skipped).toBe(0);
        expect(result.entities.errors).toHaveLength(1);
        expect(result.entities.errors[0]).toContain(`Entity ${data.entities[0].id}:`);
        expect(result.artifacts.errors).toHaveLength(1);
        expect(result.artifacts.errors[0]).toContain(`Artifact ${data.artifacts[0].id}:`);
        expect(result.events.errors).toHaveLength(1);
        expect(result.events.errors[0]).toContain(`Event ${data.events[0].id}:`);
        expect(result.receipts.errors).toHaveLength(1);
        expect(result.receipts.errors[0]).toContain(`Receipt ${data.receipts[0].id}:`);
        // The live record was not overwritten.
        expect((await target.canonical.get(seeded.entity.id))?.name).toBe('seed-note');
    });

    it('reports metadata-only artifacts and checksum mismatches as per-artifact errors', async () => {
        const metadataOnly: ClusterBackup = JSON.parse(JSON.stringify(data));
        delete metadataOnly.artifactSnapshots![0].contentBase64;
        const r1 = await restore(target, metadataOnly);
        expect(r1.artifacts.created).toBe(0);
        expect(r1.artifacts.errors).toEqual([
            `Artifact ${data.artifacts[0].id}: no content in backup (metadata-only)`,
        ]);

        const corrupted: ClusterBackup = JSON.parse(JSON.stringify(data));
        corrupted.artifactSnapshots![0].contentBase64 = Buffer.from('other bytes').toString('base64');
        const r2 = await restore(target, corrupted);
        expect(r2.artifacts.created).toBe(0);
        expect(r2.artifacts.errors).toHaveLength(1);
        expect(r2.artifacts.errors[0]).toContain('content checksum mismatch');
        expect(r2.artifacts.errors[0]).toContain(sha('other bytes'));
        expect(await target.artifact.list()).toEqual([]);
    });

    it('falls back to the legacy artifacts slot when artifactSnapshots is absent', async () => {
        const legacy: ClusterBackup = JSON.parse(JSON.stringify(data));
        delete legacy.artifactSnapshots;
        const result = await restore(target, legacy);
        // Legacy slot carries no content, so it is reported rather than silently dropped.
        expect(result.artifacts.created).toBe(0);
        expect(result.artifacts.errors[0]).toContain('metadata-only');
    });

    it.each([
        ['canonical', 'importSnapshot', 'canonical'],
        ['artifact', 'importSnapshot', 'artifact'],
        ['ledger', 'importEvent', 'ledger'],
        ['ledger', 'importReceipt', 'ledger'],
    ] as const)('throws ImportSnapshotNotSupportedError when the %s adapter lacks %s', async (store, method, kind) => {
        const broken = { ...target, [store]: overlay(target[store] as object, { [method]: undefined }) } as ClusterStores;
        // For the receipt hook the events must import cleanly first, so strip nothing else.
        let caught: unknown;
        try {
            await restore(broken, data);
        } catch (e) {
            caught = e;
        }
        expect(caught).toBeInstanceOf(ImportSnapshotNotSupportedError);
        const err = caught as ImportSnapshotNotSupportedError;
        expect(err.code).toBe('IMPORT_SNAPSHOT_NOT_SUPPORTED');
        expect(err.storeKind).toBe(kind);
        expect(err.missingMethod).toBe(method);
    });

    it('restores commands into a supplied command queue and counts them', async () => {
        const dataDir = join(dir, 'target');
        const cmdSource = new ClusterKernel(source, { dataDir: join(dir, 'source') });
        const cmd = await cmdSource.proposeMutation({
            verb: 'create_entity', targetStore: 'canonical',
            payload: { kind: 'note', name: 'queued', attributes: {} }, proposedBy: ACTOR,
        });
        const withCommands = await backup(source, { commandQueue: new CommandQueue(join(dir, 'source')) });
        expect(withCommands.commands?.map((c) => c.id)).toEqual([cmd.id]);

        const queue = new CommandQueue(dataDir);
        const result = await restore(target, withCommands, { commandQueue: queue });
        expect(result.commands).toEqual({ restored: 1 });
        expect(result.summary).toContain('commands: 1 restored');
        expect(queue.get(cmd.id)?.status).toBe('proposed');

        // Dry run counts but does not save.
        const queue2 = new CommandQueue(join(dir, 'dry'));
        const dry = await restore(target, withCommands, { commandQueue: queue2, dryRun: true });
        expect(dry.commands).toEqual({ restored: 1 });
        expect(queue2.list()).toEqual([]);
    });

    describe('staging files', () => {
        it('restores valid staging entries, skips existing ones, and rejects bad hashes and tampered content', async () => {
            const dataDir = join(dir, 'restored-data');
            const good = Buffer.from('good staged');
            const goodHash = sha(good);
            const dup = Buffer.from('already there');
            const dupHash = sha(dup);
            mkdirSync(join(dataDir, 'pending-content'), { recursive: true });
            writeFileSync(join(dataDir, 'pending-content', dupHash), dup);

            const staged: ClusterBackup = {
                ...JSON.parse(JSON.stringify(data)),
                staging: [
                    { contentHash: goodHash, content: good.toString('base64') },
                    { contentHash: dupHash, content: dup.toString('base64') },
                    { contentHash: 'NOT-A-HASH-AT-ALL-0123456789', content: 'eA==' },
                    { contentHash: sha('claimed'), content: Buffer.from('different').toString('base64') },
                ],
            };
            const result = await restore(target, staged, { dataDir });
            expect(result.staging?.restored).toBe(1);
            expect(result.staging?.skipped).toBe(1);
            expect(result.staging?.errors).toHaveLength(2);
            expect(result.staging?.errors[0]).toContain('invalid contentHash shape (NOT-A-HASH-AT-AL...)');
            expect(result.staging?.errors[1]).toContain(`Staging entry ${sha('claimed')}: content hash mismatch (got ${sha('different')})`);
            expect(readFileSync(join(dataDir, 'pending-content', goodHash))).toEqual(good);
            expect(readdirSync(join(dataDir, 'pending-content')).sort()).toEqual([dupHash, goodHash].sort());
            expect(result.summary).toContain('staging: 1 restored, 1 skipped, 2 errored');
        });

        it('dry run reports staging restores without writing the files', async () => {
            const dataDir = join(dir, 'dry-data');
            const bytes = Buffer.from('dry staged');
            const hash = sha(bytes);
            const staged: ClusterBackup = {
                ...JSON.parse(JSON.stringify(data)),
                staging: [{ contentHash: hash, content: bytes.toString('base64') }],
            };
            const result = await restore(target, staged, { dataDir, dryRun: true });
            expect(result.staging?.restored).toBe(1);
            expect(existsSync(join(dataDir, 'pending-content', hash))).toBe(false);
        });

        it('collects a write failure for one staging file as a per-entry error', async () => {
            const dataDir = join(dir, 'blocked-data');
            mkdirSync(dataDir, { recursive: true });
            // A regular file where the staging directory should be: mkdir is swallowed, the write fails.
            writeFileSync(join(dataDir, 'pending-content'), 'blocker');
            const bytes = Buffer.from('cannot land');
            const hash = sha(bytes);
            const staged: ClusterBackup = {
                ...JSON.parse(JSON.stringify(data)),
                staging: [{ contentHash: hash, content: bytes.toString('base64') }],
            };
            const result = await restore(target, staged, { dataDir });
            expect(result.staging?.restored).toBe(0);
            expect(result.staging?.errors).toHaveLength(1);
            expect(result.staging?.errors[0]).toContain(`Staging entry ${hash}:`);
        });

        it('warns when dataDir is supplied but the backup pre-dates staging support', async () => {
            const noStaging: ClusterBackup = JSON.parse(JSON.stringify(data));
            delete noStaging.staging;
            const withWarn = await restore(target, noStaging, { dataDir: join(dir, 'd1') });
            expect(withWarn.warnings).toContain('backup snapshot pre-dates staging support (V1-A4-004); no staging files restored');
            expect(withWarn.staging).toBeUndefined();

            // An explicitly empty staging list is not an old-format backup: no warning.
            const emptyStaging: ClusterBackup = { ...JSON.parse(JSON.stringify(data)), staging: [] };
            const quiet = await restore(createLocalCluster(join(dir, 'target2')), emptyStaging, { dataDir: join(dir, 'd2') });
            expect(quiet.warnings).toEqual([]);
        });
    });
});
