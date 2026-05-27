/**
 * SQL injection resistance tests (TESTS-002).
 *
 * The Postgres canonical store is parameterized today — these tests are the
 * regression net for that invariant. They probe the surfaces an attacker
 * could reach (create, update, list with `nameContains`) with classic
 * injection payloads and verify the payloads land as inert data, not as
 * executed SQL.
 *
 * Postgres-gated. Skip with a clear message when DB_CLUSTER_POSTGRES_URL
 * is absent. To run locally:
 *   DB_CLUSTER_POSTGRES_URL=postgres://... npm test sql-injection
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { PostgresCanonicalStore } from '../src/adapters/postgres/postgres-canonical-store.js';
import { CANONICAL_TABLE } from '../src/adapters/postgres/schema.js';

const POSTGRES_URL = process.env.DB_CLUSTER_POSTGRES_URL;
const describePostgres = POSTGRES_URL ? describe : describe.skip;

if (!POSTGRES_URL) {
    // eslint-disable-next-line no-console
    console.log(
        '[sql-injection.test.ts] DB_CLUSTER_POSTGRES_URL not set — skipping. ' +
            'These tests verify SQL is parameterized; running them locally requires Postgres.',
    );
}

describePostgres('SQL injection resistance — Postgres canonical store', () => {
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
        await pool.query(`DELETE FROM ${CANONICAL_TABLE}`);
    });

    it('classic DROP TABLE payload in entity.name is stored verbatim, table survives', async () => {
        const payload = `'; DROP TABLE ${CANONICAL_TABLE}; --`;

        const created = await store.create({
            kind: 'attack',
            name: payload,
            attributes: { source: 'injection-test' },
        });

        expect(created.name).toBe(payload);

        // Table must still exist (a successful injection would have dropped it).
        const tableExists = await pool.query(
            `SELECT to_regclass($1) AS reg`,
            [CANONICAL_TABLE],
        );
        expect(tableExists.rows[0].reg).toBe(CANONICAL_TABLE);

        // The row is stored as data, not SQL.
        const reread = await store.get(created.id);
        expect(reread).not.toBeNull();
        expect(reread!.name).toBe(payload);
    });

    it('nested SQL payloads in attributes are stored as JSON data, not executed', async () => {
        const attributes = {
            query: `1 UNION SELECT * FROM ${CANONICAL_TABLE}`,
            comment: `-- '; UPDATE ${CANONICAL_TABLE} SET name='pwned'; --`,
            nested: {
                inner: `' OR '1'='1`,
            },
        };

        const created = await store.create({
            kind: 'attack',
            name: 'attribute-attack',
            attributes,
        });

        const reread = await store.get(created.id);
        expect(reread).not.toBeNull();
        expect(reread!.attributes).toEqual(attributes);

        // No other row should have been mutated.
        const all = await store.list();
        expect(all).toHaveLength(1);
        expect(all[0].name).toBe('attribute-attack');
    });

    it("list({nameContains: \"' OR '1'='1\"}) does not match unrelated rows", async () => {
        // Seed two unrelated rows.
        await store.create({ kind: 'doc', name: 'alpha', attributes: {} });
        await store.create({ kind: 'doc', name: 'beta', attributes: {} });

        // A successful injection here would return all rows.
        const results = await store.list({ nameContains: `' OR '1'='1` });

        // The literal substring should not appear in any of our seeded names,
        // so the only correct answer is zero matches.
        expect(results).toHaveLength(0);

        // Sanity: a normal substring still works.
        const normal = await store.list({ nameContains: 'alpha' });
        expect(normal.map((r) => r.name)).toContain('alpha');
    });

    it('payloads in update() patch are escaped, no table-wide UPDATE happens', async () => {
        const a = await store.create({ kind: 'doc', name: 'name-A', attributes: { v: 1 } });
        const b = await store.create({ kind: 'doc', name: 'name-B', attributes: { v: 2 } });

        // Try to update one row with a payload that would mutate all rows
        // if it were interpolated rather than parameterized.
        const payload = `pwned' WHERE 1=1; UPDATE ${CANONICAL_TABLE} SET name='hacked`;
        await store.update(a.id, { name: payload });

        const aAfter = await store.get(a.id);
        const bAfter = await store.get(b.id);

        // a got the literal string; b is untouched.
        expect(aAfter!.name).toBe(payload);
        expect(bAfter!.name).toBe('name-B');
        expect(bAfter!.attributes).toEqual({ v: 2 });
    });

    it('importSnapshot with payload-laden fields stores verbatim', async () => {
        const malicious = {
            id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
            kind: `'; DROP TABLE ${CANONICAL_TABLE}; --`,
            name: `'); DELETE FROM ${CANONICAL_TABLE}; --`,
            attributes: { x: `' OR 1=1; --` },
            owner: 'canonical' as const,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };

        const imported = await store.importSnapshot(malicious);
        expect(imported.kind).toBe(malicious.kind);
        expect(imported.name).toBe(malicious.name);

        // Table still exists, row count is exactly 1.
        const all = await store.list();
        expect(all).toHaveLength(1);
        expect(all[0].id).toBe(malicious.id);
    });
});
