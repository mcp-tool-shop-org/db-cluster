/**
 * Migration 001: Create canonical_entities table.
 * This is the initial schema for Postgres-backed CanonicalStore.
 */

import type { Pool } from 'pg';
import { CREATE_TABLE_SQL, DROP_TABLE_SQL } from '../schema.js';

export const id = '001_create_canonical_entities';

export async function up(pool: Pool): Promise<void> {
    await pool.query(CREATE_TABLE_SQL);
}

export async function down(pool: Pool): Promise<void> {
    await pool.query(DROP_TABLE_SQL);
}
