/**
 * Wave 2+3: PostgresCanonicalStore — schema and contract parity tests.
 * 
 * These tests require a running Postgres instance.
 * Set DB_CLUSTER_POSTGRES_URL to run them.
 * Skipped gracefully when no Postgres is available.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { PostgresCanonicalStore } from '../src/adapters/postgres/postgres-canonical-store.js';

const POSTGRES_URL = process.env.DB_CLUSTER_POSTGRES_URL;

const describePostgres = POSTGRES_URL ? describe : describe.skip;

describePostgres('PostgresCanonicalStore — contract parity', () => {
    let pool: Pool;
    let store: PostgresCanonicalStore;

    beforeAll(async () => {
        pool = new Pool({ connectionString: POSTGRES_URL });
        store = new PostgresCanonicalStore(pool);
        await store.migrate();
    });

    afterAll(async () => {
        await store.teardown();
        await pool.end();
    });

    beforeEach(async () => {
        // Clean table between tests for isolation
        await pool.query('DELETE FROM canonical_entities');
    });

    // --- Schema proofs ---

    it('schema creates cleanly (migrate is idempotent)', async () => {
        // Running migrate again should not throw
        await expect(store.migrate()).resolves.not.toThrow();
    });

    // --- Create proofs ---

    it('create returns entity with all required fields', async () => {
        const entity = await store.create({
            kind: 'concept',
            name: 'Test Entity',
            attributes: { color: 'blue', score: 42 },
        });

        expect(entity.id).toMatch(/^[0-9a-f-]{36}$/);
        expect(entity.kind).toBe('concept');
        expect(entity.name).toBe('Test Entity');
        expect(entity.attributes).toEqual({ color: 'blue', score: 42 });
        expect(entity.owner).toBe('canonical');
        expect(entity.createdAt).toBeDefined();
        expect(entity.updatedAt).toBeDefined();
    });

    it('entity rows preserve owner = canonical', async () => {
        const entity = await store.create({
            kind: 'fact',
            name: 'Owner Test',
            attributes: {},
        });
        expect(entity.owner).toBe('canonical');

        // Verify directly in DB
        const result = await pool.query(
            'SELECT owner FROM canonical_entities WHERE id = $1',
            [entity.id],
        );
        expect(result.rows[0].owner).toBe('canonical');
    });

    it('attributes roundtrip complex JSON', async () => {
        const complex = {
            nested: { deep: { array: [1, 2, 3] } },
            nullVal: null,
            bool: true,
            str: 'hello "quoted"',
        };
        const entity = await store.create({
            kind: 'data',
            name: 'Complex Attrs',
            attributes: complex,
        });

        const retrieved = await store.get(entity.id);
        expect(retrieved?.attributes).toEqual(complex);
    });

    it('timestamps are valid ISO strings', async () => {
        const entity = await store.create({
            kind: 'temporal',
            name: 'Time Test',
            attributes: {},
        });

        const created = new Date(entity.createdAt);
        const updated = new Date(entity.updatedAt);
        expect(created.getTime()).not.toBeNaN();
        expect(updated.getTime()).not.toBeNaN();
        expect(created.getTime()).toBeLessThanOrEqual(Date.now());
    });

    // --- Get proofs ---

    it('get returns null for non-existent entity', async () => {
        const result = await store.get('00000000-0000-0000-0000-000000000000');
        expect(result).toBeNull();
    });

    it('get retrieves created entity', async () => {
        const created = await store.create({
            kind: 'item',
            name: 'Get Me',
            attributes: { x: 1 },
        });
        const retrieved = await store.get(created.id);
        expect(retrieved).toEqual(created);
    });

    // --- Exists proofs ---

    it('exists returns false for missing entity', async () => {
        const result = await store.exists('00000000-0000-0000-0000-000000000000');
        expect(result).toBe(false);
    });

    it('exists returns true for created entity', async () => {
        const entity = await store.create({
            kind: 'check',
            name: 'Exists Test',
            attributes: {},
        });
        expect(await store.exists(entity.id)).toBe(true);
    });

    // --- List proofs ---

    it('list returns all entities', async () => {
        await store.create({ kind: 'a', name: 'One', attributes: {} });
        await store.create({ kind: 'b', name: 'Two', attributes: {} });

        const all = await store.list();
        expect(all.length).toBe(2);
    });

    it('list filters by kind', async () => {
        await store.create({ kind: 'alpha', name: 'A1', attributes: {} });
        await store.create({ kind: 'beta', name: 'B1', attributes: {} });
        await store.create({ kind: 'alpha', name: 'A2', attributes: {} });

        const alphas = await store.list({ kind: 'alpha' });
        expect(alphas.length).toBe(2);
        expect(alphas.every((e) => e.kind === 'alpha')).toBe(true);
    });

    it('list filters by nameContains (case-insensitive)', async () => {
        await store.create({ kind: 'x', name: 'Hello World', attributes: {} });
        await store.create({ kind: 'x', name: 'Goodbye', attributes: {} });

        const results = await store.list({ nameContains: 'hello' });
        expect(results.length).toBe(1);
        expect(results[0].name).toBe('Hello World');
    });

    it('list respects limit', async () => {
        await store.create({ kind: 'x', name: 'A', attributes: {} });
        await store.create({ kind: 'x', name: 'B', attributes: {} });
        await store.create({ kind: 'x', name: 'C', attributes: {} });

        const results = await store.list({ limit: 2 });
        expect(results.length).toBe(2);
    });

    it('list with stable ordering (createdAt ASC)', async () => {
        const e1 = await store.create({ kind: 'x', name: 'First', attributes: {} });
        const e2 = await store.create({ kind: 'x', name: 'Second', attributes: {} });

        const results = await store.list();
        expect(results[0].id).toBe(e1.id);
        expect(results[1].id).toBe(e2.id);
    });

    // --- Update proofs ---

    it('update changes name', async () => {
        const entity = await store.create({
            kind: 'mutable',
            name: 'Original',
            attributes: { v: 1 },
        });

        const updated = await store.update(entity.id, { name: 'Renamed' });
        expect(updated.name).toBe('Renamed');
        expect(updated.attributes).toEqual({ v: 1 }); // unchanged
        expect(new Date(updated.updatedAt).getTime()).toBeGreaterThanOrEqual(
            new Date(entity.updatedAt).getTime(),
        );
    });

    it('update changes attributes', async () => {
        const entity = await store.create({
            kind: 'mutable',
            name: 'AttrTest',
            attributes: { old: true },
        });

        const updated = await store.update(entity.id, { attributes: { new: true } });
        expect(updated.attributes).toEqual({ new: true });
        expect(updated.name).toBe('AttrTest'); // unchanged
    });

    it('update throws for non-existent entity', async () => {
        await expect(
            store.update('00000000-0000-0000-0000-000000000000', { name: 'Nope' }),
        ).rejects.toThrow('Entity not found');
    });

    // --- Behavioral parity proofs ---

    it('entity shape matches Entity type exactly', async () => {
        const entity = await store.create({
            kind: 'shape',
            name: 'Shape Test',
            attributes: { a: 1 },
        });

        const keys = Object.keys(entity).sort();
        expect(keys).toEqual([
            'attributes', 'createdAt', 'id', 'kind', 'name', 'owner', 'updatedAt',
        ]);
    });

    it('empty attributes roundtrip as empty object', async () => {
        const entity = await store.create({
            kind: 'empty',
            name: 'No Attrs',
            attributes: {},
        });
        const retrieved = await store.get(entity.id);
        expect(retrieved?.attributes).toEqual({});
    });
});
