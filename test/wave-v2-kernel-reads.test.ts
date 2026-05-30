/**
 * Wave V2 — A1 regression: kernel read accessors (VERSIONS-001 / AI-009).
 *
 * The canonical/artifact stores already expose listVersions/getVersion/versions,
 * and the command queue exposes list/listByStatus — but those reach a policed
 * surface through NO kernel accessor (only /unsafe). These tests pin the new
 * concrete ClusterKernel reads that A2 will wrap with policy enforcement.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLocalCluster } from '../src/adapters/local/index.js';
import { ClusterKernel } from '../src/kernel/cluster-kernel.js';
import type { ClusterStores } from '../src/contracts/index.js';

describe('Wave V2 — A1 kernel reads (versions + listCommands accessors)', () => {
    let cluster: ClusterStores;
    let kernel: ClusterKernel;
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'db-cluster-v2-kreads-'));
        cluster = createLocalCluster(dir);
        kernel = new ClusterKernel(cluster, { dataDir: dir });
    });
    afterEach(() => {
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    it('listEntityVersions returns all versions ascending; getEntityVersion fetches one', async () => {
        const { entity } = await kernel.createEntity({ kind: 'doc', name: 'V1 Name', attributes: {}, actorId: 'u' });
        await cluster.canonical.update(entity.id, { name: 'V2 Name' }); // append version 2

        const versions = await kernel.listEntityVersions(entity.id);
        expect(versions).toHaveLength(2);
        expect(versions.map((v) => v.version)).toEqual([1, 2]); // ascending
        expect(versions[0].name).toBe('V1 Name');
        expect(versions[1].name).toBe('V2 Name');

        const v1 = await kernel.getEntityVersion(entity.id, 1);
        expect(v1?.name).toBe('V1 Name');
        const v2 = await kernel.getEntityVersion(entity.id, 2);
        expect(v2?.name).toBe('V2 Name');
    });

    it('listEntityVersions on unknown id is empty; getEntityVersion on unknown id/version is null', async () => {
        expect(await kernel.listEntityVersions('unknown-id')).toEqual([]);
        expect(await kernel.getEntityVersion('unknown-id', 1)).toBeNull();
        const { entity } = await kernel.createEntity({ kind: 'doc', name: 'Only V1', attributes: {}, actorId: 'u' });
        expect(await kernel.getEntityVersion(entity.id, 99)).toBeNull();
    });

    it('listArtifactVersions returns all versions sharing a filename', async () => {
        await kernel.ingestArtifact({ filename: 'spec.md', content: Buffer.from('v1'), mimeType: 'text/markdown', actorId: 'u' });
        await kernel.ingestArtifact({ filename: 'spec.md', content: Buffer.from('v2 content'), mimeType: 'text/markdown', actorId: 'u' });

        const versions = await kernel.listArtifactVersions('spec.md');
        expect(versions.length).toBe(2);
        expect(versions.every((a) => a.filename === 'spec.md')).toBe(true);
        expect(await kernel.listArtifactVersions('nope.md')).toEqual([]);
    });

    it('listCommands returns commands and filters by status', async () => {
        const cmd = await kernel.proposeMutation({
            verb: 'create_entity',
            targetStore: 'canonical',
            payload: { kind: 'doc', name: 'Pending', attributes: {} },
            proposedBy: 'u',
        });
        const all = await kernel.listCommands();
        expect(all.some((c) => c.id === cmd.id)).toBe(true);

        const proposed = await kernel.listCommands('proposed');
        expect(proposed.some((c) => c.id === cmd.id)).toBe(true);

        expect(await kernel.listCommands('committed')).toHaveLength(0);
    });
});
