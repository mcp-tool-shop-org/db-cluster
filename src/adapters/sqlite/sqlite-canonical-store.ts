/**
 * SqliteCanonicalStore — SQLite-backed implementation of the CanonicalStore
 * contract. Behaviorally IDENTICAL to LocalCanonicalStore and
 * PostgresCanonicalStore: the kernel cannot tell them apart.
 *
 * Wave V3 (SQLite store, agent A1). Append-a-version semantics (PROV-002),
 * mirroring the local + postgres stores exactly:
 *  - One entity `id` owns MANY immutable rows, one per `version` (≥1). The
 *    composite PRIMARY KEY is `(id, version)` (A3's schema). The latest version
 *    is the highest.
 *  - `create()` INSERTs version 1, stamping id/version/owner/timestamps last so
 *    a caller-supplied value (via a raw cast) cannot win.
 *  - `update(id, patch)` reads the latest version, merges `patch` on top, and
 *    INSERTs a NEW row at `MAX(version)+1` inside ONE transaction so a
 *    concurrent writer cannot collide on the same version. Prior rows are
 *    RETAINED — nothing is mutated or deleted in place.
 *  - `get(id)` returns the LATEST version; `list()` the latest of each id.
 *  - `listVersions()` / `getVersion()` reach the full history.
 *  - `importSnapshot()` preserves the incoming `version` and matches LOCAL's
 *    conflict semantics (assertContentMatch → ImportConflictError on a tampered
 *    re-import), the stronger behavior, rather than Postgres's ON CONFLICT DO
 *    NOTHING first-write-wins.
 *
 * SQL SAFETY: every query is parameterized with `?` placeholders. The ONLY
 * interpolated tokens are the compile-time `CANONICAL_TABLE` constant from A3's
 * schema — never an entity id/name/kind/attributes value.
 */

import { randomUUID } from 'node:crypto';
import type { Entity } from '../../types/entity.js';
import type { CanonicalStore, EntityFilter } from '../../contracts/canonical-store.js';
import { assertContentMatch } from '../local/errors.js';
import { SqliteDb } from './sqlite-db.js';
import { CANONICAL_TABLE } from './schema.js';

/** Column list shared by every SELECT so the row shape rowToEntity consumes
 *  stays in one place. Mirrors the Postgres COLUMNS constant. */
const COLUMNS = 'id, version, kind, name, attributes, owner, created_at, updated_at';

/** The shape of a raw canonical_entities row as better-sqlite3 returns it. */
interface CanonicalRow {
    id: string;
    version: number;
    kind: string;
    name: string;
    attributes: string;
    owner: string;
    created_at: string;
    updated_at: string;
}

export class SqliteCanonicalStore implements CanonicalStore {
    constructor(private readonly db: SqliteDb) {}

    async get(id: string): Promise<Entity | null> {
        // Latest version of this id.
        const row = this.db.connection
            .prepare<[string], CanonicalRow>(
                `SELECT ${COLUMNS} FROM ${CANONICAL_TABLE} WHERE id = ? ORDER BY version DESC LIMIT 1`,
            )
            .get(id);
        return row ? this.rowToEntity(row) : null;
    }

    async list(filter?: EntityFilter): Promise<Entity[]> {
        // Latest version of EACH id (one row per id), via a correlated subquery
        // picking the max version per id. Ordered by each id's INSERTION order —
        // the rowid of its FIRST (lowest) version — so the result, AND the subset
        // returned under `limit`, matches LocalCanonicalStore's Map-insertion
        // (creation) order EXACTLY, even when several entities share a created_at
        // millisecond. (Ordering by created_at would tie-break nondeterministically
        // vs local and return a DIFFERENT limited subset — Wave V3 parity finding
        // F1. better-sqlite3 tables carry an implicit monotonic rowid; MIN(rowid)
        // per id is the order the ids were first created.) kind is filtered in SQL
        // (exact); nameContains + limit are applied in JS to match local's
        // `name.toLowerCase().includes(q)` / `.slice(0, n)` semantics exactly
        // (SQLite's LIKE is ASCII-case-insensitive but Unicode-case-sensitive, so
        // JS is the faithful match).
        const params: unknown[] = [];
        let where = `e.version = (SELECT MAX(v.version) FROM ${CANONICAL_TABLE} v WHERE v.id = e.id)`;
        if (filter?.kind) {
            where += ` AND e.kind = ?`;
            params.push(filter.kind);
        }
        const rows = this.db.connection
            .prepare<unknown[], CanonicalRow>(
                `SELECT ${COLUMNS} FROM ${CANONICAL_TABLE} e WHERE ${where} ` +
                    `ORDER BY (SELECT MIN(v2.rowid) FROM ${CANONICAL_TABLE} v2 WHERE v2.id = e.id) ASC`,
            )
            .all(...params);

        let results = rows.map((row) => this.rowToEntity(row));
        if (filter?.nameContains) {
            const q = filter.nameContains.toLowerCase();
            results = results.filter((e) => e.name.toLowerCase().includes(q));
        }
        if (filter?.limit) {
            results = results.slice(0, filter.limit);
        }
        return results;
    }

    async exists(id: string): Promise<boolean> {
        const row = this.db.connection
            .prepare<[string], { one: number }>(
                `SELECT 1 AS one FROM ${CANONICAL_TABLE} WHERE id = ? LIMIT 1`,
            )
            .get(id);
        return row !== undefined;
    }

    async create(
        input: Omit<Entity, 'id' | 'version' | 'createdAt' | 'updatedAt' | 'owner'>,
    ): Promise<Entity> {
        const now = new Date().toISOString();
        // Spread first, then stamp generated fields — caller-supplied
        // id/version/owner (via a raw cast) cannot override the store stamps.
        const entity: Entity = {
            ...input,
            id: randomUUID(),
            version: 1,
            createdAt: now,
            updatedAt: now,
            owner: 'canonical',
        };
        this.db.connection
            .prepare(
                `INSERT INTO ${CANONICAL_TABLE} (id, version, kind, name, attributes, owner, created_at, updated_at) ` +
                    `VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
                entity.id,
                entity.version,
                entity.kind,
                entity.name,
                JSON.stringify(entity.attributes),
                entity.owner,
                entity.createdAt,
                entity.updatedAt,
            );
        return entity;
    }

    async update(
        id: string,
        patch: Partial<Pick<Entity, 'name' | 'attributes'>>,
    ): Promise<Entity> {
        // Read latest → merge patch → INSERT N+1, all inside ONE transaction so a
        // concurrent writer cannot collide on the same version (the composite PK
        // would otherwise reject the duplicate). Prior rows are retained.
        const conn = this.db.connection;
        const selectLatest = conn.prepare<[string], CanonicalRow>(
            `SELECT ${COLUMNS} FROM ${CANONICAL_TABLE} WHERE id = ? ORDER BY version DESC LIMIT 1`,
        );
        const insert = conn.prepare(
            `INSERT INTO ${CANONICAL_TABLE} (id, version, kind, name, attributes, owner, created_at, updated_at) ` +
                `VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        );

        return this.db.transaction(() => {
            const row = selectLatest.get(id);
            if (!row) {
                // Parity: local + postgres throw a plain Error on unknown id.
                throw new Error(`Entity not found: ${id}`);
            }
            const current = this.rowToEntity(row);
            const next: Entity = {
                ...current,
                ...patch,
                version: current.version + 1,
                updatedAt: new Date().toISOString(),
            };
            insert.run(
                next.id,
                next.version,
                next.kind,
                next.name,
                JSON.stringify(next.attributes),
                next.owner,
                next.createdAt,
                next.updatedAt,
            );
            return next;
        });
    }

    async listVersions(id: string): Promise<Entity[]> {
        const rows = this.db.connection
            .prepare<[string], CanonicalRow>(
                `SELECT ${COLUMNS} FROM ${CANONICAL_TABLE} WHERE id = ? ORDER BY version ASC`,
            )
            .all(id);
        return rows.map((row) => this.rowToEntity(row));
    }

    async getVersion(id: string, version: number): Promise<Entity | null> {
        const row = this.db.connection
            .prepare<[string, number], CanonicalRow>(
                `SELECT ${COLUMNS} FROM ${CANONICAL_TABLE} WHERE id = ? AND version = ?`,
            )
            .get(id, version);
        return row ? this.rowToEntity(row) : null;
    }

    /**
     * Import a full entity snapshot preserving the original id, version,
     * createdAt, updatedAt (owner is store-stamped to 'canonical').
     *
     * Matches LOCAL's conflict semantics (NOT Postgres's first-write-wins): the
     * incoming `version` is preserved (default 1 if absent); if a row with the
     * same `(id, version)` already exists, assertContentMatch is called — it
     * throws ImportConflictError when the content differs (excluding `owner`)
     * and the existing row is returned on a true match. Otherwise the new
     * (id, version) row is INSERTed.
     */
    async importSnapshot(entity: Entity): Promise<Entity> {
        const incomingVersion =
            typeof entity.version === 'number' && Number.isFinite(entity.version)
                ? entity.version
                : 1;
        const snapshot: Entity = {
            ...entity,
            version: incomingVersion,
            owner: 'canonical',
        };

        const existingRow = this.db.connection
            .prepare<[string, number], CanonicalRow>(
                `SELECT ${COLUMNS} FROM ${CANONICAL_TABLE} WHERE id = ? AND version = ?`,
            )
            .get(entity.id, incomingVersion);

        if (existingRow) {
            const existing = this.rowToEntity(existingRow);
            // Same (id, version) already present — assert content equality
            // (tampered-backup detection); idempotent on a true match. Both
            // sides go through rowToEntity-shaped objects so JSON.stringify
            // (key order = source enumeration order) compares apples to apples.
            assertContentMatch(
                'canonical',
                `${entity.id}@${incomingVersion}`,
                existing as unknown as Record<string, unknown>,
                this.normalizeForCompare(snapshot) as unknown as Record<string, unknown>,
            );
            return existing;
        }

        this.db.connection
            .prepare(
                `INSERT INTO ${CANONICAL_TABLE} (id, version, kind, name, attributes, owner, created_at, updated_at) ` +
                    `VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
                snapshot.id,
                snapshot.version,
                snapshot.kind,
                snapshot.name,
                JSON.stringify(snapshot.attributes),
                snapshot.owner,
                snapshot.createdAt,
                snapshot.updatedAt,
            );
        return snapshot;
    }

    /**
     * Re-emit an Entity with the SAME field order rowToEntity produces, so the
     * assertContentMatch JSON.stringify comparison (which is key-order
     * sensitive) compares the incoming snapshot against the stored row on equal
     * footing. (`attributes` is normalized through a JSON round-trip too so two
     * structurally-equal attribute objects with different in-memory key order
     * still match — the stored side always arrives JSON-parsed.)
     */
    private normalizeForCompare(entity: Entity): Entity {
        return {
            id: entity.id,
            kind: entity.kind,
            name: entity.name,
            attributes: JSON.parse(JSON.stringify(entity.attributes)) as Record<string, unknown>,
            version: Number(entity.version),
            owner: 'canonical',
            createdAt: entity.createdAt,
            updatedAt: entity.updatedAt,
        };
    }

    /**
     * Map a raw canonical_entities row to an Entity. `attributes` is parsed from
     * JSON TEXT; `version` is coerced to a JS number; `owner` is pinned to the
     * literal 'canonical'; timestamps are already ISO strings (stored as TEXT —
     * no Date round-trip needed, unlike the Postgres adapter).
     */
    private rowToEntity(row: CanonicalRow): Entity {
        return {
            id: row.id,
            kind: row.kind,
            name: row.name,
            attributes: JSON.parse(row.attributes) as Record<string, unknown>,
            version: Number(row.version),
            owner: 'canonical',
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        };
    }
}
