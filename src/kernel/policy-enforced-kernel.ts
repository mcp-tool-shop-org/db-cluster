import type { ClusterStores } from '../contracts/index.js';
import type { Principal, Capability, PolicyDecision, TrustZone, Policy, VisibilityRule } from '../types/policy.js';
import type { Entity } from '../types/entity.js';
import type { Artifact } from '../types/artifact.js';
import type { EvidenceBundle } from '../types/evidence-bundle.js';
import type { ProvenanceGraph, TraceOptions } from '../types/provenance-graph.js';
import type { Receipt } from '../types/receipt.js';
import type { Command } from '../types/command.js';
import { evaluatePolicy, checkVisibility } from '../policy/policy-engine.js';
import type { PolicyEngineOptions } from '../policy/policy-engine.js';
import { ClusterKernel } from './cluster-kernel.js';
import type {
    KernelOptions,
    FindSourcesInput,
    FindSourcesResult,
    ProposeMutationInput,
    CommitMutationResult,
} from './cluster-kernel.js';
import { ClusterError } from './errors.js';

// ─── Policy denial error ───────────────────────────────────────────────────

export class PolicyDeniedError extends ClusterError {
    constructor(
        public readonly decision: PolicyDecision,
    ) {
        super(
            `Policy denied: ${decision.capability} — ${decision.reason} (policy: ${decision.matchedPolicyName})`,
            'POLICY_DENIED',
        );
        this.name = 'PolicyDeniedError';
    }
}

// ─── Policy context ────────────────────────────────────────────────────────

export interface PolicyContext {
    principal: Principal;
    trustZone?: string;
}

export interface PolicyKernelOptions extends KernelOptions {
    policies: Policy[];
    trustZones?: TrustZone[];
    visibilityRules?: VisibilityRule[];
}

// ─── Policy-enforced kernel ────────────────────────────────────────────────

/**
 * Wraps ClusterKernel with policy enforcement.
 *
 * Policy sits ABOVE existing cluster law:
 * - If policy denies, the operation never reaches the kernel.
 * - If policy allows, the kernel still applies its own validation
 *   (command lifecycle, provenance, owner-store boundaries, etc.).
 * - Policy cannot weaken existing guarantees.
 */
export class PolicyEnforcedKernel {
    private readonly kernel: ClusterKernel;
    private readonly policyOptions: PolicyEngineOptions;
    private readonly visibilityRules: VisibilityRule[];

    constructor(
        stores: ClusterStores,
        private readonly context: PolicyContext,
        policyOptions: PolicyKernelOptions,
    ) {
        this.kernel = new ClusterKernel(stores, policyOptions);
        this.policyOptions = {
            policies: policyOptions.policies,
            trustZones: policyOptions.trustZones,
        };
        this.visibilityRules = policyOptions.visibilityRules ?? [];
    }

    // ─── Policy check helper ─────────────────────────────────────────

    private enforce(capability: Capability, opts?: {
        resourceUri?: string;
        ownerStore?: 'canonical' | 'artifact' | 'index' | 'ledger';
        entityKind?: string;
        commandVerb?: string;
    }): PolicyDecision {
        const decision = evaluatePolicy({
            principal: this.context.principal,
            capability,
            trustZone: this.context.trustZone ?? this.context.principal.trustZone,
            resourceUri: opts?.resourceUri,
            ownerStore: opts?.ownerStore,
            entityKind: opts?.entityKind,
            commandVerb: opts?.commandVerb,
        }, this.policyOptions);

        if (decision.decision === 'deny') {
            throw new PolicyDeniedError(decision);
        }

        return decision;
    }

    // ─── Read verbs ──────────────────────────────────────────────────

    async inspectEntity(id: string): Promise<Entity> {
        this.enforce('read_owner_truth', { ownerStore: 'canonical', resourceUri: `cluster://canonical/${id}` });
        return this.kernel.inspectEntity(id);
    }

    async findSources(input: FindSourcesInput): Promise<FindSourcesResult> {
        this.enforce('discover_existence', { ownerStore: 'index' });

        const result = await this.kernel.findSources(input);

        // Apply visibility filtering: remove results the principal cannot see
        const filteredEntities: Entity[] = [];
        const filteredArtifacts: Artifact[] = [];

        for (const entity of result.resolvedEntities) {
            const canRead = evaluatePolicy({
                principal: this.context.principal,
                capability: 'read_owner_truth',
                trustZone: this.context.trustZone ?? this.context.principal.trustZone,
                ownerStore: 'canonical',
                resourceUri: `cluster://canonical/${entity.id}`,
                entityKind: entity.kind,
            }, this.policyOptions);

            if (canRead.decision === 'allow') {
                filteredEntities.push(entity);
            }
        }

        for (const artifact of result.resolvedArtifacts) {
            const canRead = evaluatePolicy({
                principal: this.context.principal,
                capability: 'read_owner_truth',
                trustZone: this.context.trustZone ?? this.context.principal.trustZone,
                ownerStore: 'artifact',
                resourceUri: `cluster://artifact/${artifact.id}`,
            }, this.policyOptions);

            if (canRead.decision === 'allow') {
                filteredArtifacts.push(artifact);
            }
        }

        return {
            indexRecords: result.indexRecords,
            resolvedEntities: filteredEntities,
            resolvedArtifacts: filteredArtifacts,
        };
    }

    async retrieveBundle(query: string, options?: { limit?: number }): Promise<EvidenceBundle> {
        this.enforce('read_derivative', { ownerStore: 'index' });
        return this.kernel.retrieveBundle(query, options);
    }

    async explainRetrieval(bundle: EvidenceBundle) {
        this.enforce('explain_retrieval');
        return this.kernel.explainRetrieval(bundle);
    }

    // ─── Provenance verbs ────────────────────────────────────────────

    async traceObject(uri: string, options?: Partial<TraceOptions>): Promise<ProvenanceGraph> {
        this.enforce('trace_provenance', { resourceUri: uri });
        return this.kernel.traceObject(uri, options);
    }

    async why(uri: string): Promise<string> {
        this.enforce('trace_provenance', { resourceUri: uri });
        return this.kernel.why(uri);
    }

    // ─── Command lifecycle verbs ─────────────────────────────────────

    async proposeMutation(input: ProposeMutationInput): Promise<Command> {
        this.enforce('propose_mutation', {
            ownerStore: input.targetStore as any,
            commandVerb: input.verb,
        });
        return this.kernel.proposeMutation(input);
    }

    async validateMutation(commandId: string): Promise<Command> {
        this.enforce('validate_command');
        return this.kernel.validateMutation(commandId);
    }

    async approveMutation(commandId: string, approvedBy: string, note?: string): Promise<Command> {
        this.enforce('approve_command');
        return this.kernel.approveMutation(commandId, approvedBy, note);
    }

    async rejectMutation(commandId: string, rejectedBy: string, reason: string): Promise<Command> {
        this.enforce('reject_command');
        return this.kernel.rejectMutation(commandId, rejectedBy, reason);
    }

    async commitMutation(commandId: string, actorId: string): Promise<CommitMutationResult> {
        this.enforce('commit_command', { commandVerb: undefined });
        return this.kernel.commitMutation(commandId, actorId);
    }

    async compensateMutation(
        originalCommandId: string,
        compensatedBy: string,
        reason: string,
        compensatingPayload?: Record<string, unknown>,
    ) {
        this.enforce('compensate_command');
        return this.kernel.compensateMutation(originalCommandId, compensatedBy, reason, compensatingPayload);
    }

    // ─── Receipt verbs ───────────────────────────────────────────────

    async inspectCommand(commandId: string): Promise<Command> {
        this.enforce('read_command');
        return this.kernel.inspectCommand(commandId);
    }

    async listReceipts(filter?: { commandId?: string; since?: string; limit?: number }): Promise<Receipt[]> {
        this.enforce('read_receipts');
        return this.kernel.listReceipts(filter);
    }

    // ─── Index verbs ─────────────────────────────────────────────────

    async explainIndex(recordId: string) {
        this.enforce('explain_retrieval', { ownerStore: 'index' });
        return this.kernel.explainIndex(recordId);
    }

    async listStaleRecords() {
        this.enforce('explain_retrieval', { ownerStore: 'index' });
        return this.kernel.listStaleRecords();
    }

    async rebuildIndex(actorId: string) {
        this.enforce('commit_command', { commandVerb: 'reindex' });
        return this.kernel.rebuildIndex(actorId);
    }

    // ─── Visibility check (exposed for callers that need it) ─────────

    checkVisibility(resourceUri: string | undefined, ownerStore: string | undefined) {
        return checkVisibility(resourceUri, ownerStore, this.visibilityRules);
    }

    // ─── Access to underlying kernel (for tests/internals only) ──────

    /** @internal — for test verification. Not part of public contract. */
    get _kernel(): ClusterKernel {
        return this.kernel;
    }
}
