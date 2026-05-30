/**
 * AI-006 (Wave V4): typed error for AI-facing MCP approval-gate refusals.
 *
 * Pre-fix, the MCP commit + compensate approval gates RETURNED a refusal
 * object on the success path (no `isError`), so a spec-compliant host read a
 * `POLICY_DENIED` on the two most destructive tools as SUCCESS. The fix routes
 * both refusals through THIS typed error (thrown), so the existing
 * `CallToolRequestSchema` catch arm sets `isError: true` and builds the
 * canonical `AiErrorEnvelope` (via `redactError` → `errorToAiEnvelope`).
 *
 * It is a SIBLING of the kernel's `PolicyDeniedError` (which carries a
 * policy-engine `decision`), not a reuse: a surface approval-gate refusal is
 * not a policy-engine decision. It lives in `src/policy/` (not `src/kernel/`)
 * so the MCP surface can import it without a no-back-edge violation — the MCP
 * server already imports from `../policy/`.
 *
 * Shares the stable `POLICY_DENIED` code (→ CLI exit 77, EX_NOPERM). Per-
 * instance `message` + `remediationHint` because one class serves both the
 * commit gate (status-not-approved) and the compensate gate (privileged-only).
 */
import { ClusterError, type ClusterErrorCode } from '../kernel/errors.js';

export interface ApprovalGateContext {
    /** The command the refused action targeted. */
    commandId: string;
    /** Commit gate: the command's actual status (e.g. 'validated'). */
    currentStatus?: string;
    /** Commit gate: the status the AI surface requires before commit ('approved'). */
    requiredStatus?: string;
    /** Compensate gate: the surface that refused ('ai-facing'). */
    surface?: string;
    /** Compensate gate: whether an operator privileged opt-in would lift the refusal. */
    requiresPrivileged?: boolean;
}

export class ApprovalGateDeniedError extends ClusterError {
    public readonly code: ClusterErrorCode = 'POLICY_DENIED';
    public readonly remediationHint: string;
    public readonly commandId: string;
    public readonly currentStatus?: string;
    public readonly requiredStatus?: string;
    public readonly surface?: string;
    public readonly requiresPrivileged?: boolean;

    constructor(message: string, remediationHint: string, ctx: ApprovalGateContext) {
        super(message);
        this.name = 'ApprovalGateDeniedError';
        this.remediationHint = remediationHint;
        this.commandId = ctx.commandId;
        this.currentStatus = ctx.currentStatus;
        this.requiredStatus = ctx.requiredStatus;
        this.surface = ctx.surface;
        this.requiresPrivileged = ctx.requiresPrivileged;
    }
}
