import type { ClusterStores } from '../contracts/index.js';
import type { Principal, Capability, PolicyDecision, TrustZone, Policy, VisibilityRule, RedactionRule } from '../types/policy.js';
import type { Entity } from '../types/entity.js';
import type { Artifact } from '../types/artifact.js';
import type { IndexRecord } from '../types/index-record.js';
import type { ProvenanceEvent } from '../types/provenance-event.js';
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
import { ClusterKernel, type IngestArtifactInput, type CreateEntityInput, type LinkEvidenceInput, type IndexStatusResult, type IndexExplanation, type StaleRecord } from './cluster-kernel.js';
import type {
    KernelOptions,
    FindSourcesInput,
    FindSourcesResult,
    ProposeMutationInput,
    CommitMutationResult,
} from './cluster-kernel.js';
import type { ClusterKernelInterface } from './cluster-kernel-interface.js';
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
export class PolicyEnforcedKernel implements ClusterKernelInterface {
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
        this.enforce('discover_existence', { ownerStore: 'index' });

        const result = await this.kernel.findSources(input);

        // Apply per-entity policy filtering + redaction
        const filteredEntities: Entity[] = [];
        const filteredArtifacts: Artifact[] = [];
        // Keep track of which source IDs survived owner-truth filtering so we
        // can prune indexRecords accordingly (KERNEL-003: returning records
        // for entities whose `read_owner_truth` was denied leaks restricted
        // kind/name/attributes via metadata).
        const allowedEntityIds = new Set<string>();
        const allowedArtifactIds = new Set<string>();

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
                allowedEntityIds.add(entity.id);
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
                allowedArtifactIds.add(artifact.id);
            }
        }

        // KERNEL-003: filter indexRecords by per-source policy. An index record
        // for a canonical entity carries the kind/name/attributes in its text
        // and metadata. If the caller cannot read the owner truth, they MUST
        // NOT see those derivatives either, even via the discovery surface.
        const filteredIndexRecords: IndexRecord[] = [];
        for (const record of result.indexRecords) {
            const sourceUri = `cluster://${record.sourceStore}/${record.sourceId}`;
            const derivativeDecision = evaluatePolicy({
                principal: this.context.principal,
                capability: 'read_derivative',
                trustZone: this.context.trustZone ?? this.context.principal.trustZone,
                ownerStore: 'index',
                resourceUri: sourceUri,
            }, this.policyOptions);

            if (derivativeDecision.decision !== 'allow') continue;

            if (record.sourceStore === 'canonical') {
                // Canonical-backed records mirror owner truth. Require BOTH the
                // derivative grant above AND the owner-truth grant — otherwise
                // restricted entity content leaks through index text/metadata.
                if (!allowedEntityIds.has(record.sourceId)) {
                    // Also re-check owner truth for records whose entity wasn't
                    // in resolvedEntities (resolver returned null / not surfaced).
                    const ownerDecision = evaluatePolicy({
                        principal: this.context.principal,
                        capability: 'read_owner_truth',
                        trustZone: this.context.trustZone ?? this.context.principal.trustZone,
                        ownerStore: 'canonical',
                        resourceUri: sourceUri,
                    }, this.policyOptions);
                    if (ownerDecision.decision !== 'allow') continue;
                }
            } else if (record.sourceStore === 'artifact') {
                // Symmetric guard for artifact-backed records — index text
                // exposes filename / mimeType.
                if (!allowedArtifactIds.has(record.sourceId)) {
                    const ownerDecision = evaluatePolicy({
                        principal: this.context.principal,
                        capability: 'read_owner_truth',
                        trustZone: this.context.trustZone ?? this.context.principal.trustZone,
                        ownerStore: 'artifact',
                        resourceUri: sourceUri,
                    }, this.policyOptions);
                    if (ownerDecision.decision !== 'allow') continue;
                }
            }

            // Final visibility veto — if the source is hidden by visibility
            // rules, drop the index record too.
            const vis = checkVisibility(sourceUri, record.sourceStore, this.visibilityRules);
            if (!vis.existenceVisible) continue;

            filteredIndexRecords.push(record);
        }

        return {
            indexRecords: filteredIndexRecords,
            resolvedEntities: filteredEntities,
            resolvedArtifacts: filteredArtifacts,
        };
    }

    async retrieveBundle(query: string, options?: { limit?: number }): Promise<EvidenceBundle> {
        // Bundle-level capability — caller must be allowed to do a retrieval
        // at all. Per-object filtering (read_owner_truth) is applied below.
        const bundleDecision = this.enforce('read_derivative', { ownerStore: 'index' });
        const bundle = await this.kernel.retrieveBundle(query, options);

        // KERNEL-004: apply per-entity / per-artifact policy filtering with
        // owner-truth scope, mirroring findSources. The previous behaviour
        // was a single blanket decision; restricted entities slipped through.
        const trustZone = this.context.trustZone ?? this.context.principal.trustZone;
        const filteredEntities: EvidenceBundle['resolvedEntities'] = [];
        const allowedEntityIds = new Set<string>();
        for (const re of bundle.resolvedEntities) {
            const ownerDecision = evaluatePolicy({
                principal: this.context.principal,
                capability: 'read_owner_truth',
                trustZone,
                ownerStore: 'canonical',
                resourceUri: re.uri,
                entityKind: re.object.kind,
            }, this.policyOptions);
            if (ownerDecision.decision !== 'allow') continue;
            const rules = this.collectRedactionRules(ownerDecision);
            const obj = rules.length > 0 ? redactEntity(re.object, rules) : re.object;
            filteredEntities.push({ ...re, object: obj });
            allowedEntityIds.add(re.object.id);
        }

        const filteredArtifacts: EvidenceBundle['resolvedArtifacts'] = [];
        const allowedArtifactIds = new Set<string>();
        for (const ra of bundle.resolvedArtifacts) {
            const ownerDecision = evaluatePolicy({
                principal: this.context.principal,
                capability: 'read_owner_truth',
                trustZone,
                ownerStore: 'artifact',
                resourceUri: ra.uri,
            }, this.policyOptions);
            if (ownerDecision.decision !== 'allow') continue;
            const rules = this.collectRedactionRules(ownerDecision);
            const obj = rules.length > 0 ? redactArtifact(ra.object, rules) : ra.object;
            filteredArtifacts.push({ ...ra, object: obj });
            allowedArtifactIds.add(ra.object.id);
        }

        // Prune indexRecords that point at sources we filtered out — same
        // rationale as KERNEL-003.
        const filteredIndexRecords = bundle.indexRecords.filter((r) => {
            if (r.sourceStore === 'canonical' && !allowedEntityIds.has(r.sourceId)) return false;
            if (r.sourceStore === 'artifact' && !allowedArtifactIds.has(r.sourceId)) return false;
            return true;
        });

        // Provenance events keyed to filtered subjects are also dropped so
        // we don't surface them via the retrieval surface.
        const filteredProvenance = bundle.provenanceEvents.filter((e) => {
            if (e.subjectStore === 'canonical') return allowedEntityIds.has(e.subjectId);
            if (e.subjectStore === 'artifact') return allowedArtifactIds.has(e.subjectId);
            return true;
        });

        // Bundle-level redaction (apply blanket rules from the bundle
        // capability decision in addition to the per-object rules above).
        const bundleRules = this.collectRedactionRules(bundleDecision);
        const redactedEntities = bundleRules.length > 0
            ? filteredEntities.map((re) => ({ ...re, object: redactEntity(re.object, bundleRules) }))
            : filteredEntities;
        const redactedArtifacts = bundleRules.length > 0
            ? filteredArtifacts.map((ra) => ({ ...ra, object: redactArtifact(ra.object, bundleRules) }))
            : filteredArtifacts;

        return {
            ...bundle,
            resolvedEntities: redactedEntities,
            resolvedArtifacts: redactedArtifacts,
            indexRecords: filteredIndexRecords,
            provenanceEvents: filteredProvenance,
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

    /**
     * Returns the same IndexExplanation shape ClusterKernel.explainIndex
     * returns, but with `sourceObject` redacted per the matched policy.
     * KERNEL-011 fix: previously this returned the raw Entity/Artifact/Event
     * without any redaction, leaking restricted content.
     */
    async explainIndex(recordId: string): Promise<IndexExplanation> {
        const decision = this.enforce('explain_retrieval', { ownerStore: 'index' });
        const explanation = await this.kernel.explainIndex(recordId);

        // Visibility veto on the source itself
        const sourceUri = `cluster://${explanation.sourceStore}/${explanation.sourceId}`;
        const vis = checkVisibility(sourceUri, explanation.sourceStore, this.visibilityRules);
        if (!vis.existenceVisible) {
            return {
                ...explanation,
                sourceObject: null,
                sourceExists: false,
                staleCause: explanation.staleCause,
            };
        }

        const rules = this.collectRedactionRules(decision);
        let sourceObject = explanation.sourceObject;
        if (sourceObject) {
            // Per-source-type redaction. The ledger event case has no
            // dedicated redactor in this layer (provenance redaction is
            // applied through the graph surface).
            if (explanation.sourceStore === 'canonical' && rules.length > 0) {
                sourceObject = redactEntity(sourceObject as Entity, rules);
            } else if (explanation.sourceStore === 'artifact' && rules.length > 0) {
                sourceObject = redactArtifact(sourceObject as Artifact, rules);
            }
        }

        return { ...explanation, sourceObject };
    }

    async listStaleRecords(): Promise<StaleRecord[]> {
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

    /**
     * Index status — derivative, redact at the count level only.
     * Adds a wrapper so the verb-parity contract is satisfied (KERNEL-001).
     */
    async indexStatus(): Promise<IndexStatusResult> {
        this.enforce('read_derivative', { ownerStore: 'index' });
        return this.kernel.indexStatus();
    }

    // ─── Helper write verbs (KERNEL-001 fix) ─────────────────────────

    /**
     * Wrap ClusterKernel.ingestArtifact behind the policy gate.
     *
     * Prior to KERNEL-001 there was NO wrapper for these helpers, which meant
     * any caller holding either a raw `ClusterKernel` (via the `_kernel`
     * getter) or the public `ClusterKernel` export could write to the
     * artifact / canonical / ledger stores with zero policy check and zero
     * redaction. These wrappers route through `enforce()` first.
     */
    async ingestArtifact(input: IngestArtifactInput) {
        const decision = this.enforce('commit_command', {
            ownerStore: 'artifact',
            commandVerb: 'ingest_artifact',
        });
        const result = await this.kernel.ingestArtifact(input);
        const rules = this.collectRedactionRules(decision);
        return rules.length > 0
            ? { ...result, artifact: redactArtifact(result.artifact, rules) }
            : result;
    }

    async createEntity(input: CreateEntityInput) {
        const decision = this.enforce('commit_command', {
            ownerStore: 'canonical',
            commandVerb: 'create_entity',
        });
        const result = await this.kernel.createEntity(input);
        const rules = this.collectRedactionRules(decision);
        return rules.length > 0
            ? { ...result, entity: redactEntity(result.entity, rules) }
            : result;
    }

    async linkEvidence(input: LinkEvidenceInput) {
        this.enforce('commit_command', {
            ownerStore: 'canonical',
            commandVerb: 'link_evidence',
        });
        return this.kernel.linkEvidence(input);
    }

    // ─── Provenance / trace verbs (KERNEL-001 fix) ───────────────────

    /**
     * Subject-scoped provenance trace. Caller must hold `trace_provenance`.
     * Output is the raw event list (no redaction applied here — graph-level
     * redaction lives in {@link traceObject}); we just gate access.
     */
    async traceProvenance(subjectId: string): Promise<ProvenanceEvent[]> {
        this.enforce('trace_provenance', {
            resourceUri: `cluster://canonical/${subjectId}`,
        });
        return this.kernel.traceProvenance(subjectId);
    }

    /**
     * Multi-URI bundle trace. Same gate + redaction model as
     * {@link traceObject}, applied bundle-wide.
     */
    async traceBundle(bundle: EvidenceBundle, options?: Partial<TraceOptions>): Promise<ProvenanceGraph> {
        const decision = this.enforce('trace_provenance');
        const graph = await this.kernel.traceBundle(bundle, options);
        const rules = this.collectRedactionRules(decision);

        let redacted = redactGraphNodes(graph, (node: ProvenanceNode) => {
            if (!node.uri) return true;
            const vis = checkVisibility(node.uri, node.ownerStore ?? undefined, this.visibilityRules);
            return vis.existenceVisible;
        });

        if (rules.length > 0) {
            redacted = redactProvenanceActors(redacted, rules);
        }

        const { warnings, gaps } = sanitizeWarnings(redacted.warnings, redacted.gaps, this.visibilityRules);
        return { ...redacted, warnings, gaps };
    }

    /**
     * String renderer for a provenance graph. The graph it's invoked with
     * has already been redacted by traceObject / traceBundle, so this is
     * a thin pass-through that still surfaces under the verb-parity
     * contract.
     */
    explainTrace(graph: ProvenanceGraph): string {
        this.enforce('trace_provenance');
        return this.kernel.explainTrace(graph);
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
