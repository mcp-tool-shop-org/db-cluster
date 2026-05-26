/**
 * Dogfood operations tests — verify ops/recovery work on project memory.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDogfoodCluster, type DogfoodCluster } from '../scripts/dogfood-ingest.js';
import { doctor } from '../src/ops/doctor.js';
import { rebuildIndex } from '../src/ops/rebuild.js';
import { backup, restore } from '../src/ops/backup.js';
import { createLocalCluster } from '../src/adapters/local/index.js';
import { PolicyEnforcedKernel } from '../src/kernel/policy-enforced-kernel.js';
import { DEFAULT_POLICIES, DEFAULT_TRUST_ZONES, DEFAULT_VISIBILITY_RULES } from '../src/policy/default-policies.js';
import type { Principal } from '../src/types/policy.js';

let cluster: DogfoodCluster;

beforeAll(async () => {
    cluster = await createDogfoodCluster();
});

afterAll(() => {
    rmSync(cluster.dataDir, { recursive: true, force: true });
});

describe('Dogfood operations', () => {
    it('doctor reports healthy on fresh cluster', async () => {
        const stores = createLocalCluster(cluster.dataDir);
        const health = await doctor(stores);
        expect(health.status).toBe('healthy');
    });

    it('doctor detects degraded state when index wiped', async () => {
        const stores = createLocalCluster(cluster.dataDir);
        await stores.index.clear();
        const health = await doctor(stores);
        expect(['degraded', 'stale', 'unhealthy']).toContain(health.status);
    });

    it('rebuild index restores discoverability', async () => {
        const stores = createLocalCluster(cluster.dataDir);
        await stores.index.clear();

        // Before rebuild: nothing found
        const before = await stores.index.search({ text: 'Phase' });
        expect(before.length).toBe(0);

        // Rebuild
        const result = await rebuildIndex(stores);
        expect(result.rebuilt).toBeGreaterThan(0);

        // After rebuild: entities discoverable
        const after = await stores.index.search({ text: 'Phase' });
        expect(after.length).toBeGreaterThan(0);
    });

    it('backup captures all cluster state', async () => {
        const stores = createLocalCluster(cluster.dataDir);
        const data = await backup(stores);
        expect(data.entities.length).toBeGreaterThan(0);
        expect(data.artifacts.length).toBeGreaterThan(0);
        expect(data.events.length).toBeGreaterThan(0);
        expect(data.receipts.length).toBeGreaterThan(0);
    });

    it('restore recovers entities and events into fresh cluster', async () => {
        const stores = createLocalCluster(cluster.dataDir);
        const data = await backup(stores);

        const freshDir = mkdtempSync(join(tmpdir(), 'dogfood-ops-test-'));
        const freshStores = createLocalCluster(freshDir);

        const result = await restore(freshStores, data);
        expect(result.entities.created).toBeGreaterThan(0);
        expect(result.events.created).toBeGreaterThan(0);
        // Note: artifact restore is not yet implemented — this is a product finding

        rmSync(freshDir, { recursive: true, force: true });
    });

    it('receipts and provenance survive restore', async () => {
        const stores = createLocalCluster(cluster.dataDir);
        const data = await backup(stores);

        const freshDir = mkdtempSync(join(tmpdir(), 'dogfood-ops-prov-'));
        const freshStores = createLocalCluster(freshDir);
        await restore(freshStores, data);

        // Provenance should exist in restored cluster
        const events = await freshStores.ledger.listEvents({});
        expect(events.length).toBeGreaterThan(0);

        // Receipts should exist
        const receipts = await freshStores.ledger.listReceipts({});
        expect(receipts.length).toBeGreaterThan(0);

        rmSync(freshDir, { recursive: true, force: true });
    });

    it('policy still applies after restore', async () => {
        const stores = createLocalCluster(cluster.dataDir);
        const data = await backup(stores);

        const freshDir = mkdtempSync(join(tmpdir(), 'dogfood-ops-policy-'));
        const freshStores = createLocalCluster(freshDir);
        await restore(freshStores, data);

        // Policy should still deny external access
        const external: Principal = { id: 'external', name: 'External', roles: [], trustZone: 'external' };
        const k = new PolicyEnforcedKernel(freshStores, { principal: external }, {
            policies: [
                ...DEFAULT_POLICIES,
                { id: 'ext-deny', name: 'Ext Deny', priority: 5, match: { trustZones: ['external'] }, decision: 'deny', reason: 'No access.' },
            ],
            trustZones: DEFAULT_TRUST_ZONES,
            visibilityRules: DEFAULT_VISIBILITY_RULES,
        });

        await expect(
            k.findSources({ query: 'Phase' }),
        ).rejects.toThrow();

        rmSync(freshDir, { recursive: true, force: true });
    });
});
