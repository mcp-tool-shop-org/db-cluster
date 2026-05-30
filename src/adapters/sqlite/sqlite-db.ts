/**
 * SqliteDb — the lazy connection wrapper for the SQLite backend.
 *
 * Wave V3 (SQLite foundation). This is the FOUNDATION the store agents (A1/A2)
 * build on: it owns the better-sqlite3 connection, the pragmas (WAL +
 * foreign_keys + busy_timeout), the migration runner, transaction helper, and
 * idempotent close. The store classes prepare statements / run transactions on
 * `db.connection`; they never open or close it themselves.
 *
 * Critical design points:
 *  - LAZY DRIVER LOAD. better-sqlite3 is imported ONLY inside `open()`, via
 *    `createRequire(import.meta.url)('better-sqlite3')` (synchronous, ESM-safe).
 *    At module top-level it is `import type` only — erased at compile, needs the
 *    `@types` package but no runtime dependency. Rationale: the db-cluster
 *    package root must import cleanly when better-sqlite3 is absent (the
 *    fresh-install smoke test). Selecting the sqlite backend — i.e. calling
 *    `open()` — is the ONLY thing that pulls in the native driver. Any load
 *    failure (module-not-found OR native-binary-failed-to-load) is converted to
 *    a typed `SqliteDriverUnavailableError`, cause preserved.
 *  - WINDOWS FILE LOCK. An open connection holds a lock on the db file (and its
 *    -wal / -shm sidecars). Tests `rmSync` their temp dir and would fail with
 *    EBUSY if the connection were still open. `close()` is therefore idempotent
 *    and checkpoints the WAL (TRUNCATE) before closing so the sidecars are
 *    released too.
 */

import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { Database } from 'better-sqlite3';
import { SqliteDriverUnavailableError } from './errors.js';
import { MIGRATIONS } from './migrations/index.js';
import { MIGRATIONS_TABLE } from './schema.js';

/**
 * better-sqlite3's constructor type. The runtime value is loaded lazily inside
 * `open()`; this type-only alias lets us annotate the `require` result without
 * a top-level runtime import. (better-sqlite3 exports the constructor as its
 * default/callable export — `new Ctor(path)` yields a `Database`.)
 */
type DatabaseConstructor = new (filename: string) => Database;

/**
 * Lazy connection wrapper around a better-sqlite3 Database.
 *
 * Construct via the static `open()` factory — the constructor is private so the
 * only path to a `SqliteDb` runs the pragmas + migrations exactly once.
 */
export class SqliteDb {
    /**
     * Raw better-sqlite3 Database. The store layer prepares/runs statements and
     * opens transactions on this handle. Read-only reference: stores must not
     * close it (use `SqliteDb.close()` for that).
     */
    public readonly connection: Database;

    /** Tracks whether `close()` has already run, so it is idempotent. */
    private closed = false;

    private constructor(connection: Database) {
        this.connection = connection;
    }

    /**
     * Open (or create) the SQLite database at `dbPath` and return a ready
     * `SqliteDb`. Synchronous. On first call this lazily `require`s
     * better-sqlite3, creates the parent directory, opens the file, applies the
     * pragmas, and runs any pending migrations.
     *
     * @throws SqliteDriverUnavailableError if better-sqlite3 cannot be loaded.
     */
    public static open(dbPath: string): SqliteDb {
        const Ctor = loadDriver();

        // Ensure the parent directory exists (better-sqlite3 will not mkdir for
        // us; opening into a missing directory throws SQLITE_CANTOPEN).
        mkdirSync(dirname(dbPath), { recursive: true });

        const connection = new Ctor(dbPath);

        // Pragmas: WAL for concurrent readers + durable single-writer, FK
        // enforcement on (off by default in SQLite), and a busy_timeout so a
        // momentarily-locked db waits rather than throwing SQLITE_BUSY.
        connection.pragma('journal_mode = WAL');
        connection.pragma('foreign_keys = ON');
        connection.pragma('busy_timeout = 5000');

        const db = new SqliteDb(connection);
        db.runMigrations();
        return db;
    }

    /**
     * Run `fn` inside a better-sqlite3 transaction. Commits on normal return
     * (forwarding `fn`'s result), rolls back if `fn` throws (re-throwing the
     * original error). better-sqlite3 transactions are synchronous; `fn` must be
     * synchronous too.
     */
    public transaction<T>(fn: () => T): T {
        const wrapped = this.connection.transaction(fn);
        return wrapped();
    }

    /**
     * Close the connection. Idempotent — safe to call more than once. Before
     * closing, best-effort checkpoints the WAL with TRUNCATE so the -wal / -shm
     * sidecar files are flushed and released (important on Windows, where an
     * open handle keeps a file lock and a subsequent `rmSync` of the directory
     * would fail with EBUSY).
     */
    public close(): void {
        if (this.closed) return;
        this.closed = true;
        try {
            this.connection.pragma('wal_checkpoint(TRUNCATE)');
        } catch {
            // Best-effort: a checkpoint failure must not block close().
        }
        this.connection.close();
    }

    /**
     * Apply every migration in the registry that is not already recorded in
     * `_migrations`, in order. Each migration's `up()` and its bookkeeping
     * insert run together inside one transaction, so a migration is recorded as
     * applied only if its DDL fully succeeded. Idempotent across reopens: a
     * second `open()` of the same path finds every id already present and
     * applies nothing.
     */
    private runMigrations(): void {
        const conn = this.connection;
        conn.exec(
            `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (` +
                `id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`,
        );

        const hasApplied = conn.prepare<[string], { id: string }>(
            `SELECT id FROM ${MIGRATIONS_TABLE} WHERE id = ?`,
        );
        const recordApplied = conn.prepare<[string, string]>(
            `INSERT INTO ${MIGRATIONS_TABLE} (id, applied_at) VALUES (?, ?)`,
        );

        for (const migration of MIGRATIONS) {
            if (hasApplied.get(migration.id)) continue;
            const apply = conn.transaction(() => {
                migration.up(conn);
                recordApplied.run(migration.id, new Date().toISOString());
            });
            apply();
        }
    }
}

/**
 * Lazily load the better-sqlite3 constructor. Uses `createRequire` against this
 * module's URL so it resolves the dependency the same way a CommonJS `require`
 * would, from an ESM module, synchronously. ANY failure — the package is not
 * installed, or its native binary failed to load on this platform/Node ABI — is
 * converted to a typed `SqliteDriverUnavailableError` with the underlying cause
 * preserved. This is the ONLY place the runtime driver is touched.
 */
function loadDriver(): DatabaseConstructor {
    try {
        const require = createRequire(import.meta.url);
        return require('better-sqlite3') as DatabaseConstructor;
    } catch (cause) {
        throw new SqliteDriverUnavailableError(cause);
    }
}
