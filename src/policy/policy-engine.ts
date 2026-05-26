import type {
    Policy,
    PolicyDecision,
    PolicyEvaluationRequest,
    PolicyMatch,
    Capability,
    RedactionRule,
    TrustZone,
    VisibilityRule,
    Scope,
} from '../types/policy.js';

// ─── Default deny decision ─────────────────────────────────────────────────

const DEFAULT_DENY_POLICY_ID = '__default_deny';
const DEFAULT_DENY_POLICY_NAME = 'Default Deny';

function defaultDeny(request: PolicyEvaluationRequest): PolicyDecision {
    return {
        decision: 'deny',
        matchedPolicyId: DEFAULT_DENY_POLICY_ID,
        matchedPolicyName: DEFAULT_DENY_POLICY_NAME,
        capability: request.capability,
        reason: 'No matching policy found. Default is deny.',
        principalId: request.principal.id,
        trustZone: request.trustZone ?? request.principal.trustZone,
        resourceUri: request.resourceUri,
        requiresApproval: false,
    };
}

// ─── Policy sorting ────────────────────────────────────────────────────────

/**
 * Sort policies by priority (lower number = higher priority).
 * Ties broken by: deny before allow, then by ID lexicographic.
 */
export function sortPoliciesByPriority(policies: Policy[]): Policy[] {
    return [...policies].sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        // At same priority, deny wins over allow
        if (a.decision !== b.decision) {
            return a.decision === 'deny' ? -1 : 1;
        }
        return a.id.localeCompare(b.id);
    });
}

// ─── Policy matching ───────────────────────────────────────────────────────

/**
 * Check if a policy's match conditions apply to a given request.
 * Omitted fields in PolicyMatch are wildcards (match anything).
 */
export function matchPolicy(request: PolicyEvaluationRequest, policy: Policy): boolean {
    const match = policy.match;

    if (!matchPrincipals(request, match)) return false;
    if (!matchTrustZones(request, match)) return false;
    if (!matchCapabilities(request, match)) return false;
    if (!matchStores(request, match)) return false;
    if (!matchKinds(request, match)) return false;
    if (!matchUriPatterns(request, match)) return false;
    if (!matchCommandVerbs(request, match)) return false;

    return true;
}

function matchPrincipals(request: PolicyEvaluationRequest, match: PolicyMatch): boolean {
    if (!match.principals || match.principals.length === 0) return true;
    // Match by principal ID or any of their roles
    const identifiers = [request.principal.id, ...request.principal.roles];
    return match.principals.some((p) => identifiers.includes(p));
}

function matchTrustZones(request: PolicyEvaluationRequest, match: PolicyMatch): boolean {
    if (!match.trustZones || match.trustZones.length === 0) return true;
    const zone = request.trustZone ?? request.principal.trustZone;
    return match.trustZones.includes(zone);
}

function matchCapabilities(request: PolicyEvaluationRequest, match: PolicyMatch): boolean {
    if (!match.capabilities || match.capabilities.length === 0) return true;
    return match.capabilities.includes(request.capability);
}

function matchStores(request: PolicyEvaluationRequest, match: PolicyMatch): boolean {
    if (!match.stores || match.stores.length === 0) return true;
    if (match.stores.includes('*')) return true;
    if (!request.ownerStore) return true; // no store constraint on request = pass
    return match.stores.includes(request.ownerStore);
}

function matchKinds(request: PolicyEvaluationRequest, match: PolicyMatch): boolean {
    if (!match.kinds || match.kinds.length === 0) return true;
    if (!request.entityKind) return true; // no kind constraint on request = pass
    return match.kinds.includes(request.entityKind);
}

function matchUriPatterns(request: PolicyEvaluationRequest, match: PolicyMatch): boolean {
    if (!match.uriPatterns || match.uriPatterns.length === 0) return true;
    if (!request.resourceUri) return true; // no URI on request = pass
    return match.uriPatterns.some((pattern) => request.resourceUri!.startsWith(pattern));
}

function matchCommandVerbs(request: PolicyEvaluationRequest, match: PolicyMatch): boolean {
    if (!match.commandVerbs || match.commandVerbs.length === 0) return true;
    if (!request.commandVerb) return true; // no verb on request = pass
    return match.commandVerbs.includes(request.commandVerb);
}

// ─── Trust zone restrictions ───────────────────────────────────────────────

function applyTrustZoneRestrictions(
    decision: PolicyDecision,
    request: PolicyEvaluationRequest,
    trustZones: TrustZone[],
): PolicyDecision {
    const zoneId = request.trustZone ?? request.principal.trustZone;
    const zone = trustZones.find((z) => z.id === zoneId);
    if (!zone) return decision;

    // Trust zone can require approval for write operations
    if (decision.decision === 'allow') {
        const isWriteCapability = isWriteAction(request.capability);
        if (isWriteCapability && zone.approvalMode === 'require_approval') {
            return { ...decision, requiresApproval: true };
        }
        if (isWriteCapability && zone.approvalMode === 'require_approval_for_writes') {
            return { ...decision, requiresApproval: true };
        }
    }

    return decision;
}

function isWriteAction(capability: Capability): boolean {
    return capability === 'commit_command' || capability === 'compensate_command';
}

// ─── Main evaluator ────────────────────────────────────────────────────────

export interface PolicyEngineOptions {
    policies: Policy[];
    trustZones?: TrustZone[];
    visibilityRules?: VisibilityRule[];
}

/**
 * Evaluate policy for a specific action request.
 *
 * Evaluation order:
 * 1. Policies sorted by priority (lower = higher precedence).
 * 2. At same priority, deny wins over allow.
 * 3. First matching policy produces the decision.
 * 4. Trust zone restrictions apply on top (may add approval requirement).
 * 5. Default is deny.
 */
export function evaluatePolicy(
    request: PolicyEvaluationRequest,
    options: PolicyEngineOptions,
): PolicyDecision {
    const sorted = sortPoliciesByPriority(options.policies);

    for (const policy of sorted) {
        if (matchPolicy(request, policy)) {
            const decision: PolicyDecision = {
                decision: policy.decision,
                matchedPolicyId: policy.id,
                matchedPolicyName: policy.name,
                capability: request.capability,
                reason: policy.reason,
                principalId: request.principal.id,
                trustZone: request.trustZone ?? request.principal.trustZone,
                resourceUri: request.resourceUri,
                redaction: policy.redaction,
                requiresApproval: false,
            };

            // Apply trust zone restrictions
            return applyTrustZoneRestrictions(decision, request, options.trustZones ?? []);
        }
    }

    return defaultDeny(request);
}

// ─── Explanation ───────────────────────────────────────────────────────────

/**
 * Produce a human-readable explanation of a policy decision.
 */
export function explainPolicyDecision(decision: PolicyDecision): string {
    const parts: string[] = [];

    parts.push(`Decision: ${decision.decision.toUpperCase()}`);
    parts.push(`Principal: ${decision.principalId}`);
    parts.push(`Capability: ${decision.capability}`);
    if (decision.resourceUri) parts.push(`Resource: ${decision.resourceUri}`);
    parts.push(`Trust zone: ${decision.trustZone}`);
    parts.push(`Matched policy: ${decision.matchedPolicyName} (${decision.matchedPolicyId})`);
    parts.push(`Reason: ${decision.reason}`);
    if (decision.requiresApproval) parts.push(`⚠️ Requires explicit approval`);
    if (decision.redaction) parts.push(`Redaction: ${decision.redaction.behavior} ${decision.redaction.target} — ${decision.redaction.reason}`);

    return parts.join('\n');
}

// ─── Visibility check ──────────────────────────────────────────────────────

/**
 * Determine whether a denied object's existence should be disclosed.
 */
export function checkVisibility(
    resourceUri: string | undefined,
    ownerStore: string | undefined,
    visibilityRules: VisibilityRule[],
): { existenceVisible: boolean; emitPlaceholder: boolean } {
    if (!resourceUri && !ownerStore) {
        return { existenceVisible: false, emitPlaceholder: false };
    }

    for (const rule of visibilityRules) {
        if (scopeMatchesResource(rule.scope, resourceUri, ownerStore)) {
            return {
                existenceVisible: rule.existenceVisible,
                emitPlaceholder: rule.emitPlaceholder,
            };
        }
    }

    // Default: existence hidden, no placeholder
    return { existenceVisible: false, emitPlaceholder: false };
}

function scopeMatchesResource(scope: Scope, resourceUri: string | undefined, ownerStore: string | undefined): boolean {
    // Check store match
    if (ownerStore) {
        if (!scope.stores.includes('*') && !scope.stores.includes(ownerStore as any)) {
            return false;
        }
    }
    // Check URI match
    if (resourceUri && scope.uris && scope.uris.length > 0) {
        if (!scope.uris.some((u) => resourceUri.startsWith(u))) {
            return false;
        }
    }
    return true;
}
