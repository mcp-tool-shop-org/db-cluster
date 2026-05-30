/**
 * SQLite adapter schema — DDL constants for every store the cluster backs.
 *
 * Wave V3 (SQLite foundation). Mirrors the Postgres schema-registry pattern
 * (`src/adapters/postgres/schema.ts`): a set of compile-time table-name
 * constants plus the static DDL that creates them. The store agents (A1/A2)
 * prepare statements against these table names; this module is the single
 * source of truth for what those names are.
 *
 * Design parity with the domain types (`src/types/`):
 *  - Every persisted field of Entity / Artifact / IndexRecord / ProvenanceEvent
 *    / Receipt has a column so a record round-trips byte-identically.
 *  - ISO-8601 timestamps are TEXT (SQLite has no native datetime; the app
 *    supplies `new Date().toISOString()` strings and compares them
 *    lexicographically, which is correct for the Zulu ISO format).
 *  - JSON-shaped fields (attributes / metadata / detail / affectedIds /
 *    embedding) are TEXT holding `JSON.stringify(value)`. The store layer
 *    parses on read. SQLite's JSON1 functions are available but the foundation
 *    treats these columns as opaque TEXT.
 *  - `owner` columns carry a CHECK pinning the literal owner tag (matching the
 *    Postgres `CHECK (owner = '...')` guard and the `owner: '...'` literal
 *    types in `src/types/`).
 *  - `integrity_hash` / `prev_hash` on the ledger tables hold the existing
 *    unkeyed SHA-256 tamper-evidence chain (see `src/types/integrity.ts`);
 *    these columns just store what the append/verify logic already computes —
 *    the foundation adds no new integrity guarantee.
 *
 * Security note: all DDL below is fully static. The only interpolated tokens
 * are the compile-time table-name constants in this file — never untrusted
 * input. There is no dynamic identifier construction anywhere in the schema.
 */

// --- Table name constants (the registry the store layer imports) ---

export const CANONICAL_TABLE = 'canonical_entities';
export const ARTIFACTS_TABLE = 'artifacts';
export const ARTIFACT_CONTENT_TABLE = 'artifact_content';
export const INDEX_RECORDS_TABLE = 'index_records';
export const LEDGER_EVENTS_TABLE = 'ledger_events';
export const LEDGER_RECEIPTS_TABLE = 'ledger_receipts';
export const LEDGER_EVENTS_ARCHIVE_TABLE = 'ledger_events_archive';
export const LEDGER_RECEIPTS_ARCHIVE_TABLE = 'ledger_receipts_archive';

/** Migration-bookkeeping table. Tracks which migrations have been applied. */
export const MIGRATIONS_TABLE = '_migrations';

/**
 * Every table a healthy SQLite-backed cluster must have after migration 001.
 * Consumed by the foundation tests (and any future doctor()/migration-status
 * check) so a new required table is added in exactly one place. Excludes the
 * `_migrations` bookkeeping table, which the runner owns directly.
 */
export function getRequiredTables(): readonly string[] {
    return [
        CANONICAL_TABLE,
        ARTIFACTS_TABLE,
        ARTIFACT_CONTENT_TABLE,
        INDEX_RECORDS_TABLE,
        LEDGER_EVENTS_TABLE,
        LEDGER_RECEIPTS_TABLE,
        LEDGER_EVENTS_ARCHIVE_TABLE,
        LEDGER_RECEIPTS_ARCHIVE_TABLE,
    ];
}

// --- Per-table DDL (CREATE TABLE IF NOT EXISTS + indexes) ---

/**
 * canonical_entities — versioned, append-a-version like the Postgres shape.
 * One entity id owns MANY immutable rows, one per `version` (≥1); the latest
 * version is the highest. PRIMARY KEY (id, version) gives latest-version
 * lookup an ordered index to walk. Indexes on `kind` and `LOWER(name)` serve
 * `list()`. (Mirrors `src/types/entity.ts` + Postgres composite-PK shape.)
 */
export const CREATE_CANONICAL_SQL = `
CREATE TABLE IF NOT EXISTS ${CANONICAL_TABLE} (
    id TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    attributes TEXT NOT NULL DEFAULT '{}',
    owner TEXT NOT NULL DEFAULT 'canonical' CHECK (owner = 'canonical'),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (id, version)
);
CREATE INDEX IF NOT EXISTS idx_canonical_kind ON ${CANONICAL_TABLE} (kind);
CREATE INDEX IF NOT EXISTS idx_canonical_name_lower ON ${CANONICAL_TABLE} (LOWER(name));
`;

/**
 * artifacts — immutable source-object metadata (`src/types/artifact.ts`).
 * `content_hash` references the content-addressed blob in `artifact_content`.
 * Index on `filename` serves lookups by name.
 */
export const CREATE_ARTIFACTS_SQL = `
CREATE TABLE IF NOT EXISTS ${ARTIFACTS_TABLE} (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    version INTEGER NOT NULL,
    storage_path TEXT NOT NULL,
    ingested_at TEXT NOT NULL,
    owner TEXT NOT NULL DEFAULT 'artifact' CHECK (owner = 'artifact')
);
CREATE INDEX IF NOT EXISTS idx_artifacts_filename ON ${ARTIFACTS_TABLE} (filename);
`;

/**
 * artifact_content — content-addressed blob store. Dedups by sha256 hash:
 * many artifacts with identical bytes share one row. The blob is stored as a
 * SQLite BLOB (raw bytes), keyed by the lowercase hex `content_hash`.
 */
export const CREATE_ARTIFACT_CONTENT_SQL = `
CREATE TABLE IF NOT EXISTS ${ARTIFACT_CONTENT_TABLE} (
    content_hash TEXT PRIMARY KEY,
    bytes BLOB NOT NULL
);
`;

/**
 * index_records — derivative discoverability entries (`src/types/index-record.ts`).
 * `seq` (AUTOINCREMENT) gives a stable insertion order so candidate retrieval
 * can return rows in write order. `id` is the logical record id (UNIQUE).
 * `embedding` is NULLABLE TEXT (JSON array of numbers, absent when unset).
 * Index on `source_store` serves filtered scans.
 */
export const CREATE_INDEX_RECORDS_SQL = `
CREATE TABLE IF NOT EXISTS ${INDEX_RECORDS_TABLE} (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    source_id TEXT NOT NULL,
    source_store TEXT NOT NULL,
    text TEXT NOT NULL,
    metadata TEXT NOT NULL DEFAULT '{}',
    embedding TEXT,
    indexed_at TEXT NOT NULL,
    owner TEXT NOT NULL DEFAULT 'index' CHECK (owner = 'index')
);
CREATE INDEX IF NOT EXISTS idx_index_records_source_store ON ${INDEX_RECORDS_TABLE} (source_store);
`;

/**
 * ledger_events — append-only provenance ledger (`src/types/provenance-event.ts`).
 * `seq` (AUTOINCREMENT) is the physical write order — the order the `prev_hash`
 * chain is built in and that `verify()` walks. `parent_event_id` (logical
 * lineage, walked by `trace()`) and `prev_hash` (physical chain link) are both
 * NULLABLE: NULL ≡ absent (the genesis event / a root event has no parent or
 * prior-hash). Indexes on `subject_id`, `action`, `timestamp` serve queries.
 */
export const CREATE_LEDGER_EVENTS_SQL = `
CREATE TABLE IF NOT EXISTS ${LEDGER_EVENTS_TABLE} (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    timestamp TEXT NOT NULL,
    action TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    subject_store TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '{}',
    parent_event_id TEXT,
    owner TEXT NOT NULL DEFAULT 'ledger' CHECK (owner = 'ledger'),
    integrity_hash TEXT NOT NULL,
    prev_hash TEXT
);
CREATE INDEX IF NOT EXISTS idx_ledger_events_subject_id ON ${LEDGER_EVENTS_TABLE} (subject_id);
CREATE INDEX IF NOT EXISTS idx_ledger_events_action ON ${LEDGER_EVENTS_TABLE} (action);
CREATE INDEX IF NOT EXISTS idx_ledger_events_timestamp ON ${LEDGER_EVENTS_TABLE} (timestamp);
`;

/**
 * ledger_receipts — append-only command receipts (`src/types/receipt.ts`).
 * `seq` is physical write order (the `prev_hash` chain order). `affected_ids`
 * is a JSON array TEXT. `prev_hash` is NULLABLE (genesis receipt). Index on
 * `command_id` serves lookups by the command that produced the receipt.
 */
export const CREATE_LEDGER_RECEIPTS_SQL = `
CREATE TABLE IF NOT EXISTS ${LEDGER_RECEIPTS_TABLE} (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    command_id TEXT NOT NULL,
    committed_at TEXT NOT NULL,
    result_summary TEXT NOT NULL,
    affected_ids TEXT NOT NULL DEFAULT '[]',
    provenance_event_id TEXT NOT NULL,
    integrity_hash TEXT NOT NULL,
    prev_hash TEXT
);
CREATE INDEX IF NOT EXISTS idx_ledger_receipts_command_id ON ${LEDGER_RECEIPTS_TABLE} (command_id);
`;

/**
 * ledger_events_archive — rotation target for `ledger_events`. Same columns as
 * the active table, BUT `seq` is a plain INTEGER (preserving the original write
 * order value, not a fresh autoincrement key), plus `archive_id` (the rotation
 * batch id) and `archived_at`. PK is `(archive_id, id)` so the same event id
 * could in principle be archived under distinct rotation batches without a PK
 * clash, while a single batch cannot archive the same id twice. The ledger
 * store's `rotate()` (A2) populates this transactionally; the foundation only
 * creates the table.
 */
export const CREATE_LEDGER_EVENTS_ARCHIVE_SQL = `
CREATE TABLE IF NOT EXISTS ${LEDGER_EVENTS_ARCHIVE_TABLE} (
    archive_id TEXT NOT NULL,
    archived_at TEXT NOT NULL,
    seq INTEGER NOT NULL,
    id TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    action TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    subject_store TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '{}',
    parent_event_id TEXT,
    owner TEXT NOT NULL DEFAULT 'ledger' CHECK (owner = 'ledger'),
    integrity_hash TEXT NOT NULL,
    prev_hash TEXT,
    PRIMARY KEY (archive_id, id)
);
CREATE INDEX IF NOT EXISTS idx_ledger_events_archive_id ON ${LEDGER_EVENTS_ARCHIVE_TABLE} (id);
`;

/**
 * ledger_receipts_archive — rotation target for `ledger_receipts`. Same column
 * parity rules as `ledger_events_archive`: plain-INTEGER `seq` + `archive_id` +
 * `archived_at`, PK `(archive_id, id)`. A2 writes the rotate logic.
 */
export const CREATE_LEDGER_RECEIPTS_ARCHIVE_SQL = `
CREATE TABLE IF NOT EXISTS ${LEDGER_RECEIPTS_ARCHIVE_TABLE} (
    archive_id TEXT NOT NULL,
    archived_at TEXT NOT NULL,
    seq INTEGER NOT NULL,
    id TEXT NOT NULL,
    command_id TEXT NOT NULL,
    committed_at TEXT NOT NULL,
    result_summary TEXT NOT NULL,
    affected_ids TEXT NOT NULL DEFAULT '[]',
    provenance_event_id TEXT NOT NULL,
    integrity_hash TEXT NOT NULL,
    prev_hash TEXT,
    PRIMARY KEY (archive_id, id)
);
CREATE INDEX IF NOT EXISTS idx_ledger_receipts_archive_id ON ${LEDGER_RECEIPTS_ARCHIVE_TABLE} (id);
`;

/**
 * The complete initial schema (migration 001). Concatenation of every
 * per-table DDL above, in dependency-neutral order (all `CREATE TABLE IF NOT
 * EXISTS`, no cross-table FKs at the schema level). The migration runner
 * executes this as a single script via `Database.exec`.
 */
export const INIT_SQL = [
    CREATE_CANONICAL_SQL,
    CREATE_ARTIFACTS_SQL,
    CREATE_ARTIFACT_CONTENT_SQL,
    CREATE_INDEX_RECORDS_SQL,
    CREATE_LEDGER_EVENTS_SQL,
    CREATE_LEDGER_RECEIPTS_SQL,
    CREATE_LEDGER_EVENTS_ARCHIVE_SQL,
    CREATE_LEDGER_RECEIPTS_ARCHIVE_SQL,
].join('\n');
