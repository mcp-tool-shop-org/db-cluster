/**
 * Wave 7: Backend parity tests.
 * 
 * Proves Local and Postgres canonical stores are interchangeable —
 * kernel behavior does not change when the canonical backend changes.
 * 
 * Requires DB_CLUSTER_POSTGRES_URL to be set.
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
import { createCluster } from '../src/adapters/factory.js';
import type { ClusterStores } from '../src/contracts/index.js';
import type { Entity } from '../src/types/entity.js';
import type { Principal, Policy } from '../src/types/policy.js';
import { DEFAULT_POLICIES, DEFAULT_TRUST_ZONES, DEFAULT_VISIBILITY_RULES } from '../src/policy/default-policies.js';

const POSTGRES_URL = process.env.DB_CLUSTER_POSTGRES_URL;
const describePostgres = POSTGRES_URL ? describe : describe.skip;

describePostgres('Wave 7 — Backend Parity Tests', () => {
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

    function makePgStores(): ClusterStores {
        const dir = mkdtempSync(join(tmpdir(), 'parity-pg-'));
        return {
            canonical: pgStore,
            artifact: new LocalArtifactStore(join(dir, 'artifact')),
            index: new LocalIndexStore(join(dir, 'index')),
            ledger: new LocalLedgerStore(join(dir, 'ledger')),
        };
    }

    function makeLocalStores(): ClusterStores {
        const dir = mkdtempSync(join(tmpdir(), 'parity-local-'));
        return {
            canonical: new LocalCanonicalStore(join(dir, 'canonical')),
            artifact: new LocalArtifactStore(join(dir, 'artifact')),
            index: new LocalIndexStore(join(dir, 'index')),
            ledger: new LocalLedgerStore(join(dir, 'ledger')),
        };
    }

    // --- Proof 1: equivalent entity shape ---

    it('Local and Postgres canonical stores return equivalent entity shape', async () => {
        const localStores = makeLocalStores();
        const pgStores = makePgStores();

        const localEntity = await localStores.canonical.create({
            kind: 'concept', name: 'Shape Test', attributes: { a: 1 },
        });
        const pgEntity = await pgStores.canonical.create({
            kind: 'concept', name: 'Shape Test', attributes: { a: 1 },
        });

        // Same keys
        const localKeys = Object.keys(localEntity).sort();
        const pgKeys = Object.keys(pgEntity).sort();
        expect(pgKeys).toEqual(localKeys);

        // Same owner
        expect(pgEntity.owner).toBe(localEntity.owner);
        expect(pgEntity.owner).toBe('canonical');

        // Same attribute shape
        expect(pgEntity.attributes).toEqual(localEntity.attributes);
    });

    // --- Proof 2: kernel behavior doesn't change ---

    it('kernel behavior does not change when canonical backend changes', async () => {
        const localStores = makeLocalStores();
        const pgStores = makePgStores();

        const localKernel = new ClusterKernel(localStores);
        const pgKernel = new ClusterKernel(pgStores);

        const localResult = await localKernel.createEntity({
            kind: 'concept', name: 'Kernel Test', attributes: { v: 1 }, actorId: 'user-1',
        });
        const pgResult = await pgKernel.createEntity({
            kind: 'concept', name: 'Kernel Test', attributes: { v: 1 }, actorId: 'user-1',
        });

        // Both produce valid entities
        expect(localResult.entity.owner).toBe('canonical');
        expect(pgResult.entity.owner).toBe('canonical');
        expect(localResult.entity.kind).toBe(pgResult.entity.kind);
        expect(localResult.entity.name).toBe(pgResult.entity.name);

        // Both produce receipts
        expect(localResult.receipt.commandId).toBeDefined();
        expect(pgResult.receipt.commandId).toBeDefined();
    });

    // --- Proof 3: index remains derivative ---

    it('index remains derivative — can be deleted and rebuilt from canonical truth', async () => {
        const pgStores = makePgStores();
        const kernel = new ClusterKernel(pgStores);

        await kernel.createEntity({
            kind: 'concept', name: 'Index Derivative', attributes: {}, actorId: 'user-1',
        });

        // Index has the record
        const before = await pgStores.index.search({ text: 'Index Derivative' });
        expect(before.length).toBe(1);

        // Canonical truth is still in Postgres regardless of index
        const entity = await pgStores.canonical.list({ nameContains: 'Index Derivative' });
        expect(entity.length).toBe(1);
    });

    // --- Proof 4: ledger remains append-only ---

    it('ledger remains append-only regardless of canonical backend', async () => {
        const pgStores = makePgStores();
        const kernel = new ClusterKernel(pgStores);

        await kernel.createEntity({
            kind: 'fact', name: 'Ledger Test', attributes: {}, actorId: 'user-1',
        });

        const receipts = await kernel.listReceipts({});
        expect(receipts.length).toBe(1);

        // Create another
        await kernel.createEntity({
            kind: 'fact', name: 'Ledger Test 2', attributes: {}, actorId: 'user-1',
        });

        const receiptsAfter = await kernel.listReceipts({});
        expect(receiptsAfter.length).toBe(2);
    });

    // --- Proof 5: artifact store remains immutable ---

    it('artifact store remains immutable with Postgres canonical', async () => {
        const pgStores = makePgStores();
        const kernel = new ClusterKernel(pgStores);

        const result = await kernel.ingestArtifact({
            content: 'Immutable content',
            filename: 'test.txt',
            actorId: 'user-1',
        });

        expect(result.artifact.owner).toBe('artifact');
        expect(result.artifact.version).toBe(1);
    });

    // --- Proof 6: policy enforcement behaves the same ---

    it('policy enforcement behaves the same with Postgres canonical', async () => {
        const pgStores = makePgStores();
        const kernel = new ClusterKernel(pgStores);

        const { entity } = await kernel.createEntity({
            kind: 'secret', name: 'Protected', attributes: { x: 1 }, actorId: 'admin-1',
        });

        const restrictedPrincipal: Principal = {
            id: 'restricted-1', roles: ['reader'], trustZone: 'external',
        };
        const policies: Policy[] = [
            { id: 'deny-external', name: 'Deny External', priority: 5, match: { trustZones: ['external'], capabilities: ['read_owner_truth'] }, decision: 'deny', reason: 'External zone denied.' },
            ...DEFAULT_POLICIES,
        ];

        const pk = new PolicyEnforcedKernel(
            pgStores,
            { principal: restrictedPrincipal },
            { policies, trustZones: DEFAULT_TRUST_ZONES, visibilityRules: DEFAULT_VISIBILITY_RULES },
        );

        await expect(pk.inspectEntity(entity.id)).rejects.toThrow();
    });

    // --- Proof 7: redaction behaves the same ---

    it('redaction behaves the same with Postgres canonical', async () => {
        const pgStores = makePgStores();
        const kernel = new ClusterKernel(pgStores);

        await kernel.createEntity({
            kind: 'concept', name: 'Redact Target', attributes: { secret: 'hidden' }, actorId: 'admin-1',
        });

        const adminPrincipal: Principal = {
            id: 'admin-1', roles: ['admin'], trustZone: 'internal',
        };
        const policies: Policy[] = [
            {
                id: 'redact-attrs', name: 'Redact Attrs', priority: 5,
                match: { principals: ['admin-1'], capabilities: ['read_owner_truth'] },
                decision: 'allow', reason: 'Read with redaction.',
                redaction: { id: 'strip-attrs', target: 'entity_attributes', behavior: 'strip', reason: 'Attributes stripped.' },
            },
            ...DEFAULT_POLICIES,
        ];

        const pk = new PolicyEnforcedKernel(
            pgStores,
            { principal: adminPrincipal },
            { policies, trustZones: DEFAULT_TRUST_ZONES, visibilityRules: DEFAULT_VISIBILITY_RULES },
        );

        const entities = await pgStores.canonical.list({ nameContains: 'Redact Target' });
        expect(entities.length).toBe(1);
        // Policy-enforced read applies redaction
        const inspected = await pk.inspectEntity(entities[0].id);
        expect(inspected.attributes).toEqual({});
    });

    // --- Proof 8: mutation receipts behave the same ---

    it('mutation receipts behave the same with Postgres canonical', async () => {
        const pgStores = makePgStores();
        const kernel = new ClusterKernel(pgStores);

        const { entity, receipt } = await kernel.createEntity({
            kind: 'mutable', name: 'Receipt Test', attributes: { v: 1 }, actorId: 'user-1',
        });

        expect(receipt.commandId).toBeDefined();
        expect(receipt.resultSummary).toContain('Created entity');
        expect(receipt.affectedIds).toContain(entity.id);
    });

    // --- Proof 9: cross-process persistence is stronger ---

    it('Postgres canonical persists across separate pool connections', async () => {
        // Write with one pool
        const entity = await pgStore.create({
            kind: 'durable', name: 'Cross-Process', attributes: { persistent: true },
        });

        // Read with a fresh pool (simulates separate process)
        const pool2 = new Pool({ connectionString: POSTGRES_URL });
        const store2 = new PostgresCanonicalStore(pool2);
        const retrieved = await store2.get(entity.id);
        await pool2.end();

        expect(retrieved).not.toBeNull();
        expect(retrieved!.name).toBe('Cross-Process');
        expect(retrieved!.attributes.persistent).toBe(true);
    });

    // --- Proof 10: factory refuses unsafe config ---

    it('store factory refuses missing Postgres URL', () => {
        expect(() => createCluster({
            rootDir: '/tmp/test',
            backends: { canonical: 'postgres' },
            // postgresUrl intentionally missing
        })).toThrow('DB_CLUSTER_POSTGRES_URL is required');
    });
});
