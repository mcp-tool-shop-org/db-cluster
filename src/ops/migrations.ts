/**
 * Migration status — checks schema state of physical backends.
 */

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
 */
export async function checkMigrationStatus(pool: MigrationPool): Promise<MigrationStatus> {
    try {
        const result = await pool.query(
            `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
        );
        const tables = result.rows.map((r: any) => r.table_name as string);
        const required = ['canonical_entities'];
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
 */
export async function verifySchema(pool: MigrationPool): Promise<{ valid: boolean; issues: string[] }> {
    const issues: string[] = [];

    try {
        // Check canonical_entities columns
        const cols = await pool.query(
            `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'canonical_entities' ORDER BY ordinal_position`,
        );

        const expectedColumns = ['id', 'kind', 'name', 'attributes', 'created_at', 'updated_at'];
        const actual = cols.rows.map((r: any) => r.column_name as string);

        for (const col of expectedColumns) {
            if (!actual.includes(col)) {
                issues.push(`canonical_entities: missing column '${col}'`);
            }
        }
    } catch (err: any) {
        issues.push(`Schema verification failed: ${err.message}`);
    }

    return { valid: issues.length === 0, issues };
}
