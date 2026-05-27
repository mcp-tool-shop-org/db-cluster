import { randomUUID } from 'node:crypto';
import type { Command, CommandVerb, CommandStatus, ValidationResult, ValidationCheck } from '../types/command.js';
import { InvalidContentShapeError, InvalidStateTransitionError } from './errors.js';

/**
 * SHA-KERNEL-C-001 helper: build a typed `Error` carrying validation
 * failure detail. Used by {@link validateCommand} to throw a typed
 * shape instead of the bare `new Error(...)` (should-have-been-A from
 * Stage A; closed in Wave C1-Amend).
 *
 * The validation-failure path is distinct from `InvalidStateTransitionError`
 * — those are status-transition guards; this is "the payload didn't pass
 * the per-verb shape check." We extend `Error` with an attached `code`
 * so MCP / CLI consumers can still branch.
 */
export class CommandValidationFailedError extends Error {
    public readonly code = 'COMMAND_VALIDATION_FAILED';
    public readonly remediationHint: string =
        'The command failed structural validation. Inspect ' +
        '`command.validation.checks` to see which check failed; fix the ' +
        'payload and re-propose. Common causes: missing required fields ' +
        '(name/kind on create_entity; filename or artifactId on ' +
        'ingest_artifact); invalid targetStore.';
    public readonly retryable: boolean = false;
    public readonly failures: string;
    constructor(failures: string) {
        super(`Validation failed: ${failures}`);
        this.name = 'CommandValidationFailedError';
        this.failures = failures;
    }
}

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
        // SHA-KERNEL-C-001: was `throw new Error(...)` — typed now so
        // consumers can branch and the error carries a remediationHint.
        throw new CommandValidationFailedError(failures);
    }

    return { ...command, status: 'validated', validation };
}

/**
 * Approve a validated command — operator/policy gate.
 */
export function approveCommand(command: Command, approvedBy: string, note?: string): Command {
    if (command.status !== 'validated') {
        // SHA-KERNEL-C-001: was bare `new Error(...)` — typed now.
        throw new InvalidStateTransitionError(command.status, 'approved', command.id);
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
 * Reject a command — can happen from any non-terminal status (proposed, validated, approved).
 *
 * The valid-from set MUST stay in sync with {@link validTransitions} and
 * {@link isValidTransition} — see KERNEL-010 for the historical contradiction.
 */
export function rejectCommand(command: Command, rejectedBy: string, reason: string): Command {
    if (!isValidTransition(command.status, 'rejected')) {
        // SHA-KERNEL-C-001: was bare `new Error(...)` — typed now.
        throw new InvalidStateTransitionError(command.status, 'rejected', command.id);
    }
    return {
        ...command,
        status: 'rejected',
        rejectedBy,
        rejectedAt: new Date().toISOString(),
        rejectionReason: reason,
    };
}

const REJECTABLE_FROM: CommandStatus[] = ['proposed', 'validated', 'approved'];

export function markCommitted(command: Command, committedBy?: string): Command {
    if (command.status !== 'validated' && command.status !== 'approved') {
        // SHA-KERNEL-C-001: was bare `new Error(...)` — typed now.
        throw new InvalidStateTransitionError(command.status, 'committed', command.id);
    }
    return {
        ...command,
        status: 'committed',
        committedAt: new Date().toISOString(),
        committedBy: committedBy ?? command.proposedBy,
    };
}

/**
 * Mark a command as rejected from any pre-terminal status.
 *
 * Unlike {@link rejectCommand} (which enforces the proposed → validated → rejected
 * transition table), this is the internal escape hatch the kernel uses when a
 * runtime check fails — e.g. validation throws inside commitMutation or an
 * unknown verb is seen in the switch arm. It must still record WHO failed the
 * command and WHY so the receipt audit isn't lossy (see KERNEL-009).
 */
export function markRejected(command: Command, rejectedBy: string, reason: string): Command {
    return {
        ...command,
        status: 'rejected',
        rejectedBy,
        rejectedAt: new Date().toISOString(),
        rejectionReason: reason,
    };
}

/**
 * Mark a committed command as compensated — links to the compensating command.
 */
export function markCompensated(command: Command, compensatingCommandId: string, compensatedBy: string): Command {
    if (command.status !== 'committed') {
        // SHA-KERNEL-C-001: was bare `new Error(...)` — typed now.
        throw new InvalidStateTransitionError(command.status, 'compensated', command.id);
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
            // V2-004 follow-up (KERNEL-B-017): probe the SHAPE of
            // `payload.content` to reject the post-JSON-roundtrip artifact
            // `{type:'Buffer', data:[byte,...]}` BEFORE the command reaches
            // the queue. Wave A4 closed the propose-time Buffer side-channel
            // by hashing + staging, but validateCommand still happily passed
            // ambiguous payload shapes — so a caller building a command from
            // a JSON-roundtripped payload reached the queue and the silent-
            // corruption window opened at commit-time. Reject at validate.
            //
            // Accepted shapes for payload.content:
            //   - Buffer (real Node Buffer instance)
            //   - string (a contentHash reference for the staging area form,
            //     OR a base64-encoded body; the kernel doesn't care which —
            //     a string survives JSON round-trip without losing identity)
            //   - undefined (artifact propose without content body; the
            //     payload uses artifactId instead)
            //
            // Rejected shapes (this finding's exact target):
            //   - object with `type === 'Buffer'` AND `data: Array<number>`
            //     (the JSON-roundtrip artifact)
            //   - any other object / array / number / boolean / null
            if (payload.content !== undefined) {
                const c = payload.content;
                const isBuffer = Buffer.isBuffer(c);
                const isString = typeof c === 'string';
                if (!isBuffer && !isString) {
                    // Identify the ambiguous-shape error specifically so the
                    // thrown error in validateCommand carries the typed
                    // InvalidContentShapeError, not a generic "Validation
                    // failed" string.
                    const shape = describeContentShape(c);
                    throw new InvalidContentShapeError(shape);
                }
            }
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

/**
 * Render a human-readable description of an unsupported payload.content
 * shape. Used in {@link InvalidContentShapeError} so the rejection
 * carries actionable diagnostics ("JSON-roundtripped Buffer object" vs
 * "plain number" vs "array of bytes").
 */
function describeContentShape(c: unknown): string {
    if (c === null) return 'null';
    if (Array.isArray(c)) return `Array(${c.length})`;
    if (typeof c === 'object') {
        // The signature shape of the JSON-roundtrip Buffer artifact.
        const obj = c as { type?: unknown; data?: unknown };
        if (obj.type === 'Buffer' && Array.isArray(obj.data)) {
            return `JSON-roundtripped Buffer object {type:'Buffer', data:[${(obj.data as unknown[]).length} bytes]}`;
        }
        return `object (${Object.keys(c as Record<string, unknown>).slice(0, 3).join(', ')}...)`;
    }
    return typeof c;
}
