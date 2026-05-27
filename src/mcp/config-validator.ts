/**
 * Shared structural validators for policy configuration loaded from
 * `.db-cluster/policies.json` (CLI surface) and the
 * `DB_CLUSTER_POLICIES_FILE` env var (MCP surface).
 *
 * Why this exists (SURFACE-B-006 / V2-008 carry-over):
 * The MCP server's `buildSDKOptions` (server.ts) already fail-closes when
 * `DB_CLUSTER_PRINCIPAL` (or the policies-file principal field) is
 * structurally malformed. The CLI's `loadPolicyConfig` previously did a
 * raw `JSON.parse() as PolicyConfig` cast with no runtime check — a
 * malformed `policies.json` could slip into `PolicyEnforcedKernel`,
 * which may trust-zone-not-found-branch into bypass behavior.
 *
 * The MCP server is the single chosen home for these validators because
 * the request flow is CLI → MCP → Kernel; sharing MCP's validators with
 * the CLI is consistent with that flow, while putting the validators in
 * `src/policy/` would collide with Kernel's domain ownership of
 * `redactor.ts`, `default-policies.ts`, `policy-engine.ts`, and
 * `index.ts`.
 *
 * The validators follow the same fail-closed shape as the MCP server's
 * inline `validatePrincipal`: invalid input → typed `PolicyConfigError`
 * with a clear `field` identifier and human-readable message.
 */

import type { Principal, Policy, TrustZone, VisibilityRule } from '../types/policy.js';

/**
 * Surfaced when a parsed policy config (or one of its fields) is
 * structurally malformed. Carries `field` so callers can produce a
 * targeted operator-actionable error message.
 *
 * This is a plain `Error` subclass (not a `ClusterError`) because:
 *   1. It is raised at surface-load time, before the kernel is
 *      constructed — there's no kernel hierarchy to participate in.
 *   2. The MCP / CLI catch arms map it to a stable code at the boundary
 *      via the existing typed-error → exit-code / MCP-error pathways.
 */
export class PolicyConfigError extends Error {
    public readonly code = 'INVALID_POLICY_CONFIG';
    public readonly field: string;
    constructor(field: string, reason: string) {
        super(`Invalid policy config (${field}): ${reason}`);
        this.name = 'PolicyConfigError';
        this.field = field;
    }
}

/**
 * Structural validation for a `Principal` parsed from JSON.
 *
 * Validates the same shape the MCP server requires:
 *   - `id`        — non-empty string
 *   - `name`      — string
 *   - `roles`     — string[]
 *   - `trustZone` — non-empty string
 *
 * Returns a type predicate so callers can narrow `unknown` → `Principal`
 * after a successful check. Use {@link assertPrincipal} when the caller
 * wants to throw on failure instead of branching.
 */
export function validatePrincipal(obj: unknown): obj is Principal {
    if (typeof obj !== 'object' || obj === null) return false;
    const o = obj as Record<string, unknown>;
    if (typeof o.id !== 'string' || o.id.length === 0) return false;
    if (typeof o.name !== 'string') return false;
    if (!Array.isArray(o.roles)) return false;
    if (!o.roles.every((r) => typeof r === 'string')) return false;
    if (typeof o.trustZone !== 'string' || o.trustZone.length === 0) return false;
    return true;
}

/**
 * Throw `PolicyConfigError` if `obj` is not a valid `Principal`. Useful
 * when the caller wants fail-closed semantics at the load site.
 */
export function assertPrincipal(obj: unknown, field: string): asserts obj is Principal {
    if (!validatePrincipal(obj)) {
        throw new PolicyConfigError(
            field,
            'missing or wrong-typed field(s); required: id (non-empty string), ' +
                'name (string), roles (string[]), trustZone (non-empty string)',
        );
    }
}

/**
 * The structural shape a parsed `policies.json` file may carry. All
 * fields are optional — a config with only `principal` (and no policies)
 * is valid; so is a config with only `policies` (no principal).
 */
export interface ValidatedPolicyConfig {
    policies?: Policy[];
    trustZones?: TrustZone[];
    visibilityRules?: VisibilityRule[];
    principal?: Principal;
}

/**
 * Validate a parsed policy config object. Throws `PolicyConfigError` on
 * any structural defect. Returns the input (narrowed via assertion) on
 * success — callers may chain `const cfg = validatePolicyConfig(raw);`.
 *
 * Validation is intentionally shallow:
 *   - `policies`        — must be array of objects with `id`, `decision` strings
 *   - `trustZones`      — must be array of objects with `id` string
 *   - `visibilityRules` — must be array of objects
 *   - `principal`       — must satisfy {@link validatePrincipal}
 *
 * Deeper field-level checks (capability strings, priority types) are
 * left to the policy engine — this validator only guards against the
 * trust-zone-not-found-branch bypass behavior that motivated
 * SURFACE-B-006.
 */
export function validatePolicyConfig(parsed: unknown): ValidatedPolicyConfig {
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new PolicyConfigError('root', 'expected a JSON object');
    }
    const obj = parsed as Record<string, unknown>;

    if (obj.policies !== undefined) {
        if (!Array.isArray(obj.policies)) {
            throw new PolicyConfigError('policies', 'expected an array');
        }
        for (let i = 0; i < obj.policies.length; i++) {
            const p = obj.policies[i];
            if (typeof p !== 'object' || p === null || Array.isArray(p)) {
                throw new PolicyConfigError(`policies[${i}]`, 'expected an object');
            }
            const pp = p as Record<string, unknown>;
            if (typeof pp.id !== 'string' || pp.id.length === 0) {
                throw new PolicyConfigError(`policies[${i}].id`, 'expected a non-empty string');
            }
            if (typeof pp.decision !== 'string') {
                throw new PolicyConfigError(`policies[${i}].decision`, 'expected a string');
            }
            // priority / match / reason are not validated structurally because
            // the policy engine treats missing fields as defaults — this
            // validator only guards against the trust-zone-bypass.
        }
    }

    if (obj.trustZones !== undefined) {
        if (!Array.isArray(obj.trustZones)) {
            throw new PolicyConfigError('trustZones', 'expected an array');
        }
        for (let i = 0; i < obj.trustZones.length; i++) {
            const tz = obj.trustZones[i];
            if (typeof tz !== 'object' || tz === null || Array.isArray(tz)) {
                throw new PolicyConfigError(`trustZones[${i}]`, 'expected an object');
            }
            const t = tz as Record<string, unknown>;
            if (typeof t.id !== 'string' || t.id.length === 0) {
                throw new PolicyConfigError(`trustZones[${i}].id`, 'expected a non-empty string');
            }
        }
    }

    if (obj.visibilityRules !== undefined) {
        if (!Array.isArray(obj.visibilityRules)) {
            throw new PolicyConfigError('visibilityRules', 'expected an array');
        }
        for (let i = 0; i < obj.visibilityRules.length; i++) {
            const vr = obj.visibilityRules[i];
            if (typeof vr !== 'object' || vr === null || Array.isArray(vr)) {
                throw new PolicyConfigError(`visibilityRules[${i}]`, 'expected an object');
            }
        }
    }

    if (obj.principal !== undefined) {
        assertPrincipal(obj.principal, 'principal');
    }

    return obj as ValidatedPolicyConfig;
}
