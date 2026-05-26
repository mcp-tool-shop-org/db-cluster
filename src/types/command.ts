/**
 * Command — a typed mutation request that must pass through the kernel.
 * AI proposes commands; the kernel validates, approves, commits, or compensates them.
 *
 * Lifecycle: proposed → validated → approved → committed → (compensated)
 *                               ↘ rejected
 */
export interface Command {
    id: string;
    verb: CommandVerb;
    targetStore: 'canonical' | 'artifact' | 'index' | 'ledger';
    payload: Record<string, unknown>;
    proposedAt: string;
    proposedBy: string;
    status: CommandStatus;

    /** Validation result — set when status transitions to 'validated' or 'rejected' */
    validation?: ValidationResult;
    /** Rejection reason — set when status transitions to 'rejected' */
    rejectionReason?: string;
    /** Who rejected and when */
    rejectedBy?: string;
    rejectedAt?: string;
    /** Approval metadata — set when status transitions to 'approved' */
    approvedBy?: string;
    approvedAt?: string;
    approvalNote?: string;
    /** Set when status transitions to 'committed' */
    committedAt?: string;
    committedBy?: string;
    /** Compensation reference — set when status transitions to 'compensated' */
    compensatedBy?: string;
    compensatedAt?: string;
    compensatingCommandId?: string;
}

export type CommandStatus =
    | 'proposed'
    | 'validated'
    | 'approved'
    | 'committed'
    | 'rejected'
    | 'compensated';

export interface ValidationResult {
    valid: boolean;
    checks: ValidationCheck[];
    validatedAt: string;
}

export interface ValidationCheck {
    name: string;
    passed: boolean;
    message?: string;
}

export type CommandVerb =
    | 'ingest_artifact'
    | 'create_entity'
    | 'update_entity'
    | 'link_evidence'
    | 'propose_mutation'
    | 'reindex'
    | 'compensate';
