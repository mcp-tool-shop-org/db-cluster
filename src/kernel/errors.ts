export class ClusterError extends Error {
    constructor(
        message: string,
        public readonly code: string,
    ) {
        super(message);
        this.name = 'ClusterError';
    }
}

export class NotFoundError extends ClusterError {
    constructor(store: string, id: string) {
        super(`Not found in ${store} store: ${id}`, 'NOT_FOUND');
        this.name = 'NotFoundError';
    }
}

export class ProvenanceMissingError extends ClusterError {
    constructor(subjectId: string) {
        super(
            `Cannot resolve provenance for: ${subjectId}. No lineage exists.`,
            'PROVENANCE_MISSING',
        );
        this.name = 'ProvenanceMissingError';
    }
}

export class CommandNotValidatedError extends ClusterError {
    constructor(commandId: string) {
        super(
            `Command ${commandId} has not been validated. Cannot commit.`,
            'COMMAND_NOT_VALIDATED',
        );
        this.name = 'CommandNotValidatedError';
    }
}

export class CommandRejectedError extends ClusterError {
    constructor(commandId: string, reason: string) {
        super(`Command ${commandId} rejected: ${reason}`, 'COMMAND_REJECTED');
        this.name = 'CommandRejectedError';
    }
}

/**
 * Raised when a store mutation succeeds but the post-mutation
 * provenance / receipt write fails — i.e. the store is now mutated
 * but no receipt exists. The kernel tries to record a
 * `mutation_orphaned` ledger event before throwing so that
 * `doctor()` / `verify()` can surface the discrepancy.
 */
export class ReceiptFailedError extends ClusterError {
    constructor(
        public readonly subjectId: string,
        public readonly commandId: string | undefined,
        public readonly cause: Error,
    ) {
        super(
            `Mutation succeeded but receipt/provenance emission failed for subject ${subjectId}${commandId ? ` (command ${commandId})` : ''}: ${cause.message}`,
            'RECEIPT_FAILED',
        );
        this.name = 'ReceiptFailedError';
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
    public readonly filePath: string;
    public readonly innerCause?: unknown;
    constructor(filePath: string, cause?: unknown) {
        const causeMsg = cause instanceof Error ? cause.message : String(cause ?? 'unknown');
        super(
            `Command queue file is unreadable or corrupt: ${filePath} (${causeMsg}). ` +
                `Pending commands cannot be loaded safely. Recovery: restore from a backup, ` +
                `delete the file to start fresh (pending commands will be lost), ` +
                `or inspect the file by hand.`,
            'COMMAND_QUEUE_CORRUPT',
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
    public readonly filePath: string;
    public readonly markerPath: string;
    constructor(filePath: string, markerPath: string) {
        super(
            `Command queue persistence lost: marker file present (${markerPath}) but ` +
                `pending-commands file is missing (${filePath}). The queue previously held ` +
                `persisted state. Recovery: restore from a backup that includes both files, ` +
                `or delete the marker file to re-cold-start (this loses any pending commands).`,
            'COMMAND_QUEUE_PERSISTENCE_LOST',
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
    public readonly claimedHash: string;
    public readonly actualHash: string;
    constructor(claimedHash: string, actualHash: string) {
        super(
            `Content hash mismatch on propose: caller claimed ${claimedHash} but ` +
                `sha256(content)=${actualHash}. The ingest_artifact propose-time validator ` +
                `requires a contentHash that matches the supplied buffer.`,
            'CONTENT_HASH_MISMATCH',
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
    public readonly contentHash: string;
    public readonly stagingPath: string;
    public readonly actualHash: string;
    constructor(contentHash: string, stagingPath: string, actualHash: string) {
        super(
            `Staged content tampered between propose and commit: command claims ` +
                `contentHash=${contentHash} but the staged file at ${stagingPath} now hashes ` +
                `to ${actualHash}. Staging file preserved for forensics.`,
            'STAGED_CONTENT_TAMPERED',
        );
        this.name = 'StagedContentTamperedError';
        this.contentHash = contentHash;
        this.stagingPath = stagingPath;
        this.actualHash = actualHash;
    }
}

/**
 * Reserved for future use when a remote adapter cannot access the kernel's
 * local staging directory for `ingest_artifact` buffer payloads. Exported
 * here so callers/MCP surfaces can `instanceof`-check uniformly when the
 * remote-adapter path is wired in a later wave. Not thrown anywhere this
 * wave; the type exists so the surface contract is forward-compatible.
 */
export class BufferSideChannelNotSupportedError extends ClusterError {
    public readonly adapterName: string;
    constructor(adapterName: string) {
        super(
            `Buffer side-channel for ingest_artifact is not supported on adapter ` +
                `${adapterName}. The kernel-local staging directory is unreachable. ` +
                `This error is reserved for future use; not currently thrown.`,
            'BUFFER_SIDE_CHANNEL_NOT_SUPPORTED',
        );
        this.name = 'BufferSideChannelNotSupportedError';
        this.adapterName = adapterName;
    }
}
