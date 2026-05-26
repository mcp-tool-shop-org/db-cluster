import { randomUUID } from 'node:crypto';
import type { Command, CommandVerb, CommandStatus, ValidationResult, ValidationCheck } from '../types/command.js';

/**
 * Create a proposed command. Does NOT mutate any store.
 * The command must be validated and committed through the kernel.
 */
export function proposeCommand(
    verb: CommandVerb,
    targetStore: Command['targetStore'],
    payload: Record<string, unknown>,
    proposedBy: string,
): Command {
    return {
        id: randomUUID(),
        verb,
        targetStore,
        payload,
        proposedAt: new Date().toISOString(),
        proposedBy,
        status: 'proposed',
    };
}

/**
 * Validate a command — runs structural and semantic checks.
 * Returns the command with status='validated' and a ValidationResult,
 * or throws if validation fails fatally.
 */
export function validateCommand(command: Command): Command {
    const checks: ValidationCheck[] = [];

    // Check 1: verb exists
    checks.push({
        name: 'verb_present',
        passed: !!command.verb,
        message: command.verb ? undefined : 'Command missing verb',
    });

    // Check 2: targetStore valid
    const validStores = ['canonical', 'artifact', 'index', 'ledger'];
    checks.push({
        name: 'target_store_valid',
        passed: validStores.includes(command.targetStore),
        message: validStores.includes(command.targetStore) ? undefined : `Invalid target store: ${command.targetStore}`,
    });

    // Check 3: payload exists
    checks.push({
        name: 'payload_present',
        passed: !!command.payload && typeof command.payload === 'object',
        message: command.payload ? undefined : 'Command missing payload',
    });

    // Check 4: verb-specific payload validation
    const payloadCheck = validatePayloadForVerb(command.verb, command.payload);
    checks.push(payloadCheck);

    // Check 5: status must be 'proposed' to validate
    checks.push({
        name: 'status_is_proposed',
        passed: command.status === 'proposed',
        message: command.status === 'proposed' ? undefined : `Cannot validate command in status: ${command.status}`,
    });

    const allPassed = checks.every((c) => c.passed);

    const validation: ValidationResult = {
        valid: allPassed,
        checks,
        validatedAt: new Date().toISOString(),
    };

    if (!allPassed) {
        const failures = checks.filter((c) => !c.passed).map((c) => c.message).join('; ');
        throw new Error(`Validation failed: ${failures}`);
    }

    return { ...command, status: 'validated', validation };
}

/**
 * Approve a validated command — operator/policy gate.
 */
export function approveCommand(command: Command, approvedBy: string, note?: string): Command {
    if (command.status !== 'validated') {
        throw new Error(`Cannot approve command in status: ${command.status}. Must be 'validated'.`);
    }
    return {
        ...command,
        status: 'approved',
        approvedBy,
        approvedAt: new Date().toISOString(),
        approvalNote: note,
    };
}

/**
 * Reject a command — can happen from 'proposed' or 'validated' status.
 */
export function rejectCommand(command: Command, rejectedBy: string, reason: string): Command {
    if (command.status !== 'proposed' && command.status !== 'validated') {
        throw new Error(`Cannot reject command in status: ${command.status}. Must be 'proposed' or 'validated'.`);
    }
    return {
        ...command,
        status: 'rejected',
        rejectedBy,
        rejectedAt: new Date().toISOString(),
        rejectionReason: reason,
    };
}

export function markCommitted(command: Command, committedBy?: string): Command {
    if (command.status !== 'validated' && command.status !== 'approved') {
        throw new Error(`Cannot commit command in status: ${command.status}. Must be 'validated' or 'approved'.`);
    }
    return {
        ...command,
        status: 'committed',
        committedAt: new Date().toISOString(),
        committedBy: committedBy ?? command.proposedBy,
    };
}

export function markRejected(command: Command): Command {
    return { ...command, status: 'rejected', rejectedAt: new Date().toISOString() };
}

/**
 * Mark a committed command as compensated — links to the compensating command.
 */
export function markCompensated(command: Command, compensatingCommandId: string, compensatedBy: string): Command {
    if (command.status !== 'committed') {
        throw new Error(`Cannot compensate command in status: ${command.status}. Must be 'committed'.`);
    }
    return {
        ...command,
        status: 'compensated',
        compensatingCommandId,
        compensatedBy,
        compensatedAt: new Date().toISOString(),
    };
}

/**
 * Get the valid transitions from a given status.
 */
export function validTransitions(status: CommandStatus): CommandStatus[] {
    switch (status) {
        case 'proposed': return ['validated', 'rejected'];
        case 'validated': return ['approved', 'committed', 'rejected'];
        case 'approved': return ['committed', 'rejected'];
        case 'committed': return ['compensated'];
        case 'rejected': return [];
        case 'compensated': return [];
    }
}

/**
 * Check if a status transition is valid.
 */
export function isValidTransition(from: CommandStatus, to: CommandStatus): boolean {
    return validTransitions(from).includes(to);
}

// --- Internal helpers ---

function validatePayloadForVerb(verb: CommandVerb, payload: Record<string, unknown>): ValidationCheck {
    switch (verb) {
        case 'create_entity': {
            const hasKind = typeof payload.kind === 'string' && payload.kind.length > 0;
            const hasName = typeof payload.name === 'string' && payload.name.length > 0;
            return {
                name: 'payload_shape',
                passed: hasKind && hasName,
                message: hasKind && hasName ? undefined : 'create_entity requires kind and name',
            };
        }
        case 'update_entity': {
            const hasEntityId = typeof payload.entityId === 'string';
            const hasPatch = !!payload.patch && typeof payload.patch === 'object';
            return {
                name: 'payload_shape',
                passed: hasEntityId && hasPatch,
                message: hasEntityId && hasPatch ? undefined : 'update_entity requires entityId and patch',
            };
        }
        case 'ingest_artifact': {
            const hasFilename = typeof payload.filename === 'string' || typeof payload.artifactId === 'string';
            return {
                name: 'payload_shape',
                passed: hasFilename,
                message: hasFilename ? undefined : 'ingest_artifact requires filename or artifactId',
            };
        }
        case 'link_evidence': {
            const hasArt = typeof payload.artifactId === 'string';
            const hasEnt = typeof payload.entityId === 'string';
            return {
                name: 'payload_shape',
                passed: hasArt && hasEnt,
                message: hasArt && hasEnt ? undefined : 'link_evidence requires artifactId and entityId',
            };
        }
        case 'compensate': {
            const hasOriginal = typeof payload.originalCommandId === 'string';
            const hasReason = typeof payload.reason === 'string';
            return {
                name: 'payload_shape',
                passed: hasOriginal && hasReason,
                message: hasOriginal && hasReason ? undefined : 'compensate requires originalCommandId and reason',
            };
        }
        case 'reindex':
        case 'propose_mutation':
        default:
            return { name: 'payload_shape', passed: true };
    }
}
