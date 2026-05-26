/**
 * Policy type model for db-cluster.
 *
 * Cluster-native access control vocabulary.
 * Not generic RBAC — scoped to cluster truth stores,
 * AI-facing tools, and mutation lifecycle.
 */

// ─── Principals ────────────────────────────────────────────────────────────

/**
 * A principal — an identity that can act on cluster truth.
 * Not a "user" generically — a named actor in the cluster's trust model.
 */
export interface Principal {
    id: string;
    name: string;
    roles: string[];
    trustZone: string;
    metadata?: Record<string, unknown>;
}

// ─── Capabilities ──────────────────────────────────────────────────────────

/**
 * The atomic actions a principal can perform on cluster truth.
 * Each maps to a real cluster operation, not an abstract permission verb.
 */
export type Capability =
    | 'discover_existence'    // can see that an object exists in search/index
    | 'read_owner_truth'     // can read the full object from its owner store
    | 'read_derivative'      // can read index/derivative records
    | 'trace_provenance'     // can walk provenance graph
    | 'propose_mutation'     // can propose a command (writes nothing)
    | 'validate_command'     // can trigger validation on a proposed command
    | 'approve_command'      // can approve a validated command
    | 'reject_command'       // can reject a command
    | 'commit_command'       // can commit a validated/approved command (writes truth)
    | 'compensate_command'   // can compensate a committed command
    | 'read_receipts'        // can read mutation receipts
    | 'read_command'         // can inspect command lifecycle state
    | 'explain_retrieval';   // can see retrieval explanation/stale warnings

// ─── Scope ─────────────────────────────────────────────────────────────────

/**
 * A scope constrains where a capability applies.
 * Scopes are additive — a principal needs at least one matching scope.
 */
export interface Scope {
    /** Which stores this scope applies to. '*' = all stores. */
    stores: ('canonical' | 'artifact' | 'index' | 'ledger' | '*')[];
    /** Which entity kinds this scope covers. '*' = all kinds. */
    kinds?: (string | '*')[];
    /** Specific URIs this scope is limited to. Omit = all URIs in matched stores. */
    uris?: string[];
}

// ─── Roles ─────────────────────────────────────────────────────────────────

/**
 * A role — a named bundle of capabilities + scope.
 * Roles are assigned to principals. Multiple roles are additive.
 */
export interface Role {
    id: string;
    name: string;
    capabilities: Capability[];
    scope: Scope;
}

// ─── Trust Zones ───────────────────────────────────────────────────────────

/**
 * A trust zone — a boundary within which principals operate.
 * Different zones may have different default visibility, approval requirements,
 * and redaction behavior.
 */
export interface TrustZone {
    id: string;
    name: string;
    /** Default capabilities granted to any principal in this zone */
    defaultCapabilities: Capability[];
    /** Default scope for zone-level grants */
    defaultScope: Scope;
    /** Whether mutations in this zone require explicit approval */
    approvalMode: ApprovalMode;
    /** Redaction rules applied to outputs leaving this zone */
    redactionRules: RedactionRule[];
    /** Visibility rules for object existence */
    visibilityRules: VisibilityRule[];
}

/**
 * How mutations are gated in a trust zone.
 */
export type ApprovalMode =
    | 'auto'            // validated commands auto-commit (internal/trusted zone)
    | 'require_approval' // all commits require explicit approval
    | 'require_approval_for_writes'; // only truth-writing commits need approval

// ─── Policy ────────────────────────────────────────────────────────────────

/**
 * A policy rule — maps principal/action/resource conditions to a decision.
 * Policies are evaluated in priority order. First match wins.
 */
export interface Policy {
    id: string;
    name: string;
    /** Priority (lower = evaluated first). Ties broken by ID. */
    priority: number;
    /** Match conditions */
    match: PolicyMatch;
    /** Decision when matched */
    decision: 'allow' | 'deny';
    /** Reason for this policy (human-readable) */
    reason: string;
    /** Redaction to apply if allowed (optional — e.g. strip payload from receipts) */
    redaction?: RedactionRule;
}

/**
 * Conditions that must all be true for a policy to match.
 * Omitted fields = wildcard (matches anything).
 */
export interface PolicyMatch {
    /** Principal IDs or role names */
    principals?: string[];
    /** Trust zone IDs */
    trustZones?: string[];
    /** Capabilities being requested */
    capabilities?: Capability[];
    /** Target store(s) */
    stores?: ('canonical' | 'artifact' | 'index' | 'ledger' | '*')[];
    /** Target entity kinds */
    kinds?: string[];
    /** Target URI patterns (prefix match) */
    uriPatterns?: string[];
    /** Command verbs (for mutation-related capabilities) */
    commandVerbs?: string[];
}

// ─── Policy Decision ───────────────────────────────────────────────────────

/**
 * The output of evaluating policy for a specific action.
 */
export interface PolicyDecision {
    /** Allow or deny */
    decision: 'allow' | 'deny';
    /** Which policy produced this decision */
    matchedPolicyId: string;
    matchedPolicyName: string;
    /** The capability that was evaluated */
    capability: Capability;
    /** Why this decision was made */
    reason: string;
    /** Principal who requested the action */
    principalId: string;
    /** Trust zone context */
    trustZone: string;
    /** Resource URI (if applicable) */
    resourceUri?: string;
    /** Redaction to apply (if allowed with redaction) */
    redaction?: RedactionRule;
    /** Whether approval is additionally required for this action */
    requiresApproval: boolean;
}

// ─── Redaction Rules ───────────────────────────────────────────────────────

/**
 * A redaction rule — what to strip/mask from outputs.
 */
export interface RedactionRule {
    id: string;
    /** What to redact */
    target: RedactionTarget;
    /** How to redact it */
    behavior: 'strip' | 'mask' | 'summarize' | 'hash';
    /** Reason this redaction exists */
    reason: string;
}

export type RedactionTarget =
    | 'artifact_content'     // strip raw artifact content
    | 'entity_attributes'    // strip entity attribute values
    | 'command_payload'      // strip mutation payload from receipts/inspection
    | 'provenance_actors'    // mask actor IDs in provenance
    | 'receipt_details'      // redact receipt payload but keep audit shape
    | 'index_source_uri';    // hide original source path in index records

// ─── Visibility Rules ──────────────────────────────────────────────────────

/**
 * A visibility rule — whether an object's existence is disclosed.
 * Controls whether a restricted object appears in search results at all.
 */
export interface VisibilityRule {
    id: string;
    /** Scope of objects this rule applies to */
    scope: Scope;
    /** Whether existence is disclosed to principals outside this zone */
    existenceVisible: boolean;
    /** If existence is hidden, whether to emit a count placeholder ("3 results redacted") */
    emitPlaceholder: boolean;
}

// ─── Policy Evaluation Request ─────────────────────────────────────────────

/**
 * Input to the policy engine's evaluate() method.
 */
export interface PolicyEvaluationRequest {
    principal: Principal;
    capability: Capability;
    resourceUri?: string;
    ownerStore?: 'canonical' | 'artifact' | 'index' | 'ledger';
    entityKind?: string;
    commandVerb?: string;
    trustZone?: string;
}
