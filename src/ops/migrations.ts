/**
 * Migration status — checks schema state of physical backends.
 *
 * STORES-B-018: the list of required Postgres tables comes from
 * `src/adapters/postgres/schema.ts::getRequiredTables()`. Pre-fix this
 * file inlined the canonical-entities table name directly; if a future
 * migration adds a new required table, only the registry need change.
 */

import { CANONICAL_TABLE, getRequiredTables } from '../adapters/postgres/schema.js';

export interface MigrationStatus {
    backend: string;
    migrated: boolean;
    tables: string[];
    message: string;
}

export interface MigrationPool {
    query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

/**
 * Check Postgres migration status.
 *
 * @param pool Postgres pool-like handle exposing `query(text, values)`.
 *             A real `pg.Pool` works, as does any mock conforming to the
 *             {@link MigrationPool} interface.
 * @returns    {@link MigrationStatus} summarizing which required tables
 *             are present. `migrated: false` does NOT throw — it surfaces
 *             via the structured result.
 * @throws     Doesn't throw. Connection / query failures are caught and
 *             surfaced as `migrated: false` with `message` capturing the
 *             error.
 *
 * @example
 *   const status = await checkMigrationStatus(pool);
 *   if (!status.migrated) console.error(status.message);
 */
export async function checkMigrationStatus(pool: MigrationPool): Promise<MigrationStatus> {
    try {
        const result = await pool.query(
            `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
        );
        const tables = result.rows.map((r: any) => r.table_name as string);
        const required = Array.from(getRequiredTables());
        const missing = required.filter((t) => !tables.includes(t));

        if (missing.length === 0) {
            return {
                backend: 'postgres',
                migrated: true,
                tables,
                message: `All required tables present: ${required.join(', ')}`,
            };
        }

        return {
            backend: 'postgres',
            migrated: false,
            tables,
            message: `Missing tables: ${missing.join(', ')}`,
        };
    } catch (err: any) {
        return {
            backend: 'postgres',
            migrated: false,
            tables: [],
            message: `Failed to check migration status: ${err.message}`,
        };
    }
}

/**
 * Verify schema matches expected structure.
 *
 * @param pool Postgres pool-like handle. See {@link MigrationPool}.
 * @returns    Object with `valid: boolean` and `issues: string[]`. Empty
 *             issues array means the schema matches expectations.
 * @throws     Doesn't throw. Query errors are collected into `issues[]`.
 *
 * @example
 *   const { valid, issues } = await verifySchema(pool);
 *   if (!valid) issues.forEach(i => console.error(i));
 */
export async function verifySchema(pool: MigrationPool): Promise<{ valid: boolean; issues: string[] }> {
    const issues: string[] = [];

    try {
        // Check canonical-table columns. The table name comes from the
        // schema registry (CANONICAL_TABLE) so a rename in schema.ts
        // doesn't leave this verification quietly probing a vanished table.
        const cols = await pool.query(
            `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position`,
            [CANONICAL_TABLE],
        );

        const expectedColumns = ['id', 'kind', 'name', 'attributes', 'created_at', 'updated_at'];
        const actual = cols.rows.map((r: any) => r.column_name as string);

        for (const col of expectedColumns) {
            if (!actual.includes(col)) {
                issues.push(`${CANONICAL_TABLE}: missing column '${col}'`);
            }
        }
    } catch (err: any) {
        issues.push(`Schema verification failed: ${err.message}`);
    }

    return { valid: issues.length === 0, issues };
}
