/**
 * Typed errors for the SQLite adapter.
 *
 * Wave V3 (SQLite foundation). Follows the §2b adapter-error contract
 * (`AdapterErrorShape` in `src/adapters/local/errors.ts`):
 *  - `readonly code: string` — stable identifier MCP/CLI surfaces map to exit
 *    codes.
 *  - `readonly remediationHint: string` — operator-facing one-line next step.
 *  - `readonly retryable: boolean` — almost always `false` for adapter errors
 *    (the failure is structural, not transient).
 *
 * Mirrors `CorruptStoreError`'s shape exactly so SDK consumers and test code can
 * pattern-match the SQLite errors the same way they match the local ones.
 */

import type { AdapterErrorShape } from '../local/errors.js';

export type { AdapterErrorShape };

/**
 * Thrown by `SqliteDb.open()` when the `better-sqlite3` driver cannot be
 * loaded — either the package is not installed (it lives in
 * `optionalDependencies`, so a consumer who never selects the sqlite backend
 * need not install it) OR its prebuilt native binary failed to load on this
 * platform/Node ABI.
 *
 * The whole point of the lazy `require` inside `open()` is that the package
 * root imports cleanly when better-sqlite3 is absent (the fresh-install smoke
 * test). Selecting the sqlite backend is the only thing that loads the driver,
 * and that load is the only place this error originates. The underlying cause
 * (the module-resolution / native-binding error) is preserved on `.cause` for
 * diagnosability.
 *
 * Carries a stable `code: 'SQLITE_DRIVER_UNAVAILABLE'` (non-retryable —
 * retrying without installing the dependency cannot succeed).
 */
export class SqliteDriverUnavailableError extends Error implements AdapterErrorShape {
    public readonly code = 'SQLITE_DRIVER_UNAVAILABLE';
    public readonly retryable = false;
    public readonly remediationHint: string;
    public readonly cause?: unknown;
    constructor(cause?: unknown) {
        const causeMsg = cause instanceof Error ? cause.message : String(cause ?? 'unknown');
        const hint =
            `Install the optional native driver: npm install better-sqlite3 ` +
            `(it ships prebuilt binaries for common platforms). If install ` +
            `succeeded but loading still fails, your platform/Node ABI may need ` +
            `a rebuild: npm rebuild better-sqlite3.`;
        super(
            `install better-sqlite3 to use the sqlite backend ` +
                `(driver failed to load: ${causeMsg}). ` +
                `The sqlite backend lazily requires better-sqlite3 only when selected; ` +
                `it is an optional dependency. Recovery: ${hint}`,
        );
        this.name = 'SqliteDriverUnavailableError';
        this.cause = cause;
        this.remediationHint = hint;
    }
}
