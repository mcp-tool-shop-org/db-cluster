/**
 * Wave V3 — SQLite foundation tests (agent A3).
 *
 * Proves the FOUNDATION the store agents (A1/A2) build on: the SqliteDb
 * connection wrapper (lazy driver load + pragmas + migration runner +
 * transaction + idempotent close), the schema DDL (all tables exist after
 * open), and the driver-unavailable typed error's shape.
 *
 * Gating: these tests need the native `better-sqlite3` driver. They are skipped
 * gracefully when it is absent — mirroring the Postgres `describe.skip` idiom
 * (`test/postgres-canonical-store.test.ts`), but resolving the optional module
 * rather than reading an env var. The package itself imports cleanly without
 * the driver (see `test/install-smoke.test.ts`); only EXERCISING the sqlite
 * backend needs it. The error-shape test below is NOT gated — it imports only
 * the typed error class (no driver), so it always runs.
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteDb } from '../src/adapters/sqlite/sqlite-db.js';
import { getRequiredTables, MIGRATIONS_TABLE } from '../src/adapters/sqlite/schema.js';
import { SqliteDriverUnavailableError } from '../src/adapters/sqlite/errors.js';
import type { AdapterErrorShape } from '../src/adapters/sqlite/errors.js';

/** True iff better-sqlite3 resolves on this machine (does not load it). */
function hasSqlite(): boolean {
    try {
        createRequire(import.meta.url).resolve('better-sqlite3');
        return true;
    } catch {
        return false;
    }
}

const describeSqlite = hasSqlite() ? describe : describe.skip;

/** Make a fresh temp dir + db path; caller is responsible for cleanup. */
function freshDir(): { dir: string; dbPath: string } {
    const dir = mkdtempSync(join(tmpdir(), 'wave-v3-found-'));
    return { dir, dbPath: join(dir, 'cluster.db') };
}

/** Query the live table names (excludes SQLite's internal/index objects). */
function tableNames(db: SqliteDb): Set<string> {
    const rows = db.connection
        .prepare<[], { name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
        )
        .all();
    return new Set(rows.map((r) => r.name));
}

describeSqlite('Wave V3 — SqliteDb foundation', () => {
    it('open() creates the db file and every required table', () => {
        const { dir, dbPath } = freshDir();
        let db: SqliteDb | undefined;
        try {
            db = SqliteDb.open(dbPath);
            expect(existsSync(dbPath)).toBe(true);

            const names = tableNames(db);
            for (const required of getRequiredTables()) {
                expect(names.has(required)).toBe(true);
            }
            // The bookkeeping table is also present.
            expect(names.has(MIGRATIONS_TABLE)).toBe(true);
        } finally {
            db?.close();
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('open() mkdirs a missing parent directory', () => {
        const { dir } = freshDir();
        // Point at a db inside a not-yet-existing nested subdirectory.
        const nestedDbPath = join(dir, 'nested', 'deeper', 'cluster.db');
        let db: SqliteDb | undefined;
        try {
            db = SqliteDb.open(nestedDbPath);
            expect(existsSync(nestedDbPath)).toBe(true);
        } finally {
            db?.close();
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('applies WAL + foreign_keys + busy_timeout pragmas', () => {
        const { dir, dbPath } = freshDir();
        let db: SqliteDb | undefined;
        try {
            db = SqliteDb.open(dbPath);
            // pragma() with simple:true returns the scalar value.
            const journalMode = db.connection.pragma('journal_mode', { simple: true });
            expect(String(journalMode).toLowerCase()).toBe('wal');

            const foreignKeys = db.connection.pragma('foreign_keys', { simple: true });
            expect(Number(foreignKeys)).toBe(1);

            const busyTimeout = db.connection.pragma('busy_timeout', { simple: true });
            expect(Number(busyTimeout)).toBe(5000);
        } finally {
            db?.close();
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('migration runner is idempotent across reopen (no duplicate _migrations rows)', () => {
        const { dir, dbPath } = freshDir();
        try {
            // First open applies migration 001.
            const db1 = SqliteDb.open(dbPath);
            const rowsAfterFirst = db1.connection
                .prepare<[], { id: string }>(`SELECT id FROM ${MIGRATIONS_TABLE} ORDER BY id`)
                .all()
                .map((r) => r.id);
            expect(rowsAfterFirst).toEqual(['001_init']);
            db1.close();

            // Reopen the SAME path — runner must apply nothing new.
            const db2 = SqliteDb.open(dbPath);
            const rowsAfterReopen = db2.connection
                .prepare<[], { id: string }>(`SELECT id FROM ${MIGRATIONS_TABLE} ORDER BY id`)
                .all()
                .map((r) => r.id);
            expect(rowsAfterReopen).toEqual(['001_init']);

            // Exactly one bookkeeping row total — no re-application.
            const count = db2.connection
                .prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM ${MIGRATIONS_TABLE}`)
                .get();
            expect(count?.n).toBe(1);
            db2.close();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('transaction() commits on return and rolls back on throw', () => {
        const { dir, dbPath } = freshDir();
        let db: SqliteDb | undefined;
        try {
            db = SqliteDb.open(dbPath);
            const conn = db.connection;

            // Commit path: insert a canonical row, transaction returns its id.
            const insert = conn.prepare<[string, string, string, string, string]>(
                'INSERT INTO canonical_entities (id, version, kind, name, attributes, owner, created_at, updated_at) ' +
                    "VALUES (?, 1, ?, ?, '{}', 'canonical', ?, ?)",
            );
            const committedId = db.transaction(() => {
                insert.run('keep-1', 'concept', 'Kept', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
                return 'keep-1';
            });
            expect(committedId).toBe('keep-1');

            // Rollback path: insert a row then throw — the row must NOT persist,
            // and the original error must propagate.
            expect(() =>
                db!.transaction(() => {
                    insert.run('drop-1', 'concept', 'Dropped', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
                    throw new Error('rollback please');
                }),
            ).toThrow('rollback please');

            const ids = conn
                .prepare<[], { id: string }>('SELECT id FROM canonical_entities ORDER BY id')
                .all()
                .map((r) => r.id);
            expect(ids).toEqual(['keep-1']);
        } finally {
            db?.close();
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('close() is idempotent and releases the file lock so rmSync succeeds', () => {
        const { dir, dbPath } = freshDir();
        const db = SqliteDb.open(dbPath);
        // Force a WAL sidecar to exist by writing something.
        db.connection.exec(
            "INSERT INTO ledger_events (id, timestamp, action, actor_id, subject_id, subject_store, integrity_hash) " +
                "VALUES ('e1', '2026-01-01T00:00:00Z', 'create', 'actor', 'subj', 'canonical', 'deadbeef')",
        );

        // Idempotent: two closes must not throw.
        expect(() => db.close()).not.toThrow();
        expect(() => db.close()).not.toThrow();

        // On Windows an un-released lock would make this throw EBUSY.
        expect(() => rmSync(dir, { recursive: true, force: true })).not.toThrow();
        expect(existsSync(dir)).toBe(false);
    });
});

/**
 * Not gated on driver presence — exercises only the typed error class, which
 * has no runtime dependency on better-sqlite3. We deliberately do NOT fake the
 * `require` to simulate driver absence (the spec forbids that); instead we unit
 * test that the error implements the AdapterErrorShape contract with the right
 * code, matching `CorruptStoreError`'s shape.
 */
describe('Wave V3 — SqliteDriverUnavailableError shape', () => {
    it('implements AdapterErrorShape with the SQLITE_DRIVER_UNAVAILABLE code', () => {
        const cause = new Error('Cannot find module better-sqlite3');
        const err = new SqliteDriverUnavailableError(cause);

        // Structural AdapterErrorShape conformance (no instanceof needed).
        const shape: AdapterErrorShape = err;
        expect(shape.code).toBe('SQLITE_DRIVER_UNAVAILABLE');
        expect(shape.retryable).toBe(false);
        expect(typeof shape.remediationHint).toBe('string');
        expect(shape.remediationHint.length).toBeGreaterThan(0);

        // Message names the install path; cause is preserved.
        expect(err).toBeInstanceOf(Error);
        expect(err.name).toBe('SqliteDriverUnavailableError');
        expect(err.message).toContain('install better-sqlite3 to use the sqlite backend');
        expect(err.remediationHint).toContain('npm install better-sqlite3');
        expect(err.cause).toBe(cause);
    });
});
