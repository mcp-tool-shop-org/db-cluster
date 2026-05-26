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
