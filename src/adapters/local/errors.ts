/**
 * Typed errors for the local store adapters.
 *
 * All subclasses follow the §2b adapter-error contract:
 *  - `readonly code: string` — stable identifier MCP/CLI surfaces map to
 *    exit codes. Kept as a string literal here (not yet imported from a
 *    `ClusterErrorCode` union owned by `src/types/`) so adapters keep a
 *    one-way dependency on `kernel/` typed-error code values without
 *    requiring a `types/` round-trip.
 *  - `readonly remediationHint: string` — operator-facing one-line next-step
 *    string. Surfaces are free to render this verbatim alongside the
 *    `message` (the CLI does so via the §2c HOF).
 *  - `readonly retryable: boolean` — does retrying the same operation
 *    without operator intervention have a chance of success? Almost all
 *    adapter errors are NOT retryable (the failure is structural — corrupt
 *    file, tampered backup, missing method) and set this to `false`.
 *
 * The `CommandQueueCorruptError` exemplar in `src/kernel/errors.ts:82-87`
 * sets the bar for `message` content: it names 3 concrete recovery paths
 * (restore from backup / delete file / inspect by hand). Each subclass
 * below mirrors that pattern.
 *
 * - CorruptStoreError — raised by load() when a persistence file fails JSON.parse
 *   or otherwise looks unreadable. Carries the file path and a recovery hint.
 * - InvalidContentHashError — raised by LocalArtifactStore.importSnapshot AND
 *   LocalArtifactStore.getContent when the contentHash does not match the
 *   expected `[a-f0-9]{64}` shape. Prevents path traversal via tampered backup
 *   metadata or tampered artifacts.json (STORES-006 / STORES-R005).
 * - ImportConflictError — raised by import* methods when an existing record
 *   with the same id is found but its content differs from the incoming
 *   snapshot. Closes STORES-B-003 silent first-write-wins: a tampered backup
 *   with a matching id but altered fields no longer silently masks tampering.
 * - LedgerCycleDetectedError — raised by LocalLedgerStore.trace() when the
 *   parentEventId chain visits the same event twice. Closes STORES-B-015:
 *   corrupted ledgers fail loudly instead of looping forever or silently
 *   truncating the trace.
 * - InvalidRotateTimestampError / RotateBoundaryInFutureError — raised by
 *   LocalLedgerStore.rotate() for the two operator-intent-mismatch cases.
 * - BackupTargetExistsError — raised by `backup({ outputPath })` when the
 *   target path already exists and `force` is not set (STORES-C-006).
 */

/**
 * The §2b adapter-error contract surface, applied uniformly to every
 * subclass below. Re-stated as a structural type so test code and external
 * SDK consumers can pattern-match without instanceof when needed.
 */
export interface AdapterErrorShape extends Error {
    readonly code: string;
    readonly remediationHint: string;
    readonly retryable: boolean;
}

export class CorruptStoreError extends Error implements AdapterErrorShape {
    public readonly code = 'CORRUPT_STORE';
    public readonly retryable = false;
    public readonly remediationHint: string;
    public readonly filePath: string;
    public readonly cause?: unknown;
    constructor(filePath: string, cause?: unknown) {
        const causeMsg = cause instanceof Error ? cause.message : String(cause ?? 'unknown');
        const hint =
            `Restore the cluster from a backup (db-cluster restore <backup.json>), ` +
            `delete ${filePath} to start fresh, or inspect the file by hand.`;
        super(
            `Local store file is unreadable or corrupt: ${filePath} (${causeMsg}). ` +
                `The store cannot start safely. Recovery: ${hint}`,
        );
        this.name = 'CorruptStoreError';
        this.filePath = filePath;
        this.cause = cause;
        this.remediationHint = hint;
    }
}

const CONTENT_HASH_PATTERN = /^[a-f0-9]{64}$/;

export class InvalidContentHashError extends Error implements AdapterErrorShape {
    public readonly code = 'INVALID_CONTENT_HASH';
    public readonly retryable = false;
    public readonly remediationHint: string;
    public readonly contentHash: string;
    constructor(contentHash: string) {
        const hint =
            `Recompute sha256(content) on the caller side and re-submit with the ` +
            `correct 64-character lowercase hex contentHash, or inspect the backup ` +
            `metadata for tampering.`;
        super(
            `Invalid artifact contentHash: ${JSON.stringify(contentHash)}. ` +
                `Expected a 64-character lowercase hex string (sha256). ` +
                `Refusing to write artifact content to a path derived from untrusted input. ` +
                `Recovery: ${hint}`,
        );
        this.name = 'InvalidContentHashError';
        this.contentHash = contentHash;
        this.remediationHint = hint;
    }
}

export function isValidContentHash(hash: unknown): hash is string {
    return typeof hash === 'string' && CONTENT_HASH_PATTERN.test(hash);
}

/**
 * Thrown by import* methods (importEvent, importReceipt, importSnapshot) when
 * an existing record with the same id is found but its content differs from
 * the incoming snapshot.
 *
 * Closes STORES-B-003 (Stage B Wave B1 audit). Pre-fix every import* method
 * silently returned the existing record when the id matched, with no check
 * that incoming fields equalled existing fields. A tampered backup with a
 * matching id but altered fields was silently masked — restore reported
 * "skipped" but the cluster ended up with the original record while the
 * tampered intent went undetected. Post-fix the import* method must reject
 * the import with this typed error so the operator can inspect both records.
 *
 * existingHash / incomingHash are the JSON-serialized (and owner-elided)
 * content digests of each side, included for diagnosability.
 */
export class ImportConflictError extends Error implements AdapterErrorShape {
    public readonly code = 'IMPORT_CONFLICT';
    public readonly retryable = false;
    public readonly remediationHint: string;
    public readonly storeKind: string;
    public readonly recordId: string;
    public readonly existingHash: string;
    public readonly incomingHash: string;
    constructor(
        storeKind: string,
        recordId: string,
        existingHash: string,
        incomingHash: string,
    ) {
        const hint =
            `Inspect both records by hand (db-cluster entity inspect ${recordId} on the ` +
            `live cluster vs the backup file) and decide which is correct, then either ` +
            `re-create the live record to match the backup or omit the conflicting entry ` +
            `from the backup before retrying restore.`;
        super(
            `Import conflict in ${storeKind} store: record id=${recordId} already exists ` +
                `with different content. ` +
                `Existing serialized=${truncate(existingHash, 120)}; ` +
                `incoming serialized=${truncate(incomingHash, 120)}. ` +
                `The incoming record differs from the existing one in one or more fields ` +
                `(owner field is excluded from the comparison). Recovery: ${hint}`,
        );
        this.name = 'ImportConflictError';
        this.storeKind = storeKind;
        this.recordId = recordId;
        this.existingHash = existingHash;
        this.incomingHash = incomingHash;
        this.remediationHint = hint;
    }
}

function truncate(s: string, n: number): string {
    if (s.length <= n) return s;
    return `${s.slice(0, n)}…[${s.length - n} more chars]`;
}

/**
 * Assert that two records are content-equal once the store-stamped `owner`
 * field is excluded. Used by import* methods to surface tampered backups via
 * ImportConflictError instead of silent first-write-wins.
 *
 * The comparison is JSON-canonical via JSON.stringify after deleting the
 * `owner` field from both sides. We accept the limitation that key order
 * matters in JSON.stringify — both sides go through the same .ts type so the
 * shapes are stable, and the JSON.stringify({...record}) shallow-spread
 * normalizes property order to source-declaration order on both sides.
 */
export function assertContentMatch(
    storeKind: string,
    recordId: string,
    existing: Record<string, unknown>,
    incoming: Record<string, unknown>,
): void {
    const a = JSON.stringify({ ...existing, owner: undefined });
    const b = JSON.stringify({ ...incoming, owner: undefined });
    if (a !== b) {
        throw new ImportConflictError(storeKind, recordId, a, b);
    }
}

/**
 * Thrown by LocalLedgerStore.trace() when the parentEventId chain revisits an
 * event id. A tampered or corrupted ledger where A→B→A would produce an
 * infinite loop pre-fix; this error surfaces the corruption loudly with the
 * visited path so the operator can locate and excise the cycle.
 *
 * Closes STORES-B-015 (Stage B Wave B1 audit). Adversarial-input defence:
 * append-only stores can still be tampered with on-disk; trace must not trust
 * the parent chain blindly.
 */
export class LedgerCycleDetectedError extends Error implements AdapterErrorShape {
    public readonly code = 'LEDGER_CYCLE_DETECTED';
    public readonly retryable = false;
    public readonly remediationHint: string;
    /** The visited event ids in order, ending with the id that revisits. */
    public readonly eventIds: string[];
    constructor(eventIds: string[]) {
        const hint =
            `Inspect the events that participate in the cycle (db-cluster trace <eventId> ` +
            `for each id in the path), then either excise the cyclic parentEventId by ` +
            `hand from the events.json file or restore from a known-good backup.`;
        super(
            `Cycle detected in ledger parent chain. Visited ids in order: ` +
                `${eventIds.join(' → ')}. The last id in the path was already visited earlier. ` +
                `The ledger is corrupted or tampered; refusing to walk an infinite chain. ` +
                `Recovery: ${hint}`,
        );
        this.name = 'LedgerCycleDetectedError';
        this.eventIds = eventIds;
        this.remediationHint = hint;
    }
}

/**
 * Thrown by `LocalLedgerStore.rotate(beforeTimestamp)` when the
 * `beforeTimestamp` argument fails the ISO-8601 / `Date.parse` shape check.
 *
 * Closes AGG-B1-2b (Wave B1-Amend). Pre-fix `rotate('')` and
 * `rotate('not-a-date')` produced silent no-ops or lexicographic surprises
 * because the boundary comparison is a plain `event.timestamp <
 * beforeTimestamp` string compare. The typed error gives operator-facing
 * tooling (CLI / MCP / SDK) a stable code to branch on rather than a quiet
 * `{archived: 0}` result.
 *
 * Carries a stable `code: 'INVALID_ROTATE_TIMESTAMP'` for the MCP boundary
 * — the `BUILTIN_ERROR_CODES` map in `src/mcp/sanitize.ts` includes the
 * constructor name so the error surfaces to MCP hosts with the same code.
 */
export class InvalidRotateTimestampError extends Error implements AdapterErrorShape {
    public readonly code = 'INVALID_ROTATE_TIMESTAMP';
    public readonly retryable = false;
    public readonly remediationHint: string;
    public readonly beforeTimestamp: string;
    constructor(beforeTimestamp: string) {
        const hint =
            `Pass an ISO-8601 datetime string parseable by Date.parse() (e.g. ` +
            `"2026-01-15T00:00:00Z"). Inspect the youngest event timestamp via ` +
            `db-cluster trace if unsure which boundary to use.`;
        super(
            `Invalid rotate boundary timestamp: ${JSON.stringify(beforeTimestamp)}. ` +
                `Expected an ISO-8601 datetime string parseable by Date.parse(). ` +
                `Rotation is refused rather than risk a lexicographic-string surprise that ` +
                `archives the wrong slice of the ledger. Recovery: ${hint}`,
        );
        this.name = 'InvalidRotateTimestampError';
        this.beforeTimestamp = beforeTimestamp;
        this.remediationHint = hint;
    }
}

/**
 * Thrown by `LocalLedgerStore.rotate(beforeTimestamp)` when the boundary is
 * in the future.
 *
 * Closes AGG-B1-2d (Wave B1-Amend). Pre-fix the safeguard returned a silent
 * `{archived: 0, retained: N}` result — indistinguishable from "nothing to
 * archive." The typed error surfaces the operator-intent mismatch so a
 * mistakenly future-dated rotate doesn't quietly succeed.
 *
 * Carries a stable `code: 'ROTATE_BOUNDARY_IN_FUTURE'` (mirrored in
 * `BUILTIN_ERROR_CODES` for the MCP boundary).
 */
export class RotateBoundaryInFutureError extends Error implements AdapterErrorShape {
    public readonly code = 'ROTATE_BOUNDARY_IN_FUTURE';
    public readonly retryable = false;
    public readonly remediationHint: string;
    public readonly beforeTimestamp: string;
    public readonly nowIso: string;
    constructor(beforeTimestamp: string, nowIso?: string) {
        const now = nowIso ?? new Date().toISOString();
        const hint =
            `Pass a boundary at or just after the newest event's timestamp to archive ` +
            `everything; otherwise pass a past timestamp. Inspect the newest event via ` +
            `db-cluster trace if unsure.`;
        super(
            `rotate() refused: boundary timestamp ${beforeTimestamp} is in the future ` +
                `(current: ${now}). Archiving "everything up to a future date" is almost ` +
                `always a typo — refusing rather than silently archive the entire active ` +
                `ledger. Recovery: ${hint}`,
        );
        this.name = 'RotateBoundaryInFutureError';
        this.beforeTimestamp = beforeTimestamp;
        this.nowIso = now;
        this.remediationHint = hint;
    }
}

/**
 * Thrown by `backup({ outputPath })` when the target path already exists
 * and `force` is not set.
 *
 * Closes STORES-C-006 (Stage C Wave C1 audit). Pre-fix `db-cluster backup
 * -o existing.json` silently overwrote any prior backup at the target path
 * — operators reusing a familiar filename for a manual snapshot could lose
 * the prior backup with no warning. Post-fix `backup()` checks the path
 * before writing; `force: true` is required to overwrite.
 *
 * Carries a stable `code: 'BACKUP_TARGET_EXISTS'` for the MCP boundary
 * (mirrored in `BUILTIN_ERROR_CODES` in `src/mcp/sanitize.ts`).
 */
export class BackupTargetExistsError extends Error implements AdapterErrorShape {
    public readonly code = 'BACKUP_TARGET_EXISTS';
    public readonly retryable = false;
    public readonly remediationHint: string;
    public readonly outputPath: string;
    constructor(outputPath: string) {
        const hint =
            `Re-run with --force (CLI) or { force: true } (programmatic) to overwrite ` +
            `the existing file, or choose a different output path (e.g., a timestamped ` +
            `filename like backup-$(date -u +%Y%m%dT%H%M%SZ).json).`;
        super(
            `Backup target already exists: ${outputPath}. ` +
                `Refusing to overwrite a prior backup without explicit confirmation. ` +
                `Recovery: ${hint}`,
        );
        this.name = 'BackupTargetExistsError';
        this.outputPath = outputPath;
        this.remediationHint = hint;
    }
}
