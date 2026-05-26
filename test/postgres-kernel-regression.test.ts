/**
 * Wave 5: Kernel regression against Postgres canonical.
 *
 * Runs existing cluster law behaviors with Postgres canonical + local artifact/index/ledger.
 * Requires DB_CLUSTER_POSTGRES_URL to be set.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { PostgresCanonicalStore } from '../src/adapters/postgres/postgres-canonical-store.js';
import { LocalArtifactStore } from '../src/adapters/local/local-artifact-store.js';
import { LocalIndexStore } from '../src/adapters/local/local-index-store.js';
import { LocalLedgerStore } from '../src/adapters/local/local-ledger-store.js';
import { ClusterKernel } from '../src/kernel/cluster-kernel.js';
import { PolicyEnforcedKernel } from '../src/kernel/policy-enforced-kernel.js';
import type { ClusterStores } from '../src/contracts/index.js';
import type { Principal, Policy, TrustZone, VisibilityRule } from '../src/types/policy.js';
import { DEFAULT_POLICIES, DEFAULT_TRUST_ZONES, DEFAULT_VISIBILITY_RULES } from '../src/policy/default-policies.js';

const POSTGRES_URL = process.env.DB_CLUSTER_POSTGRES_URL;
const describePostgres = POSTGRES_URL ? describe : describe.skip;

describePostgres('Wave 5 — Kernel regression against Postgres canonical', () => {
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

    function makeStores(): ClusterStores {
        const dir = mkdtempSync(join(tmpdir(), 'wave5-pg-'));
        return {
            canonical: pgStore,
            artifact: new LocalArtifactStore(join(dir, 'artifact')),
            index: new LocalIndexStore(join(dir, 'index')),
            ledger: new LocalLedgerStore(join(dir, 'ledger')),
        };
    }

    beforeEach(async () => {
        await pool.query('DELETE FROM canonical_entities');
    });

    // --- Proof 1: ingest artifact still works ---

    it('ingest artifact writes to local artifact store, not Postgres', async () => {
        const stores = makeStores();
        const kernel = new ClusterKernel(stores);

        const result = await kernel.ingestArtifact({
            content: 'Test document content',
            filename: 'test.md',
            actorId: 'user-1',
        });

        expect(result.artifact.id).toBeDefined();
        expect(result.artifact.owner).toBe('artifact');
        // Artifact is NOT in Postgres canonical
        const pgResult = await pool.query('SELECT count(*) FROM canonical_entities');
        expect(parseInt(pgResult.rows[0].count)).toBe(0);
    });

    // --- Proof 2: create entity writes to Postgres ---

    it('create entity writes to Postgres canonical store', async () => {
        const stores = makeStores();
        const kernel = new ClusterKernel(stores);

        const result = await kernel.createEntity({
            kind: 'concept',
            name: 'Postgres Entity',
            attributes: { source: 'regression' },
            actorId: 'user-1',
        });

        expect(result.entity.owner).toBe('canonical');
        // Verify directly in Postgres
        const pgResult = await pool.query(
            'SELECT id, kind, name FROM canonical_entities WHERE id = $1',
            [result.entity.id],
        );
        expect(pgResult.rows[0].name).toBe('Postgres Entity');
    });

    // --- Proof 3: find resolves owner truth from Postgres ---

    it('find resolves entities from Postgres canonical truth', async () => {
        const stores = makeStores();
        const kernel = new ClusterKernel(stores);

        await kernel.createEntity({
            kind: 'concept',
            name: 'Findable Thing',
            attributes: { x: 1 },
            actorId: 'user-1',
        });

        const result = await kernel.findSources({ query: 'Findable' });
        expect(result.indexRecords.length).toBeGreaterThan(0);
        expect(result.resolvedEntities.length).toBeGreaterThan(0);
        expect(result.resolvedEntities[0].owner).toBe('canonical');
    });

    // --- Proof 4: inspect reads Postgres canonical truth ---

    it('inspect reads Postgres canonical truth, not index', async () => {
        const stores = makeStores();
        const kernel = new ClusterKernel(stores);

        const { entity } = await kernel.createEntity({
            kind: 'fact',
            name: 'Direct Read Test',
            attributes: { secret: 'owner-truth' },
            actorId: 'user-1',
        });

        const inspected = await kernel.inspectEntity(entity.id);
        expect(inspected.owner).toBe('canonical');
        expect(inspected.attributes.secret).toBe('owner-truth');
    });

    // --- Proof 5: retrieve bundle includes Postgres-backed entity ---

    it('retrieve bundle resolves Postgres-backed canonical entity', async () => {
        const stores = makeStores();
        const kernel = new ClusterKernel(stores);

        await kernel.createEntity({
            kind: 'concept',
            name: 'Bundle Target',
            attributes: { bundled: true },
            actorId: 'user-1',
        });

        const bundle = await kernel.retrieveBundle('Bundle Target');
        expect(bundle.resolvedEntities.length).toBeGreaterThan(0);
        const resolved = bundle.resolvedEntities[0];
        expect(resolved.ownerStore).toBe('canonical');
        expect(resolved.object.owner).toBe('canonical');
        expect(resolved.object.attributes.bundled).toBe(true);
    });

    // --- Proof 6: trace graph includes Postgres-backed entity ---

    it('trace graph includes Postgres-backed entity', async () => {
        const stores = makeStores();
        const kernel = new ClusterKernel(stores);

        const { entity } = await kernel.createEntity({
            kind: 'concept',
            name: 'Trace Target',
            attributes: {},
            actorId: 'user-1',
        });

        const trace = await kernel.traceObject(`cluster://canonical/${entity.id}`);
        expect(trace.nodes.length).toBeGreaterThan(0);
        expect(trace.nodes.some((n) => n.uri === `cluster://canonical/${entity.id}`)).toBe(true);
    });

    // --- Proof 7: mutation lifecycle updates Postgres canonical truth ---

    it('mutation lifecycle updates Postgres canonical truth', async () => {
        const stores = makeStores();
        const kernel = new ClusterKernel(stores);

        const { entity } = await kernel.createEntity({
            kind: 'mutable',
            name: 'Before Mutation',
            attributes: { v: 1 },
            actorId: 'user-1',
        });

        // Propose mutation via command lifecycle
        const cmd = await kernel.proposeMutation({
            verb: 'update_entity',
            targetStore: 'canonical',
            payload: { entityId: entity.id, patch: { name: 'After Mutation', attributes: { v: 2 } } },
            proposedBy: 'user-1',
        });

        await kernel.commitMutation(cmd.id, 'user-1');

        // Verify Postgres has updated value
        const pgResult = await pool.query(
            'SELECT name FROM canonical_entities WHERE id = $1',
            [entity.id],
        );
        expect(pgResult.rows[0].name).toBe('After Mutation');
    });

    // --- Proof 8: receipts still live in ledger ---

    it('receipts from Postgres-backed mutations live in ledger, not Postgres', async () => {
        const stores = makeStores();
        const kernel = new ClusterKernel(stores);

        await kernel.createEntity({
            kind: 'receipt-test',
            name: 'Receipt Source',
            attributes: {},
            actorId: 'user-1',
        });

        const receipts = await kernel.listReceipts({});
        expect(receipts.length).toBeGreaterThan(0);
        // Receipts have commandId and committedAt — they live in ledger
        expect(receipts[0].commandId).toBeDefined();
        expect(receipts[0].committedAt).toBeDefined();
        // Postgres canonical table has no receipt rows
        const pgResult = await pool.query(
            "SELECT count(*) FROM canonical_entities WHERE kind = 'receipt'",
        );
        expect(parseInt(pgResult.rows[0].count)).toBe(0);
    });

    // --- Proof 9: policy denies/redacts Postgres-backed entity correctly ---

    it('policy denies read of Postgres-backed entity for restricted principal', async () => {
        const stores = makeStores();
        const kernel = new ClusterKernel(stores);

        const { entity } = await kernel.createEntity({
            kind: 'secret',
            name: 'Classified Entity',
            attributes: { classified: true },
            actorId: 'admin-1',
        });

        const restrictedPrincipal: Principal = {
            id: 'restricted-1',
            roles: ['reader'],
            trustZone: 'external',
        };

        const policies: Policy[] = [
            {
                id: 'deny-external-secrets',
                name: 'Deny External Secrets',
                priority: 5,
                match: { trustZones: ['external'], capabilities: ['read_owner_truth'] },
                decision: 'deny',
                reason: 'External zone denied.',
            },
            ...DEFAULT_POLICIES,
        ];

        const pk = new PolicyEnforcedKernel(
            stores,
            { principal: restrictedPrincipal },
            { policies, trustZones: DEFAULT_TRUST_ZONES, visibilityRules: DEFAULT_VISIBILITY_RULES },
        );

        await expect(pk.inspectEntity(entity.id)).rejects.toThrow();
    });
});
