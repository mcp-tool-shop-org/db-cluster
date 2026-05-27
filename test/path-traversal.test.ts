/**
 * Path traversal resistance (TESTS-003).
 *
 * Two probes against the artifact-storage sandbox:
 *
 *   1. Backup tamper — mutate `artifactSnapshots[0].metadata.contentHash` to
 *      `'../../../escape-path-test'` and try to restore. `LocalArtifactStore.importSnapshot`
 *      validates the hash shape (STORES-006) and throws `InvalidContentHashError`.
 *      The restore wrapper surfaces this as an error entry in `result.artifacts.errors`.
 *
 *   2. Filename tamper — `ingestArtifact` with `filename = '../../escape.txt'`.
 *      The literal string is stored as metadata (filenames are arbitrary by design),
 *      but the on-disk write path uses sha256(content) as the file name, so nothing
 *      lands outside the contentDir.
 *
 * Lives in its own file rather than restore-artifacts.test.ts because that file
 * uses beforeAll/afterAll (TESTS-007) and shared state would muddy these probes.
 * Each test here gets a fresh tmpdir.
 */

import { describe, it, expect } from 'vitest';
import {
    mkdtempSync,
    rmSync,
    existsSync,
    statSync,
    readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createLocalCluster } from '../src/adapters/local/index.js';
import { ClusterKernel } from '../src/kernel/cluster-kernel.js';
import { LocalArtifactStore } from '../src/adapters/local/local-artifact-store.js';
import { backup, restore } from '../src/ops/backup.js';
import { InvalidContentHashError } from '../src/adapters/local/errors.js';
import type { Artifact } from '../src/types/artifact.js';

describe('Path traversal resistance — artifact store sandbox', () => {
    it('importSnapshot rejects a tampered contentHash with traversal characters', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'path-trav-1-'));
        try {
            const store = new LocalArtifactStore(join(dir, 'artifact'));

            const tamperedMetadata: Artifact = {
                id: '11111111-2222-3333-4444-555555555555',
                filename: 'innocent.txt',
                contentHash: '../../../escape-path-test',
                mimeType: 'text/plain',
                sizeBytes: 5,
                version: 1,
                storagePath: '<placeholder>',
                ingestedAt: new Date().toISOString(),
                owner: 'artifact',
            };

            await expect(
                store.importSnapshot(tamperedMetadata, Buffer.from('payload')),
            ).rejects.toThrow(InvalidContentHashError);

            // Nothing escaped — the parent tmpdir contains exactly the artifact
            // dir we created, no `escape-path-test` files anywhere above it.
            const parent = resolve(dir, '..');
            const escapeAttempt = resolve(parent, 'escape-path-test');
            expect(existsSync(escapeAttempt)).toBe(false);
            // The artifact dir's own contentDir is empty too.
            const contentDir = join(dir, 'artifact', 'content');
            const written = existsSync(contentDir) ? readdirSync(contentDir) : [];
            expect(written).toHaveLength(0);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('importSnapshot rejects an empty contentHash', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'path-trav-2-'));
        try {
            const store = new LocalArtifactStore(join(dir, 'artifact'));
            const tampered: Artifact = {
                id: 'aaaaaaaa-1111-2222-3333-444444444444',
                filename: 'innocent.txt',
                contentHash: '',
                mimeType: 'text/plain',
                sizeBytes: 0,
                version: 1,
                storagePath: '',
                ingestedAt: new Date().toISOString(),
                owner: 'artifact',
            };
            await expect(
                store.importSnapshot(tampered, Buffer.from('')),
            ).rejects.toThrow(InvalidContentHashError);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('importSnapshot rejects uppercase hex (must be lowercase hex)', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'path-trav-3-'));
        try {
            const store = new LocalArtifactStore(join(dir, 'artifact'));
            const tampered: Artifact = {
                id: 'bbbbbbbb-1111-2222-3333-444444444444',
                filename: 'innocent.txt',
                // Uppercase hex — not a valid sha256 hex string in our regex.
                contentHash: 'A'.repeat(64),
                mimeType: 'text/plain',
                sizeBytes: 0,
                version: 1,
                storagePath: '',
                ingestedAt: new Date().toISOString(),
                owner: 'artifact',
            };
            await expect(
                store.importSnapshot(tampered, Buffer.from('x')),
            ).rejects.toThrow(InvalidContentHashError);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('restore surfaces invalid contentHash as an error entry without writing outside contentDir', async () => {
        const sourceDir = mkdtempSync(join(tmpdir(), 'path-trav-src-'));
        const targetDir = mkdtempSync(join(tmpdir(), 'path-trav-tgt-'));
        try {
            const sourceStores = createLocalCluster(sourceDir);
            const kernel = new ClusterKernel(sourceStores);
            await kernel.ingestArtifact({
                filename: 'real.md',
                content: Buffer.from('# Real content'),
                mimeType: 'text/markdown',
                actorId: 'user',
            });

            const data = await backup(sourceStores);
            expect(data.artifactSnapshots).toBeDefined();
            expect(data.artifactSnapshots!.length).toBe(1);

            // Tamper: replace the legitimate sha256 hex hash with a traversal payload.
            data.artifactSnapshots![0].metadata.contentHash = '../../../escape-path-test';

            const targetStores = createLocalCluster(targetDir);
            const result = await restore(targetStores, data);

            // restore must fail loudly on the tampered artifact, not silently
            // write outside the sandbox.
            expect(result.artifacts.created).toBe(0);
            expect(result.artifacts.errors.length).toBeGreaterThanOrEqual(1);
            const allErrs = result.artifacts.errors.join('\n');
            // Either the typed error name, the message, or the checksum
            // mismatch surfaces — any of these indicates the bad hash was
            // rejected before becoming a filesystem write.
            expect(
                allErrs.includes('InvalidContentHashError') ||
                    allErrs.includes('Invalid artifact contentHash') ||
                    allErrs.includes('checksum mismatch') ||
                    allErrs.includes('contentHash'),
            ).toBe(true);

            // No file landed at the traversal target.
            const escapeAttempt = resolve(targetDir, '..', 'escape-path-test');
            expect(existsSync(escapeAttempt)).toBe(false);
            const grandparentEscape = resolve(targetDir, '..', '..', 'escape-path-test');
            expect(existsSync(grandparentEscape)).toBe(false);
        } finally {
            rmSync(sourceDir, { recursive: true, force: true });
            rmSync(targetDir, { recursive: true, force: true });
        }
    });

    it('ingestArtifact with traversal-style filename: metadata stores literal string, no filesystem escape', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'path-trav-fn-'));
        try {
            const stores = createLocalCluster(dir);
            const kernel = new ClusterKernel(stores);

            const escapingFilename = `..${sep}..${sep}escape.txt`;
            const { artifact } = await kernel.ingestArtifact({
                filename: escapingFilename,
                content: Buffer.from('payload bytes'),
                mimeType: 'text/plain',
                actorId: 'user',
            });

            // Metadata preserves the literal user-provided string — that's a
            // metadata field, not a filesystem path.
            expect(artifact.filename).toBe(escapingFilename);

            // The actual on-disk file is named after the content sha256 hash
            // and lives inside the contentDir.
            const contentDir = join(dir, 'artifact', 'content');
            expect(existsSync(contentDir)).toBe(true);
            const onDisk = readdirSync(contentDir);
            // Exactly one file, named like a sha256 (64 hex chars).
            expect(onDisk.length).toBe(1);
            expect(onDisk[0]).toMatch(/^[a-f0-9]{64}$/);

            // No `escape.txt` written above contentDir.
            const escape1 = resolve(dir, 'escape.txt');
            const escape2 = resolve(dir, '..', 'escape.txt');
            const escape3 = resolve(dir, '..', '..', 'escape.txt');
            expect(existsSync(escape1)).toBe(false);
            expect(existsSync(escape2)).toBe(false);
            expect(existsSync(escape3)).toBe(false);

            // storagePath points inside contentDir (defense-in-depth check).
            const real = await stores.artifact.get(artifact.id);
            expect(real).not.toBeNull();
            const realPath = resolve(real!.storagePath);
            expect(realPath.startsWith(resolve(contentDir))).toBe(true);

            // And the file is a real file, not a symlink or directory.
            const st = statSync(realPath);
            expect(st.isFile()).toBe(true);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
