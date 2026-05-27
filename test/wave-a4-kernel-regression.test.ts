/**
 * Wave A4 — Kernel regression nets (should-have-been-Stage-A items v2 ensemble missed).
 *
 * Closes two findings:
 *
 *  - KERNEL-B-007 (V2-004): Buffer side-channel via contentHash. The previous
 *    `ingest_artifact` commitMutation arm cast `payload.content as Buffer`,
 *    but `CommandQueue.persist` JSON-serializes the payload. Buffer becomes
 *    `{type:'Buffer', data:[...]}` after JSON round-trip, then is cast back
 *    to Buffer in the commit arm and silently corrupts content. The fix
 *    moves Buffer payloads through a staging area keyed by contentHash with
 *    propose-time + commit-time hash re-validation.
 *
 *  - TESTS-B-003: CommandQueue marker file. `CommandQueue.load()` silently
 *    returns an empty Map when the file is missing — masks persistence-lost
 *    failures as confusing downstream "Not found in command store" errors.
 *    The fix adds a marker file written on the first successful persist so
 *    load() can distinguish "cold start" from "persistence lost".
 *
 * Both nets exist so a future regression that re-introduces the silent
 * corruption / silent-empty paths fails loudly in CI rather than reaching
 * production.
 */

import { describe, it, expect } from 'vitest';
import {
    mkdtempSync,
    rmSync,
    existsSync,
    readdirSync,
    readFileSync,
    writeFileSync,
    unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import * as fc from 'fast-check';
import { createLocalCluster } from '../src/adapters/local/index.js';
import { ClusterKernel } from '../src/kernel/cluster-kernel.js';
import { CommandQueue } from '../src/kernel/command-queue.js';
import {
    ContentHashMismatchError,
    StagedContentTamperedError,
    CommandQueuePersistenceLostError,
} from '../src/kernel/errors.js';

function sha256(buf: Buffer): string {
    return createHash('sha256').update(buf).digest('hex');
}

function freshDir(prefix: string): string {
    return mkdtempSync(join(tmpdir(), prefix));
}

describe('Wave A4 — Kernel regression nets', () => {
    // ─── KERNEL-B-007: Buffer side-channel via contentHash ───────────────────

    describe('KERNEL-B-007 — Buffer side-channel via contentHash', () => {
        it('propose-time validation: mismatched contentHash throws ContentHashMismatchError and writes no staging file', async () => {
            const dir = freshDir('a4-hash-mismatch-');
            try {
                const stores = createLocalCluster(dir);
                const kernel = new ClusterKernel(stores, { dataDir: dir });

                const content = Buffer.from('hello world');
                await expect(
                    kernel.proposeMutation({
                        verb: 'ingest_artifact',
                        targetStore: 'artifact',
                        payload: {
                            filename: 'hello.txt',
                            content,
                            mimeType: 'text/plain',
                            contentHash: 'WRONG_HASH',
                        },
                        proposedBy: 'agent',
                    }),
                ).rejects.toThrow(ContentHashMismatchError);

                // Staging dir must not contain any file — propose-time fail must
                // be before any disk write.
                const stagingDir = join(dir, 'pending-content');
                if (existsSync(stagingDir)) {
                    expect(readdirSync(stagingDir)).toEqual([]);
                }
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });

        it('propose happy path: valid contentHash persists command with hash string + staging file exists', async () => {
            const dir = freshDir('a4-propose-happy-');
            try {
                const stores = createLocalCluster(dir);
                const kernel = new ClusterKernel(stores, { dataDir: dir });

                const content = Buffer.from('hello world');
                const contentHash = sha256(content);
                const command = await kernel.proposeMutation({
                    verb: 'ingest_artifact',
                    targetStore: 'artifact',
                    payload: {
                        filename: 'hello.txt',
                        content,
                        mimeType: 'text/plain',
                        contentHash,
                    },
                    proposedBy: 'agent',
                });

                // Persisted command payload.content MUST be the hash string,
                // not a Buffer. This is the load-bearing invariant: the
                // JSON-persisted command carries only the hash; the Buffer
                // lives in the staging area.
                expect(typeof (command.payload as any).content).toBe('string');
                expect((command.payload as any).content).toBe(contentHash);
                expect((command.payload as any).contentHash).toBe(contentHash);

                // Staging file MUST exist at `.db-cluster/pending-content/{contentHash}`
                const stagingPath = join(dir, 'pending-content', contentHash);
                expect(existsSync(stagingPath)).toBe(true);
                expect(readFileSync(stagingPath).equals(content)).toBe(true);
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });

        it('commit-time re-validation: tampered staging file throws StagedContentTamperedError, file remains for forensics', async () => {
            const dir = freshDir('a4-commit-tamper-');
            try {
                const stores = createLocalCluster(dir);
                const kernel = new ClusterKernel(stores, { dataDir: dir });

                const content = Buffer.from('important content');
                const contentHash = sha256(content);
                const command = await kernel.proposeMutation({
                    verb: 'ingest_artifact',
                    targetStore: 'artifact',
                    payload: {
                        filename: 'doc.txt',
                        content,
                        mimeType: 'text/plain',
                        contentHash,
                    },
                    proposedBy: 'agent',
                });
                await kernel.validateMutation(command.id);

                // Tamper the staging file between propose and commit
                const stagingPath = join(dir, 'pending-content', contentHash);
                writeFileSync(stagingPath, Buffer.from('TAMPERED'));

                await expect(
                    kernel.commitMutation(command.id, 'operator'),
                ).rejects.toThrow(StagedContentTamperedError);

                // File MUST remain — preserved for forensic inspection. Only the
                // success path deletes the staging file.
                expect(existsSync(stagingPath)).toBe(true);
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });

        it('commit happy path: propose → validate → commit ingests artifact with correct content; staging file deleted post-commit', async () => {
            const dir = freshDir('a4-commit-happy-');
            try {
                const stores = createLocalCluster(dir);
                const kernel = new ClusterKernel(stores, { dataDir: dir });

                const content = Buffer.from('happy content');
                const contentHash = sha256(content);
                const command = await kernel.proposeMutation({
                    verb: 'ingest_artifact',
                    targetStore: 'artifact',
                    payload: {
                        filename: 'doc.txt',
                        content,
                        mimeType: 'text/plain',
                        contentHash,
                    },
                    proposedBy: 'agent',
                });
                await kernel.validateMutation(command.id);
                const { receipt } = await kernel.commitMutation(command.id, 'operator');

                expect(receipt).toBeDefined();
                expect(receipt.affectedIds.length).toBeGreaterThan(0);

                // Pull the artifact id from affectedIds and verify it was
                // ingested with the EXACT original content (not a JSON-round-
                // tripped Buffer).
                const artifactId = receipt.affectedIds[0];
                const artifact = await stores.artifact.get(artifactId);
                expect(artifact).not.toBeNull();
                expect(artifact!.contentHash).toBe(contentHash);

                const ingestedContent = await stores.artifact.getContent(artifactId);
                expect(ingestedContent).not.toBeNull();
                expect(ingestedContent!.equals(content)).toBe(true);

                // Staging file is deleted on success.
                const stagingPath = join(dir, 'pending-content', contentHash);
                expect(existsSync(stagingPath)).toBe(false);
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });

        it('reject cleanup: propose → rejectMutation deletes the staging file', async () => {
            const dir = freshDir('a4-reject-cleanup-');
            try {
                const stores = createLocalCluster(dir);
                const kernel = new ClusterKernel(stores, { dataDir: dir });

                const content = Buffer.from('to be rejected');
                const contentHash = sha256(content);
                const command = await kernel.proposeMutation({
                    verb: 'ingest_artifact',
                    targetStore: 'artifact',
                    payload: {
                        filename: 'doc.txt',
                        content,
                        mimeType: 'text/plain',
                        contentHash,
                    },
                    proposedBy: 'agent',
                });
                const stagingPath = join(dir, 'pending-content', contentHash);
                expect(existsSync(stagingPath)).toBe(true);

                await kernel.rejectMutation(command.id, 'operator', 'no-go');

                // Staging file must be cleaned up on rejection.
                expect(existsSync(stagingPath)).toBe(false);
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });

        it('property: 50 random (filename, contentBytes, mimeType) triples roundtrip cleanly through commit', async () => {
            await fc.assert(
                fc.asyncProperty(
                    fc.string({ minLength: 1, maxLength: 24 }).filter(
                        (s) => !s.includes(' ') && !/[/\\]/.test(s),
                    ),
                    fc.uint8Array({ minLength: 0, maxLength: 256 }),
                    fc.constantFrom('text/plain', 'application/json', 'application/octet-stream'),
                    async (filename, contentBytes, mimeType) => {
                        const dir = freshDir('a4-prop-');
                        try {
                            const stores = createLocalCluster(dir);
                            const kernel = new ClusterKernel(stores, { dataDir: dir });

                            const content = Buffer.from(contentBytes);
                            const contentHash = sha256(content);
                            const command = await kernel.proposeMutation({
                                verb: 'ingest_artifact',
                                targetStore: 'artifact',
                                payload: {
                                    filename,
                                    content,
                                    mimeType,
                                    contentHash,
                                },
                                proposedBy: 'agent',
                            });
                            await kernel.validateMutation(command.id);
                            const { receipt } = await kernel.commitMutation(
                                command.id,
                                'operator',
                            );

                            const artifactId = receipt.affectedIds[0];
                            const ingested = await stores.artifact.getContent(artifactId);
                            expect(ingested).not.toBeNull();
                            expect(ingested!.equals(content)).toBe(true);
                        } finally {
                            rmSync(dir, { recursive: true, force: true });
                        }
                    },
                ),
                { numRuns: 50 },
            );
        });
    });

    // ─── TESTS-B-003: CommandQueue marker file ────────────────────────────

    describe('TESTS-B-003 — CommandQueue marker file', () => {
        it('cold start: fresh .db-cluster/, no marker, no queue file → load() returns empty Map silently', async () => {
            const dir = freshDir('a4-cold-');
            try {
                const queue = new CommandQueue(dir);
                // No marker, no queue file. Should be silent / empty.
                expect(queue.list()).toEqual([]);
                expect(existsSync(join(dir, 'command-queue-marker'))).toBe(false);
                expect(existsSync(join(dir, 'pending-commands.json'))).toBe(false);
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });

        it('marker created on first persist: brand-new CommandQueue → propose → marker file now exists', async () => {
            const dir = freshDir('a4-marker-create-');
            try {
                const stores = createLocalCluster(dir);
                const kernel = new ClusterKernel(stores, { dataDir: dir });

                expect(existsSync(join(dir, 'command-queue-marker'))).toBe(false);

                await kernel.proposeMutation({
                    verb: 'create_entity',
                    targetStore: 'canonical',
                    payload: { kind: 'finding', name: 'marker-test', attributes: {} },
                    proposedBy: 'agent',
                });

                expect(existsSync(join(dir, 'command-queue-marker'))).toBe(true);
                // marker is a zero-byte sentinel
                expect(readFileSync(join(dir, 'command-queue-marker')).length).toBe(0);
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });

        it('persistence-lost detection: marker present + queue file ABSENT → CommandQueuePersistenceLostError', async () => {
            const dir = freshDir('a4-persistence-lost-');
            try {
                const stores = createLocalCluster(dir);
                const kernel = new ClusterKernel(stores, { dataDir: dir });

                // Force marker to be created by persisting one command.
                await kernel.proposeMutation({
                    verb: 'create_entity',
                    targetStore: 'canonical',
                    payload: { kind: 'finding', name: 'lost-test', attributes: {} },
                    proposedBy: 'agent',
                });
                expect(existsSync(join(dir, 'command-queue-marker'))).toBe(true);
                expect(existsSync(join(dir, 'pending-commands.json'))).toBe(true);

                // Delete the queue file but leave the marker — this is the
                // "persistence lost" signature.
                unlinkSync(join(dir, 'pending-commands.json'));

                const queue = new CommandQueue(dir);
                expect(() => queue.list()).toThrow(CommandQueuePersistenceLostError);
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });

        it('self-heal: queue file present but marker missing → load succeeds + marker now exists', async () => {
            const dir = freshDir('a4-self-heal-');
            try {
                const stores = createLocalCluster(dir);
                const kernel = new ClusterKernel(stores, { dataDir: dir });

                await kernel.proposeMutation({
                    verb: 'create_entity',
                    targetStore: 'canonical',
                    payload: { kind: 'finding', name: 'self-heal', attributes: {} },
                    proposedBy: 'agent',
                });

                // Delete the marker but keep the queue file — observed state
                // is "real queue exists, marker missing".
                unlinkSync(join(dir, 'command-queue-marker'));
                expect(existsSync(join(dir, 'command-queue-marker'))).toBe(false);
                expect(existsSync(join(dir, 'pending-commands.json'))).toBe(true);

                const queue = new CommandQueue(dir);
                // Load succeeds AND the marker is re-established.
                const commands = queue.list();
                expect(commands.length).toBe(1);
                expect(existsSync(join(dir, 'command-queue-marker'))).toBe(true);
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });
    });
});
