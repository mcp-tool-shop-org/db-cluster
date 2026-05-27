/**
 * Errors specific to the ops layer (backup / restore / rebuild / verify).
 *
 * All subclasses follow the §2b adapter-error contract:
 *  - `readonly code: string` — stable identifier MCP/CLI surfaces map to.
 *  - `readonly remediationHint: string` — operator-facing one-line next-step
 *    string. Surfaces are free to render this verbatim alongside `message`.
 *  - `readonly retryable: boolean` — does retrying the same operation
 *    without operator intervention have a chance of success?
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
    public readonly retryable = false;
    public readonly remediationHint: string;
    constructor(
        public readonly storeKind: 'canonical' | 'artifact' | 'ledger',
        public readonly missingMethod: string,
    ) {
        const hint =
            `Implement ${missingMethod} on the ${storeKind} adapter (see ` +
            `src/adapters/local/${storeKind}-store.ts for the reference implementation). ` +
            `restore() requires the import* hook to preserve original IDs.`;
        super(
            `${storeKind} store does not support ${missingMethod}. ` +
                `Cannot restore with original IDs preserved. The adapter must ` +
                `implement ${missingMethod} to be restore-safe (see STORES-001/002/003). ` +
                `Recovery: ${hint}`,
        );
        this.name = 'ImportSnapshotNotSupportedError';
        this.remediationHint = hint;
    }
}
