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

    /**
     * Construct a ClusterSDK against a cluster directory.
     *
     * SURFACE-C-014 (Wave C1-Amend): policy-vs-raw branch + principal-
     * fallback behavior were buried in inline `// SURFACE-R2-004 fix:`
     * comments. This JSDoc surfaces the contract for SDK consumers.
     *
     * Policy enforcement is OPT-IN:
     *   - Pass `policies`, `trustZones`, or `visibilityRules` → the SDK
     *     wraps the kernel with PolicyEnforcedKernel. Every read/write
     *     crosses the policy layer; redaction markers are emitted where
     *     a value is denied.
     *   - Omit those fields → raw ClusterKernel. No policy gate. Preserves
     *     the ~614 baseline tests' "no policies = no gate" behavior.
     *
     * Principal fallback:
     *   - When `policies` are set but `principal` is omitted, the SDK
     *     falls back to `INTERNAL_TRUSTED_PRINCIPAL` (cluster-admin) AND
     *     emits a `console.warn` so the caller knows they got the trusted
     *     principal — least-privilege deployments should always pass an
     *     explicit principal.
     *   - To opt into the trusted principal silently, pass
     *     `principal: ClusterSDK.INTERNAL_TRUSTED_PRINCIPAL` explicitly.
     *
     * @param options Cluster directory + policy/principal configuration.
     * @throws Will not throw on construction (errors deferred to first
     *   kernel call). Malformed PolicyEnforcedKernel construction surfaces
     *   the underlying TypeError; check {@link buildSDKOptions} for the
     *   fail-closed shape used by the MCP boundary.
     *
     * @example
     * // Raw mode — no policies
     * const sdk = new ClusterSDK({ clusterDir: '.db-cluster' });
     * await sdk.findSources('thing');
     *
     * @example
     * // Policy-enforced mode with explicit principal
     * const sdk = new ClusterSDK({
     *   clusterDir: '.db-cluster',
     *   policies: myPolicies,
     *   principal: { id: 'svc-1', name: 'svc-1', roles: ['reader'], trustZone: 'internal' },
     * });
     */
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

    /**
     * Find sources in the cluster index matching a query string.
     *
     * Returns up to `limit` index records plus resolved owner-truth
     * objects (entities, artifacts) for each match. Index records are
     * derivative — they may be stale relative to the canonical/artifact
     * stores; the resolver runs through the kernel so any policy-driven
     * filter applies. Stale index records are still returned but the
     * caller can detect staleness on the resolved objects.
     *
     * SURFACE-C-013 (Wave C1-Amend): added JSDoc to this method to match
     * the discipline already in place on `commitMutation` /
     * `retrieveBundle` / `policyExplain`.
     *
     * @param query Text query to match against indexed records.
     * @param limit Max results (default 20 in the kernel).
     * @returns Find result with indexRecords, resolvedEntities,
     *   resolvedArtifacts.
     * @throws PolicyDeniedError when the principal lacks the
     *   `find_sources` capability under the configured policies.
     *
     * @example
     * const result = await sdk.findSources('quarterly-report', 50);
     * for (const r of result.resolvedEntities) {
     *   console.log(r.kind, r.name);
     * }
     */
    async findSources(query: string, limit?: number, offset?: number): Promise<FindSourcesResult> {
        const result = await this.kernel.findSources({ query, limit, offset });
        // REDACT-001 (Wave S2-A2): pre-fix this was a raw pass-through, so the
        // resolved owner-truth artifacts escaped the SDK boundary WITH
        // `storagePath` (an absolute fs path) under BOTH the no-policy raw
        // kernel AND the default `internal` empty-rules zone (whose redaction
        // rules are empty, so the kernel returns the raw artifact). Route the
        // resolved artifacts through the SAME unconditional
        // `sanitizeArtifactForOutput` that `resolve()` already uses (AGG-002):
        // no `storagePath` escapes the SDK under ANY policy state. The other
        // result fields (indexRecords / resolvedEntities / any `_meta`
        // empty-reason the PolicyEnforcedKernel set) are preserved untouched.
        // The cast widens `SanitizedArtifact` (Omit<Artifact,'storagePath'>)
        // back to the declared `Artifact[]` element type — the same widening
        // discipline `retrieveBundle()` uses for its sanitized fields.
        return {
            ...result,
            resolvedArtifacts: result.resolvedArtifacts.map(
                (a) => sanitizeArtifactForOutput(a) ?? a,
            ) as unknown as FindSourcesResult['resolvedArtifacts'],
        };
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
    async retrieveBundle(query: string, options?: { limit?: number; offset?: number }): Promise<EvidenceBundle> {
        const bundle = await this.kernel.retrieveBundle(query, options);
        // SURFACE-B-008: sanitize indexRecords + provenanceEvents inline.
        // The sanitizers return enriched objects (adding `_sourceType`,
        // `_metadataPolicy`, and replacing `metadata`/`actorId`/`detail`).
        // The EvidenceBundle type declares strict IndexRecord / ProvenanceEvent
        // shapes; the cast widens to accept the sanitized superset. A future
        // wave that updates `src/types/evidence-bundle.ts` to express the
        // sanitization-aware shape would let us drop the cast.
        //
        // REDACT-001 (Wave S2-A2): pre-fix this method sanitized indexRecords
        // and provenanceEvents but left `resolvedArtifacts[].object` raw —
        // every resolved owner-truth artifact escaped the SDK boundary WITH
        // `storagePath` (an absolute fs path) under both the raw kernel and the
        // default `internal` empty-rules zone. Route each artifact's `object`
        // through the same unconditional `sanitizeArtifactForOutput` the rest
        // of the SDK boundary uses, so no `storagePath` leaves the SDK.
        return {
            ...bundle,
            indexRecords: bundle.indexRecords.map((r) => sanitizeIndexRecordForOutput(r) ?? r) as unknown as EvidenceBundle['indexRecords'],
            provenanceEvents: bundle.provenanceEvents.map((ev) => sanitizeProvenanceEventForOutput(ev) ?? ev) as unknown as EvidenceBundle['provenanceEvents'],
            resolvedArtifacts: bundle.resolvedArtifacts.map((ra) => ({
                ...ra,
                object: (sanitizeArtifactForOutput(ra.object) ?? ra.object) as unknown as Artifact,
            })),
        };
    }

    /**
     * Explain what a retrieval bundle contains in operator-readable prose.
     *
     * The returned `summary` is multi-line text suitable for printing to
     * a terminal or pasting into an issue tracker. `resolvedCount` /
     * `missingCount` / `allFresh` give the same signals in structured
     * form for programmatic callers.
     *
     * SURFACE-C-013 (Wave C1-Amend): added JSDoc to align with the
     * documented exemplars in this file.
     *
     * @param bundle Evidence bundle from {@link retrieveBundle}.
     * @returns `{ summary, resolvedCount, missingCount, allFresh }`.
     * @throws Won't throw on a well-formed bundle; if the underlying
     *   kernel was constructed in policy-enforced mode and the principal
     *   lacks read capability, PolicyDeniedError surfaces from
     *   kernel-side reads.
     *
     * @example
     * const bundle = await sdk.retrieveBundle('quarterly-report');
     * const expl = await sdk.explainRetrieval(bundle);
     * console.log(expl.summary);
     */
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

    /**
     * Trace provenance for any cluster URI.
     *
     * Returns a navigable {@link ProvenanceGraph} showing why an object
     * exists, what truth supports it, and what changed it. Direction +
     * depth are configurable via {@link TraceOptions}. The graph carries
     * receipts and gaps when requested.
     *
     * SURFACE-C-013 (Wave C1-Amend): added JSDoc for SDK discoverability.
     *
     * @param uri Cluster URI (`cluster://<store>/<id>`).
     * @param options Trace direction, depth, include flags.
     * @returns Navigable provenance graph.
     * @throws NotFoundError when the URI does not resolve.
     * @throws InvalidClusterUriError when URI is malformed.
     *
     * @example
     * const graph = await sdk.traceObject('cluster://canonical/abc', {
     *   direction: 'backward',
     *   depth: 5,
     * });
     */
    async traceObject(uri: string, options?: Partial<TraceOptions>): Promise<ProvenanceGraph> {
        return this.kernel.traceObject(uri, options);
    }

    /**
     * Why does this object exist? Returns a compact one-paragraph
     * explanation derived from a backward provenance trace.
     *
     * The string surfaces who created the object, what evidence was
     * linked, and any receipts attached. Designed for direct display to
     * an operator or AI consumer — see {@link traceObject} for the
     * structured graph.
     *
     * SURFACE-C-013 (Wave C1-Amend): added JSDoc.
     *
     * @param uri Cluster URI to explain.
     * @returns Multi-line prose explanation.
     * @throws NotFoundError when the URI does not resolve.
     *
     * @example
     * const story = await sdk.why('cluster://canonical/abc');
     * console.log(story);
     */
    async why(uri: string): Promise<string> {
        return this.kernel.why(uri);
    }

    // ─── Command lifecycle ─────────────────────────────────────────

    /**
     * Propose a mutation command. STAGED ONLY — no cluster truth is
     * written. The returned command is in `proposed` status and must
     * pass validate → approve → commit to actually mutate the cluster.
     *
     * SURFACE-C-013 (Wave C1-Amend): added JSDoc.
     *
     * @param input Mutation specification.
     * @returns The newly-staged Command with id + status='proposed'.
     * @throws InvalidContentShapeError when payload.content is the wrong shape
     *   (ingest_artifact verb).
     * @throws ContentHashMismatchError when caller-supplied contentHash
     *   doesn't match sha256(content) (ingest_artifact verb).
     * @throws PolicyDeniedError when policy gates the `propose_command`
     *   capability.
     *
     * @example
     * const cmd = await sdk.proposeMutation({
     *   verb: 'create_entity',
     *   targetStore: 'canonical',
     *   payload: { kind: 'person', name: 'Ada', attributes: {} },
     *   proposedBy: 'alice',
     * });
     */
    async proposeMutation(input: {
        verb: Command['verb'];
        targetStore: Command['targetStore'];
        payload: Record<string, unknown>;
        proposedBy: string;
    }): Promise<Command> {
        return this.kernel.proposeMutation(input);
    }

    /**
     * Validate a proposed command — runs structural + semantic checks.
     * Transitions the command from `proposed` to `validated`. Does NOT
     * commit.
     *
     * SURFACE-C-013 (Wave C1-Amend): added JSDoc.
     *
     * @param commandId ID of the proposed command.
     * @returns The command with status='validated' and a `validation`
     *   record listing the named checks that ran.
     * @throws NotFoundError when the command ID doesn't exist.
     *
     * @example
     * const validated = await sdk.validateMutation(cmd.id);
     */
    async validateMutation(commandId: string): Promise<Command> {
        return this.kernel.validateMutation(commandId);
    }

    /**
     * Approve a validated command — operator/policy gate. Transitions
     * the command from `validated` to `approved`. Does NOT commit; the
     * cluster truth is unchanged until {@link commitMutation}.
     *
     * SURFACE-C-013 (Wave C1-Amend): added JSDoc.
     *
     * @param commandId ID of the validated command.
     * @param approvedBy Actor approving.
     * @param note Optional approval note for audit.
     * @returns The command with status='approved' and approvedBy /
     *   approvedAt / approvalNote populated.
     * @throws NotFoundError when the command ID doesn't exist.
     * @throws PolicyDeniedError when policy gates `approve_command`.
     *
     * @example
     * await sdk.approveMutation(cmd.id, 'bob', 'reviewed in PR-1234');
     */
    async approveMutation(commandId: string, approvedBy: string, note?: string): Promise<Command> {
        return this.kernel.approveMutation(commandId, approvedBy, note);
    }

    /**
     * Reject a proposed or validated command. Terminal — rejected
     * commands CANNOT be committed. Use this to record that a proposal
     * was reviewed and refused.
     *
     * SURFACE-C-013 (Wave C1-Amend): added JSDoc.
     *
     * @param commandId ID of the command to reject.
     * @param rejectedBy Actor rejecting.
     * @param reason Operator-facing reason (surfaces in audit).
     * @returns The command with status='rejected'.
     * @throws NotFoundError when the command ID doesn't exist.
     *
     * @example
     * await sdk.rejectMutation(cmd.id, 'bob', 'duplicate of cmd-xyz');
     */
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

    /**
     * Compensate a committed command — emits a correcting command + a
     * receipt linking the pair. The original command is NOT deleted;
     * compensation preserves audit history.
     *
     * SURFACE-C-013 (Wave C1-Amend): added JSDoc.
     *
     * @param commandId ID of the committed command to compensate.
     * @param compensatedBy Actor performing compensation.
     * @param reason Operator-facing rationale.
     * @returns The compensating command + the original (now flagged) +
     *   the receipt linking the two.
     * @throws NotFoundError when the command ID doesn't exist.
     * @throws PolicyDeniedError when policy gates `compensate_command`.
     *
     * @example
     * const result = await sdk.compensateMutation(committed.id, 'bob', 'rolled back per ticket');
     */
    async compensateMutation(commandId: string, compensatedBy: string, reason: string): Promise<{ compensatingCommand: Command; originalCommand: Command; receipt: Receipt }> {
        return this.kernel.compensateMutation(commandId, compensatedBy, reason);
    }

    /**
     * Inspect a command — returns full lifecycle state including status,
     * validation results, approval/rejection metadata, and any
     * compensation pointers.
     *
     * SURFACE-C-013 (Wave C1-Amend): added JSDoc.
     *
     * @param commandId Command ID to inspect.
     * @returns The Command in its current status with all lifecycle
     *   fields populated.
     * @throws NotFoundError when the command ID doesn't exist.
     *
     * @example
     * const cmd = await sdk.inspectCommand(commandId);
     * console.log(cmd.status, cmd.validation);
     */
    async inspectCommand(commandId: string): Promise<Command> {
        return this.kernel.inspectCommand(commandId);
    }

    /**
     * List mutation receipts — proof records of committed operations.
     * Each receipt links to its command, target store, and the
     * `resultSummary` produced at commit time.
     *
     * SURFACE-C-013 (Wave C1-Amend): added JSDoc.
     *
     * @param filter Optional `commandId` / `since` / `limit`.
     * @returns Array of Receipts (newest first; per kernel discipline).
     * @throws PolicyDeniedError when policy gates `read_audit`.
     *
     * @example
     * const recent = await sdk.listReceipts({ limit: 10 });
     * for (const r of recent) console.log(r.committedAt, r.resultSummary);
     */
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
