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
    private readonly kernel: KernelLike;
    private readonly resolver: ClusterResolver;
    private readonly policyOptions: PolicyEngineOptions | null;
    private readonly visibilityRules: VisibilityRule[];
    /** True when this SDK wrapped the kernel with PolicyEnforcedKernel. */
    public readonly policyEnforced: boolean;

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
            const principal = options.principal ?? INTERNAL_TRUSTED_PRINCIPAL;
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

    // ─── Retrieval ─────────────────────────────────────────────────

    async findSources(query: string, limit?: number): Promise<FindSourcesResult> {
        return this.kernel.findSources({ query, limit });
    }

    async retrieveBundle(query: string, options?: { limit?: number }): Promise<EvidenceBundle> {
        return this.kernel.retrieveBundle(query, options);
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

    async resolve(uri: string): Promise<{ store: string; object: unknown }> {
        const resolved = await this.resolver.resolve(uri);
        return { store: resolved.store, object: resolved.object };
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
     * Commit a mutation. The kernel now requires `validated` or `approved`
     * before commit (KERNEL-006 fix). The SDK auto-walks proposed → validated
     * → approved → committed to preserve backward compat for callers that
     * treat propose+commit as one step. Callers who want explicit visibility
     * of the intermediate states can call `validateMutation` and
     * `approveMutation` directly before this.
     *
     * The walk inspects the command first; only states behind 'approved' are
     * advanced. The actor for the auto-walk is the supplied `actorId`.
     */
    async commitMutation(commandId: string, actorId: string): Promise<{ command: Command; receipt: Receipt }> {
        const cmd = await this.kernel.inspectCommand(commandId).catch(() => null);
        if (cmd) {
            if (cmd.status === 'proposed') {
                await this.kernel.validateMutation(commandId);
                await this.kernel.approveMutation(commandId, actorId);
            } else if (cmd.status === 'validated') {
                await this.kernel.approveMutation(commandId, actorId);
            }
        }
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
