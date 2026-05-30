/**
 * Wave V2 — A3 regression: SDK surface (VERSIONS-001 lift / SDK-009 / SDK-002).
 *  - version + listCommands SDK methods delegate to the policed kernel and sanitize.
 *  - SDK-009: traceProvenance(subjectId) (was omitted from the KernelLike Pick) +
 *    a typed getReceipt(id) over the resolve/getReceipt path (sanitizeReceiptForOutput).
 *  - SDK-002: ONE opaque-cursor idiom over V1's numeric offset — {items, nextCursor};
 *    the cursor is opaque (no raw offset, no internal ids).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLocalCluster } from '../src/adapters/local/index.js';
import { ClusterKernel } from '../src/kernel/cluster-kernel.js';
import { ClusterSDK } from '../src/sdk/cluster-sdk.js';

describe('Wave V2 — A3 SDK (versions / traceProvenance / getReceipt / cursor)', () => {
    let dir: string;
    let sdk: ClusterSDK;
    let entityId: string;
    let commandId: string;
    let receiptId: string;

    beforeEach(async () => {
        dir = mkdtempSync(join(tmpdir(), 'db-cluster-v2-sdk-'));
        const cluster = createLocalCluster(dir);
        const k = new ClusterKernel(cluster, { dataDir: dir });
        const { entity } = await k.createEntity({ kind: 'doc', name: 'V1', attributes: { a: 1 }, actorId: 'u' });
        entityId = entity.id;
        await cluster.canonical.update(entityId, { name: 'V2' });
        await k.ingestArtifact({ filename: 'a.md', content: Buffer.from('one'), mimeType: 'text/markdown', actorId: 'u' });
        await k.ingestArtifact({ filename: 'a.md', content: Buffer.from('two-content'), mimeType: 'text/markdown', actorId: 'u' });
        const cmd = await k.proposeMutation({ verb: 'create_entity', targetStore: 'canonical', payload: { kind: 'doc', name: 'Pending', attributes: {} }, proposedBy: 'u' });
        commandId = cmd.id;
        const receipts = await k.listReceipts();
        receiptId = receipts[0].id;
        for (let i = 0; i < 5; i++) {
            await k.createEntity({ kind: 'pageitem', name: `Item ${i}`, attributes: {}, actorId: 'u' });
        }
        sdk = new ClusterSDK({ clusterDir: dir }); // raw (no policies); still sanitizes at the boundary
    });
    afterEach(() => {
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    it('VERSIONS-001 lift: listEntityVersions / getEntityVersion / listArtifactVersions / listCommands', async () => {
        const versions = await sdk.listEntityVersions(entityId);
        expect(versions).toHaveLength(2);
        expect(versions.map((v) => v.version)).toEqual([1, 2]);

        const v1 = await sdk.getEntityVersion(entityId, 1);
        expect(v1?.version).toBe(1);
        expect(await sdk.getEntityVersion(entityId, 99)).toBeNull();

        const artifactVersions = await sdk.listArtifactVersions('a.md');
        expect(artifactVersions).toHaveLength(2);
        // SDK boundary strips storagePath even in raw mode.
        expect(JSON.stringify(artifactVersions)).not.toContain(dir);
        expect(artifactVersions.every((a) => !('storagePath' in (a as Record<string, unknown>)))).toBe(true);

        const commands = await sdk.listCommands();
        expect(commands.some((c) => c.id === commandId)).toBe(true);
        expect((await sdk.listCommands('committed')).every((c) => c.status === 'committed')).toBe(true);
    });

    it('SDK-009: traceProvenance is exposed and returns the subject lineage', async () => {
        const events = await sdk.traceProvenance(entityId);
        expect(Array.isArray(events)).toBe(true);
        expect(events.length).toBeGreaterThan(0);
        expect(events.some((e) => e.action === 'entity_created')).toBe(true);
    });

    it('SDK-009: getReceipt(id) returns the typed, sanitized receipt; unknown → null', async () => {
        const receipt = await sdk.getReceipt(receiptId);
        expect(receipt).not.toBeNull();
        expect(receipt!.id).toBe(receiptId);
        expect(await sdk.getReceipt('nonexistent-receipt')).toBeNull();
    });

    it('SDK-002: findPage paginates with an OPAQUE cursor over V1 offset (one idiom)', async () => {
        const page0 = await sdk.findPage('pageitem', { limit: 2 });
        expect(page0.items.length).toBe(2);
        expect(typeof page0.nextCursor).toBe('string'); // more results → a cursor
        // opaque: NOT the raw numeric offset, and carries no internal record ids.
        expect(page0.nextCursor).not.toBe('2');
        expect(page0.nextCursor).not.toContain(entityId);

        const page1 = await sdk.findPage('pageitem', { limit: 2, cursor: page0.nextCursor! });
        expect(page1.items.length).toBeGreaterThan(0);
        const ids0 = page0.items.map((r) => r.sourceId);
        const ids1 = page1.items.map((r) => r.sourceId);
        expect(ids0.some((id) => ids1.includes(id))).toBe(false); // disjoint pages

        // Walk to the end → nextCursor becomes null when the final partial page is reached.
        let cursor: string | null = page0.nextCursor;
        let guard = 0;
        while (cursor && guard++ < 10) {
            const p: { items: unknown[]; nextCursor: string | null } = await sdk.findPage('pageitem', { limit: 2, cursor });
            cursor = p.nextCursor;
        }
        expect(cursor).toBeNull();
    });
});
