/**
 * Mutation safety comparison — demonstrates that db-cluster makes
 * repo-knowledge updates safer through typed command lifecycle.
 *
 * Rules:
 * - No direct repo-knowledge writeback
 * - No raw canonical mutation
 * - No generated fact without source artifact
 * - Command must include support references
 */

import type { ClusterKernel } from '../../kernel/cluster-kernel.js';
import type { Command } from '../../types/command.js';

export interface UpdateProposal {
    /** Entity ID of the fact to update */
    factEntityId: string;
    /** New fact content/attributes */
    patch: Record<string, unknown>;
    /** Artifact IDs that support this update */
    supportingArtifacts: string[];
    /** Who proposed the update */
    proposedBy: string;
    /** Reason for the update */
    reason: string;
}

export interface UpdateResult {
    command: Command;
    /** Whether the update was committed */
    committed: boolean;
    /** Receipt ID if committed */
    receiptId?: string;
    /** Whether repo-knowledge files were modified */
    repoKnowledgeModified: false;
}

/**
 * Propose a fact update through the command lifecycle.
 * Returns the proposed command — does NOT commit.
 */
export async function proposeFactUpdate(
    kernel: ClusterKernel,
    proposal: UpdateProposal,
): Promise<Command> {
    if (proposal.supportingArtifacts.length === 0) {
        throw new Error('Fact updates require at least one supporting artifact');
    }

    const cmd = await kernel.proposeMutation({
        verb: 'update_entity',
        targetStore: 'canonical',
        payload: {
            entityId: proposal.factEntityId,
            patch: proposal.patch,
            supportingArtifacts: proposal.supportingArtifacts,
            reason: proposal.reason,
        },
        proposedBy: proposal.proposedBy,
    });

    return cmd;
}

/**
 * Full update workflow: propose → validate → approve → commit.
 * Only succeeds if operator approves.
 */
export async function executeFactUpdate(
    kernel: ClusterKernel,
    proposal: UpdateProposal,
    operatorId: string,
): Promise<UpdateResult> {
    const cmd = await proposeFactUpdate(kernel, proposal);

    // Validate
    await kernel.validateMutation(cmd.id);

    // Approve (requires operator)
    await kernel.approveMutation(cmd.id, operatorId);

    // Commit
    const result = await kernel.commitMutation(cmd.id, operatorId);

    return {
        command: { ...cmd, status: 'committed' },
        committed: true,
        receiptId: result.receipt.id,
        repoKnowledgeModified: false,
    };
}

/**
 * Generate a writeback payload that COULD be applied to repo-knowledge,
 * but do NOT apply it. Returns the payload for review.
 */
export function generateWritebackPayload(
    factEntityId: string,
    patch: Record<string, unknown>,
    commandId: string,
): { payload: Record<string, unknown>; applied: false } {
    return {
        payload: {
            entityId: factEntityId,
            updates: patch,
            commandRef: commandId,
            generatedAt: new Date().toISOString(),
            warning: 'This payload was generated but NOT applied. Manual review required.',
        },
        applied: false,
    };
}
