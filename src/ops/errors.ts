/**
 * Errors specific to the ops layer (backup / restore / rebuild / verify).
 */

/**
 * Raised when a store adapter does not implement the import* hook required
 * for a backup-preserving restore (STORES-001/002/003).
 *
 * `restore()` used to silently fall back to `ingest()` / `create()` /
 * `append()` when an import hook was missing — that lost original IDs,
 * shredded provenance chains, and produced non-idempotent restores. The new
 * contract is: every adapter MUST implement the relevant import hook, or
 * restore fails loudly.
 */
export class ImportSnapshotNotSupportedError extends Error {
    public readonly code = 'IMPORT_SNAPSHOT_NOT_SUPPORTED';
    constructor(
        public readonly storeKind: 'canonical' | 'artifact' | 'ledger',
        public readonly missingMethod: string,
    ) {
        super(
            `${storeKind} store does not support ${missingMethod}. ` +
            `Cannot restore with original IDs preserved. The adapter must ` +
            `implement ${missingMethod} to be restore-safe (see STORES-001/002/003).`,
        );
        this.name = 'ImportSnapshotNotSupportedError';
    }
}
