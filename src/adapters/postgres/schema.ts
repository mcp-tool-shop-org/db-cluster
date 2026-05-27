/**
 * Postgres canonical store schema definition.
 * Mirrors the Entity type exactly — no drift from CanonicalStore contract.
 *
 * STORES-B-018 — single source of truth for required Postgres table names.
 * `getRequiredTables()` is the canonical registry consumed by both
 * `src/ops/doctor.ts` (existence check) and `src/ops/migrations.ts`
 * (`checkMigrationStatus`'s required list). Pre-fix both files inlined
 * the literal `'canonical_entities'`, so a future migration adding a new
 * required table would silently leave doctor()/migrations.ts behind. Now
 * the registry is the only place to add or rename a required table.
 */

export const CANONICAL_TABLE = 'canonical_entities';

/**
 * The set of tables a healthy Postgres-backed cluster must have.
 * Add new required tables here when shipping migration 002+.
 */
export function getRequiredTables(): readonly string[] {
    return [CANONICAL_TABLE];
}

export const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS ${CANONICAL_TABLE} (
    id UUID PRIMARY KEY,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    attributes JSONB NOT NULL DEFAULT '{}',
    owner TEXT NOT NULL DEFAULT 'canonical' CHECK (owner = 'canonical'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_canonical_kind ON ${CANONICAL_TABLE} (kind);
CREATE INDEX IF NOT EXISTS idx_canonical_name_lower ON ${CANONICAL_TABLE} (LOWER(name));
`;

export const DROP_TABLE_SQL = `DROP TABLE IF EXISTS ${CANONICAL_TABLE};`;
