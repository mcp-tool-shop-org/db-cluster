/**
 * Kernel-side typed error hierarchy.
 *
 * Every error a cluster surface throws (kernel + policy boundary) extends
 * {@link ClusterError}. The base class carries three abstract readonly
 * contract fields that downstream consumers — MCP envelope sanitizer, CLI
 * `typedErrorToExitCode`, AI integrators, SDK consumers — read uniformly:
 *
 *   1. `code: ClusterErrorCode` — stable narrow union for `switch` arms.
 *      The union is exported alongside the const array
 *      {@link CLUSTER_ERROR_CODES} so consumers can exhaustively check
 *      with a type-narrowed switch. Both CLI and MCP duplicate this
 *      enumeration today (cli.ts:260 typedErrorToExitCode +
 *      mcp/sanitize.ts:137 BUILTIN_ERROR_CODES); SURFACE-C-015 /
 *      KERNEL-C-010 call out the divergence — this file is the single
 *      source of truth.
 *
 *   2. `remediationHint: string` — actionable next step the consumer can
 *      surface in error envelopes, CLI prose, and dashboard error states.
 *      Mirrors the {@link CommandQueueCorruptError} pattern (the
 *      exemplary error message — see lines below): 3 recovery paths
 *      spelled out so the user knows WHAT TO DO, not just WHAT failed.
 *      This is the AGG-008 / Stage C Theme 1 actionability contract.
 *
 *   3. `retryable: boolean` — whether the operation that produced the
 *      error can be retried unchanged. Used by AI agents to branch
 *      between retry-loop and abort-and-ask paths. Defaults to false on
 *      every concrete subclass; subclasses that represent transient
 *      failure (network blip, contended lock, stale read) override.
 *
 * The AI envelope shape consumers should populate from these fields
 * lives in `src/types/ai-envelope.ts` ({@link AiErrorEnvelope}). The
 * canonical user-facing rendering helper lives in
 * `src/policy/error-formatter.ts` ({@link formatForUser}). MCP +
 * CLI + SDK + dashboard all call those single sources of truth — no
 * duplicated enumeration.
 *
 * CONTRACT FOR ADAPTER-LAYER ERROR CLASSES (`src/adapters/local/errors.ts`):
 *
 * Adapter-layer errors extend plain `Error` (not `ClusterError`) because
 * the no-back-edge rule forbids `src/adapters/` from importing the
 * kernel hierarchy. They surface through the MCP boundary via the
 * `BUILTIN_ERROR_CODES` class-name → code map in `src/mcp/sanitize.ts`.
 *
 * To participate in the same actionability contract, adapter-layer
 * errors SHOULD declare matching public readonly fields with the same
 * shape:
 *   ```ts
 *   class CorruptStoreError extends Error {
 *       readonly code: ClusterErrorCode = 'CORRUPT_STORE';
 *       readonly remediationHint: string = '...';
 *       readonly retryable: boolean = false;
 *   }
 *   ```
 * The Stores agent owns `src/adapters/local/errors.ts` and is responsible
 * for filling in those fields per Wave C1-Amend §2b.
 */

/**
 * The exhaustive stable code set across the kernel + adapter-layer error
 * hierarchy. Single source of truth — `typedErrorToExitCode` (CLI) and
 * `BUILTIN_ERROR_CODES` (MCP) both read from / mirror this set.
 *
 * Order is alphabetized to keep diffs stable. Adding a new ClusterError
 * subclass requires adding the code here AND in the consumer maps; the
 * regression test `test/wave-c1-kernel-regression.test.ts` enforces
 * coverage.
 */
export const CLUSTER_ERROR_CODES = [
    'BACKUP_TARGET_EXISTS',
    'BUFFER_SIDE_CHANNEL_NOT_SUPPORTED',
    'COMMAND_ALREADY_TERMINAL',
    'COMMAND_NOT_FOUND',
    'COMMAND_NOT_VALIDATED',
    'COMMAND_QUEUE_CORRUPT',
    'COMMAND_QUEUE_PERSISTENCE_LOST',
    'COMMAND_REJECTED',
    // Wave C1-Amend fix-up (V1-C1-001): CommandValidationFailedError
    // extends plain Error (not ClusterError — kernel/commands.ts helper)
    // but its code participates in the same MCP envelope + CLI
    // exit-code + remediationForCode contract, so the canonical code
    // set has to include it.
    'COMMAND_VALIDATION_FAILED',
    'CONTENT_HASH_MISMATCH',
    'CORRUPT_STORE',
    'IMPORT_CONFLICT',
    'IMPORT_SNAPSHOT_NOT_SUPPORTED',
    'INVALID_CLUSTER_URI',
    'INVALID_CONTENT_HASH',
    'INVALID_CONTENT_SHAPE',
    'INVALID_POLICY_CONFIG',
    'INVALID_REDACTION_RULE',
    'INVALID_ROTATE_TIMESTAMP',
    'INVALID_STATE_TRANSITION',
    'LEDGER_CYCLE_DETECTED',
    'NOT_FOUND',
    'POLICY_DENIED',
    'PROVENANCE_MISSING',
    'RECEIPT_FAILED',
    'RESOLVE_NOT_FOUND',
    'ROTATE_BOUNDARY_IN_FUTURE',
    'STAGED_CONTENT_TAMPERED',
    'INTERNAL_ERROR',
    'INTERNAL_TYPE_ERROR',
    'INTERNAL_RANGE_ERROR',
    'INTERNAL_SYNTAX_ERROR',
    'INTERNAL_REFERENCE_ERROR',
    'INTERNAL_URI_ERROR',
    'INTERNAL_EVAL_ERROR',
] as const;

/**
 * Union of stable error codes — derived from {@link CLUSTER_ERROR_CODES}
 * so the const and the type stay in lock-step.
 *
 * Use in `switch (err.code) { case 'POLICY_DENIED': ... }` branches —
 * the compiler enforces exhaustiveness against the union.
 */
export type ClusterErrorCode = (typeof CLUSTER_ERROR_CODES)[number];

/**
 * Base class for every typed error thrown by the kernel + policy
 * boundary. Carries the three load-bearing fields described in the
 * module JSDoc above.
 *
 * Subclasses set `code` to a literal `ClusterErrorCode`, override
 * `remediationHint` with an actionable next step, and override
 * `retryable` only when the operation can safely be retried unchanged.
 */
export abstract class ClusterError extends Error {
    /**
     * Stable code drawn from {@link ClusterErrorCode}. Surfaces in the
     * MCP envelope, the CLI exit-code map, and AI envelopes.
     */
    public abstract readonly code: ClusterErrorCode;

    /**
     * Actionable next step a consumer can surface to the user — the
     * "WHAT TO DO" the WHAT-failed message alone never carries.
     * Subclasses MUST override with a non-empty string. The Stage C
     * Theme 1 actionability contract: every error answers
     * "now what can the user do?"
     */
    public abstract readonly remediationHint: string;

    /**
     * Whether the operation can safely be retried unchanged. Defaults
     * to false on every kernel error (most kernel failures need
     * caller-side input changes or operator action). Override on
     * subclasses that represent transient failure.
     */
    public readonly retryable: boolean = false;

    constructor(message: string) {
        super(message);
        this.name = 'ClusterError';
    }
}

export class NotFoundError extends ClusterError {
    public readonly code: ClusterErrorCode = 'NOT_FOUND';
    public readonly remediationHint: string =
        'Verify the id and store; the object may have been compensated, ' +
        'rejected, or never existed. Run `db-cluster find "<query>"` to discover ' +
        'available ids.';
    public readonly store: string;
    public readonly recordId: string;
    constructor(store: string, id: string) {
        super(`Not found in ${store} store: ${id}`);
        this.name = 'NotFoundError';
        this.store = store;
        this.recordId = id;
    }
}

export class ProvenanceMissingError extends ClusterError {
    public readonly code: ClusterErrorCode = 'PROVENANCE_MISSING';
    public readonly remediationHint: string =
        'The subject exists but no lineage events have been recorded. ' +
        'If this is unexpected, run `db-cluster verify` and inspect the ledger; ' +
        'a backup/restore cycle may have dropped the ledger.';
    public readonly subjectId: string;
    constructor(subjectId: string) {
        super(`Cannot resolve provenance for: ${subjectId}. No lineage exists.`);
        this.name = 'ProvenanceMissingError';
        this.subjectId = subjectId;
    }
}

export class CommandNotValidatedError extends ClusterError {
    public readonly code: ClusterErrorCode = 'COMMAND_NOT_VALIDATED';
    public readonly remediationHint: string =
        'Call `validateMutation(commandId)` before `commitMutation` — or run ' +
        '`db-cluster validate <commandId>` from the CLI. Commands must move ' +
        'through proposed → validated → committed.';
    public readonly commandId: string;
    constructor(commandId: string) {
        super(`Command ${commandId} has not been validated. Cannot commit.`);
        this.name = 'CommandNotValidatedError';
        this.commandId = commandId;
    }
}

export class CommandRejectedError extends ClusterError {
    public readonly code: ClusterErrorCode = 'COMMAND_REJECTED';
    public readonly remediationHint: string =
        'A rejected command is terminal — it cannot be retried. ' +
        'Inspect the rejection reason via `db-cluster inspect-command <id>` and ' +
        'propose a fresh command with the corrected payload.';
    public readonly commandId: string;
    public readonly reason: string;
    constructor(commandId: string, reason: string) {
        super(`Command ${commandId} rejected: ${reason}`);
        this.name = 'CommandRejectedError';
        this.commandId = commandId;
        this.reason = reason;
    }
}

/**
 * KERNEL-C-005: distinguishes from {@link CommandNotValidatedError}.
 * Raised when commitMutation receives an id that does NOT exist in the
 * command queue — the silent-corruption window opens differently from
 * "exists but not validated."
 *
 * Recovery: re-propose the command. If the caller has persisted state
 * pointing at the missing id, that state is stale.
 */
export class CommandNotFoundError extends ClusterError {
    public readonly code: ClusterErrorCode = 'COMMAND_NOT_FOUND';
    public readonly remediationHint: string =
        'No command with that id is queued. The id may be stale, mistyped, ' +
        'or the queue was reset. List queued commands via ' +
        '`db-cluster list-commands` (operator) or `cluster.listReceipts({limit})` ' +
        '(SDK) and re-propose if needed.';
    public readonly commandId: string;
    constructor(commandId: string) {
        super(`Command ${commandId} not found in queue. Cannot operate on it.`);
        this.name = 'CommandNotFoundError';
        this.commandId = commandId;
    }
}

/**
 * KERNEL-C-005: distinguishes the "already committed / already rejected /
 * already compensated" terminal-state cases from the not-validated case.
 * Pre-fix all three collapsed to `CommandNotValidatedError`, robbing the
 * AI of the ability to branch.
 *
 * Recovery: terminal commands cannot be moved further. Inspect the
 * command to see its history; if a new mutation is needed, propose a
 * fresh command (or, for committed → compensated, call
 * `compensateMutation`).
 */
export class CommandAlreadyTerminalError extends ClusterError {
    public readonly code: ClusterErrorCode = 'COMMAND_ALREADY_TERMINAL';
    public readonly remediationHint: string =
        'The command is already in a terminal state (committed / rejected / ' +
        'compensated). Propose a fresh command for a new mutation, or for a ' +
        'committed command call `compensateMutation` to record a correcting ' +
        'mutation without erasing history.';
    public readonly commandId: string;
    public readonly terminalStatus: string;
    constructor(commandId: string, terminalStatus: string) {
        super(
            `Command ${commandId} is already in terminal status '${terminalStatus}'. ` +
                `Further lifecycle operations are not permitted.`,
        );
        this.name = 'CommandAlreadyTerminalError';
        this.commandId = commandId;
        this.terminalStatus = terminalStatus;
    }
}

/**
 * SHA-KERNEL-C-001: replaces the bare `new Error()` throws in
 * `src/kernel/commands.ts` (validateCommand, approveCommand,
 * rejectCommand, markCommitted, markCompensated, compensateMutation
 * status guard).
 *
 * Carries the `from` and `to` status so AI agents can pattern-match the
 * specific transition that failed; consumers can render a transition
 * diagram explaining the legal moves.
 *
 * Recovery: read `validTransitions(from)` to see the legal moves out of
 * the current state, then either invoke the matching kernel verb or
 * abort.
 */
export class InvalidStateTransitionError extends ClusterError {
    public readonly code: ClusterErrorCode = 'INVALID_STATE_TRANSITION';
    public readonly remediationHint: string =
        'The command is in a status that does not permit this transition. ' +
        'Call `validTransitions(currentStatus)` (kernel/commands.ts) to ' +
        'enumerate legal moves, then invoke the matching verb. Common cause: ' +
        'calling commit on a proposed command (must validate first).';
    public readonly from: string;
    public readonly to: string;
    public readonly commandId?: string;
    constructor(from: string, to: string, commandId?: string) {
        super(
            `Cannot transition command${commandId ? ` ${commandId}` : ''} from status ` +
                `'${from}' to '${to}'. Call validTransitions('${from}') to enumerate legal moves.`,
        );
        this.name = 'InvalidStateTransitionError';
        this.from = from;
        this.to = to;
        this.commandId = commandId;
    }
}

/**
 * Raised when a store mutation succeeds but the post-mutation
 * provenance / receipt write fails — i.e. the store is now mutated
 * but no receipt exists. The kernel tries to record a
 * `mutation_orphaned` ledger event before throwing so that
 * `doctor()` / `verify()` can surface the discrepancy.
 *
 * Recovery: run `db-cluster doctor` to confirm the orphan signal;
 * inspect the ledger for the `mutation_orphaned` event; if the ledger
 * itself is broken, restore from a backup. The mutation cannot be
 * cleanly retried — the store is already dirty.
 */
export class ReceiptFailedError extends ClusterError {
    public readonly code: ClusterErrorCode = 'RECEIPT_FAILED';
    public readonly remediationHint: string =
        'A store mutation succeeded but the receipt write failed — the store ' +
        'is dirty without a matching receipt. Run `db-cluster doctor` to confirm ' +
        'the `mutation_orphaned` signal; inspect the ledger; if the ledger itself ' +
        'is broken, restore from backup. Do NOT blindly retry the mutation.';
    public readonly subjectId: string;
    public readonly commandId: string | undefined;
    public readonly cause: Error;
    constructor(
        subjectId: string,
        commandId: string | undefined,
        cause: Error,
    ) {
        super(
            `Mutation succeeded but receipt/provenance emission failed for subject ${subjectId}${commandId ? ` (command ${commandId})` : ''}: ${cause.message}`,
        );
        this.name = 'ReceiptFailedError';
        this.subjectId = subjectId;
        this.commandId = commandId;
        this.cause = cause;
    }
}

/**
 * Raised by {@link CommandQueue} when its persistence file is unreadable or
 * fails JSON.parse. Mirrors the shape of the adapter-local CorruptStoreError
 * (intentionally — kernel must not import from adapters/, so we declare a
 * sibling type here that callers can `instanceof`-check uniformly with the
 * rest of the kernel error hierarchy).
 *
 * Recovery: restore the cluster from a backup, delete the pending-commands
 * file to start fresh (commands not yet committed will be lost), or inspect
 * the file by hand.
 */
export class CommandQueueCorruptError extends ClusterError {
    public readonly code: ClusterErrorCode = 'COMMAND_QUEUE_CORRUPT';
    public readonly remediationHint: string =
        'The command queue persistence file is unreadable. Recovery paths: ' +
        '(1) restore from a backup that includes pending-commands.json; ' +
        '(2) delete the file to start fresh (pending commands will be lost); ' +
        '(3) inspect the file by hand to recover what you can.';
    public readonly filePath: string;
    public readonly innerCause?: unknown;
    constructor(filePath: string, cause?: unknown) {
        const causeMsg = cause instanceof Error ? cause.message : String(cause ?? 'unknown');
        super(
            `Command queue file is unreadable or corrupt: ${filePath} (${causeMsg}). ` +
                `Pending commands cannot be loaded safely. Recovery: restore from a backup, ` +
                `delete the file to start fresh (pending commands will be lost), ` +
                `or inspect the file by hand.`,
        );
        this.name = 'CommandQueueCorruptError';
        this.filePath = filePath;
        this.innerCause = cause;
    }
}

/**
 * Raised by {@link CommandQueue} when the marker file is present but the
 * pending-commands file is absent. This signals that the queue has previously
 * persisted state (otherwise the marker would not exist) but the queue file
 * has since been deleted or lost. Without this distinction the silent-empty
 * load path masks lost-persistence as confusing downstream "Not found in
 * command store" errors.
 *
 * Recovery: restore from a backup that includes both `pending-commands.json`
 * and `command-queue-marker`, or — if no pending commands need to be
 * recovered — delete the marker file to re-cold-start.
 */
export class CommandQueuePersistenceLostError extends ClusterError {
    public readonly code: ClusterErrorCode = 'COMMAND_QUEUE_PERSISTENCE_LOST';
    public readonly remediationHint: string =
        'Pending-commands file is missing but its marker survives — the queue ' +
        'previously held persisted state. Recovery: restore from a backup that ' +
        'includes both files, or delete the marker file to re-cold-start ' +
        '(this loses any pending commands).';
    public readonly filePath: string;
    public readonly markerPath: string;
    constructor(filePath: string, markerPath: string) {
        super(
            `Command queue persistence lost: marker file present (${markerPath}) but ` +
                `pending-commands file is missing (${filePath}). The queue previously held ` +
                `persisted state. Recovery: restore from a backup that includes both files, ` +
                `or delete the marker file to re-cold-start (this loses any pending commands).`,
        );
        this.name = 'CommandQueuePersistenceLostError';
        this.filePath = filePath;
        this.markerPath = markerPath;
    }
}

/**
 * Raised at `proposeMutation` for `ingest_artifact` when the caller-supplied
 * `payload.contentHash` does not match the recomputed SHA-256 of
 * `payload.content`. Fails fast BEFORE any staging-area write so a misbehaving
 * caller can never seed a poisoned hash → buffer mapping.
 *
 * Recovery: caller recomputes `sha256(content)` and re-proposes with the
 * correct hash.
 */
export class ContentHashMismatchError extends ClusterError {
    public readonly code: ClusterErrorCode = 'CONTENT_HASH_MISMATCH';
    public readonly remediationHint: string =
        'Recompute the hash via `sha256(content)` and re-propose with the ' +
        'correct contentHash. The propose-time validator refuses to stage ' +
        'content whose hash claim disagrees with the bytes.';
    public readonly claimedHash: string;
    public readonly actualHash: string;
    constructor(claimedHash: string, actualHash: string) {
        super(
            `Content hash mismatch on propose: caller claimed ${claimedHash} but ` +
                `sha256(content)=${actualHash}. The ingest_artifact propose-time validator ` +
                `requires a contentHash that matches the supplied buffer.`,
        );
        this.name = 'ContentHashMismatchError';
        this.claimedHash = claimedHash;
        this.actualHash = actualHash;
    }
}

/**
 * Raised at `commitMutation` when the staged content buffer's SHA-256 no
 * longer matches the persisted `contentHash` claim on the command. Distinct
 * from {@link ContentHashMismatchError} because the cause is staging-area
 * tampering (someone or some process rewrote the staging file between
 * propose and commit), not caller error.
 *
 * The staging file is intentionally NOT deleted on this error — it is
 * preserved for forensic inspection.
 *
 * Recovery: investigate the staging directory for tampering, then either
 * re-propose with fresh content or remove the staging file by hand.
 */
export class StagedContentTamperedError extends ClusterError {
    public readonly code: ClusterErrorCode = 'STAGED_CONTENT_TAMPERED';
    public readonly remediationHint: string =
        'Staging file was rewritten between propose and commit — possible ' +
        'tampering. The staging file is preserved for forensic inspection. ' +
        'Recovery: examine the staging file by hand; remove it after inspection; ' +
        're-propose the mutation with fresh content. DO NOT retry without ' +
        'investigating the cause.';
    public readonly contentHash: string;
    public readonly stagingPath: string;
    public readonly actualHash: string;
    constructor(contentHash: string, stagingPath: string, actualHash: string) {
        super(
            `Staged content tampered between propose and commit: command claims ` +
                `contentHash=${contentHash} but the staged file at ${stagingPath} now hashes ` +
                `to ${actualHash}. Staging file preserved for forensics.`,
        );
        this.name = 'StagedContentTamperedError';
        this.contentHash = contentHash;
        this.stagingPath = stagingPath;
        this.actualHash = actualHash;
    }
}

/**
 * @experimental Reserved for future use when a remote adapter cannot access
 * the kernel's local staging directory for `ingest_artifact` buffer payloads.
 *
 * Exported here so callers/MCP surfaces can `instanceof`-check uniformly
 * when the remote-adapter path is wired in a later wave. Not thrown anywhere
 * this wave; the type exists so the surface contract is forward-compatible.
 */
export class BufferSideChannelNotSupportedError extends ClusterError {
    public readonly code: ClusterErrorCode = 'BUFFER_SIDE_CHANNEL_NOT_SUPPORTED';
    public readonly remediationHint: string =
        'This adapter cannot stage Buffer payloads on the kernel-local ' +
        'staging directory. Use a local-adapter cluster for ingest_artifact ' +
        'with buffer content, or pass content as a contentHash reference ' +
        'pointing at an already-staged blob.';
    public readonly adapterName: string;
    constructor(adapterName: string) {
        super(
            `Buffer side-channel for ingest_artifact is not supported on adapter ` +
                `${adapterName}. The kernel-local staging directory is unreachable. ` +
                `This error is reserved for future use; not currently thrown.`,
        );
        this.name = 'BufferSideChannelNotSupportedError';
        this.adapterName = adapterName;
    }
}

/**
 * Raised at validate-time (`validatePayloadForVerb`) when an
 * `ingest_artifact` command's `payload.content` is neither a `Buffer`
 * instance nor a `string`. Catches the post-JSON-roundtrip shape
 * `{type:'Buffer', data:[...]}` BEFORE the command reaches the queue and
 * the silent-corruption window opens. V2-004 follow-up — closes the
 * "validate doesn't probe content shape" gap (KERNEL-B-017 carry-over).
 *
 * Recovery: caller re-issues the command with `payload.content` as either
 * a real `Buffer` (when the caller holds the bytes) or the persisted
 * `contentHash` string (when re-driving a previously-staged ingest).
 */
export class InvalidContentShapeError extends ClusterError {
    public readonly code: ClusterErrorCode = 'INVALID_CONTENT_SHAPE';
    public readonly remediationHint: string =
        'Re-propose with `payload.content` as a real Buffer instance OR a ' +
        'string contentHash reference. Reject the JSON-roundtripped form ' +
        "`{type:'Buffer', data:[byte,...]}` at the caller — it loses byte " +
        'identity and the kernel cannot safely reconstruct it.';
    public readonly actualShape: string;
    constructor(actualShape: string) {
        super(
            `ingest_artifact payload.content has unsupported shape: ${actualShape}. ` +
                `Accepted shapes are: Buffer instance, string (contentHash reference). ` +
                `The post-JSON-roundtrip object form {type:'Buffer', data:[byte,...]} ` +
                `is rejected at validate-time to prevent silent content corruption.`,
        );
        this.name = 'InvalidContentShapeError';
        this.actualShape = actualShape;
    }
}
