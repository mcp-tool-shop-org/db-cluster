/**
 * Coverage — PostgresCanonicalStore unit tests against an in-test pool.
 *
 * The store takes an injected pg Pool, so its logic (which SQL it issues,
 * which parameters it binds, how rows map back to entities, how failures
 * surface) is tested here without a server. The fake pool records every
 * statement and answers from a scripted queue. These tests say nothing about
 * what Postgres does with the SQL; that is what the server-backed contract
 * tests in postgres-canonical-store.test.ts (skipped without
 * DB_CLUSTER_POSTGRES_URL) are for.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { Pool } from 'pg';
import { PostgresCanonicalStore } from '../src/adapters/postgres/postgres-canonical-store.js';
import {
    CANONICAL_TABLE,
    CREATE_TABLE_SQL,
    DROP_TABLE_SQL,
    ADD_VERSION_COLUMN_SQL,
} from '../src/adapters/postgres/schema.js';
import type { Entity } from '../src/types/entity.js';

interface Call { sql: string; params: unknown[] | undefined }

class FakePool {
    public calls: Call[] = [];
    private script: Array<{ rows: Array<Record<string, unknown>> } | Error> = [];

    /** Queue the next response (a result set or an error to throw). */
    enqueue(...responses: Array<Array<Record<string, unknown>> | Error>): this {
        for (const r of responses) this.script.push(r instanceof Error ? r : { rows: r });
        return this;
    }

    async query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> {
        this.calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
        const next = this.script.shift();
        if (next === undefined) return { rows: [] };
        if (next instanceof Error) throw next;
        return next;
    }
}

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: '11111111-1111-1111-1111-111111111111',
        version: '1', // pg returns int columns as numbers, but the mapper must coerce either way
        kind: 'concept',
        name: 'Alpha',
        attributes: { color: 'blue' },
        owner: 'canonical',
        created_at: new Date('2026-01-02T03:04:05.000Z'),
        updated_at: new Date('2026-02-03T04:05:06.000Z'),
        ...overrides,
    };
}

describe('PostgresCanonicalStore (fake pool)', () => {
    let pool: FakePool;
    let store: PostgresCanonicalStore;

    beforeEach(() => {
        pool = new FakePool();
        store = new PostgresCanonicalStore(pool as unknown as Pool);
    });

    describe('reads', () => {
        it('get() selects the latest version by id and maps the row to an Entity', async () => {
            pool.enqueue([row()]);
            const entity = await store.get('abc');
            expect(pool.calls).toHaveLength(1);
            expect(pool.calls[0].sql).toBe(
                `SELECT id, version, kind, name, attributes, owner, created_at, updated_at FROM ${CANONICAL_TABLE} WHERE id = $1 ORDER BY version DESC LIMIT 1`,
            );
            expect(pool.calls[0].params).toEqual(['abc']);
            expect(entity).toEqual({
                id: '11111111-1111-1111-1111-111111111111',
                kind: 'concept',
                name: 'Alpha',
                attributes: { color: 'blue' },
                version: 1,
                owner: 'canonical',
                createdAt: '2026-01-02T03:04:05.000Z',
                updatedAt: '2026-02-03T04:05:06.000Z',
            });
        });

        it('get() returns null when no row exists', async () => {
            pool.enqueue([]);
            expect(await store.get('missing')).toBeNull();
        });

        it('parses attributes that arrive as a JSON string', async () => {
            pool.enqueue([row({ attributes: '{"n":42,"nested":{"ok":true}}' })]);
            const entity = await store.get('abc');
            expect(entity?.attributes).toEqual({ n: 42, nested: { ok: true } });
        });

        it('a malformed JSON attributes string surfaces as a SyntaxError rather than a silent empty object', async () => {
            pool.enqueue([row({ attributes: '{not json' })]);
            await expect(store.get('abc')).rejects.toBeInstanceOf(SyntaxError);
        });

        it('exists() issues a parameterised probe and maps row presence to a boolean', async () => {
            pool.enqueue([{ '?column?': 1 }], []);
            expect(await store.exists('here')).toBe(true);
            expect(await store.exists('gone')).toBe(false);
            expect(pool.calls[0].sql).toBe(`SELECT 1 FROM ${CANONICAL_TABLE} WHERE id = $1 LIMIT 1`);
            expect(pool.calls.map((c) => c.params)).toEqual([['here'], ['gone']]);
        });

        it('listVersions() orders ascending and getVersion() filters by both id and version', async () => {
            pool.enqueue(
                [row({ version: 1 }), row({ version: 2, name: 'Alpha v2' })],
                [row({ version: 2, name: 'Alpha v2' })],
                [],
            );
            const versions = await store.listVersions('abc');
            expect(versions.map((v) => [v.version, v.name])).toEqual([[1, 'Alpha'], [2, 'Alpha v2']]);
            expect(pool.calls[0].sql).toContain('WHERE id = $1 ORDER BY version ASC');

            const v2 = await store.getVersion('abc', 2);
            expect(v2?.version).toBe(2);
            expect(pool.calls[1].sql).toContain('WHERE id = $1 AND version = $2');
            expect(pool.calls[1].params).toEqual(['abc', 2]);

            expect(await store.getVersion('abc', 9)).toBeNull();
        });
    });

    describe('list()', () => {
        it('with no filter selects the latest version of each id, ordered by creation, with no parameters', async () => {
            pool.enqueue([row(), row({ id: '22222222-2222-2222-2222-222222222222', name: 'Beta' })]);
            const entities = await store.list();
            expect(pool.calls[0].params).toEqual([]);
            expect(pool.calls[0].sql).toContain(`SELECT DISTINCT ON (id)`);
            expect(pool.calls[0].sql).toContain(`FROM ${CANONICAL_TABLE} ORDER BY id, version DESC`);
            expect(pool.calls[0].sql).toContain(') latest ORDER BY created_at ASC');
            expect(pool.calls[0].sql).not.toContain('WHERE');
            expect(pool.calls[0].sql).not.toContain('LIMIT');
            expect(entities.map((e) => e.name)).toEqual(['Alpha', 'Beta']);
        });

        it('binds kind, a lower-cased name pattern and the limit as numbered parameters in order', async () => {
            pool.enqueue([row()]);
            await store.list({ kind: 'concept', nameContains: 'AlPhA', limit: 5 });
            const { sql, params } = pool.calls[0];
            expect(sql).toContain('WHERE kind = $1 AND LOWER(name) LIKE $2');
            expect(sql.endsWith('LIMIT $3')).toBe(true);
            expect(params).toEqual(['concept', '%alpha%', 5]);
        });

        it('numbers parameters from $1 when only some filters are present', async () => {
            pool.enqueue([], []);
            await store.list({ nameContains: 'x' });
            expect(pool.calls[0].sql).toContain('WHERE LOWER(name) LIKE $1');
            expect(pool.calls[0].params).toEqual(['%x%']);

            await store.list({ limit: 2 });
            expect(pool.calls[1].sql).not.toContain('WHERE');
            expect(pool.calls[1].sql.endsWith('LIMIT $1')).toBe(true);
            expect(pool.calls[1].params).toEqual([2]);
        });

        it('never interpolates filter values into the SQL text', async () => {
            pool.enqueue([]);
            await store.list({ kind: "x'; DROP TABLE canonical_entities; --", nameContains: "y'--" });
            expect(pool.calls[0].sql).not.toContain('DROP TABLE');
            expect(pool.calls[0].sql).not.toContain("y'--");
            expect(pool.calls[0].params).toEqual(["x'; DROP TABLE canonical_entities; --", "%y'--%"]);
        });
    });

    describe('create()', () => {
        it('inserts version 1 with a generated uuid and serialised attributes, and returns the stored row', async () => {
            pool.enqueue([row({ kind: 'person', name: 'Ada', attributes: { role: 'eng' } })]);
            const entity = await store.create({ kind: 'person', name: 'Ada', attributes: { role: 'eng' } });
            const { sql, params } = pool.calls[0];
            expect(sql).toContain(`INSERT INTO ${CANONICAL_TABLE}`);
            expect(sql).toContain(`VALUES ($1, 1, $2, $3, $4, 'canonical', $5, $5) RETURNING`);
            expect(params![0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
            expect(params!.slice(1, 4)).toEqual(['person', 'Ada', JSON.stringify({ role: 'eng' })]);
            expect(new Date(params![4] as string).toISOString()).toBe(params![4]);
            expect(entity).toMatchObject({ kind: 'person', name: 'Ada', owner: 'canonical', version: 1 });
        });

        it('propagates a database error unchanged', async () => {
            const failure = Object.assign(new Error('connection terminated'), { code: '57P01' });
            pool.enqueue(failure);
            await expect(store.create({ kind: 'k', name: 'n', attributes: {} })).rejects.toBe(failure);
        });
    });

    describe('update()', () => {
        it('reads the latest version then inserts max(version)+1 carrying forward kind and createdAt', async () => {
            const latest = row({ version: 3, name: 'Old', attributes: { keep: 1 } });
            pool.enqueue([latest], [row({ version: 4, name: 'New', attributes: { keep: 1 } })]);
            const updated = await store.update('abc', { name: 'New' });
            expect(pool.calls).toHaveLength(2);
            expect(pool.calls[0].sql).toContain('ORDER BY version DESC LIMIT 1');
            const insert = pool.calls[1];
            expect(insert.sql).toContain(`INSERT INTO ${CANONICAL_TABLE}`);
            expect(insert.sql).toContain('COALESCE(MAX(version), 0) + 1');
            expect(insert.sql).toContain(`FROM ${CANONICAL_TABLE} WHERE id = $1 RETURNING`);
            expect(insert.params![0]).toBe('abc');
            expect(insert.params![1]).toBe('concept');            // kind carried forward
            expect(insert.params![2]).toBe('New');                // patched name
            expect(insert.params![3]).toBe(JSON.stringify({ keep: 1 })); // attributes untouched
            expect(insert.params![4]).toBe('2026-01-02T03:04:05.000Z');  // created_at carried forward
            expect(updated.version).toBe(4);
        });

        it('replaces attributes wholesale when the patch supplies them and keeps the name otherwise', async () => {
            pool.enqueue([row()], [row({ version: 2, attributes: { fresh: true } })]);
            await store.update('abc', { attributes: { fresh: true } });
            const insert = pool.calls[1];
            expect(insert.params![2]).toBe('Alpha');
            expect(insert.params![3]).toBe(JSON.stringify({ fresh: true }));
        });

        it('an explicitly empty-string name is a real patch, not "unchanged"', async () => {
            pool.enqueue([row()], [row({ version: 2, name: '' })]);
            await store.update('abc', { name: '' });
            expect(pool.calls[1].params![2]).toBe('');
        });

        it('throws when the entity does not exist and issues no INSERT', async () => {
            pool.enqueue([]);
            await expect(store.update('ghost', { name: 'x' })).rejects.toThrow('Entity not found: ghost');
            expect(pool.calls).toHaveLength(1);
        });

        it('throws when the row vanishes between the read and the INSERT', async () => {
            pool.enqueue([row()], []);
            await expect(store.update('abc', { name: 'x' })).rejects.toThrow('Entity not found: abc');
            expect(pool.calls).toHaveLength(2);
        });

        it('surfaces a unique-violation from a concurrent writer to the caller', async () => {
            const conflict = Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
            pool.enqueue([row()], conflict);
            await expect(store.update('abc', { name: 'x' })).rejects.toBe(conflict);
        });
    });

    describe('importSnapshot()', () => {
        const snapshot: Entity = {
            id: '33333333-3333-3333-3333-333333333333',
            kind: 'concept',
            name: 'Imported',
            attributes: { src: 'backup' },
            version: 7,
            owner: 'canonical',
            createdAt: '2026-03-01T00:00:00.000Z',
            updatedAt: '2026-03-02T00:00:00.000Z',
        };

        it('inserts with the original id, version and timestamps and does nothing on conflict', async () => {
            pool.enqueue([row({ id: snapshot.id, version: 7, name: 'Imported' })]);
            const result = await store.importSnapshot(snapshot);
            expect(pool.calls).toHaveLength(1);
            expect(pool.calls[0].sql).toContain('ON CONFLICT (id, version) DO NOTHING RETURNING');
            expect(pool.calls[0].params).toEqual([
                snapshot.id, 7, 'concept', 'Imported', JSON.stringify({ src: 'backup' }),
                '2026-03-01T00:00:00.000Z', '2026-03-02T00:00:00.000Z',
            ]);
            expect(result.version).toBe(7);
        });

        it('defaults a snapshot with no version to 1', async () => {
            pool.enqueue([row({ version: 1 })]);
            const { version: _omit, ...noVersion } = snapshot;
            await store.importSnapshot(noVersion as unknown as Entity);
            expect(pool.calls[0].params![1]).toBe(1);
        });

        it('on conflict reads the existing (id, version) back and returns it (idempotent re-import)', async () => {
            pool.enqueue([], [row({ id: snapshot.id, version: 7, name: 'Already There' })]);
            const result = await store.importSnapshot(snapshot);
            expect(pool.calls).toHaveLength(2);
            expect(pool.calls[1].sql).toContain('WHERE id = $1 AND version = $2');
            expect(pool.calls[1].params).toEqual([snapshot.id, 7]);
            expect(result.name).toBe('Already There');
        });

        it('throws when the conflicting row cannot be read back', async () => {
            pool.enqueue([], []);
            await expect(store.importSnapshot(snapshot)).rejects.toThrow(
                `importSnapshot: ON CONFLICT skipped insert for id=${snapshot.id} version=7 but the conflicting row could not be read back.`,
            );
        });
    });

    describe('migrate() and teardown()', () => {
        it('migrate() runs migration 001 then 002, in that order', async () => {
            await store.migrate();
            expect(pool.calls.map((c) => c.sql)).toEqual([
                CREATE_TABLE_SQL.replace(/\s+/g, ' ').trim(),
                ADD_VERSION_COLUMN_SQL.replace(/\s+/g, ' ').trim(),
            ]);
            expect(pool.calls[0].sql).toContain(`CREATE TABLE IF NOT EXISTS ${CANONICAL_TABLE}`);
            expect(pool.calls[0].sql).toContain('PRIMARY KEY (id, version)');
        });

        it('migrate() stops at the first failing migration', async () => {
            pool.enqueue(new Error('permission denied for schema public'));
            await expect(store.migrate()).rejects.toThrow('permission denied');
            expect(pool.calls).toHaveLength(1);
        });

        it('teardown() drops the table with the migration-001 down statement', async () => {
            await store.teardown();
            expect(pool.calls).toHaveLength(1);
            expect(pool.calls[0].sql).toBe(DROP_TABLE_SQL.trim());
        });
    });
});
