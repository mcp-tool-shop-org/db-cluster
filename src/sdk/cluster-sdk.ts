import { ClusterKernel } from '../kernel/cluster-kernel.js';
import { ClusterResolver } from '../resolver/index.js';
import { createLocalCluster } from '../adapters/local/index.js';
import { evaluatePolicy, explainPolicyDecision, checkVisibility } from '../policy/policy-engine.js';
import type { PolicyEngineOptions } from '../policy/policy-engine.js';
import type { Policy, Principal, Capability, TrustZone, VisibilityRule, PolicyDecision } from '../types/policy.js';
import type { EvidenceBundle } from '../types/evidence-bundle.js';
import type { ProvenanceGraph, TraceOptions } from '../types/provenance-graph.js';
import type { Command } from '../types/command.js';
import type { Receipt } from '../types/receipt.js';
import type { FindSourcesResult } from '../kernel/cluster-kernel.js';
import { PolicyEnforcedKernel } from '../kernel/policy-enforced-kernel.js';
import { INTERNAL_TRUSTED_PRINCIPAL } from '../policy/index.js';
import type { Artifact } from '../types/artifact.js';
import type { Entity } from '../types/entity.js';
import {
    sanitizeArtifactForOutput,
    sanitizeEntityForOutput,
    sanitizeReceiptForOutput,
} from '../mcp/sanitize.js';
import {
    sanitizeIndexRecordForOutput,
    sanitizeProvenanceEventForOutput,
} from '../policy/store-output-sanitizers.js';

export interface SDKOptions {
    clusterDir: string;
    policies?: Policy[];
    trustZones?: TrustZone[];
    visibilityRules?: VisibilityRule[];
    /**
     * Principal under which kernel calls run when policies are configured.
     * Required when policies are non-empty for least-privilege use cases;
     * defaults to INTERNAL_TRUSTED_PRINCIPAL (cluster-admin) when omitted.
     * Has no effect when policies are not set (raw kernel path).
     */
    principal?: Principal;
}

/**
 * Internal kernel shape covered by both ClusterKernel and PolicyEnforcedKernel.
 * Used by the SDK so the dispatch path is type-safe regardless of which
 * concrete kernel is constructed.
 */
type KernelLike = Pick<
    ClusterKernel,
    | 'findSources'
    | 'retrieveBundle'
    | 'explainRetrieval'
    | 'traceObject'
    | 'why'
    | 'proposeMutation'
    | 'validateMutation'
    | 'approveMutation'
    | 'rejectMutation'
    | 'commitMutation'
    | 'compensateMutation'
    | 'inspectCommand'
    | 'listReceipts'
>;

export interface PolicyExplainInput {
    principal: Principal;
    capability: Capability;
    resourceUri?: string;
    ownerStore?: 'canonical' | 'artifact' | 'index' | 'ledger';
    entityKind?: string;
    commandVerb?: string;
    trustZone?: string;
}

export interface PolicyExplainResult {
    decision: 'allow' | 'deny';
    matchedPolicyId: string;
    matchedPolicyName: string;
    capability: Capability;
    reason: string;
    principalId: string;
    trustZone: string;
    requiresApproval: boolean;
    explanation: string;
    visibility?: { existenceVisible: boolean; emitPlaceholder: boolean };
}

export interface PolicyTestInput {
    scenario: string;
    principal: Principal;
    actions: Array<{
        capability: Capability;
        resourceUri?: string;
        ownerStore?: 'canonical' | 'artifact' | 'index' | 'ledger';
        commandVerb?: string;
    }>;
}

export interface PolicyTestResult {
    scenario: string;
    principalId: string;
    results: Array<{
        capability: Capability;
        decision: 'allow' | 'deny';
        reason: string;
        matchedPolicyId: string;
        requiresApproval: boolean;
    }>;
    summary: string;
}

/**
 * ClusterSDK — the programmatic API for db-cluster.
 *
 * Exposes cluster verbs, not store internals.
 * SDK cannot bypass validation, approval, or command lifecycle.
 * Every operation goes through the kernel.
 */
export class ClusterSDK {
    /**
     * The internal trusted principal (cluster-admin / internal trust zone).
     * Re-exported as a static so callers can explicitly opt in to the
     * legacy default principal without the silent-fallback warning
     * (SURFACE-R2-004): pass `principal: ClusterSDK.INTERNAL_TRUSTED_PRINCIPAL`
     * when you really want this — least privilege wants a custom principal.
     */
    static readonly INTERNAL_TRUSTED_PRINCIPAL: Principal = INTERNAL_TRUSTED_PRINCIPAL;

    private readonly kernel: KernelLike;
    private readonly resolver: ClusterResolver;
    private readonly policyOptions: PolicyEngineOptions | null;
    private readonly visibilityRules: VisibilityRule[];
    /**
     * True when this SDK wrapped the kernel with PolicyEnforcedKernel.
     *
     * SURFACE-B-007 (Wave B1-Amend): pre-fix `public readonly` made this
     * an attractive bypass-branch surface — any consumer could read it and
     * branch ("if policies aren't enforced, skip the principal check") —
     * a documented anti-pattern that was compileable. Tests assert the
     * value via the `isPolicyEnforced()` introspection method; production
     * code outside the SDK should not branch on internal enforcement
     * state.
     */
    private readonly policyEnforced: boolean;

    constructor(options: SDKOptions) {
        const stores = createLocalCluster(options.clusterDir);
        this.resolver = new ClusterResolver(stores);
        this.visibilityRules = options.visibilityRules ?? [];

        // Policy enforcement is OPT-IN. When the caller passes policies (or
        // trust zones / visibility rules), the SDK wraps the kernel with
        // PolicyEnforcedKernel so every read/write crosses the policy layer.
        // Otherwise the SDK uses raw ClusterKernel — preserves existing
        // behavior for the ~614 baseline tests that never set policies.
        const policyConfigured = !!(
            (options.policies && options.policies.length > 0) ||
            (options.trustZones && options.trustZones.length > 0) ||
            (options.visibilityRules && options.visibilityRules.length > 0)
        );

        if (policyConfigured) {
            // SURFACE-R2-004 fix: warn loudly when a caller configures
            // policies but forgets to set a principal. The SDK silently
            // falls back to INTERNAL_TRUSTED_PRINCIPAL (cluster admin),
            // which defeats least-privilege deployment intent. Callers that
            // really want the trusted principal MUST pass it explicitly via
            // `principal: ClusterSDK.INTERNAL_TRUSTED_PRINCIPAL` to silence
            // the warning.
            let principal: Principal;
            if (options.principal === undefined) {
                console.warn(
                    'ClusterSDK: policies provided without principal — using INTERNAL_TRUSTED_PRINCIPAL. ' +
                    'Pass `principal: ClusterSDK.INTERNAL_TRUSTED_PRINCIPAL` to silence.',
                );
                principal = INTERNAL_TRUSTED_PRINCIPAL;
            } else {
                principal = options.principal;
            }
            this.kernel = new PolicyEnforcedKernel(
                stores,
                { principal },
                {
                    dataDir: options.clusterDir,
                    policies: options.policies ?? [],
                    trustZones: options.trustZones,
                    visibilityRules: options.visibilityRules,
                },
            );
            this.policyOptions = {
                policies: options.policies ?? [],
                trustZones: options.trustZones,
            };
            this.policyEnforced = true;
        } else {
            this.kernel = new ClusterKernel(stores, { dataDir: options.clusterDir });
            this.policyOptions = null;
            this.policyEnforced = false;
        }
    }

    /**
     * Test-seam introspection — returns whether this SDK is policy-enforced.
     *
     * SURFACE-B-007 (Wave B1-Amend): exposes the enforcement state through
     * a method instead of a public field so consumers cannot trivially
     * branch on it inline. Outside `NODE_ENV=test` a stderr warning is
     * emitted to discourage production callers from reading the value —
     * they should branch on capability semantics, not on internal
     * enforcement state.
     */
    isPolicyEnforced(): boolean {
        if (process.env.NODE_ENV !== 'test') {
            // Emit a one-shot warning so production callers know this is a
            // test-seam method, not a public branching surface.
            console.warn(
                'ClusterSDK.isPolicyEnforced(): test-seam introspection — do not branch on this in production code. ' +
                'Use capability semantics (try/catch on POLICY_DENIED) instead.',
            );
        }
        return this.policyEnforced;
    }

    // ─── Retrieval ─────────────────────────────────────────────────

    async findSources(query: string, limit?: number): Promise<FindSourcesResult> {
        return this.kernel.findSources({ query, limit });
    }

    /**
     * Retrieve a structured evidence bundle for a query.
     *
     * SURFACE-B-008 fix (Wave B1-Amend): pre-fix this was a pure pass-through.
     * The returned `EvidenceBundle` includes `indexRecords: IndexRecord[]`
     * (with `metadata` mirroring entity content) and `provenanceEvents:
     * ProvenanceEvent[]` (with `actorId` / `detail.payload`). With raw
     * `ClusterKernel`, the bundle returned owner-store-truth raw — the
     * SDK doctrine documented in `resolve()` ("the returned object is
     * sanitized inline before it leaves the SDK boundary") was violated
     * for these two fields. AGG-002 made `resolve()` unconditional; this
     * extends the same shape to `retrieveBundle()`.
     *
     * Sanitization is unconditional (same shape as AGG-002 / SURFACE-R2-003).
     * The sanitizers tolerate the new `RedactedMarker` type Kernel shipped
     * this wave — values that are already RedactedMarker (e.g. policy-
     * enforced kernel may have pre-redacted some fields) are passed
     * through unchanged via the `_redacted: true` discriminator. Double-
     * redaction is structurally avoided because the sanitizers operate
     * on flat field shape, not on already-redacted markers.
     */
    async retrieveBundle(query: string, options?: { limit?: number }): Promise<EvidenceBundle> {
        const bundle = await this.kernel.retrieveBundle(query, options);
        // SURFACE-B-008: sanitize indexRecords + provenanceEvents inline.
        // The sanitizers return enriched objects (adding `_sourceType`,
        // `_metadataPolicy`, and replacing `metadata`/`actorId`/`detail`).
        // The EvidenceBundle type declares strict IndexRecord / ProvenanceEvent
        // shapes; the cast widens to accept the sanitized superset. A future
        // wave that updates `src/types/evidence-bundle.ts` to express the
        // sanitization-aware shape would let us drop the cast.
        return {
            ...bundle,
            indexRecords: bundle.indexRecords.map((r) => sanitizeIndexRecordForOutput(r) ?? r) as unknown as EvidenceBundle['indexRecords'],
            provenanceEvents: bundle.provenanceEvents.map((ev) => sanitizeProvenanceEventForOutput(ev) ?? ev) as unknown as EvidenceBundle['provenanceEvents'],
        };
    }

    async explainRetrieval(bundle: EvidenceBundle): Promise<{ summary: string; resolvedCount: number; missingCount: number; allFresh: boolean }> {
        const explanation = await this.kernel.explainRetrieval(bundle);
        return {
            summary: explanation.summary,
            resolvedCount: explanation.resolvedCount,
            missingCount: explanation.missingCount,
            allFresh: explanation.allFresh,
        };
    }

    // ─── Resolution ────────────────────────────────────────────────

    /**
     * Resolve a cluster URI to its owner-store object.
     *
     * SURFACE-R003 fix: when the SDK is policy-enforced, the returned object
     * is sanitized inline before it leaves the SDK boundary. Without this,
     * SDK consumers (which is everything except the MCP server, whose
     * boundary sanitizes a second time) would receive `storagePath` and
     * other internal fields. The MCP boundary still sanitizes — these layers
     * are independent and intentionally redundant.
     *
     * SURFACE-R2-003 fix: the previous SDK.resolve sanitizer covered only
     * artifact + canonical. The resolver returns five store types (the two
     * already covered plus `ledger`, `index`, and `receipt`) and the three
     * uncovered types leaked raw ProvenanceEvent / IndexRecord / Receipt
     * objects with `actorId`/`detail.payload`/`metadata`/`resultSummary`
     * fields. The branches below now cover all five.
     *
     * AGG-002 fix-up (Wave A3): sanitization now runs UNCONDITIONALLY,
     * not only when policy-enforced. The previous `if (this.policyEnforced)`
     * guard meant the ~614 baseline-tests path returned raw owner truth
     * for every store type — storagePath on artifact, actorId+detail on
     * ledger, metadata on index, resultSummary on receipt. The
     * `_sourceType` markers and field stripping are an unconditional
     * boundary invariant, not a policy-gated one. The `default: never`
     * arm makes a future 6th ResolvedObject store type a compile error
     * rather than a silent raw-return regression.
     */
    async resolve(uri: string): Promise<{ store: string; object: unknown }> {
        const resolved = await this.resolver.resolve(uri);
        switch (resolved.store) {
            case 'artifact':
                return { store: resolved.store, object: sanitizeArtifactForOutput(resolved.object as Artifact) };
            case 'canonical':
                return { store: resolved.store, object: sanitizeEntityForOutput(resolved.object as Entity) };
            case 'receipt':
                return { store: resolved.store, object: sanitizeReceiptForOutput(resolved.object) };
            case 'ledger':
                return { store: resolved.store, object: sanitizeProvenanceEventForOutput(resolved.object) };
            case 'index':
                return { store: resolved.store, object: sanitizeIndexRecordForOutput(resolved.object) };
            default: {
                // Exhaustiveness guard — adding a new ResolvedObject store
                // type to the union must surface as a TS compile error here.
                // Falls back to raw object only at runtime as a last resort.
                const _exhaustive: never = resolved;
                void _exhaustive;
                return { store: (resolved as { store: string }).store, object: (resolved as { object: unknown }).object };
            }
        }
    }

    // ─── Provenance ────────────────────────────────────────────────

    async traceObject(uri: string, options?: Partial<TraceOptions>): Promise<ProvenanceGraph> {
        return this.kernel.traceObject(uri, options);
    }

    async why(uri: string): Promise<string> {
        return this.kernel.why(uri);
    }

    // ─── Command lifecycle ─────────────────────────────────────────

    async proposeMutation(input: {
        verb: Command['verb'];
        targetStore: Command['targetStore'];
        payload: Record<string, unknown>;
        proposedBy: string;
    }): Promise<Command> {
        return this.kernel.proposeMutation(input);
    }

    async validateMutation(commandId: string): Promise<Command> {
        return this.kernel.validateMutation(commandId);
    }

    async approveMutation(commandId: string, approvedBy: string, note?: string): Promise<Command> {
        return this.kernel.approveMutation(commandId, approvedBy, note);
    }

    async rejectMutation(commandId: string, rejectedBy: string, reason: string): Promise<Command> {
        return this.kernel.rejectMutation(commandId, rejectedBy, reason);
    }

    /**
     * Commit a validated/approved command. Callers must `validateMutation`
     * and `approveMutation` first; the kernel throws `CommandNotValidatedError`
     * otherwise (KERNEL-006).
     *
     * KERNEL-R002 fix: the previous SDK auto-walked `proposed → validated →
     * approved → committed` using the same actorId for both approve and
     * commit. That preserved backward compat but defeated separation of duties
     * — every caller of `commitMutation` could trivially self-approve. The
     * walk is gone; the SDK is a thin pass-through. Surfaces above the SDK
     * (CLI, MCP, programmatic SDK consumers) sequence the lifecycle.
     */
    async commitMutation(commandId: string, actorId: string): Promise<{ command: Command; receipt: Receipt }> {
        return this.kernel.commitMutation(commandId, actorId);
    }

    async compensateMutation(commandId: string, compensatedBy: string, reason: string): Promise<{ compensatingCommand: Command; originalCommand: Command; receipt: Receipt }> {
        return this.kernel.compensateMutation(commandId, compensatedBy, reason);
    }

    async inspectCommand(commandId: string): Promise<Command> {
        return this.kernel.inspectCommand(commandId);
    }

    async listReceipts(filter?: { commandId?: string; since?: string; limit?: number }): Promise<Receipt[]> {
        return this.kernel.listReceipts(filter);
    }

    // ─── Policy surface ────────────────────────────────────────────

    /**
     * Explain what the policy engine would decide for a given action.
     * Does NOT execute the action — this is a dry-run policy check.
     * Never returns restricted object data.
     */
    policyExplain(input: PolicyExplainInput): PolicyExplainResult {
        if (!this.policyOptions) {
            return {
                decision: 'allow',
                matchedPolicyId: '__no_policy',
                matchedPolicyName: 'No Policy Configured',
                capability: input.capability,
                reason: 'No policies configured — default permissive.',
                principalId: input.principal.id,
                trustZone: input.trustZone ?? input.principal.trustZone,
                requiresApproval: false,
                explanation: 'No policies configured. All actions are permitted by default.',
            };
        }

        const decision = evaluatePolicy({
            principal: input.principal,
            capability: input.capability,
            resourceUri: input.resourceUri,
            ownerStore: input.ownerStore,
            entityKind: input.entityKind,
            commandVerb: input.commandVerb,
            trustZone: input.trustZone,
        }, this.policyOptions);

        const explanation = explainPolicyDecision(decision);

        // If denied, check visibility rules for existence disclosure
        let visibility: { existenceVisible: boolean; emitPlaceholder: boolean } | undefined;
        if (decision.decision === 'deny' && input.resourceUri) {
            visibility = checkVisibility(input.resourceUri, input.ownerStore, this.visibilityRules);
        }

        return {
            decision: decision.decision,
            matchedPolicyId: decision.matchedPolicyId,
            matchedPolicyName: decision.matchedPolicyName,
            capability: decision.capability,
            reason: decision.reason,
            principalId: decision.principalId,
            trustZone: decision.trustZone,
            requiresApproval: decision.requiresApproval,
            explanation,
            visibility,
        };
    }

    /**
     * Test a policy scenario — evaluates multiple actions for a principal
     * without executing any of them. Returns structured results.
     */
    policyTest(input: PolicyTestInput): PolicyTestResult {
        const results = input.actions.map((action) => {
            const result = this.policyExplain({
                principal: input.principal,
                capability: action.capability,
                resourceUri: action.resourceUri,
                ownerStore: action.ownerStore,
                commandVerb: action.commandVerb,
            });
            return {
                capability: action.capability,
                decision: result.decision,
                reason: result.reason,
                matchedPolicyId: result.matchedPolicyId,
                requiresApproval: result.requiresApproval,
            };
        });

        const allowed = results.filter((r) => r.decision === 'allow').length;
        const denied = results.filter((r) => r.decision === 'deny').length;
        const summary = `Scenario "${input.scenario}": ${allowed} allowed, ${denied} denied out of ${results.length} actions.`;

        return {
            scenario: input.scenario,
            principalId: input.principal.id,
            results,
            summary,
        };
    }
}
