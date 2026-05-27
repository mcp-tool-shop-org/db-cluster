/**
 * PostgresCanonicalStore — Postgres-backed implementation of CanonicalStore contract.
 * Implements the same interface as LocalCanonicalStore. The kernel cannot tell them apart.
 */

import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { Entity } from '../../types/entity.js';
import type { CanonicalStore, EntityFilter } from '../../contracts/canonical-store.js';
import { CANONICAL_TABLE } from './schema.js';

export class PostgresCanonicalStore implements CanonicalStore {
    private readonly pool: Pool;

    constructor(pool: Pool) {
        this.pool = pool;
    }

    async get(id: string): Promise<Entity | null> {
        const result = await this.pool.query(
            `SELECT id, kind, name, attributes, owner, created_at, updated_at FROM ${CANONICAL_TABLE} WHERE id = $1`,
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

        let sql = `SELECT id, kind, name, attributes, owner, created_at, updated_at FROM ${CANONICAL_TABLE}`;
        if (conditions.length > 0) {
            sql += ` WHERE ${conditions.join(' AND ')}`;
        }
        sql += ` ORDER BY created_at ASC`;
        if (filter?.limit) {
            sql += ` LIMIT $${paramIndex++}`;
            params.push(filter.limit);
        }

        const result = await this.pool.query(sql, params);
        return result.rows.map((row) => this.rowToEntity(row));
    }

    async exists(id: string): Promise<boolean> {
        const result = await this.pool.query(
            `SELECT 1 FROM ${CANONICAL_TABLE} WHERE id = $1`,
            [id],
        );
        return result.rows.length > 0;
    }

    async create(
        input: Omit<Entity, 'id' | 'createdAt' | 'updatedAt' | 'owner'>,
    ): Promise<Entity> {
        const id = randomUUID();
        const now = new Date().toISOString();
        const result = await this.pool.query(
            `INSERT INTO ${CANONICAL_TABLE} (id, kind, name, attributes, owner, created_at, updated_at)
             VALUES ($1, $2, $3, $4, 'canonical', $5, $5)
             RETURNING id, kind, name, attributes, owner, created_at, updated_at`,
            [id, input.kind, input.name, JSON.stringify(input.attributes), now],
        );
        return this.rowToEntity(result.rows[0]);
    }

    async update(
        id: string,
        patch: Partial<Pick<Entity, 'name' | 'attributes'>>,
    ): Promise<Entity> {
        const setClauses: string[] = [];
        const params: unknown[] = [];
        let paramIndex = 1;

        if (patch.name !== undefined) {
            setClauses.push(`name = $${paramIndex++}`);
            params.push(patch.name);
        }
        if (patch.attributes !== undefined) {
            setClauses.push(`attributes = $${paramIndex++}`);
            params.push(JSON.stringify(patch.attributes));
        }
        setClauses.push(`updated_at = $${paramIndex++}`);
        params.push(new Date().toISOString());

        params.push(id);
        const sql = `UPDATE ${CANONICAL_TABLE} SET ${setClauses.join(', ')} WHERE id = $${paramIndex} RETURNING id, kind, name, attributes, owner, created_at, updated_at`;

        const result = await this.pool.query(sql, params);
        if (result.rows.length === 0) {
            throw new Error(`Entity not found: ${id}`);
        }
        return this.rowToEntity(result.rows[0]);
    }

    /**
     * Import a full entity snapshot preserving original id, createdAt, updatedAt.
     * Used by restore so that re-runs are idempotent and provenance events that
     * cite the original subjectId still resolve (STORES-001).
     *
     * Idempotent via `INSERT ... ON CONFLICT (id) DO NOTHING`: if the row
     * already exists the insert is a no-op and we read the existing row back.
     * Pre-STORES-R006 this was a TOCTOU read-then-insert that raced under
     * concurrent restores. Two concurrent restores hitting the same id will
     * now both succeed, both returning the row that won the race.
     */
    async importSnapshot(entity: Entity): Promise<Entity> {
        const insertResult = await this.pool.query(
            `INSERT INTO ${CANONICAL_TABLE} (id, kind, name, attributes, owner, created_at, updated_at)
             VALUES ($1, $2, $3, $4, 'canonical', $5, $6)
             ON CONFLICT (id) DO NOTHING
             RETURNING id, kind, name, attributes, owner, created_at, updated_at`,
            [
                entity.id,
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
        // Conflict — row already exists. Read it back for idempotent return.
        const existing = await this.get(entity.id);
        if (!existing) {
            // Extremely unlikely: ON CONFLICT skipped insert but the row
            // disappeared before we could read it. Surface as a hard error
            // rather than returning null and breaking the contract.
            throw new Error(
                `importSnapshot: ON CONFLICT skipped insert for id=${entity.id} ` +
                `but the conflicting row could not be read back.`,
            );
        }
        return existing;
    }

    /**
     * Run pending migrations. Call once at startup.
     */
    async migrate(): Promise<void> {
        const { up } = await import('./migrations/001_create_canonical_entities.js');
        await up(this.pool);
    }

    /**
     * Drop schema. For testing only.
     */
    async teardown(): Promise<void> {
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
            owner: 'canonical',
            createdAt: (row.created_at as Date).toISOString(),
            updatedAt: (row.updated_at as Date).toISOString(),
        };
    }
}
