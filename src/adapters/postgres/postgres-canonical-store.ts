/**
 * PostgresCanonicalStore — Postgres-backed implementation of CanonicalStore contract.
 * Implements the same interface as LocalCanonicalStore. The kernel cannot tell them apart.
 *
 * Wave S2-A1 (PROV-002) — append-a-version semantics, IDENTICAL to
 * LocalCanonicalStore:
 *  - One entity `id` owns MANY immutable rows, one per `version` (≥1).
 *  - `create()` INSERTs version 1.
 *  - `update(id, patch)` reads the latest version, merges `patch` on top, and
 *    INSERTs a NEW row at `max(version)+1`. Prior rows are RETAINED — nothing
 *    is mutated or deleted in place.
 *  - `get(id)` returns the LATEST version (`ORDER BY version DESC LIMIT 1`).
 *  - `list()` returns the latest version of each matching id.
 *  - `listVersions(id)` returns all versions ascending; `getVersion(id, n)`
 *    fetches one.
 *  - `importSnapshot()` preserves the incoming `version` verbatim.
 *
 * Every query is parameterized (`$1, $2, …`); no string-concatenated SQL and
 * no interpolated identifiers from untrusted input. The only interpolated
 * token is the compile-time `CANONICAL_TABLE` constant.
 */

import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { Entity } from '../../types/entity.js';
import type { CanonicalStore, EntityFilter } from '../../contracts/canonical-store.js';
import { CANONICAL_TABLE } from './schema.js';

/** Column list shared by every SELECT/INSERT … RETURNING so the row shape
 *  rowToEntity consumes stays in one place. */
const COLUMNS = 'id, version, kind, name, attributes, owner, created_at, updated_at';

export class PostgresCanonicalStore implements CanonicalStore {
    private readonly pool: Pool;

    constructor(pool: Pool) {
        this.pool = pool;
    }

    async get(id: string): Promise<Entity | null> {
        // Latest version of this id.
        const result = await this.pool.query(
            `SELECT ${COLUMNS} FROM ${CANONICAL_TABLE} WHERE id = $1 ORDER BY version DESC LIMIT 1`,
            [id],
        );
        if (result.rows.length === 0) return null;
        return this.rowToEntity(result.rows[0]);
    }

    async list(filter?: EntityFilter): Promise<Entity[]> {
        const conditions: string[] = [];
        const params: unknown[] = [];
        let paramIndex = 1;

        if (filter?.kind) {
            conditions.push(`kind = $${paramIndex++}`);
            params.push(filter.kind);
        }
        if (filter?.nameContains) {
            conditions.push(`LOWER(name) LIKE $${paramIndex++}`);
            params.push(`%${filter.nameContains.toLowerCase()}%`);
        }

        const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';

        // Return the LATEST version of each id (parity with the local store,
        // whose Map is keyed by id and therefore yields one entity per id).
        // DISTINCT ON (id) with `ORDER BY id, version DESC` picks the highest
        // version per id; the outer query re-orders by created_at for stable,
        // creation-ordered output and applies the limit.
        let sql =
            `SELECT ${COLUMNS} FROM (` +
            `SELECT DISTINCT ON (id) ${COLUMNS} FROM ${CANONICAL_TABLE}${where} ` +
            `ORDER BY id, version DESC` +
            `) latest ORDER BY created_at ASC`;
        if (filter?.limit) {
            sql += ` LIMIT $${paramIndex++}`;
            params.push(filter.limit);
        }

        const result = await this.pool.query(sql, params);
        return result.rows.map((row) => this.rowToEntity(row));
    }

    async exists(id: string): Promise<boolean> {
        const result = await this.pool.query(
            `SELECT 1 FROM ${CANONICAL_TABLE} WHERE id = $1 LIMIT 1`,
            [id],
        );
        return result.rows.length > 0;
    }

    async create(
        input: Omit<Entity, 'id' | 'version' | 'createdAt' | 'updatedAt' | 'owner'>,
    ): Promise<Entity> {
        const id = randomUUID();
        const now = new Date().toISOString();
        // A freshly created entity is its own first version (version=1).
        const result = await this.pool.query(
            `INSERT INTO ${CANONICAL_TABLE} (id, version, kind, name, attributes, owner, created_at, updated_at)
             VALUES ($1, 1, $2, $3, $4, 'canonical', $5, $5)
             RETURNING ${COLUMNS}`,
            [id, input.kind, input.name, JSON.stringify(input.attributes), now],
        );
        return this.rowToEntity(result.rows[0]);
    }

    async update(
        id: string,
        patch: Partial<Pick<Entity, 'name' | 'attributes'>>,
    ): Promise<Entity> {
        // Read the current latest version to merge the patch onto AND to carry
        // forward the immutable id/kind/created_at. Throws NotFoundError-parity
        // (plain Error) when no version exists, matching the local store.
        const latest = await this.get(id);
        if (!latest) {
            throw new Error(`Entity not found: ${id}`);
        }

        const mergedName = patch.name !== undefined ? patch.name : latest.name;
        const mergedAttributes =
            patch.attributes !== undefined ? patch.attributes : latest.attributes;
        const now = new Date().toISOString();

        // INSERT a NEW row at max(version)+1 carrying the merged fields. The
        // version is computed inside SQL from the live max so a concurrent
        // writer can't collide on the same version (the composite PK would
        // reject a duplicate, surfacing as a unique-violation the caller can
        // retry). id/kind/created_at carry forward unchanged; updated_at is
        // restamped. Fully parameterized.
        const result = await this.pool.query(
            `INSERT INTO ${CANONICAL_TABLE} (id, version, kind, name, attributes, owner, created_at, updated_at)
             SELECT $1,
                    COALESCE(MAX(version), 0) + 1,
                    $2, $3, $4, 'canonical', $5, $6
             FROM ${CANONICAL_TABLE} WHERE id = $1
             RETURNING ${COLUMNS}`,
            [
                id,
                latest.kind,
                mergedName,
                JSON.stringify(mergedAttributes),
                latest.createdAt,
                now,
            ],
        );
        if (result.rows.length === 0) {
            // The id existed at get() time but vanished before the INSERT's
            // SELECT (concurrent teardown). Surface loudly rather than return
            // a malformed entity.
            throw new Error(`Entity not found: ${id}`);
        }
        return this.rowToEntity(result.rows[0]);
    }

    async listVersions(id: string): Promise<Entity[]> {
        const result = await this.pool.query(
            `SELECT ${COLUMNS} FROM ${CANONICAL_TABLE} WHERE id = $1 ORDER BY version ASC`,
            [id],
        );
        return result.rows.map((row) => this.rowToEntity(row));
    }

    async getVersion(id: string, version: number): Promise<Entity | null> {
        const result = await this.pool.query(
            `SELECT ${COLUMNS} FROM ${CANONICAL_TABLE} WHERE id = $1 AND version = $2`,
            [id, version],
        );
        if (result.rows.length === 0) return null;
        return this.rowToEntity(result.rows[0]);
    }

    /**
     * Import a full entity snapshot preserving original id, version, createdAt,
     * updatedAt. Used by restore so that re-runs are idempotent and provenance
     * events that cite the original subjectId still resolve (STORES-001).
     *
     * The incoming `version` is preserved verbatim (default 1 only if the
     * snapshot somehow lacks one — every Entity now carries version). The
     * composite PK is `(id, version)`, so idempotency keys on the
     * `(id, version)` pair: re-importing the same version is a no-op; importing
     * a NEW version of an existing id appends it (matching append-a-version).
     */
    async importSnapshot(entity: Entity): Promise<Entity> {
        const version = entity.version ?? 1;
        const insertResult = await this.pool.query(
            `INSERT INTO ${CANONICAL_TABLE} (id, version, kind, name, attributes, owner, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, 'canonical', $6, $7)
             ON CONFLICT (id, version) DO NOTHING
             RETURNING ${COLUMNS}`,
            [
                entity.id,
                version,
                entity.kind,
                entity.name,
                JSON.stringify(entity.attributes),
                entity.createdAt,
                entity.updatedAt,
            ],
        );
        if (insertResult.rows.length > 0) {
            return this.rowToEntity(insertResult.rows[0]);
        }
        // Conflict — that (id, version) already exists. Read it back for
        // idempotent return.
        const existing = await this.getVersion(entity.id, version);
        if (!existing) {
            // Extremely unlikely: ON CONFLICT skipped insert but the row
            // disappeared before we could read it. Surface as a hard error
            // rather than returning null and breaking the contract.
            throw new Error(
                `importSnapshot: ON CONFLICT skipped insert for id=${entity.id} ` +
                `version=${version} but the conflicting row could not be read back.`,
            );
        }
        return existing;
    }

    /**
     * Run pending migrations in order. Call once at startup.
     */
    async migrate(): Promise<void> {
        const m001 = await import('./migrations/001_create_canonical_entities.js');
        await m001.up(this.pool);
        const m002 = await import('./migrations/002_add_entity_version.js');
        await m002.up(this.pool);
    }

    /**
     * Drop schema. For testing only.
     */
    async teardown(): Promise<void> {
        // 001's down() drops the whole table, which also removes the version
        // column/constraint from 002 — running 002's down() first is
        // unnecessary for a full teardown but harmless to skip.
        const { down } = await import('./migrations/001_create_canonical_entities.js');
        await down(this.pool);
    }

    private rowToEntity(row: Record<string, unknown>): Entity {
        return {
            id: row.id as string,
            kind: row.kind as string,
            name: row.name as string,
            attributes: (typeof row.attributes === 'string'
                ? JSON.parse(row.attributes)
                : row.attributes) as Record<string, unknown>,
            // `version` arrives as a JS number from pg's int parser.
            version: Number(row.version),
            owner: 'canonical',
            createdAt: (row.created_at as Date).toISOString(),
            updatedAt: (row.updated_at as Date).toISOString(),
        };
    }
}
