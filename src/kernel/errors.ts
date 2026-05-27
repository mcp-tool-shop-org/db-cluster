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
