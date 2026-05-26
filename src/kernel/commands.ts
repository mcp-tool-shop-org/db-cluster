import { randomUUID } from 'node:crypto';
import type { Command, CommandVerb } from '../types/command.js';

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

export function validateCommand(command: Command): Command {
    // Phase 1 validation: check required fields exist.
    // Future phases will add schema validation, permission checks, etc.
    if (!command.verb) throw new Error('Command missing verb');
    if (!command.targetStore) throw new Error('Command missing targetStore');
    if (!command.payload) throw new Error('Command missing payload');

    return { ...command, status: 'validated' };
}

export function markCommitted(command: Command): Command {
    return { ...command, status: 'committed' };
}

export function markRejected(command: Command): Command {
    return { ...command, status: 'rejected' };
}
