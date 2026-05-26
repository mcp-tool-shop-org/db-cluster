import type { ClusterStores } from '../contracts/index.js';
import type { Principal, Capability, PolicyDecision, TrustZone, Policy, VisibilityRule, RedactionRule } from '../types/policy.js';
import type { Entity } from '../types/entity.js';
import type { Artifact } from '../types/artifact.js';
import type { EvidenceBundle } from '../types/evidence-bundle.js';
import type { ProvenanceGraph, TraceOptions, ProvenanceNode } from '../types/provenance-graph.js';
import type { Receipt } from '../types/receipt.js';
import type { Command } from '../types/command.js';
import { evaluatePolicy, checkVisibility } from '../policy/policy-engine.js';
import type { PolicyEngineOptions } from '../policy/policy-engine.js';
import {
    redactArtifact,
    redactEntity,
    redactCommand,
    redactReceipt,
    redactProvenanceActors,
    redactGraphNodes,
    sanitizeWarnings,
} from '../policy/redactor.js';
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

    // ─── Redaction rule collector ────────────────────────────────────

    private collectRedactionRules(decision: PolicyDecision): RedactionRule[] {
        const rules: RedactionRule[] = [];

        // From matched policy
        if (decision.redaction) {
            rules.push(decision.redaction);
        }

        // From trust zone
        const zoneName = this.context.trustZone ?? this.context.principal.trustZone;
        if (zoneName && this.policyOptions.trustZones) {
            const zone = this.policyOptions.trustZones.find((z) => z.id === zoneName);
            if (zone?.redactionRules.length) {
                rules.push(...zone.redactionRules);
            }
        }

        return rules;
    }

    // ─── Read verbs ──────────────────────────────────────────────────

    async inspectEntity(id: string): Promise<Entity> {
        const decision = this.enforce('read_owner_truth', { ownerStore: 'canonical', resourceUri: `cluster://canonical/${id}` });
        const entity = await this.kernel.inspectEntity(id);
        const rules = this.collectRedactionRules(decision);
        return rules.length > 0 ? redactEntity(entity, rules) : entity;
    }

    async findSources(input: FindSourcesInput): Promise<FindSourcesResult> {
        const decision = this.enforce('discover_existence', { ownerStore: 'index' });

        const result = await this.kernel.findSources(input);

        // Apply per-entity policy filtering + redaction
        const filteredEntities: Entity[] = [];
        const filteredArtifacts: Artifact[] = [];

        for (const entity of result.resolvedEntities) {
            const uri = `cluster://canonical/${entity.id}`;
            const canRead = evaluatePolicy({
                principal: this.context.principal,
                capability: 'read_owner_truth',
                trustZone: this.context.trustZone ?? this.context.principal.trustZone,
                ownerStore: 'canonical',
                resourceUri: uri,
                entityKind: entity.kind,
            }, this.policyOptions);

            if (canRead.decision === 'allow') {
                const rules = this.collectRedactionRules(canRead);
                filteredEntities.push(rules.length > 0 ? redactEntity(entity, rules) : entity);
            } else {
                // Denied — check visibility. If hidden, silently exclude (no leakage)
                // If visible with placeholder, could add placeholder — but for findSources we just exclude
                // to prevent existence leakage through the search surface
            }
        }

        for (const artifact of result.resolvedArtifacts) {
            const uri = `cluster://artifact/${artifact.id}`;
            const canRead = evaluatePolicy({
                principal: this.context.principal,
                capability: 'read_owner_truth',
                trustZone: this.context.trustZone ?? this.context.principal.trustZone,
                ownerStore: 'artifact',
                resourceUri: uri,
            }, this.policyOptions);

            if (canRead.decision === 'allow') {
                const rules = this.collectRedactionRules(canRead);
                filteredArtifacts.push(rules.length > 0 ? redactArtifact(artifact, rules) : artifact);
            }
        }

        return {
            indexRecords: result.indexRecords,
            resolvedEntities: filteredEntities,
            resolvedArtifacts: filteredArtifacts,
        };
    }

    async retrieveBundle(query: string, options?: { limit?: number }): Promise<EvidenceBundle> {
        const decision = this.enforce('read_derivative', { ownerStore: 'index' });
        const bundle = await this.kernel.retrieveBundle(query, options);
        const rules = this.collectRedactionRules(decision);

        if (rules.length === 0) return bundle;

        // Redact resolved entities (already allowed by read_derivative, apply redaction rules)
        const redactedEntities = bundle.resolvedEntities.map((re) => ({
            ...re,
            object: redactEntity(re.object, rules),
        }));

        // Redact resolved artifacts
        const redactedArtifacts = bundle.resolvedArtifacts.map((ra) => ({
            ...ra,
            object: redactArtifact(ra.object, rules),
        }));

        return {
            ...bundle,
            resolvedEntities: redactedEntities,
            resolvedArtifacts: redactedArtifacts,
        };
    }

    async explainRetrieval(bundle: EvidenceBundle) {
        this.enforce('explain_retrieval');
        return this.kernel.explainRetrieval(bundle);
    }

    // ─── Provenance verbs ────────────────────────────────────────────

    async traceObject(uri: string, options?: Partial<TraceOptions>): Promise<ProvenanceGraph> {
        const decision = this.enforce('trace_provenance', { resourceUri: uri });
        const graph = await this.kernel.traceObject(uri, options);
        const rules = this.collectRedactionRules(decision);

        // Apply visibility: hide nodes the principal cannot see
        let redacted = redactGraphNodes(graph, (node: ProvenanceNode) => {
            if (!node.uri) return true;
            const vis = checkVisibility(node.uri, node.ownerStore ?? undefined, this.visibilityRules);
            return vis.existenceVisible;
        });

        // Apply actor redaction if rules target provenance_actors
        if (rules.length > 0) {
            redacted = redactProvenanceActors(redacted, rules);
        }

        // Sanitize warnings to not leak hidden URIs
        const { warnings, gaps } = sanitizeWarnings(redacted.warnings, redacted.gaps, this.visibilityRules);
        return { ...redacted, warnings, gaps };
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
        const decision = this.enforce('read_command');
        const command = await this.kernel.inspectCommand(commandId);
        const rules = this.collectRedactionRules(decision);
        return rules.length > 0 ? redactCommand(command, rules) : command;
    }

    async listReceipts(filter?: { commandId?: string; since?: string; limit?: number }): Promise<Receipt[]> {
        const decision = this.enforce('read_receipts');
        const receipts = await this.kernel.listReceipts(filter);
        const rules = this.collectRedactionRules(decision);
        if (rules.length === 0) return receipts;
        return receipts.map((r) => redactReceipt(r, rules));
    }

    // ─── Index verbs ─────────────────────────────────────────────────

    async explainIndex(recordId: string) {
        this.enforce('explain_retrieval', { ownerStore: 'index' });
        const explanation = await this.kernel.explainIndex(recordId);
        // explainIndex returns a string — safe as long as it doesn't expose hidden URIs
        return explanation;
    }

    async listStaleRecords() {
        this.enforce('explain_retrieval', { ownerStore: 'index' });
        const records = await this.kernel.listStaleRecords();

        // Filter stale records to not expose hidden source URIs
        return records.filter((r) => {
            const uri = `cluster://${r.sourceStore}/${r.sourceId}`;
            const vis = checkVisibility(uri, r.sourceStore, this.visibilityRules);
            return vis.existenceVisible;
        });
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
