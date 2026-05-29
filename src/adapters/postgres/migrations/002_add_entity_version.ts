/**
 * Migration 002: Add entity versioning to canonical_entities.
 *
 * Wave S2-A1 (PROV-002). Promotes the single-row-per-id table created by
 * migration 001 to the append-a-version shape:
 *  - adds `version int NOT NULL` (existing rows backfilled to 1),
 *  - swaps the primary key from `(id)` to `(id, version)`.
 *
 * Idempotent and safe to run against either a 001 table or an already-002
 * table — the column add uses `IF NOT EXISTS` and the PK swap is guarded by an
 * `information_schema` check (see `ADD_VERSION_COLUMN_SQL` in `../schema.ts`).
 *
 * Mirrors the 001 migration module shape: a stable `id`, an `up(pool)`, and a
 * `down(pool)`. All DDL is static (the table name is the compile-time
 * `CANONICAL_TABLE` constant) — no string-concatenated identifiers from
 * untrusted input.
 */

import type { Pool } from 'pg';
import { ADD_VERSION_COLUMN_SQL, DROP_VERSION_COLUMN_SQL } from '../schema.js';

export const id = '002_add_entity_version';

export async function up(pool: Pool): Promise<void> {
    await pool.query(ADD_VERSION_COLUMN_SQL);
}

export async function down(pool: Pool): Promise<void> {
    await pool.query(DROP_VERSION_COLUMN_SQL);
}
