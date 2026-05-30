/**
 * Migration 001: create the initial SQLite schema (all stores).
 *
 * Wave V3 (SQLite foundation). Mirrors the Postgres migration-module shape
 * (`src/adapters/postgres/migrations/001_create_canonical_entities.ts`): an
 * `id` plus an `up()` that applies the DDL. SQLite-flavoured differences:
 *  - `up(db)` is SYNCHRONOUS and takes a better-sqlite3 `Database` (the
 *    Postgres modules are async and take a `Pool`).
 *  - The whole initial schema lands in one `db.exec(INIT_SQL)` — better-sqlite3
 *    `exec` runs a multi-statement script.
 *
 * `up()` does NOT manage the `_migrations` bookkeeping row — the runner in
 * `sqlite-db.ts` wraps `up()` + the bookkeeping insert in one transaction so a
 * partially-applied migration can never be marked complete.
 */

import type { Database } from 'better-sqlite3';
import { INIT_SQL } from '../schema.js';

export const id = '001_init';

export function up(db: Database): void {
    db.exec(INIT_SQL);
}
