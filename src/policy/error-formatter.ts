/**
 * Canonical user-facing error formatter.
 *
 * Architectural §2b helper (Wave C1-Amend). Replaces the per-surface
 * inline formatting (CLI `console.error(err.message)` + MCP envelope
 * synthesis + dashboard error state rendering) with a single function.
 *
 * The `CommandQueueCorruptError` (`src/kernel/errors.ts`) is the
 * exemplar pattern this helper crystallizes: ${message}\n  → try: ${hint}.
 * Stage C Theme 1 actionability: every error answers WHAT TO DO, not
 * just WHAT failed.
 *
 * CLI + MCP + SDK + dashboard all import {@link formatForUser}. Any
 * future "format an error for a user" surface that re-implements this
 * pattern is a family-of-call-sites family-probe miss.
 */

import { ClusterError } from '../kernel/errors.js';
import type { AiErrorEnvelope } from '../types/ai-envelope.js';

/**
 * Render a `ClusterError` (or an already-built `AiErrorEnvelope`) to
 * the canonical operator-facing prose form:
 *
 *   ```
 *   <message>
 *     → try: <remediation hint>
 *   ```
 *
 * Multi-line remediation hints are indented under the `→ try:` marker
 * so the prose stays scannable. The marker itself is a stable
 * convention — `db-cluster doctor` already uses `→ fix:` for
 * suggestedCommand bullets; we use `→ try:` for the per-error
 * remediation to keep the two visually distinct.
 *
 * Non-ClusterError inputs (plain Error, string, unknown) collapse to a
 * generic prose form that still names the type but cannot offer a
 * remediation hint — the caller should prefer to convert to a typed
 * error upstream.
 *
 * @param err - A `ClusterError` subclass instance, an `AiErrorEnvelope`
 *              (already populated at a sanitizer boundary), or any
 *              other unknown value.
 * @returns A user-facing multi-line string suitable for stderr / CLI
 *          --json error output / MCP error envelope `_meta.preview`.
 *
 * @example
 *   try {
 *       await kernel.commitMutation(commandId, actorId);
 *   } catch (err) {
 *       process.stderr.write(formatForUser(err));
 *       process.exitCode = typedErrorToExitCode((err as ClusterError).code);
 *   }
 */
export function formatForUser(err: ClusterError | AiErrorEnvelope | unknown): string {
    if (err instanceof ClusterError) {
        return `${err.message}\n  → try: ${err.remediationHint}`;
    }
    // Already-built envelope (e.g. coming back through an MCP roundtrip
    // where the original ClusterError instance is lost to JSON).
    if (
        typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        'remediation_hint' in err &&
        'message' in err
    ) {
        const env = err as AiErrorEnvelope;
        return `${env.message}\n  → try: ${env.remediation_hint}`;
    }
    if (err instanceof Error) {
        return err.message;
    }
    return String(err ?? 'unknown error');
}

/**
 * Build an `AiErrorEnvelope` from a `ClusterError`. Surface-side
 * sanitizers (MCP, SDK) call this to produce the AI-facing envelope
 * from a typed error instance.
 *
 * Pulls the public-readonly subclass fields into the `context` dict.
 * This is the canonical place to add a new subclass's context — adding
 * a new subclass to {@link ClusterError} requires extending this
 * helper's context-pulling logic (the regression test enforces).
 *
 * The `scrubMessage` callback is injected so the helper stays
 * boundary-agnostic — MCP passes the path-scrubbing variant, CLI may
 * pass identity (it controls its own output), tests pass identity.
 *
 * @param err - A {@link ClusterError} subclass instance.
 * @param scrubMessage - Function applied to the error's message before
 *                       surfacing. MCP passes a path-scrubber.
 * @returns AI envelope populated from the error's public-readonly fields.
 *
 * @example
 *   const envelope = errorToAiEnvelope(err, scrubMessage);
 *   return JSON.stringify({_meta: {operation: 'error'}, body: envelope});
 */
export function errorToAiEnvelope(
    err: ClusterError,
    scrubMessage: (msg: string) => string = (s) => s,
): AiErrorEnvelope {
    const context: Record<string, unknown> = {};
    // Wave C1-Amend fix-up (Cluster A wiring): surface the subclass name
    // so MCP consumers can pattern-match on the class even when the
    // `code` is shared (e.g. RECEIPT_FAILED across two subclass
    // scenarios). Mirror of the `extractTypedErrorContext` discipline
    // sanitize.ts previously carried.
    if (err.name && err.name !== 'ClusterError') {
        context.errorClass = err.name;
    }
    // Subclass-context pull. New subclasses extend this list.
    // Path-like strings get scrubbed; primitives pass through unchanged.
    const e = err as ClusterError & Record<string, unknown>;
    const setStr = (key: string, val: unknown) => {
        if (typeof val === 'string') context[key] = scrubMessage(val);
    };
    setStr('commandId', e.commandId);
    setStr('subjectId', e.subjectId);
    setStr('recordId', e.recordId);
    setStr('store', e.store);
    setStr('filePath', e.filePath);
    setStr('markerPath', e.markerPath);
    setStr('claimedHash', e.claimedHash);
    setStr('actualHash', e.actualHash);
    setStr('contentHash', e.contentHash);
    setStr('stagingPath', e.stagingPath);
    setStr('actualShape', e.actualShape);
    setStr('adapterName', e.adapterName);
    setStr('from', e.from);
    setStr('to', e.to);
    setStr('terminalStatus', e.terminalStatus);
    setStr('reason', e.reason);
    // PolicyDeniedError carries a structured `decision`.
    if (e.decision && typeof e.decision === 'object') {
        const d = e.decision as Record<string, unknown>;
        if (typeof d.capability === 'string') context.capability = d.capability;
        if (typeof d.matchedPolicyName === 'string') context.matchedPolicyName = d.matchedPolicyName;
        if (typeof d.matchedPolicyId === 'string') context.matchedPolicyId = d.matchedPolicyId;
        if (typeof d.principalId === 'string') context.principalId = d.principalId;
        if (typeof d.resourceUri === 'string') context.resourceUri = d.resourceUri;
    }
    // ReceiptFailedError chains a `cause`. We surface its NAME and a
    // scrubbed message — the cause instance itself is not JSON-safe.
    if (e.cause instanceof Error) {
        context.causeName = e.cause.name;
        context.causeMessage = scrubMessage(e.cause.message);
    }

    return {
        code: err.code,
        message: scrubMessage(err.message),
        retryable: err.retryable,
        remediation_hint: err.remediationHint,
        context,
    };
}
