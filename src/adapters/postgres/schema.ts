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

/**
 * Initial table DDL (migration 001).
 *
 * Wave S2-A1 (PROV-002): the canonical store became append-a-version — a
 * single entity id now owns MANY immutable rows, one per `version`. The
 * primary key is therefore the composite `(id, version)`, NOT `id` alone, and
 * a `version int` column carries the version number (≥1). `get()` resolves the
 * highest `version` for an id; `update()` INSERTs a new row at
 * `max(version)+1` and never mutates a prior row. The composite PK is created
 * here for fresh installs; migration 002 (`002_add_entity_version`) performs
 * the same change on a pre-existing 001 table.
 *
 * The `idx_canonical_kind` / `idx_canonical_name_lower` indexes still serve
 * `list()` (which filters across all versions). The composite PK gives the
 * latest-version lookup `WHERE id = $1 ORDER BY version DESC LIMIT 1` an
 * ordered index to walk.
 */
export const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS ${CANONICAL_TABLE} (
    id UUID NOT NULL,
    version INT NOT NULL DEFAULT 1 CHECK (version >= 1),
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    attributes JSONB NOT NULL DEFAULT '{}',
    owner TEXT NOT NULL DEFAULT 'canonical' CHECK (owner = 'canonical'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (id, version)
);

CREATE INDEX IF NOT EXISTS idx_canonical_kind ON ${CANONICAL_TABLE} (kind);
CREATE INDEX IF NOT EXISTS idx_canonical_name_lower ON ${CANONICAL_TABLE} (LOWER(name));
`;

export const DROP_TABLE_SQL = `DROP TABLE IF EXISTS ${CANONICAL_TABLE};`;

/**
 * Migration 002 (`002_add_entity_version`) — promote a pre-existing 001 table
 * (PK `id`, no `version`) to the versioned shape (PK `(id, version)`,
 * `version int NOT NULL` defaulting existing rows to 1).
 *
 * Idempotent and safe to run on a 001 or a 002 table:
 *  - `ADD COLUMN IF NOT EXISTS version …` — backfills existing rows to 1 via
 *    the column DEFAULT, then we drop the default so the application supplies
 *    the value explicitly going forward.
 *  - The PK swap is guarded: we only drop the single-column PK and add the
 *    composite PK when the current PK is NOT already `(id, version)`. Postgres
 *    has no `IF NOT EXISTS` for PK constraints, so the guard runs in a
 *    DO-block that inspects `information_schema`.
 *
 * All statements are static DDL — no string-concatenated identifiers from
 * untrusted input (the table name is the compile-time `CANONICAL_TABLE`
 * constant).
 */
export const ADD_VERSION_COLUMN_SQL = `
ALTER TABLE ${CANONICAL_TABLE}
    ADD COLUMN IF NOT EXISTS version INT NOT NULL DEFAULT 1;

ALTER TABLE ${CANONICAL_TABLE}
    ADD CONSTRAINT ${CANONICAL_TABLE}_version_check CHECK (version >= 1) NOT VALID;

ALTER TABLE ${CANONICAL_TABLE} VALIDATE CONSTRAINT ${CANONICAL_TABLE}_version_check;

DO $$
DECLARE
    pk_cols text;
BEGIN
    SELECT string_agg(a.attname, ',' ORDER BY array_position(c.conkey, a.attnum))
        INTO pk_cols
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
    WHERE c.conrelid = '${CANONICAL_TABLE}'::regclass AND c.contype = 'p';

    IF pk_cols IS DISTINCT FROM 'id,version' THEN
        EXECUTE 'ALTER TABLE ${CANONICAL_TABLE} DROP CONSTRAINT IF EXISTS ' ||
            (SELECT conname FROM pg_constraint
             WHERE conrelid = '${CANONICAL_TABLE}'::regclass AND contype = 'p');
        EXECUTE 'ALTER TABLE ${CANONICAL_TABLE} ADD PRIMARY KEY (id, version)';
    END IF;
END $$;

ALTER TABLE ${CANONICAL_TABLE} ALTER COLUMN version DROP DEFAULT;
`;

/**
 * Reverse of migration 002 — collapse back to a single-column `id` PK and drop
 * the `version` column. Destructive when more than one version of any id
 * exists (the older rows would violate a single-column PK); intended for test
 * teardown / clean-room rollback only.
 */
export const DROP_VERSION_COLUMN_SQL = `
DO $$
DECLARE
    pk_cols text;
BEGIN
    SELECT string_agg(a.attname, ',' ORDER BY array_position(c.conkey, a.attnum))
        INTO pk_cols
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
    WHERE c.conrelid = '${CANONICAL_TABLE}'::regclass AND c.contype = 'p';

    IF pk_cols IS DISTINCT FROM 'id' THEN
        EXECUTE 'ALTER TABLE ${CANONICAL_TABLE} DROP CONSTRAINT IF EXISTS ' ||
            (SELECT conname FROM pg_constraint
             WHERE conrelid = '${CANONICAL_TABLE}'::regclass AND contype = 'p');
        EXECUTE 'ALTER TABLE ${CANONICAL_TABLE} ADD PRIMARY KEY (id)';
    END IF;
END $$;

ALTER TABLE ${CANONICAL_TABLE} DROP CONSTRAINT IF EXISTS ${CANONICAL_TABLE}_version_check;
ALTER TABLE ${CANONICAL_TABLE} DROP COLUMN IF EXISTS version;
`;
