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
