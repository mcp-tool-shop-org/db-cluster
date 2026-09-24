/**
 * SQLite driver presence — a missing driver fails the run where CI expects one.
 *
 * better-sqlite3 is an OPTIONAL dependency, and the SQLite suites skip when it
 * does not resolve. That is right on a machine without the driver and wrong in
 * CI: after the better-sqlite3 13 bump, `npm ci` deleted the driver on three of
 * the six cells and every run stayed green with the SQLite suites skipped.
 *
 * CI sets DB_CLUSTER_REQUIRE_SQLITE=1. This test then opens a real database
 * through SqliteDb.open(), the same lazy loader the backend uses, so a missing
 * or unloadable driver fails with the typed SqliteDriverUnavailableError and
 * its cause. With the variable unset (local runs) it skips.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteDb } from '../src/adapters/sqlite/sqlite-db.js';

const required = process.env.DB_CLUSTER_REQUIRE_SQLITE === '1';

describe.runIf(required)('SQLite driver presence (DB_CLUSTER_REQUIRE_SQLITE=1)', () => {
    it('SqliteDb.open() loads better-sqlite3 and opens a database', () => {
        const dir = mkdtempSync(join(tmpdir(), 'sqlite-presence-'));
        const dbPath = join(dir, 'cluster.db');
        let db: SqliteDb | undefined;
        try {
            db = SqliteDb.open(dbPath);
            expect(existsSync(dbPath)).toBe(true);
        } finally {
            db?.close();
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
