/**
 * Typed errors for the local store adapters.
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
 */

export class CorruptStoreError extends Error {
    public readonly filePath: string;
    public readonly cause?: unknown;
    constructor(filePath: string, cause?: unknown) {
        const causeMsg = cause instanceof Error ? cause.message : String(cause ?? 'unknown');
        super(
            `Local store file is unreadable or corrupt: ${filePath} (${causeMsg}). ` +
                `The store cannot start safely. Recovery: restore from a backup, ` +
                `delete the file to start fresh, or inspect the file by hand.`,
        );
        this.name = 'CorruptStoreError';
        this.filePath = filePath;
        this.cause = cause;
    }
}

const CONTENT_HASH_PATTERN = /^[a-f0-9]{64}$/;

export class InvalidContentHashError extends Error {
    public readonly contentHash: string;
    constructor(contentHash: string) {
        super(
            `Invalid artifact contentHash: ${JSON.stringify(contentHash)}. ` +
                `Expected a 64-character lowercase hex string (sha256). ` +
                `Refusing to write artifact content to a path derived from untrusted input.`,
        );
        this.name = 'InvalidContentHashError';
        this.contentHash = contentHash;
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
export class ImportConflictError extends Error {
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
        super(
            `Import conflict in ${storeKind} store: record id=${recordId} already exists ` +
                `with different content. ` +
                `Existing serialized=${truncate(existingHash, 120)}; ` +
                `incoming serialized=${truncate(incomingHash, 120)}. ` +
                `The incoming record differs from the existing one in one or more fields ` +
                `(owner field is excluded from the comparison). Inspect both records and ` +
                `decide whether the backup is correct or the live store is correct before retrying.`,
        );
        this.name = 'ImportConflictError';
        this.storeKind = storeKind;
        this.recordId = recordId;
        this.existingHash = existingHash;
        this.incomingHash = incomingHash;
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
export class LedgerCycleDetectedError extends Error {
    /** The visited event ids in order, ending with the id that revisits. */
    public readonly eventIds: string[];
    constructor(eventIds: string[]) {
        super(
            `Cycle detected in ledger parent chain. Visited ids in order: ` +
                `${eventIds.join(' → ')}. The last id in the path was already visited earlier. ` +
                `The ledger is corrupted or tampered; refusing to walk an infinite chain. ` +
                `Recovery: inspect the events that participate in the cycle and break the cycle ` +
                `by hand, or restore from a known-good backup.`,
        );
        this.name = 'LedgerCycleDetectedError';
        this.eventIds = eventIds;
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
export class InvalidRotateTimestampError extends Error {
    public readonly code = 'INVALID_ROTATE_TIMESTAMP';
    public readonly beforeTimestamp: string;
    constructor(beforeTimestamp: string) {
        super(
            `Invalid rotate boundary timestamp: ${JSON.stringify(beforeTimestamp)}. ` +
                `Expected an ISO-8601 datetime string parseable by Date.parse(). ` +
                `Rotation is refused rather than risk a lexicographic-string surprise that ` +
                `archives the wrong slice of the ledger.`,
        );
        this.name = 'InvalidRotateTimestampError';
        this.beforeTimestamp = beforeTimestamp;
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
export class RotateBoundaryInFutureError extends Error {
    public readonly code = 'ROTATE_BOUNDARY_IN_FUTURE';
    public readonly beforeTimestamp: string;
    public readonly nowIso: string;
    constructor(beforeTimestamp: string, nowIso?: string) {
        const now = nowIso ?? new Date().toISOString();
        super(
            `rotate() refused: boundary timestamp ${beforeTimestamp} is in the future ` +
                `(current: ${now}). Archiving "everything up to a future date" is almost ` +
                `always a typo — refusing rather than silently archive the entire active ` +
                `ledger. To archive everything, pass a boundary at or just after the newest ` +
                `event's timestamp.`,
        );
        this.name = 'RotateBoundaryInFutureError';
        this.beforeTimestamp = beforeTimestamp;
        this.nowIso = now;
    }
}
