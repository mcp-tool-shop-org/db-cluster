/**
 * Kernel mutators validate their input before any store write.
 *
 * The one-call mutators used to write first and validate afterwards.
 * createEntity stored the entity and its index record, then validated a
 * synthetic create_entity command built from the same input, so an empty
 * name or kind threw COMMAND_VALIDATION_FAILED with the entity already
 * stored and no command, receipt or provenance recording it. On SQLite a
 * missing name leaked a raw NOT NULL constraint error instead.
 * ingestArtifact never validated its input: on the local backend a missing
 * filename stored an artifact the proposal path would refuse, and malformed
 * content leaked a raw TypeError. compensateMutation swept a leftover
 * staging file before validating its compensating command.
 *
 * Each case runs on a fresh cluster per backend and asserts the typed
 * error, that no store changed, and that verify() stays healthy. The SQLite
 * backend is gated like the other SQLite suites; CI sets
 * DB_CLUSTER_REQUIRE_SQLITE=1, which makes a missing driver a failure
 * (test/sqlite-driver-presence.test.ts), so it runs there on every cell.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCluster } from '../src/adapters/factory.js';
import type { ClusterConfig } from '../src/adapters/factory.js';
import type { SqliteDb } from '../src/adapters/sqlite/sqlite-db.js';
import type { ClusterStores } from '../src/contracts/index.js';
import { ClusterKernel } from '../src/kernel/cluster-kernel.js';
import { verify } from '../src/ops/verify.js';

/** True iff better-sqlite3 resolves on this machine (does not load it). */
function hasSqlite(): boolean {
    try {
        createRequire(import.meta.url).resolve('better-sqlite3');
        return true;
    } catch {
        return false;
    }
}

const BACKENDS: { name: string; backends: ClusterConfig['backends']; available: boolean }[] = [
    { name: 'local', backends: undefined, available: true },
    {
        name: 'sqlite',
        backends: { canonical: 'sqlite', artifact: 'sqlite', index: 'sqlite', ledger: 'sqlite' },
        available: hasSqlite(),
    },
];

for (const b of BACKENDS) {
    (b.available ? describe : describe.skip)(`input validated before any write (${b.name})`, () => {
        let dir: string;
        let stores: ClusterStores;
        let sqliteDb: SqliteDb | undefined;
        let kernel: ClusterKernel;

        beforeEach(() => {
            dir = mkdtempSync(join(tmpdir(), `validate-first-${b.name}-`));
            const cluster = createCluster({ rootDir: dir, backends: b.backends });
            stores = cluster.stores;
            sqliteDb = cluster.sqliteDb;
            kernel = new ClusterKernel(stores, { dataDir: dir });
        });

        afterEach(() => {
            sqliteDb?.close();
            rmSync(dir, { recursive: true, force: true });
        });

        /** Everything a mutator could write. Equal snapshots mean no write. */
        async function snapshot() {
            return {
                entities: (await stores.canonical.list()).length,
                artifacts: (await stores.artifact.list()).length,
                index: await stores.index.count(),
                events: (await stores.ledger.listEvents({})).length,
                receipts: (await stores.ledger.listReceipts({})).length,
                commands: (await kernel.listCommands()).map((c) => `${c.id}:${c.status}`).sort(),
            };
        }

        /** Assert the call is refused with `code` and changed nothing. */
        async function expectRefused(code: string, call: () => Promise<unknown>) {
            const before = await snapshot();
            await expect(call()).rejects.toMatchObject({ code });
            expect(await snapshot()).toEqual(before);
            const health = await verify(stores);
            const unhealthy = health.checks.filter((c) => !['healthy', 'unverified'].includes(c.status));
            expect(unhealthy.map((c) => `${c.name}:${c.status}`)).toEqual([]);
        }

        it.each<[string, Record<string, unknown>]>([
            ['an empty name (the reported repro)', { kind: 'note', name: '' }],
            ['an empty kind', { kind: '', name: 'x' }],
            ['a missing name', { kind: 'note' }],
        ])('createEntity refuses %s', async (_label, fields) => {
            await expectRefused('COMMAND_VALIDATION_FAILED', () =>
                kernel.createEntity({ ...fields, attributes: {}, actorId: 'operator' } as never),
            );
        });

        it('ingestArtifact refuses a missing filename', async () => {
            await expectRefused('COMMAND_VALIDATION_FAILED', () =>
                kernel.ingestArtifact({
                    content: Buffer.from('hello'),
                    mimeType: 'text/plain',
                    actorId: 'operator',
                } as never),
            );
        });

        it('ingestArtifact refuses content that went through JSON', async () => {
            await expectRefused('INVALID_CONTENT_SHAPE', () =>
                kernel.ingestArtifact({
                    filename: 'a.txt',
                    content: JSON.parse(JSON.stringify(Buffer.from('hello'))),
                    mimeType: 'text/plain',
                    actorId: 'operator',
                }),
            );
        });

        it('ingestArtifact refuses missing content', async () => {
            await expectRefused('INVALID_CONTENT_SHAPE', () =>
                kernel.ingestArtifact({ filename: 'a.txt', mimeType: 'text/plain', actorId: 'operator' } as never),
            );
        });

        it('linkEvidence refuses ids that name nothing (it already checked before writing)', async () => {
            await expectRefused('NOT_FOUND', () => kernel.linkEvidence({ actorId: 'operator' } as never));
        });

        it('compensateMutation validates before it sweeps the staging area', async () => {
            // Commit an ingest_artifact through the lifecycle, then leave a
            // stale staging file for it. Compensation sweeps such a file; a
            // compensation it then refuses must leave it where it was.
            const content = Buffer.from('hello');
            const cmd = await kernel.proposeMutation({
                verb: 'ingest_artifact',
                targetStore: 'artifact',
                payload: {
                    filename: 'a.txt',
                    content,
                    contentHash: createHash('sha256').update(content).digest('hex'),
                    mimeType: 'text/plain',
                },
                proposedBy: 'setup',
            });
            await kernel.validateMutation(cmd.id);
            await kernel.approveMutation(cmd.id, 'setup');
            await kernel.commitMutation(cmd.id, 'setup');
            const { contentHash } = (await kernel.inspectCommand(cmd.id)).payload as { contentHash?: unknown };
            expect(typeof contentHash).toBe('string');
            const stale = join(dir, 'pending-content', contentHash as string);
            writeFileSync(stale, 'hello');

            await expectRefused('COMMAND_VALIDATION_FAILED', () =>
                kernel.compensateMutation(cmd.id, 'setup', undefined as unknown as string),
            );
            expect(existsSync(stale)).toBe(true);
        });
    });
}
