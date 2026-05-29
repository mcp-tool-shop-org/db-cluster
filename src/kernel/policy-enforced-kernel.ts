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
    redactProvenanceEvent,
    redactGraphNodes,
    sanitizeWarnings,
} from '../policy/redactor.js';
import { renderProvenanceLabel, type LabelData } from '../provenance/trace-builder.js';
import { ClusterKernel, type IngestArtifactInput, type CreateEntityInput, type LinkEvidenceInput, type IndexStatusResult, type IndexExplanation, type StaleRecord } from './cluster-kernel.js';
import type {
    KernelOptions,
    FindSourcesInput,
    FindSourcesResult,
    ProposeMutationInput,
    CommitMutationResult,
    CommandLifecycleEnvelope,
} from './cluster-kernel.js';
import type { ClusterKernelInterface } from './cluster-kernel-interface.js';
import { ClusterError, type ClusterErrorCode, NotFoundError } from './errors.js';

// ─── Policy denial error ───────────────────────────────────────────────────

/**
 * Raised by every policy-gated verb on {@link PolicyEnforcedKernel} when
 * the configured policy denies the caller's principal.
 *
 * The carried `decision` payload includes the matched policy id/name,
 * the failing capability, and the reason — consumers branch on
 * `decision.capability` to know WHICH capability would unlock the call.
 *
 * Recovery: either acquire the named capability (operator action — grant
 * the role/scope to the principal) or call a less-privileged sibling
 * verb that the principal IS authorized for.
 */
export class PolicyDeniedError extends ClusterError {
    public readonly code: ClusterErrorCode = 'POLICY_DENIED';
    public readonly remediationHint: string;
    public readonly decision: PolicyDecision;
    constructor(decision: PolicyDecision) {
        super(
            `Policy denied: ${decision.capability} — ${decision.reason} (policy: ${decision.matchedPolicyName})`,
        );
        this.decision = decision;
        // Per-instance remediation pulls the matched capability into the
        // hint so the AI / operator knows which capability to acquire.
        this.remediationHint =
            `Acquire the '${decision.capability}' capability for principal ` +
            `${decision.principalId} (operator action — grant a role/scope that ` +
            `includes it), or call a sibling verb that the principal IS authorized ` +
            `to invoke. Run \`db-cluster policy explain\` to see the active ruleset.`;
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
 *
 * KERNEL-C-009 (Wave C1-Amend) — **every wrapped verb on this class
 * can throw {@link PolicyDeniedError}** in addition to whatever the
 * delegated ClusterKernel method would have thrown. Consumers MUST
 * catch and branch on `PolicyDeniedError` separately. The carried
 * `decision.capability` names which capability would unlock the call.
 *
 * Method-level JSDoc lives on {@link ClusterKernelInterface} (verb-parity
 * contract) and on {@link ClusterKernel} (concrete prose). Per-method
 * JSDoc on this wrapper class is intentionally light — the wrapper's
 * job is to delegate after a policy gate.
 *
 * @example
 *   const kernel = new PolicyEnforcedKernel(stores, context, {
 *       policies, dataDir,
 *   });
 *   try {
 *       await kernel.commitMutation(cmd.id, actorId);
 *   } catch (err) {
 *       if (err instanceof PolicyDeniedError) {
 *           console.log('denied:', err.decision.capability);
 *       }
 *   }
 */
export class PolicyEnforcedKernel implements ClusterKernelInterface {
    private readonly kernel: ClusterKernel;
    private readonly policyOptions: PolicyEngineOptions;
    private readonly visibilityRules: VisibilityRule[];

    /**
     * Construct a policy-enforced kernel.
     *
     * KERNEL-C-009 (Wave C1-Amend) — load-bearing side-effects this
     * constructor performs:
     *
     *   1. **Builds its own ClusterKernel** internally
     *      (`new ClusterKernel(stores, policyOptions)`). The
     *      ClusterKernel constructor in turn:
     *      - If `policyOptions.dataDir` is set, instantiates
     *        {@link CommandQueue} which performs filesystem reads
     *        (loading any existing pending-commands.json) and may
     *        throw {@link CommandQueueCorruptError} or
     *        {@link CommandQueuePersistenceLostError}.
     *      - Plans the staging directory at
     *        `${dataDir}/pending-content/` (lazy mkdir on first
     *        proposeMutation call).
     *      - Plans a one-shot orphan-tmp sweep on first staging
     *        access.
     *
     *   2. **Stores the policy bundle** for use by every verb's
     *      `enforce()` call. Every wrapped method can throw
     *      {@link PolicyDeniedError} based on this bundle.
     *
     *   3. **Stores the visibility rules** for the visibility-check
     *      pass on every read verb.
     *
     * Every method on this class (apart from the pure-helper
     * {@link withNextValidActions}) can throw
     * {@link PolicyDeniedError} when the configured policy denies the
     * principal.
     *
     * @param stores - The underlying truth stores.
     * @param context - The {@link PolicyContext} for this kernel
     *                  instance (principal + trust zone).
     * @param policyOptions - {@link PolicyKernelOptions} — policies,
     *                        trust zones, visibility rules, plus the
     *                        inherited {@link KernelOptions.dataDir}.
     * @throws {CommandQueueCorruptError} - via the inner ClusterKernel
     *         constructor when an existing pending-commands.json is
     *         unreadable.
     * @throws {CommandQueuePersistenceLostError} - via the inner
     *         ClusterKernel when the marker file is present but the
     *         pending-commands file is missing.
     */
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

    /**
     * KERNEL-004 (Wave S2-A2) — validate a caller-supplied target store
     * against the known owner-store union and return it narrowed. A value
     * outside `{canonical, artifact, index, ledger}` (e.g. a forged store
     * crossing the typed boundary from a JSON tool call) is rejected with a
     * fail-closed {@link PolicyDeniedError} carrying a synthetic decision —
     * the same `__*_deny` shape the per-resource oracle guards use. This
     * replaces the prior `targetStore as any` cast that let an unknown store
     * slip into the policy engine where a wildcard `allow` absorbed it.
     */
    private assertOwnerStore(
        store: string,
        capability: Capability,
    ): 'canonical' | 'artifact' | 'index' | 'ledger' {
        if (store === 'canonical' || store === 'artifact' || store === 'index' || store === 'ledger') {
            return store;
        }
        throw new PolicyDeniedError({
            decision: 'deny',
            matchedPolicyId: '__invalid_store_deny',
            matchedPolicyName: 'Invalid target store (fail closed)',
            capability,
            reason:
                `Unknown target store '${store}'. Valid stores are: ` +
                `canonical, artifact, index, ledger.`,
            principalId: this.context.principal.id,
            trustZone: this.context.trustZone ?? this.context.principal.trustZone,
            requiresApproval: false,
        });
    }

    /**
     * AGG-B1-1b — re-render every node's `label` through the policy view.
     *
     * The bare ClusterKernel produces a literal label
     * (`renderProvenanceLabel(labelData, [])`). At this trust boundary the
     * `entity_name` / `artifact_filename` RedactionTargets must actually fire
     * — otherwise the AGG-008 typed-redaction machinery is dead config.
     *
     * Nodes without `metadata.labelData` (the redacted-placeholder nodes
     * inserted by `redactGraphNodes` carry `label: '[Access restricted]'`
     * but no structured labelData) are left untouched.
     */
    private rerenderLabelsWithPolicy(
        graph: ProvenanceGraph,
        policyView: ReadonlyArray<RedactionRule>,
    ): ProvenanceGraph {
        if (policyView.length === 0) return graph;
        const nodes = graph.nodes.map((node) => {
            const labelData = node.metadata && (node.metadata as Record<string, unknown>).labelData as LabelData | undefined;
            if (!labelData) return node;
            return { ...node, label: renderProvenanceLabel(labelData, policyView) };
        });
        return { ...graph, nodes };
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

    /**
     * AGG-004 fix-up (Wave A3): mirror the inspectCommand double-enforce
     * pattern. The pre-fix code ran a single per-resource enforce and then
     * fetched — denied principals supplying real ids got `PolicyDeniedError`
     * while those supplying bogus ids got `NotFoundError`. The error-type
     * distinction was a per-resource existence oracle.
     *
     * Two-stage gate: a coarse pre-fetch enforce on `read_owner_truth`
     * with `ownerStore: 'canonical'` but NO `resourceUri`, then the fetch,
     * then refine with the resource URI for redaction. If the coarse gate
     * denies, both existent and nonexistent ids surface PolicyDeniedError
     * — no oracle. If the coarse gate allows, the fetch's NotFoundError
     * propagates: the principal has already been told they can inspect
     * entities, so existence-vs-nonexistence at that point is information
     * they're entitled to. But if the principal carries any per-resource
     * deny rules (`uriPatterns` / `kinds` / `commandVerbs`), we convert the
     * NotFoundError to a PolicyDeniedError so the oracle stays closed even
     * for the second-stage deny path.
     */
    async inspectEntity(id: string): Promise<Entity> {
        // Coarse pre-fetch gate WITHOUT resourceUri — collapses the
        // existence oracle to a single PolicyDeniedError for any denied
        // principal regardless of the entity id supplied.
        this.enforce('read_owner_truth', { ownerStore: 'canonical' });

        let entity: Entity;
        try {
            entity = await this.kernel.inspectEntity(id);
        } catch (err) {
            if (err instanceof NotFoundError && this.hasAnyPerResourceRule('read_owner_truth')) {
                // Principal has rules that condition on resource URI / kind
                // — second-stage refinement could deny existent ids while
                // nonexistent ids would surface NotFoundError. Unify both
                // to PolicyDeniedError to close that per-resource oracle.
                throw new PolicyDeniedError({
                    decision: 'deny',
                    matchedPolicyId: '__refined_deny',
                    matchedPolicyName: 'Refined deny (per-resource gate)',
                    capability: 'read_owner_truth',
                    reason: 'Per-resource policy denied access.',
                    principalId: this.context.principal.id,
                    trustZone: this.context.trustZone ?? this.context.principal.trustZone,
                    resourceUri: `cluster://canonical/${id}`,
                    requiresApproval: false,
                });
            }
            throw err;
        }

        // Refined per-resource enforce — may carry redaction rules. If this
        // denies (per-resource rule fires) we surface PolicyDeniedError;
        // existent and nonexistent ids now both yield PolicyDeniedError, no
        // oracle remains.
        const decision = this.enforce('read_owner_truth', {
            ownerStore: 'canonical',
            resourceUri: `cluster://canonical/${id}`,
            entityKind: entity.kind,
        });
        const rules = this.collectRedactionRules(decision);
        return rules.length > 0 ? redactEntity(entity, rules) : entity;
    }

    /**
     * Returns true when the principal has any policy rule that conditions
     * its match on a per-resource axis (uriPatterns, kinds, commandVerbs).
     * Used by the double-enforce pattern to decide whether NotFoundError
     * after a coarse-allow should be unified to PolicyDeniedError — i.e.,
     * whether a verb-refined / kind-refined / uri-refined deny COULD have
     * fired had the fetch succeeded.
     *
     * Conservative: returns true whenever any deny rule for the given
     * capability targets one of these axes. The cost of converting an
     * extra NotFoundError to PolicyDeniedError is acceptable; the cost of
     * leaving a refined-deny oracle open is not.
     */
    private hasAnyPerResourceRule(capability: Capability): boolean {
        const principalIds = new Set<string>([this.context.principal.id, ...this.context.principal.roles]);
        for (const policy of this.policyOptions.policies ?? []) {
            if (policy.decision !== 'deny') continue;
            if (policy.match.capabilities && !policy.match.capabilities.includes(capability)) continue;
            const policyPrincipals = policy.match.principals;
            if (policyPrincipals && policyPrincipals.length > 0) {
                const overlap = policyPrincipals.some((p) => principalIds.has(p));
                if (!overlap) continue;
            }
            // A deny rule for this capability whose match references any
            // per-resource axis. Such a rule COULD have fired at the
            // refined enforce stage.
            const hasPerResourceAxis =
                (policy.match.uriPatterns && policy.match.uriPatterns.length > 0) ||
                (policy.match.kinds && policy.match.kinds.length > 0) ||
                (policy.match.commandVerbs && policy.match.commandVerbs.length > 0);
            if (hasPerResourceAxis) return true;
        }
        return false;
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

        // KERNEL-C-003 (Wave C1-Amend): if the underlying findSources
        // surfaced data but the policy-filter dropped EVERYTHING, signal
        // `all_filtered_by_policy` rather than the bare-kernel
        // `no_match`. The AI then knows it's a capability gap, not a
        // query miss. We compute the unfiltered count BEFORE the policy
        // pass — if any of the underlying result's three arrays were
        // non-empty, we had matches but lost them.
        const unfilteredCount =
            result.indexRecords.length +
            result.resolvedEntities.length +
            result.resolvedArtifacts.length;
        if (
            filteredIndexRecords.length === 0 &&
            filteredEntities.length === 0 &&
            filteredArtifacts.length === 0 &&
            unfilteredCount > 0
        ) {
            return {
                indexRecords: filteredIndexRecords,
                resolvedEntities: filteredEntities,
                resolvedArtifacts: filteredArtifacts,
                _meta: {
                    empty_reason: 'all_filtered_by_policy',
                    remediation_hint:
                        `${unfilteredCount} record(s) matched the query but were filtered ` +
                        `out by policy. The principal lacks 'read_owner_truth' or ` +
                        `'read_derivative' for the matching records. Request the ` +
                        `capability (operator action — grant the role/scope), or ` +
                        `accept the empty result.`,
                    filteredCount: unfilteredCount,
                },
            };
        }
        // If the underlying result was already empty, preserve its _meta
        // (no_data / no_match) — the bare kernel populated it.
        if (
            filteredIndexRecords.length === 0 &&
            filteredEntities.length === 0 &&
            filteredArtifacts.length === 0 &&
            result._meta
        ) {
            return {
                indexRecords: filteredIndexRecords,
                resolvedEntities: filteredEntities,
                resolvedArtifacts: filteredArtifacts,
                _meta: result._meta,
            };
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
        // we don't surface them via the retrieval surface. For ledger / index
        // subjects (command_approved/rejected, mutation_committed targeting
        // a derivative subject, etc.) the bare event has no obvious owner
        // mapping, so we apply a `read_derivative` gate AND strip the
        // `detail` payload (which would otherwise leak command verbs,
        // payload field shapes, and target IDs to anyone allowed to discover
        // events but not allowed to read the underlying truth). KERNEL-R004.
        const filteredProvenance: ProvenanceEvent[] = [];
        for (const e of bundle.provenanceEvents) {
            if (e.subjectStore === 'canonical') {
                if (allowedEntityIds.has(e.subjectId)) filteredProvenance.push(e);
                continue;
            }
            if (e.subjectStore === 'artifact') {
                if (allowedArtifactIds.has(e.subjectId)) filteredProvenance.push(e);
                continue;
            }
            if (e.subjectStore === 'ledger' || e.subjectStore === 'index') {
                // KERNEL-R2-008: an attacker-controlled
                // `detail.targetStore` string previously flowed through
                // a raw TypeScript cast and into matchStores. Wildcard
                // `allow read_derivative` policies (which have no
                // `stores` constraint) absorbed the unknown value, so
                // a forged event with `targetStore='malicious'` leaked
                // through. We now validate the claim against the known
                // store-type union; if the `detail` carries a
                // `targetStore` claim that isn't recognised we DROP
                // the event rather than fall back to a default-allow
                // path. An attacker forging the targetStore in
                // unrelated ledger detail can no longer reach the
                // policy gate at all.
                const ALLOWED_STORES = new Set(['canonical', 'artifact', 'index', 'ledger']);
                const rawTarget = e.detail?.targetStore;
                let targetStore: 'canonical' | 'artifact' | 'index' | 'ledger' | undefined;
                if (rawTarget === undefined) {
                    targetStore = undefined;
                } else if (typeof rawTarget === 'string' && ALLOWED_STORES.has(rawTarget)) {
                    targetStore = rawTarget as 'canonical' | 'artifact' | 'index' | 'ledger';
                } else {
                    // targetStore claim present but malformed / unknown:
                    // event is suspicious, drop it.
                    continue;
                }
                const derivativeDecision = evaluatePolicy({
                    principal: this.context.principal,
                    capability: 'read_derivative',
                    trustZone,
                    ownerStore: targetStore ?? (e.subjectStore as 'ledger' | 'index'),
                    resourceUri: `cluster://${e.subjectStore}/${e.subjectId}`,
                }, this.policyOptions);
                if (derivativeDecision.decision !== 'allow') continue;
                // No clear resolved subject for opaque ledger/index events —
                // surface the event with action+subjectId+timestamp+actor but
                // drop the leaky `detail` payload.
                filteredProvenance.push({ ...e, detail: {} });
            }
        }

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
            // AGG-B1-1b: re-render every visible node's `label` through the
            // policy view so the `entity_name` / `artifact_filename`
            // RedactionTargets actually gate the rendered string. Pre-fix
            // the bare-kernel literal label leaked through.
            redacted = this.rerenderLabelsWithPolicy(redacted, rules);
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
        // KERNEL-004 (Wave S2-A2): validate `targetStore` against the known
        // owner-store union BEFORE enforce, instead of casting it through
        // `as any`. Pre-fix a forged store string (e.g. crossing the typed
        // boundary from a JSON tool call) flowed straight into the policy
        // engine, where a wildcard `allow` (no `stores` constraint) absorbed
        // the unknown value — so a store-scoped propose policy could be
        // dodged via an unrecognised store, and the cast hid the gap from the
        // compiler. The base kernel's `validateCommand` would later reject the
        // bad store (fail closed), but propose should reject up front and the
        // gate must see a real store. We fail closed here with a typed
        // PolicyDeniedError so the value never reaches the queue.
        const ownerStore = this.assertOwnerStore(input.targetStore, 'propose_mutation');
        this.enforce('propose_mutation', {
            ownerStore,
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
        // KERNEL-003 (Wave S2-A2): the commit gate used to be store-blind AND
        // verb-blind — `enforce('commit_command', { commandVerb: undefined })`
        // passed no `ownerStore`, so a store-scoped commit policy (e.g. "this
        // principal may commit only to canonical") could not be expressed: a
        // store-constrained `allow` refuses to match an underspecified request
        // and the principal fell through to default-deny on EVERY commit. That
        // failed CLOSED (no bypass) but made store/verb-scoped commit policies
        // inexpressible.
        //
        // Fix: re-derive the command's `targetStore` + `verb` (the command is
        // already in the queue at this point) and run the gate with them, so
        // store/verb-scoped commit policies become expressible.
        //
        // Ordering discipline (preserves the existing existence-oracle posture
        // and the "principal who cannot commit at all is denied even for a
        // nonexistent id" contract — see test/policy-kernel.test.ts Proof 6):
        //   1. Fetch the command to learn its store/verb.
        //   2a. If found → refined enforce with ownerStore + commandVerb, then
        //       delegate (the delegated kernel still applies lifecycle
        //       validation — policy never weakens it).
        //   2b. If NOT found → a store-blind enforce so a principal with NO
        //       commit grant still surfaces PolicyDeniedError (not a NotFound
        //       existence oracle); if that gate allows (e.g. an allow-all
        //       principal), delegate so the kernel raises the canonical
        //       CommandNotFoundError.
        let command: Command | undefined;
        try {
            command = await this.kernel.inspectCommand(commandId);
        } catch (err) {
            if (err instanceof NotFoundError) {
                // Store-blind gate: deny principals (no commit_command allow)
                // get PolicyDeniedError; allow-all principals pass and the
                // delegated commit raises CommandNotFoundError.
                this.enforce('commit_command');
                return this.kernel.commitMutation(commandId, actorId);
            }
            throw err;
        }

        this.enforce('commit_command', {
            ownerStore: command.targetStore,
            commandVerb: command.verb,
        });
        return this.kernel.commitMutation(commandId, actorId);
    }

    async compensateMutation(
        originalCommandId: string,
        compensatedBy: string,
        reason: string,
        compensatingPayload?: Record<string, unknown>,
    ) {
        // KERNEL-003 (Wave S2-A2 fix-up): mirror commitMutation's store/verb
        // re-derivation. Pre-fix this gate was store/verb-blind —
        // `enforce('compensate_command')` passed no `ownerStore`, so a
        // store-scoped compensate policy (e.g. "this principal may compensate
        // only in canonical") was inexpressible: a store-constrained `allow`
        // refused to match the underspecified request and the principal fell
        // through to default-deny on EVERY compensate. That failed CLOSED (no
        // bypass) but made store-scoped compensate policies impossible.
        //
        // Fix: re-derive the ORIGINAL command's `targetStore` (the compensating
        // command the kernel creates inherits `original.targetStore`, so the
        // gate's store axis must be the original's store) and run the gate with
        // `commandVerb: 'compensate'`, mirroring commitMutation.
        //
        // Ordering discipline preserves the existing existence-oracle posture
        // (same contract as commitMutation — see test/policy-kernel.test.ts):
        //   2a. Found → refined enforce with ownerStore + commandVerb, then
        //       delegate (the kernel still applies its committed-status guard;
        //       policy never weakens it).
        //   2b. NOT found → a store-blind enforce so a principal with NO
        //       compensate grant still surfaces PolicyDeniedError (not a
        //       NotFound existence oracle); if that gate allows (allow-all
        //       principal) delegate so the kernel raises NotFoundError.
        let original: Command | undefined;
        try {
            original = await this.kernel.inspectCommand(originalCommandId);
        } catch (err) {
            if (err instanceof NotFoundError) {
                this.enforce('compensate_command', { commandVerb: 'compensate' });
                return this.kernel.compensateMutation(originalCommandId, compensatedBy, reason, compensatingPayload);
            }
            throw err;
        }

        this.enforce('compensate_command', {
            ownerStore: original.targetStore,
            commandVerb: 'compensate',
        });
        return this.kernel.compensateMutation(originalCommandId, compensatedBy, reason, compensatingPayload);
    }

    // ─── Receipt verbs ───────────────────────────────────────────────

    async inspectCommand(commandId: string): Promise<Command> {
        // KERNEL-R006 + KERNEL-R2-001: the policy gate runs BEFORE the
        // command is fetched, otherwise a denied principal who supplies
        // a real commandId observes `PolicyDeniedError` while one who
        // supplies a bogus id observes `NotFoundError`. That error-type
        // distinction is an existence oracle: a denied caller can
        // enumerate which commandIds exist by counting which response
        // type they get.
        //
        // We enforce twice: a coarse pre-fetch gate WITHOUT commandVerb
        // (so the existence oracle collapses to a single
        // PolicyDeniedError for both cases), then — only if the coarse
        // gate allowed — fetch the command, refine with commandVerb,
        // and apply payload redaction.
        //
        // AGG-004 fix-up (Wave A3): the verb-refinement second stage
        // can still re-introduce the oracle when the principal carries
        // a verb-conditioned deny rule (kinds / uriPatterns /
        // commandVerbs). Existent ids would surface PolicyDeniedError
        // at the refined stage; nonexistent ids surface NotFoundError
        // from the fetch. If the fetch throws NotFoundError after the
        // coarse passes AND the principal has any per-resource rule
        // for read_command, we unify to PolicyDeniedError so the
        // oracle stays closed at the refined stage too.
        this.enforce('read_command', {
            resourceUri: `cluster://ledger/${commandId}`,
            ownerStore: 'ledger',
        });

        let command: Command;
        try {
            command = await this.kernel.inspectCommand(commandId);
        } catch (err) {
            if (err instanceof NotFoundError && this.hasAnyPerResourceRule('read_command')) {
                throw new PolicyDeniedError({
                    decision: 'deny',
                    matchedPolicyId: '__refined_deny',
                    matchedPolicyName: 'Refined deny (per-resource gate)',
                    capability: 'read_command',
                    reason: 'Per-resource policy denied access.',
                    principalId: this.context.principal.id,
                    trustZone: this.context.trustZone ?? this.context.principal.trustZone,
                    resourceUri: `cluster://ledger/${commandId}`,
                    requiresApproval: false,
                });
            }
            throw err;
        }

        const decision = this.enforce('read_command', {
            resourceUri: `cluster://ledger/${commandId}`,
            ownerStore: 'ledger',
            commandVerb: command.verb,
        });
        const rules = this.collectRedactionRules(decision);
        return rules.length > 0 ? redactCommand(command, rules) : command;
    }

    async listReceipts(filter?: { commandId?: string; since?: string; limit?: number }): Promise<Receipt[]> {
        // KERNEL-R007: prior implementation was a blanket `read_receipts`
        // gate followed by the same redaction rules applied to every
        // receipt. Two leaks resulted:
        // - Restricted receipts (those that should be filtered out
        //   entirely) were surfaced because there was no per-receipt
        //   evaluatePolicy call.
        // - `resultSummary` strings like `'Created entity: User/john@example.com'`
        //   contain entity names verbatim — a caller allowed to list
        //   receipts but not allowed to read owner truth would still see
        //   the entity name through this surface.
        //
        // Two-stage fix:
        // 1. Bundle-level `enforce('read_receipts')` — a principal that
        //    cannot read receipts at all gets the typed PolicyDeniedError
        //    instead of a silent empty list (preserves the existing API
        //    contract for callers that distinguish 'no receipts visible'
        //    from 'capability denied').
        // 2. Per-receipt scoping (mirroring findSources / retrieveBundle):
        //    each receipt gets its own evaluatePolicy call rooted at
        //    `cluster://receipt/<id>`. Receipts whose decision is `deny`
        //    are dropped (no leakage to a partially-restricted reader).
        //    Receipts whose decision is `allow` are redacted with the
        //    rules from that specific decision (which may include a
        //    `receipt_details` rule that strips the leaky resultSummary).
        this.enforce('read_receipts', { ownerStore: 'ledger' });
        const trustZone = this.context.trustZone ?? this.context.principal.trustZone;
        const allReceipts = await this.kernel.listReceipts(filter);
        const filtered: Receipt[] = [];
        for (const receipt of allReceipts) {
            const decision = evaluatePolicy({
                principal: this.context.principal,
                capability: 'read_receipts',
                trustZone,
                ownerStore: 'ledger',
                resourceUri: `cluster://receipt/${receipt.id}`,
            }, this.policyOptions);
            if (decision.decision !== 'allow') continue;
            const rules = this.collectRedactionRules(decision);
            filtered.push(rules.length > 0 ? redactReceipt(receipt, rules) : receipt);
        }
        return filtered;
    }

    // ─── Index verbs ─────────────────────────────────────────────────

    /**
     * Returns the same IndexExplanation shape ClusterKernel.explainIndex
     * returns, but with `sourceObject` redacted per the matched policy.
     *
     * KERNEL-011 closed canonical + artifact redaction. KERNEL-R005 extends
     * the redaction to ledger source-store events: prior to that fix the
     * full {@link ProvenanceEvent} including `detail` was returned
     * unredacted to read_derivative-only callers — leaking actor IDs and
     * the original command payload through the index explanation surface.
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
        if (sourceObject && rules.length > 0) {
            // Per-source-type redaction.
            if (explanation.sourceStore === 'canonical') {
                sourceObject = redactEntity(sourceObject as Entity, rules);
            } else if (explanation.sourceStore === 'artifact') {
                sourceObject = redactArtifact(sourceObject as Artifact, rules);
            } else if (explanation.sourceStore === 'ledger') {
                // KERNEL-R005: ledger sources flow through the dedicated
                // ProvenanceEvent redactor — strips actor IDs and command
                // payload while keeping audit-essential fields.
                sourceObject = redactProvenanceEvent(sourceObject as ProvenanceEvent, rules);
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
     * any caller holding the public `ClusterKernel` export could write to the
     * artifact / canonical / ledger stores with zero policy check and zero
     * redaction. These wrappers route through `enforce()` first.
     *
     * The {@link PolicyEnforcedKernel} no longer exposes a backdoor accessor
     * for the underlying kernel — every surface MUST call these wrappers
     * (KERNEL-R003 ≡ SURFACE-R001).
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
     *
     * KERNEL-R2-004: previously returned the raw `ProvenanceEvent[]` with
     * no per-event redaction, so a caller with `trace_provenance` allowed
     * (capability) but matched against a policy that carried a
     * `provenance_actors` redaction rule would still see raw `actorId`
     * fields. Graph-level surfaces (`traceObject` / `traceBundle`) already
     * call `redactProvenanceActors` on the graph nodes; the flat event
     * list was the leak. We now apply `redactProvenanceEvent` per event
     * so `provenance_actors`, `command_payload`, and `receipt_details`
     * rules from the matched policy / trust zone all fire here too.
     */
    async traceProvenance(subjectId: string): Promise<ProvenanceEvent[]> {
        const decision = this.enforce('trace_provenance', {
            resourceUri: `cluster://canonical/${subjectId}`,
        });
        const events = await this.kernel.traceProvenance(subjectId);
        const rules = this.collectRedactionRules(decision);
        if (rules.length === 0) return events;
        return events.map((ev) => redactProvenanceEvent(ev, rules));
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
            // AGG-B1-1b: re-render labels through the policy view (parity
            // with traceObject above).
            redacted = this.rerenderLabelsWithPolicy(redacted, rules);
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

    /**
     * KERNEL-C-002 wrapper (Wave C1-Amend) — surface legal next-state
     * moves on a `Command` from `validTransitions(command.status)`.
     *
     * Mirrors {@link ClusterKernel.withNextValidActions}. Pure function
     * — no policy gate needed since the legal-transition table is
     * public knowledge (it's documented in CLI / SDK / MCP surfaces).
     *
     * @param command - A `Command` in any lifecycle status.
     * @returns Envelope with `command` and `nextValidActions`.
     */
    withNextValidActions(command: import('../types/command.js').Command): CommandLifecycleEnvelope {
        return this.kernel.withNextValidActions(command);
    }

    // KERNEL-R003 ≡ SURFACE-R001: the `_kernel` getter was deleted. Every
    // verb that callers need is exposed through the wrappers above (verb
    // parity is compiler-enforced via ClusterKernelInterface). If you find
    // yourself wanting to reach behind this layer, add a wrapper instead.
}
