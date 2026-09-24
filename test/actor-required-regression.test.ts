/**
 * Kernel mutators reject a missing or blank actor BEFORE any store write.
 *
 * Every mutator types its actor as a required string, but nothing checked it
 * at runtime. On the local backend a missing actor was written into
 * provenance as nothing at all, an actor-less event under the tamper-evidence
 * hash. On SQLite the ledger's NOT NULL constraint rejected the event AFTER
 * the canonical write had landed, leaving an orphaned mutation
 * (ReceiptFailedError; doctor/verify degraded on no_orphaned_mutations).
 *
 * Each case runs on a fresh cluster per backend and asserts the typed
 * INVALID_ACTOR error, that no store changed, and that no command moved.
 * The SQLite backend is gated like the other SQLite suites; CI sets
 * DB_CLUSTER_REQUIRE_SQLITE=1, which makes a missing driver a failure
 * (test/sqlite-driver-presence.test.ts), so it runs there on every cell.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCluster, createSafeCluster } from '../src/adapters/factory.js';
import type { ClusterConfig } from '../src/adapters/factory.js';
import type { SqliteDb } from '../src/adapters/sqlite/sqlite-db.js';
import type { ClusterStores } from '../src/contracts/index.js';
import { ClusterKernel } from '../src/kernel/cluster-kernel.js';
import { handleTool } from '../src/mcp/server.js';
import { redactError } from '../src/mcp/sanitize.js';
import { verify } from '../src/ops/verify.js';
import { ClusterSDK } from '../src/sdk/cluster-sdk.js';

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

/** Values a caller can hand the kernel that name no actor. */
const NO_ACTOR = [undefined, null, '', '   '] as unknown as string[];

for (const b of BACKENDS) {
    (b.available ? describe : describe.skip)(`actor required before any write (${b.name})`, () => {
        let dir: string;
        let stores: ClusterStores;
        let sqliteDb: SqliteDb | undefined;
        let kernel: ClusterKernel;

        beforeEach(() => {
            dir = mkdtempSync(join(tmpdir(), `actor-required-${b.name}-`));
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
                events: (await stores.ledger.listEvents({})).length,
                receipts: (await stores.ledger.listReceipts({})).length,
                commands: (await kernel.listCommands()).map((c) => `${c.id}:${c.status}`).sort(),
            };
        }

        /** Assert the call is refused with INVALID_ACTOR and changed nothing. */
        async function expectRefused(call: () => Promise<unknown>) {
            const before = await snapshot();
            await expect(call()).rejects.toMatchObject({ code: 'INVALID_ACTOR' });
            expect(await snapshot()).toEqual(before);
            const health = await verify(stores);
            const unhealthy = health.checks.filter((c) => !['healthy', 'unverified'].includes(c.status));
            expect(unhealthy.map((c) => `${c.name}:${c.status}`)).toEqual([]);
        }

        it.each(NO_ACTOR.map((a) => [JSON.stringify(a) ?? 'undefined', a]))(
            'createEntity refuses actorId %s',
            async (_label, actorId) => {
                await expectRefused(() =>
                    kernel.createEntity({ kind: 'note', name: 'x', attributes: {}, actorId }),
                );
            },
        );

        it('createSafeCluster().kernel.createEntity refuses a missing actorId (the reported repro)', async () => {
            // The policed handle delegates to the same guard; this is the exact
            // call the old @example made, on its own cluster root.
            const safeRoot = mkdtempSync(join(tmpdir(), `actor-required-safe-${b.name}-`));
            const safe = createSafeCluster({ rootDir: safeRoot, backends: b.backends });
            try {
                await expect(
                    safe.kernel.createEntity({ kind: 'note', name: 'hello', attributes: {} } as never),
                ).rejects.toMatchObject({ code: 'INVALID_ACTOR' });
                const health = await safe.verify();
                expect(health.checks.filter((c) => !['healthy', 'unverified'].includes(c.status))).toEqual([]);
                const { entity } = await safe.kernel.createEntity({
                    kind: 'note', name: 'hello', attributes: {}, actorId: 'operator',
                });
                expect(entity.version).toBe(1);
            } finally {
                safe.sqliteDb?.close();
                rmSync(safeRoot, { recursive: true, force: true });
            }
        });

        it('ingestArtifact refuses a missing actorId', async () => {
            await expectRefused(() =>
                kernel.ingestArtifact({
                    filename: 'a.txt',
                    content: Buffer.from('hello'),
                    mimeType: 'text/plain',
                    actorId: undefined as unknown as string,
                }),
            );
        });

        it('linkEvidence refuses a missing actorId', async () => {
            const { entity } = await kernel.createEntity({
                kind: 'note', name: 'e', attributes: {}, actorId: 'setup',
            });
            const { artifact } = await kernel.ingestArtifact({
                filename: 'a.txt', content: Buffer.from('hello'), mimeType: 'text/plain', actorId: 'setup',
            });
            await expectRefused(() =>
                kernel.linkEvidence({
                    artifactId: artifact.id,
                    entityId: entity.id,
                    actorId: undefined as unknown as string,
                }),
            );
        });

        it('rebuildIndex refuses a missing actorId', async () => {
            await expectRefused(() => kernel.rebuildIndex(undefined as unknown as string));
        });

        describe('command lifecycle', () => {
            async function validatedUpdate(): Promise<string> {
                const { entity } = await kernel.createEntity({
                    kind: 'note', name: 'before', attributes: {}, actorId: 'setup',
                });
                const cmd = await kernel.proposeMutation({
                    verb: 'update_entity',
                    targetStore: 'canonical',
                    payload: { entityId: entity.id, patch: { name: 'after' } },
                    proposedBy: 'setup',
                });
                await kernel.validateMutation(cmd.id);
                return cmd.id;
            }

            it('proposeMutation refuses a missing proposedBy', async () => {
                const { entity } = await kernel.createEntity({
                    kind: 'note', name: 'before', attributes: {}, actorId: 'setup',
                });
                await expectRefused(() =>
                    kernel.proposeMutation({
                        verb: 'update_entity',
                        targetStore: 'canonical',
                        payload: { entityId: entity.id, patch: { name: 'after' } },
                        proposedBy: undefined as unknown as string,
                    }),
                );
            });

            it('approveMutation refuses a missing approvedBy', async () => {
                const id = await validatedUpdate();
                await expectRefused(() => kernel.approveMutation(id, undefined as unknown as string));
            });

            it('rejectMutation refuses a missing rejectedBy', async () => {
                const id = await validatedUpdate();
                await expectRefused(() =>
                    kernel.rejectMutation(id, undefined as unknown as string, 'no'),
                );
            });

            it('commitMutation refuses a missing actorId', async () => {
                const id = await validatedUpdate();
                await kernel.approveMutation(id, 'setup');
                await expectRefused(() => kernel.commitMutation(id, undefined as unknown as string));
            });

            it('compensateMutation refuses a missing compensatedBy', async () => {
                const id = await validatedUpdate();
                await kernel.approveMutation(id, 'setup');
                await kernel.commitMutation(id, 'setup');
                await expectRefused(() =>
                    kernel.compensateMutation(id, undefined as unknown as string, 'undo'),
                );
            });
        });
    });
}

describe('actor required: the MCP boundary reports INVALID_ACTOR', () => {
    // The CLI can never send a blank actor (resolveOperator falls back to the
    // OS user), but MCP tools take the actor straight from their arguments,
    // and a JSON schema's `type: string` accepts "". The tool call must fail
    // with the typed code and its remediation, the way an MCP host sees it.
    let dir: string;
    let sdk: ClusterSDK;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'actor-required-mcp-'));
        sdk = new ClusterSDK({ clusterDir: dir });
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    async function toolError(name: string, args: Record<string, unknown>) {
        try {
            await handleTool(name, args, sdk);
        } catch (err) {
            return redactError(err);
        }
        throw new Error(`${name} succeeded with a blank actor`);
    }

    it('cluster_propose_mutation with proposedBy "" is INVALID_ACTOR', async () => {
        const envelope = await toolError('cluster_propose_mutation', {
            verb: 'create_entity',
            targetStore: 'canonical',
            payload: { kind: 'note', name: 'x', attributes: {} },
            proposedBy: '',
        });
        expect(envelope.code).toBe('INVALID_ACTOR');
        expect(envelope.remediation_hint).toMatch(/non-empty/);
        expect(await sdk.listCommands()).toEqual([]);
    });

    it('cluster_approve_mutation with approvedBy "   " is INVALID_ACTOR and leaves the command validated', async () => {
        const cmd = await sdk.proposeMutation({
            verb: 'create_entity',
            targetStore: 'canonical',
            payload: { kind: 'note', name: 'x', attributes: {} },
            proposedBy: 'setup',
        });
        await sdk.validateMutation(cmd.id);
        const envelope = await toolError('cluster_approve_mutation', { commandId: cmd.id, approvedBy: '   ' });
        expect(envelope.code).toBe('INVALID_ACTOR');
        expect((await sdk.inspectCommand(cmd.id)).status).toBe('validated');
    });
});
