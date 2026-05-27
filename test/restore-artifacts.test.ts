/**
 * TESTS-B-008 (Wave B1-Amend): MIGRATED beforeAll → beforeEach with seed.
 * Pre-fix: tests 2-5 SILENTLY DEPENDED on test 1 (`backup captures artifact
 * payload`) having ingested the test-doc.md artifact into the shared
 * sourceDir. If test 1 was renamed, reordered, `.only`d-out, or skipped,
 * tests 2-5 broke with "no artifacts found." The ordering-dependence was
 * INVISIBLE to readers and only fault-shielded by vitest's stable in-file
 * order. Post-fix: each test re-ingests its own seed into a per-test fresh
 * sourceDir, eliminating the implicit dependency.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalCluster } from '../src/adapters/local/index.js';
import { backup, restore } from '../src/ops/backup.js';
import { ClusterKernel } from '../src/kernel/cluster-kernel.js';

describe('Wave 2: Restore artifacts', () => {
    let sourceDir: string;
    let targetDir: string;

    beforeEach(async () => {
        sourceDir = mkdtempSync(join(tmpdir(), 'restore-art-src-'));
        targetDir = mkdtempSync(join(tmpdir(), 'restore-art-tgt-'));

        // Seed: every test starts with the test-doc.md artifact ingested
        // into sourceDir. This replicates the pre-fix `beforeAll` seed from
        // the original "test 1" body so all downstream tests have an
        // artifact to back up / restore / corrupt without depending on the
        // ordering of test 1.
        const stores = createLocalCluster(sourceDir);
        const kernel = new ClusterKernel(stores);
        await kernel.ingestArtifact({
            filename: 'test-doc.md',
            content: Buffer.from('# Test Document\nContent here.'),
            mimeType: 'text/markdown',
            actorId: 'operator',
        });
    });

    afterEach(() => {
        try { rmSync(sourceDir, { recursive: true, force: true }); } catch { /* best-effort */ }
        try { rmSync(targetDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    it('backup captures artifact payload, metadata, and checksum', async () => {
        // Seed is already in sourceDir (see beforeEach). Just back it up
        // and verify the captured shape.
        const stores = createLocalCluster(sourceDir);

        const data = await backup(stores);
        expect(data.artifactSnapshots).toBeDefined();
        expect(data.artifactSnapshots!.length).toBe(1);

        const snap = data.artifactSnapshots![0];
        expect(snap.metadata.filename).toBe('test-doc.md');
        expect(snap.metadata.contentHash).toBeDefined();
        expect(snap.contentBase64).toBeDefined();
        // Verify content round-trips
        const decoded = Buffer.from(snap.contentBase64!, 'base64');
        expect(decoded.toString()).toBe('# Test Document\nContent here.');
    });

    it('restore recreates artifacts with content', async () => {
        const stores = createLocalCluster(sourceDir);
        const data = await backup(stores);

        const freshStores = createLocalCluster(targetDir);
        const result = await restore(freshStores, data);

        expect(result.artifacts.created).toBe(1);
        expect(result.artifacts.errors).toHaveLength(0);

        // Verify artifact exists and is retrievable
        const artifacts = await freshStores.artifact.list({});
        expect(artifacts.length).toBe(1);
        expect(artifacts[0].filename).toBe('test-doc.md');
    });

    it('artifact IDs are preserved via importSnapshot', async () => {
        const stores = createLocalCluster(sourceDir);
        const originalArtifacts = await stores.artifact.list({});
        const originalId = originalArtifacts[0].id;

        const data = await backup(stores);
        const freshDir = mkdtempSync(join(tmpdir(), 'restore-id-'));
        const freshStores = createLocalCluster(freshDir);
        await restore(freshStores, data);

        const restored = await freshStores.artifact.get(originalId);
        expect(restored).not.toBeNull();
        expect(restored!.id).toBe(originalId);
        expect(restored!.filename).toBe('test-doc.md');

        rmSync(freshDir, { recursive: true, force: true });
    });

    it('trace after restore includes restored artifacts', async () => {
        const stores = createLocalCluster(sourceDir);
        const data = await backup(stores);

        const freshDir = mkdtempSync(join(tmpdir(), 'restore-trace-'));
        const freshStores = createLocalCluster(freshDir);
        await restore(freshStores, data);

        // Provenance events referencing artifact should exist
        const events = await freshStores.ledger.listEvents({});
        const artifactEvents = events.filter((e) =>
            e.subjectStore === 'artifact' || e.action === 'artifact_ingested',
        );
        expect(artifactEvents.length).toBeGreaterThan(0);

        rmSync(freshDir, { recursive: true, force: true });
    });

    it('retrieve after restore can resolve restored artifact evidence', async () => {
        const stores = createLocalCluster(sourceDir);
        const data = await backup(stores);

        const freshDir = mkdtempSync(join(tmpdir(), 'restore-retrieve-'));
        const freshStores = createLocalCluster(freshDir);
        await restore(freshStores, data);

        // Index should have been rebuilt — artifact should be searchable
        const results = await freshStores.index.search({ text: 'test-doc' });
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].sourceStore).toBe('artifact');

        // Content should be retrievable
        const content = await freshStores.artifact.getContent(results[0].sourceId);
        expect(content).not.toBeNull();
        expect(content!.toString()).toContain('Test Document');

        rmSync(freshDir, { recursive: true, force: true });
    });

    it('corrupted backup artifact fails loudly', async () => {
        const stores = createLocalCluster(sourceDir);
        const data = await backup(stores);

        // Corrupt the content
        data.artifactSnapshots![0].contentBase64 = Buffer.from('corrupted garbage').toString('base64');

        const freshDir = mkdtempSync(join(tmpdir(), 'restore-corrupt-'));
        const freshStores = createLocalCluster(freshDir);
        const result = await restore(freshStores, data);

        expect(result.artifacts.created).toBe(0);
        expect(result.artifacts.errors.length).toBe(1);
        expect(result.artifacts.errors[0]).toContain('checksum mismatch');

        rmSync(freshDir, { recursive: true, force: true });
    });
});
