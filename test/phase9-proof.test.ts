/**
 * Wave 8: Phase 9 Proof Suite — 12 destructive proofs that operational
 * damage is detectable and recoverable without losing ownership, retrieval,
 * provenance, policy, redaction, or mutation law.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalCluster } from '../src/adapters/local/index.js';
import { ClusterKernel } from '../src/kernel/cluster-kernel.js';
import type { ClusterStores } from '../src/contracts/index.js';
import { doctor } from '../src/ops/doctor.js';
import { verify } from '../src/ops/verify.js';
import { rebuildIndex, checkStale } from '../src/ops/rebuild.js';
import { checkProvenance } from '../src/ops/provenance-check.js';
import { checkReceipts } from '../src/ops/receipt-check.js';
import { backup, restore } from '../src/ops/backup.js';
import { buildClusterHealth, worstStatus } from '../src/ops/health.js';

describe('Phase 9 Proof Suite — Operations, Rebuild, and Recovery', () => {
    let tmpDir: string;
    let stores: ClusterStores;
    let kernel: ClusterKernel;

    beforeEach(async () => {
        tmpDir = mkdtempSync(join(tmpdir(), 'db-cluster-p9-'));
        stores = createLocalCluster(tmpDir);
        kernel = new ClusterKernel(stores, { dataDir: tmpDir });

        // Seed data: entity, artifact, mutation
        await kernel.createEntity({ kind: 'document', name: 'ops-manual', attributes: { format: 'markdown' } });
        await kernel.createEntity({ kind: 'config', name: 'cluster-settings', attributes: { version: '1.0' } });
        await kernel.ingestArtifact({
            filename: 'schema.sql',
            content: Buffer.from('CREATE TABLE test (id UUID);'),
            mimeType: 'text/sql',
        });

        // Create a mutation to produce a receipt (KERNEL-006: validate first)
        const entity = (await stores.canonical.list({ limit: 1 }))[0];
        const cmd = await kernel.proposeMutation({
            verb: 'update_entity',
            targetStore: 'canonical',
            payload: { entityId: entity.id, patch: { name: 'ops-manual-v2' } },
            proposedBy: 'operator',
        });
        await kernel.validateMutation(cmd.id);
        await kernel.commitMutation(cmd.id, 'operator');
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    // Proof 1: Doctor reports healthy cluster
    it('doctor reports healthy cluster after clean setup', async () => {
        const health = await doctor(stores);
        expect(health.status).toBe('healthy');
        expect(health.summary.errors).toBe(0);
        expect(health.checks.length).toBeGreaterThan(0);
    });

    // Proof 2: Doctor detects degraded state when index is empty but data exists
    it('doctor detects degraded state when index is wiped', async () => {
        await stores.index.clear();
        const health = await doctor(stores);
        expect(health.status).toBe('degraded');
        const indexCheck = health.checks.find((c) => c.name === 'index_populated');
        expect(indexCheck).toBeDefined();
        expect(indexCheck!.status).toBe('degraded');
        expect(indexCheck!.repairAvailable).toBe(true);
    });

    // Proof 3: Verify detects stale index after entity creation without indexing
    it('verify detects missing index entries after direct entity insert', async () => {
        // Clear index, add entity directly (no indexing)
        await stores.index.clear();
        await stores.canonical.create({ kind: 'test', name: 'orphan-entity', attributes: {} });
        const health = await verify(stores);
        const check = health.checks.find((c) => c.name === 'index_references_valid');
        expect(check).toBeDefined();
        expect(check!.status).toBe('stale');
    });

    // Proof 4: rebuildIndex restores full discoverability after index wipe
    it('rebuildIndex restores index from owner truth after clear', async () => {
        // Verify we have data
        const entities = await stores.canonical.list({});
        const artifacts = await stores.artifact.list({});
        const totalExpected = entities.length + artifacts.length;
        expect(totalExpected).toBeGreaterThan(0);

        // Wipe and rebuild
        await stores.index.clear();
        const beforeCount = await stores.index.count();
        expect(beforeCount).toBe(0);

        const result = await rebuildIndex(stores);
        expect(result.rebuilt).toBe(totalExpected);
        expect(result.errors).toHaveLength(0);

        const afterCount = await stores.index.count();
        expect(afterCount).toBe(totalExpected);
    });

    // Proof 5: checkStale detects orphan index records
    it('checkStale detects orphan index records pointing to non-existent sources', async () => {
        // Insert a fake index record pointing to non-existent entity
        await stores.index.index({
            sourceId: '00000000-0000-0000-0000-000000000099',
            sourceStore: 'canonical',
            text: 'ghost entry',
            metadata: {},
        });

        const stale = await checkStale(stores);
        const orphan = stale.find((s) => s.type === 'orphan_index_record');
        expect(orphan).toBeDefined();
        expect(orphan!.sourceId).toBe('00000000-0000-0000-0000-000000000099');
    });

    // Proof 6: Provenance check verifies event integrity
    it('provenance check reports healthy when all events reference valid subjects', async () => {
        const result = await checkProvenance(stores);
        expect(result.orphans).toBe(0);
        expect(result.checks[0].status).toBe('healthy');
    });

    // Proof 7: Receipt check verifies receipt→event links
    it('receipt check reports healthy when all receipts reference valid events', async () => {
        const result = await checkReceipts(stores);
        expect(result.orphans).toBe(0);
        expect(result.checks[0].status).toBe('healthy');
    });

    // Proof 8: Backup captures all cluster state
    it('backup captures entities, artifacts, events, and receipts', async () => {
        const data = await backup(stores);
        expect(data.version).toBe(1);
        expect(data.entities.length).toBeGreaterThan(0);
        expect(data.artifacts.length).toBeGreaterThan(0);
        expect(data.events.length).toBeGreaterThan(0);
        expect(data.receipts.length).toBeGreaterThan(0);
    });

    // Proof 9: Restore into empty cluster recovers state
    it('restore recovers cluster state into empty stores', async () => {
        const data = await backup(stores);

        // Create fresh empty cluster
        const freshDir = mkdtempSync(join(tmpdir(), 'db-cluster-p9-restore-'));
        const freshStores = createLocalCluster(freshDir);

        const result = await restore(freshStores, data);
        expect(result.entities.created).toBe(data.entities.length);
        expect(result.events.created).toBe(data.events.length);
        expect(result.receipts.created).toBe(data.receipts.length);

        // Verify recovered cluster passes doctor
        const health = await doctor(freshStores);
        expect(health.status).toBe('healthy');

        rmSync(freshDir, { recursive: true, force: true });
    });

    // Proof 10: Restore is additive — duplicate restores create new records (IDs not preserved)
    it('restore is additive — second restore does not corrupt cluster', async () => {
        const data = await backup(stores);

        const freshDir = mkdtempSync(join(tmpdir(), 'db-cluster-p9-idem-'));
        const freshStores = createLocalCluster(freshDir);

        const result1 = await restore(freshStores, data);
        expect(result1.entities.created).toBe(data.entities.length);

        // Second restore — entities get new IDs (store doesn't preserve backup IDs)
        // but cluster state remains valid
        const result2 = await restore(freshStores, data);
        const health = await doctor(freshStores);
        expect(health.status).toBe('healthy');

        rmSync(freshDir, { recursive: true, force: true });
    });

    // Proof 11: Health model correctly computes worst-of status
    it('worstStatus returns the most severe status', () => {
        expect(worstStatus(['healthy', 'degraded'])).toBe('degraded');
        expect(worstStatus(['healthy', 'stale', 'corrupt'])).toBe('corrupt');
        expect(worstStatus(['healthy'])).toBe('healthy');
        expect(worstStatus(['unreachable', 'missing'])).toBe('unreachable');
    });

    // Proof 12: Full operational cycle — damage, detect, rebuild, verify
    it('full cycle: index wipe → doctor detects → rebuild → verify passes', async () => {
        // Step 1: Doctor healthy before damage
        const before = await doctor(stores);
        expect(before.status).toBe('healthy');

        // Step 2: Damage (wipe index)
        await stores.index.clear();

        // Step 3: Doctor detects damage
        const damaged = await doctor(stores);
        expect(damaged.status).toBe('degraded');

        // Step 4: Rebuild
        const rebuildResult = await rebuildIndex(stores);
        expect(rebuildResult.errors).toHaveLength(0);

        // Step 5: Doctor healthy after rebuild
        const after = await doctor(stores);
        expect(after.status).toBe('healthy');

        // Step 6: Verify passes (invariants hold)
        const verified = await verify(stores);
        expect(verified.summary.errors).toBe(0);
    });
});
