/**
 * Wave V1 — A4 regression: call-site safety + ops ledger arms + findSources offset.
 *
 *  - RETR-006: ledger-sourced index records were silently skipped by verify()
 *    and rebuild()'s checkStale() (only canonical/artifact arms existed). They
 *    must now surface as missing/orphan references — mirroring the planner's
 *    MissingContext else-arm. Latent today (nothing indexes ledger), so these
 *    arms must not perturb the 9 non-retrieval search() sites.
 *  - RETR-005: findSources threads `offset` so CLI/MCP find can paginate; offset
 *    absent ≡ prior behavior (existence-probe unaffected).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLocalCluster } from '../src/adapters/local/index.js';
import { ClusterKernel } from '../src/kernel/cluster-kernel.js';
import { verify } from '../src/ops/verify.js';
import { checkStale } from '../src/ops/rebuild.js';
import type { ClusterStores } from '../src/contracts/index.js';

describe('Wave V1 — call-site safety + ops ledger arms + findSources offset (RETR-005/006)', () => {
    let cluster: ClusterStores;
    let kernel: ClusterKernel;
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'db-cluster-v1-callsite-'));
        cluster = createLocalCluster(dir);
        kernel = new ClusterKernel(cluster, { dataDir: dir });
    });
    afterEach(() => {
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    it('RETR-006: verify() flags an orphan ledger-sourced index record (no longer silently skipped)', async () => {
        await cluster.index.index({ sourceId: 'ghost-evt-001', sourceStore: 'ledger', text: 'ledger checkpoint alpha', metadata: {} });

        const health = await verify(cluster);
        const check = health.checks.find((c) => c.name === 'index_references_valid');
        expect(check).toBeDefined();
        // ledger source 'ghost-evt-001' does not exist → counted as a missing reference.
        expect(check!.status).toBe('corrupt');
    });

    it('RETR-006: checkStale() flags an orphan ledger-sourced index record', async () => {
        await cluster.index.index({ sourceId: 'ghost-evt-002', sourceStore: 'ledger', text: 'ledger checkpoint beta', metadata: {} });

        const stale = await checkStale(cluster);
        expect(stale.some((s) => s.sourceStore === 'ledger' && s.type === 'orphan_index_record' && s.sourceId === 'ghost-evt-002')).toBe(true);
    });

    it('RETR-006: a present canonical record alongside an orphan ledger record yields exactly one orphan', async () => {
        await kernel.createEntity({ kind: 'note', name: 'Present Entity', attributes: {}, actorId: 'u' });
        await cluster.index.index({ sourceId: 'ghost-evt-003', sourceStore: 'ledger', text: 'ledger checkpoint gamma', metadata: {} });

        const stale = await checkStale(cluster);
        const orphans = stale.filter((s) => s.type === 'orphan_index_record');
        expect(orphans).toHaveLength(1);
        expect(orphans[0].sourceStore).toBe('ledger');
    });

    it('RETR-005: findSources threads offset (CLI/MCP find pagination)', async () => {
        for (let i = 0; i < 5; i++) {
            await kernel.createEntity({ kind: 'batch', name: `Item ${i}`, attributes: {}, actorId: 'u' });
        }
        const page0 = await kernel.findSources({ query: 'batch', limit: 2 });
        const page1 = await kernel.findSources({ query: 'batch', limit: 2, offset: 2 });

        expect(page0.indexRecords).toHaveLength(2);
        expect(page1.indexRecords).toHaveLength(2);
        const ids0 = page0.indexRecords.map((r) => r.sourceId);
        const ids1 = page1.indexRecords.map((r) => r.sourceId);
        expect(ids0.some((id) => ids1.includes(id))).toBe(false); // offset advanced past page 0
    });

    it('RETR-005: findSources with offset absent behaves identically (existence-probe unaffected)', async () => {
        await kernel.createEntity({ kind: 'batch', name: 'Item Solo', attributes: {}, actorId: 'u' });
        const probe = await kernel.findSources({ query: 'Item Solo', limit: 1 });
        expect(probe.indexRecords.length).toBe(1);
        expect(probe.resolvedEntities.length).toBe(1);
        expect(probe.resolvedEntities[0].name).toBe('Item Solo');
    });
});
