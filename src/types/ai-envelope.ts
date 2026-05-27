/**
 * AiErrorEnvelope — the AI-facing error shape consumers populate at every
 * surface boundary (MCP error path, SDK error catch, CLI --json error
 * output, dashboard error state).
 *
 * Architectural §2a (Wave C1-Amend). Pre-fix `redactError` in
 * `src/mcp/sanitize.ts` produced `{code, message}` only — the rich
 * subclass context (claimedHash, actualHash, filePath, decision.capability,
 * cause.name, commandId) was collapsed to prose. KERNEL-C-001 plus the
 * AI envelope poverty cluster (Theme 2). This module establishes the
 * canonical shape; surface-side consumers (Surface domain) populate it.
 *
 * The shape mirrors the {@link ClusterError} base class contract:
 *   - `code` reads `err.code` (stable {@link ClusterErrorCode})
 *   - `retryable` reads `err.retryable`
 *   - `remediation_hint` reads `err.remediationHint`
 *   - `context` is a per-subclass dict pulled from public-readonly fields
 *     (claimedHash + actualHash for ContentHashMismatchError, filePath
 *     for CommandQueueCorruptError, decision.capability for
 *     PolicyDeniedError, commandId + from + to for
 *     InvalidStateTransitionError, etc.)
 *   - `next_valid_actions` is set ONLY on command-lifecycle errors where
 *     the consumer can branch (e.g. `CommandNotValidatedError` carries
 *     `['validated']` — the AI should validate first then retry commit).
 *
 * AI consumers branch like:
 *   ```ts
 *   const env = await mcpClient.call('cluster_commit_mutation', {commandId});
 *   if (env._meta?.operation === 'error') {
 *       const err = env.body as AiErrorEnvelope;
 *       if (err.retryable) await retry(err);
 *       else if (err.next_valid_actions?.length) await trySuggestedFlow(err.next_valid_actions);
 *       else surfaceToOperator(err.remediation_hint);
 *   }
 *   ```
 *
 * EmptyResultMeta is the parallel for empty-result responses — pre-fix
 * `findSources` returning `{indexRecords: [], resolvedEntities: [], ...}`
 * gave the AI no signal whether (a) the query matched nothing, (b) the
 * data is empty, (c) policy filtered everything out. KERNEL-C-003 /
 * SURFACE-C-003. The `_meta` field is OPTIONAL — surfaces that always
 * return data may omit it; surfaces that can return empty include it.
 */

import type { ClusterErrorCode } from '../kernel/errors.js';
import type { CommandStatus } from './command.js';

/**
 * The AI-facing error envelope. Populated at the consumer boundary by
 * reading the public-readonly fields off a {@link ClusterError} subclass.
 *
 * Stability promise: the shape is the contract. Adding a new optional
 * field is non-breaking; renaming or removing a field is breaking.
 */
export type AiErrorEnvelope = {
    /** Stable code — see {@link ClusterErrorCode} for the closed union. */
    code: ClusterErrorCode;
    /** Path-scrubbed message safe to surface to AI / operator. */
    message: string;
    /** Whether the operation can safely be retried unchanged. */
    retryable: boolean;
    /** Actionable next step. Mirrors `ClusterError.remediationHint`. */
    remediation_hint: string;
    /**
     * Subclass-specific context pulled from public-readonly fields:
     *   - ContentHashMismatchError → `{claimedHash, actualHash}`
     *   - StagedContentTamperedError → `{contentHash, stagingPath, actualHash}`
     *   - CommandQueueCorruptError → `{filePath}`
     *   - PolicyDeniedError → `{capability, matchedPolicyName, principalId}`
     *   - InvalidStateTransitionError → `{from, to, commandId}`
     *   - NotFoundError → `{store, recordId}`
     *   - CommandRejectedError → `{commandId, reason}`
     *   - CommandNotFoundError / CommandNotValidatedError /
     *     CommandAlreadyTerminalError → `{commandId, terminalStatus?}`
     *   - ReceiptFailedError → `{subjectId, commandId, causeName}`
     *
     * The context is JSON-safe (no Error instances, no Buffer, no
     * functions). MCP / dashboard / CLI all serialize cleanly.
     */
    context: Record<string, unknown>;
    /**
     * For command-lifecycle errors only: the names of the next MCP tools
     * (or `CommandStatus` values) the AI consumer should invoke to make
     * progress. Pulled from `validTransitions(currentStatus)` or from the
     * MCP-side `lifecycleNextValidActions` map.
     *
     * The union widens to `string[]` because consumers populate this field
     * with two different vocabularies:
     *   - **CommandStatus values** (e.g. 'validated', 'committed') — when
     *     a kernel-side caller wants to suggest a status transition.
     *   - **MCP tool names** (e.g. 'cluster_validate_mutation') — when
     *     the MCP-side catch arm wants to point the AI at the next tool
     *     it can call directly.
     *
     * Wave C1-Amend fix-up (V1-C1-010 + V3-C1-006): pre-fix the type was
     * `CommandStatus[]` but the MCP-side producer emitted tool-name
     * strings — a silent contract drift between producer and consumer.
     * The widened union resolves both producers while keeping the field
     * meaningful (a non-empty array always names something callable).
     */
    next_valid_actions?: (CommandStatus | string)[];
};

/**
 * Empty-result meta surfaced on read tools when the result set is empty.
 * Distinguishes the three reasons emptiness can arise:
 *
 *   - `no_data` — the store is empty for this query domain (e.g.
 *     `findSources("anything")` on a freshly-initialized cluster).
 *   - `no_match` — the store has data but nothing matched the query
 *     (e.g. `findSources("noprov")` against a cluster of entities and
 *     artifacts that just don't include any with provenance text).
 *   - `all_filtered_by_policy` — the underlying query matched, but
 *     `PolicyEnforcedKernel` filtered every record out (insufficient
 *     `read_owner_truth` for any of them). Tells the AI to request the
 *     missing capability or surrender the lookup.
 *
 * AI consumers branch:
 *   ```ts
 *   if (result._meta?.empty_reason === 'all_filtered_by_policy') {
 *       // Don't widen the query — the AI lacks the capability.
 *   } else if (result._meta?.empty_reason === 'no_match') {
 *       // Widening the query is the next step.
 *   }
 *   ```
 *
 * KERNEL-C-003 / SURFACE-C-003. The `EmptyResultMeta` shape is the
 * generic; specific surfaces may extend with additional context
 * (filteredCount on findSources, etc.) by intersecting types.
 */
export type EmptyResultMeta = {
    _meta: {
        empty_reason: 'no_data' | 'no_match' | 'all_filtered_by_policy';
        remediation_hint: string;
        /**
         * For `all_filtered_by_policy` only: how many records the
         * underlying call returned BEFORE policy filtering. Lets the AI
         * decide whether to broaden the query or surrender on capability.
         */
        filteredCount?: number;
    };
};
