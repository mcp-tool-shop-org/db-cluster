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
