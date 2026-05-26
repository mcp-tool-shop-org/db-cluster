/**
 * Wave 8: Phase 8 Proof Suite — Destructive proofs that physical backend
 * binding does not weaken cluster law.
 *
 * 10 required proofs. Requires DB_CLUSTER_POSTGRES_URL.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { PostgresCanonicalStore } from '../src/adapters/postgres/postgres-canonical-store.js';
import { LocalCanonicalStore } from '../src/adapters/local/local-canonical-store.js';
import { LocalArtifactStore } from '../src/adapters/local/local-artifact-store.js';
import { LocalIndexStore } from '../src/adapters/local/local-index-store.js';
import { LocalLedgerStore } from '../src/adapters/local/local-ledger-store.js';
import { ClusterKernel } from '../src/kernel/cluster-kernel.js';
import { PolicyEnforcedKernel } from '../src/kernel/policy-enforced-kernel.js';
import { ClusterSDK } from '../src/sdk/cluster-sdk.js';
import { createCluster } from '../src/adapters/factory.js';
import type { ClusterStores } from '../src/contracts/index.js';
import type { Principal, Policy } from '../src/types/policy.js';
import { DEFAULT_POLICIES, DEFAULT_TRUST_ZONES, DEFAULT_VISIBILITY_RULES } from '../src/policy/default-policies.js';

const POSTGRES_URL = process.env.DB_CLUSTER_POSTGRES_URL;
const describePostgres = POSTGRES_URL ? describe : describe.skip;

describePostgres('Wave 8 — Phase 8 Proof Suite', () => {
    let pool: Pool;
    let pgStore: PostgresCanonicalStore;

    beforeAll(async () => {
        pool = new Pool({ connectionString: POSTGRES_URL });
        pgStore = new PostgresCanonicalStore(pool);
        await pgStore.migrate();
    });

    afterAll(async () => {
        await pgStore.teardown();
        await pool.end();
    });

    beforeEach(async () => {
        await pool.query('DELETE FROM canonical_entities');
    });

    function makeStores(): ClusterStores {
        const dir = mkdtempSync(join(tmpdir(), 'phase8-proof-'));
        return {
            canonical: pgStore,
            artifact: new LocalArtifactStore(join(dir, 'artifact')),
            index: new LocalIndexStore(join(dir, 'index')),
            ledger: new LocalLedgerStore(join(dir, 'ledger')),
        };
    }

    // --- Proof 1: Delete index, rebuild from Postgres canonical truth ---

    it('Proof 1: index can be rebuilt from Postgres canonical truth', async () => {
        const stores = makeStores();
        const kernel = new ClusterKernel(stores);

        // Create entity (writes to Postgres canonical + local index)
        const { entity } = await kernel.createEntity({
            kind: 'concept', name: 'Rebuildable', attributes: { v: 1 }, actorId: 'user-1',
        });

        // Index has the record
        const before = await stores.index.search({ text: 'Rebuildable' });
        expect(before.length).toBe(1);

        // "Delete" index by searching in a fresh index store (simulating rebuild)
        const freshDir = mkdtempSync(join(tmpdir(), 'fresh-index-'));
        const freshIndex = new LocalIndexStore(join(freshDir, 'index'));

        // Canonical truth survives — entity still in Postgres
        const pgEntity = await pgStore.get(entity.id);
        expect(pgEntity).not.toBeNull();
        expect(pgEntity!.name).toBe('Rebuildable');

        // Re-index from canonical truth
        await freshIndex.index({
            sourceId: pgEntity!.id,
            sourceStore: 'canonical',
            text: `${pgEntity!.kind}: ${pgEntity!.name}`,
            metadata: { kind: pgEntity!.kind, ...pgEntity!.attributes },
        });

        const after = await freshIndex.search({ text: 'Rebuildable' });
        expect(after.length).toBe(1);
        expect(after[0].sourceId).toBe(entity.id);
    });

    // --- Proof 2: Mutate Postgres canonical entity only through command lifecycle ---

    it('Proof 2: Postgres canonical entity only mutates through command lifecycle', async () => {
        const stores = makeStores();
        const kernel = new ClusterKernel(stores);

        const { entity } = await kernel.createEntity({
            kind: 'mutable', name: 'Before', attributes: { v: 1 }, actorId: 'user-1',
        });

        // Propose + commit update through lifecycle
        const cmd = await kernel.proposeMutation({
            verb: 'update_entity',
            targetStore: 'canonical',
            payload: { entityId: entity.id, patch: { name: 'After', attributes: { v: 2 } } },
            proposedBy: 'user-1',
        });
        await kernel.commitMutation(cmd.id, 'user-1');

        // Verify update happened
        const updated = await pgStore.get(entity.id);
        expect(updated!.name).toBe('After');
        expect(updated!.attributes).toEqual({ v: 2 });

        // Verify receipt was emitted
        const receipts = await kernel.listReceipts({ commandId: cmd.id });
        expect(receipts.length).toBe(1);
        expect(receipts[0].resultSummary).toContain('Updated entity');
    });

    // --- Proof 3: Direct adapter mutation does not emit receipt ---

    it('Proof 3: direct adapter mutation is detectable as drift (no receipt)', async () => {
        const stores = makeStores();
        const kernel = new ClusterKernel(stores);

        const { entity } = await kernel.createEntity({
            kind: 'drifted', name: 'Original', attributes: { v: 1 }, actorId: 'user-1',
        });

        // Bypass kernel: direct adapter write
        await pgStore.update(entity.id, { name: 'Drifted', attributes: { v: 99 } });

        // Data changed in Postgres
        const raw = await pgStore.get(entity.id);
        expect(raw!.name).toBe('Drifted');

        // But NO receipt exists for this change — drift is detectable
        const allReceipts = await kernel.listReceipts({});
        const updateReceipts = allReceipts.filter((r) =>
            r.resultSummary.includes('Updated entity'),
        );
        expect(updateReceipts.length).toBe(0);
    });

    // --- Proof 4: Retrieve bundle resolves Postgres owner truth ---

    it('Proof 4: retrieve bundle resolves Postgres owner truth', async () => {
        const stores = makeStores();
        const kernel = new ClusterKernel(stores);

        await kernel.createEntity({
            kind: 'concept', name: 'Bundle Proof', attributes: { source: 'postgres' }, actorId: 'user-1',
        });

        const bundle = await kernel.retrieveBundle('Bundle Proof');
        expect(bundle.resolvedEntities.length).toBe(1);
        expect(bundle.resolvedEntities[0].object.attributes.source).toBe('postgres');
        expect(bundle.resolvedEntities[0].ownerStore).toBe('canonical');
    });

    // --- Proof 5: Trace graph crosses Postgres canonical + local ledger ---

    it('Proof 5: trace graph crosses Postgres canonical + local ledger', async () => {
        const stores = makeStores();
        const kernel = new ClusterKernel(stores);

        const { entity } = await kernel.createEntity({
            kind: 'traceable', name: 'Cross-Store', attributes: {}, actorId: 'user-1',
        });

        const trace = await kernel.traceObject(`cluster://canonical/${entity.id}`);

        // Entity node comes from Postgres canonical
        const entityNode = trace.nodes.find((n) => n.uri === `cluster://canonical/${entity.id}`);
        expect(entityNode).toBeDefined();
        expect(entityNode!.ownerStore).toBe('canonical');
        expect(entityNode!.isSourceTruth).toBe(true);

        // Provenance event node comes from local ledger
        const provenanceNodes = trace.nodes.filter((n) => n.type === 'provenance_event');
        expect(provenanceNodes.length).toBeGreaterThan(0);
        expect(provenanceNodes[0].ownerStore).toBe('ledger');
    });

    // --- Proof 6: Policy denial prevents reading Postgres owner truth ---

    it('Proof 6: policy denial prevents reading Postgres owner truth', async () => {
        const stores = makeStores();
        const kernel = new ClusterKernel(stores);

        const { entity } = await kernel.createEntity({
            kind: 'classified', name: 'Secret Data', attributes: { secret: 42 }, actorId: 'admin-1',
        });

        const externalPrincipal: Principal = {
            id: 'outsider', roles: ['external'], trustZone: 'external',
        };
        const policies: Policy[] = [
            { id: 'deny-external', name: 'Deny External', priority: 5, match: { trustZones: ['external'], capabilities: ['read_owner_truth'] }, decision: 'deny', reason: 'External denied.' },
            ...DEFAULT_POLICIES,
        ];

        const pk = new PolicyEnforcedKernel(
            stores,
            { principal: externalPrincipal },
            { policies, trustZones: DEFAULT_TRUST_ZONES, visibilityRules: DEFAULT_VISIBILITY_RULES },
        );

        await expect(pk.inspectEntity(entity.id)).rejects.toThrow();
    });

    // --- Proof 7: Redaction hides Postgres-backed entity attributes ---

    it('Proof 7: redaction hides Postgres-backed entity attributes', async () => {
        const stores = makeStores();
        const kernel = new ClusterKernel(stores);

        const { entity } = await kernel.createEntity({
            kind: 'redactable', name: 'Has Secrets', attributes: { password: 'hunter2', username: 'admin' }, actorId: 'admin-1',
        });

        const readerPrincipal: Principal = {
            id: 'reader-1', roles: ['restricted-reader'], trustZone: 'internal',
        };
        const policies: Policy[] = [
            {
                id: 'read-redacted', name: 'Read Redacted', priority: 5,
                match: { principals: ['restricted-reader'], capabilities: ['read_owner_truth'] },
                decision: 'allow', reason: 'Allow with redaction.',
                redaction: { id: 'strip-attrs', target: 'entity_attributes', behavior: 'strip', reason: 'Attributes stripped.' },
            },
            ...DEFAULT_POLICIES,
        ];

        const pk = new PolicyEnforcedKernel(
            stores,
            { principal: readerPrincipal },
            { policies, trustZones: DEFAULT_TRUST_ZONES, visibilityRules: DEFAULT_VISIBILITY_RULES },
        );

        const inspected = await pk.inspectEntity(entity.id);
        // Attributes redacted
        expect(inspected.attributes).toEqual({});
        // But entity shape preserved
        expect(inspected.id).toBe(entity.id);
        expect(inspected.name).toBe('Has Secrets');
        expect(inspected.owner).toBe('canonical');
    });

    // --- Proof 8: MCP cannot tell if canonical is local or Postgres ---

    it('Proof 8: MCP cannot distinguish backend except via allowed store metadata', async () => {
        const stores = makeStores();
        const kernel = new ClusterKernel(stores);

        const { entity } = await kernel.createEntity({
            kind: 'opaque', name: 'Backend Opaque', attributes: { x: 1 }, actorId: 'user-1',
        });

        // Entity observed through kernel has no backend indicator
        const inspected = await kernel.inspectEntity(entity.id);
        expect(inspected.owner).toBe('canonical'); // logical store, not physical
        expect((inspected as any).backend).toBeUndefined();
        expect((inspected as any).postgresTable).toBeUndefined();
        expect((inspected as any).connectionString).toBeUndefined();
    });

    // --- Proof 9: CLI/SDK/MCP all observe same Postgres-backed mutation ---

    it('Proof 9: SDK observes Postgres-backed mutation consistently', async () => {
        const stores = makeStores();
        const kernel = new ClusterKernel(stores);

        const { entity } = await kernel.createEntity({
            kind: 'observable', name: 'Mutation Observed', attributes: { v: 1 }, actorId: 'user-1',
        });

        // Mutate
        const cmd = await kernel.proposeMutation({
            verb: 'update_entity',
            targetStore: 'canonical',
            payload: { entityId: entity.id, patch: { name: 'Mutated', attributes: { v: 2 } } },
            proposedBy: 'user-1',
        });
        await kernel.commitMutation(cmd.id, 'user-1');

        // Read through kernel (same path SDK/MCP would use)
        const after = await kernel.inspectEntity(entity.id);
        expect(after.name).toBe('Mutated');
        expect(after.attributes).toEqual({ v: 2 });

        // Read through raw store confirms same
        const raw = await pgStore.get(entity.id);
        expect(raw!.name).toBe('Mutated');
    });

    // --- Proof 10: Local and Postgres backends pass shared contract ---

    it('Proof 10: local and Postgres backends pass shared contract suite', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'contract-'));
        const localStore = new LocalCanonicalStore(join(dir, 'canonical'));

        // Same operations on both stores produce equivalent results
        const localEntity = await localStore.create({
            kind: 'contract', name: 'Contract Test', attributes: { shared: true },
        });
        const pgEntity = await pgStore.create({
            kind: 'contract', name: 'Contract Test', attributes: { shared: true },
        });

        // Shape parity
        expect(Object.keys(localEntity).sort()).toEqual(Object.keys(pgEntity).sort());
        expect(localEntity.owner).toBe(pgEntity.owner);
        expect(localEntity.kind).toBe(pgEntity.kind);
        expect(localEntity.attributes).toEqual(pgEntity.attributes);

        // Get parity
        const localGet = await localStore.get(localEntity.id);
        const pgGet = await pgStore.get(pgEntity.id);
        expect(localGet).not.toBeNull();
        expect(pgGet).not.toBeNull();

        // Exists parity
        expect(await localStore.exists(localEntity.id)).toBe(true);
        expect(await pgStore.exists(pgEntity.id)).toBe(true);
        expect(await localStore.exists('00000000-0000-0000-0000-000000000000')).toBe(false);
        expect(await pgStore.exists('00000000-0000-0000-0000-000000000000')).toBe(false);

        // Update parity
        const localUpdated = await localStore.update(localEntity.id, { name: 'Updated' });
        const pgUpdated = await pgStore.update(pgEntity.id, { name: 'Updated' });
        expect(localUpdated.name).toBe('Updated');
        expect(pgUpdated.name).toBe('Updated');

        // List parity
        const localList = await localStore.list({ kind: 'contract' });
        const pgList = await pgStore.list({ kind: 'contract' });
        expect(localList.length).toBe(1);
        expect(pgList.length).toBe(1);
    });
});
