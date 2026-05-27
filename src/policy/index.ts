export {
    evaluatePolicy,
    explainPolicyDecision,
    sortPoliciesByPriority,
    matchPolicy,
    checkVisibility,
} from './policy-engine.js';

export type { PolicyEngineOptions } from './policy-engine.js';

export {
    DEFAULT_POLICIES,
    DEFAULT_TRUST_ZONES,
    DEFAULT_VISIBILITY_RULES,
} from './default-policies.js';

export { PolicyEnforcedKernel, PolicyDeniedError } from '../kernel/policy-enforced-kernel.js';
export type { PolicyContext, PolicyKernelOptions } from '../kernel/policy-enforced-kernel.js';

export {
    redactArtifact,
    redactEntity,
    redactCommand,
    redactReceipt,
    redactProvenanceActors,
    redactGraphNodes,
    sanitizeWarnings,
    redactIndexSourceUri,
    REDACTED,
} from './redactor.js';

export type { Principal, Policy, TrustZone, VisibilityRule } from '../types/policy.js';

import type { Principal } from '../types/policy.js';

/**
 * Default principal used by product surfaces (SDK/CLI/MCP) when they wrap
 * the kernel with PolicyEnforcedKernel but the caller hasn't supplied one.
 *
 * This principal is treated as internal/trusted by DEFAULT_POLICIES and
 * DEFAULT_TRUST_ZONES (`cluster-admin` role + `internal` trust zone).
 * Callers that need a least-privilege principal MUST pass their own.
 */
export const INTERNAL_TRUSTED_PRINCIPAL: Principal = {
    id: 'internal',
    name: 'Internal Trusted',
    roles: ['cluster-admin'],
    trustZone: 'internal',
};
