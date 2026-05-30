/**
 * SQLite migration registry — the static, ordered list the runner applies.
 *
 * Wave V3 (SQLite foundation). Each entry is a `SqliteMigration`: a stable
 * `id` (recorded in the `_migrations` table) and a synchronous `up(db)` that
 * applies the change against a better-sqlite3 `Database`. The runner in
 * `sqlite-db.ts` walks `MIGRATIONS` in array order, skipping any `id` already
 * present in `_migrations`, and wraps each `up()` + its bookkeeping insert in a
 * single transaction.
 *
 * To add migration 002+: create the module, then APPEND it here. Order is
 * load-bearing — never reorder or remove an applied migration.
 */

import type { Database } from 'better-sqlite3';
import * as m001 from './001_init.js';

/** A single ordered, tracked schema migration. */
export interface SqliteMigration {
    /** Stable identifier recorded in the `_migrations` table. */
    readonly id: string;
    /** Apply the migration. Synchronous; runs inside the runner's transaction. */
    up(db: Database): void;
}

/** Ordered migration registry. Append new migrations; never reorder. */
export const MIGRATIONS: readonly SqliteMigration[] = [m001];
