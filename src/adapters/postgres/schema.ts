/**
 * Postgres canonical store schema definition.
 * Mirrors the Entity type exactly — no drift from CanonicalStore contract.
 */

export const CANONICAL_TABLE = 'canonical_entities';

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
