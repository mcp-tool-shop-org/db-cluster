/**
 * SQLite adapter barrel.
 *
 * Wave V3 (SQLite backend). Exports the connection wrapper, the schema
 * constants/registry, the driver-unavailable typed error, and the four store
 * classes that implement the cluster store contracts over a shared SqliteDb.
 */

export { SqliteDb } from './sqlite-db.js';

export { SqliteCanonicalStore } from './sqlite-canonical-store.js';
export { SqliteArtifactStore } from './sqlite-artifact-store.js';
export { SqliteIndexStore } from './sqlite-index-store.js';
export { SqliteLedgerStore } from './sqlite-ledger-store.js';

export {
    // Table-name constants + registry.
    CANONICAL_TABLE,
    ARTIFACTS_TABLE,
    ARTIFACT_CONTENT_TABLE,
    INDEX_RECORDS_TABLE,
    LEDGER_EVENTS_TABLE,
    LEDGER_RECEIPTS_TABLE,
    LEDGER_EVENTS_ARCHIVE_TABLE,
    LEDGER_RECEIPTS_ARCHIVE_TABLE,
    MIGRATIONS_TABLE,
    getRequiredTables,
    // DDL.
    INIT_SQL,
    CREATE_CANONICAL_SQL,
    CREATE_ARTIFACTS_SQL,
    CREATE_ARTIFACT_CONTENT_SQL,
    CREATE_INDEX_RECORDS_SQL,
    CREATE_LEDGER_EVENTS_SQL,
    CREATE_LEDGER_RECEIPTS_SQL,
    CREATE_LEDGER_EVENTS_ARCHIVE_SQL,
    CREATE_LEDGER_RECEIPTS_ARCHIVE_SQL,
} from './schema.js';

export { SqliteDriverUnavailableError } from './errors.js';
