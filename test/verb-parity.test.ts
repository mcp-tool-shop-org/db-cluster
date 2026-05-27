/**
 * Verb parity between ClusterKernel and PolicyEnforcedKernel (KERNEL-014).
 *
 * Belt-and-braces runtime check for the contract declared in
 * `src/kernel/cluster-kernel-interface.ts`. The TS interface forces the two
 * kernels to stay aligned at compile time; this test catches drift if anyone
 * adds a new method to ClusterKernel and either:
 *
 *   - forgets to add it to ClusterKernelInterface, OR
 *   - widens PolicyEnforcedKernel's method visibility without declaring
 *     intent in the interface.
 *
 * Exactly the kind of gap that hid KERNEL-001 — seven public ClusterKernel
 * verbs (`ingestArtifact`, `createEntity`, `linkEvidence`, `traceProvenance`,
 * `indexStatus`, `traceBundle`, `explainTrace`) had no PolicyEnforcedKernel
 * wrapper and therefore bypassed policy when reached via the underlying
 * kernel reference.
 */

import { describe, it, expect } from 'vitest';
import { ClusterKernel } from '../src/kernel/cluster-kernel.js';
import { PolicyEnforcedKernel } from '../src/kernel/policy-enforced-kernel.js';

/**
 * Methods on ClusterKernel that are intentionally internal — not part of the
 * public verb surface PolicyEnforcedKernel must wrap. These exist for the
 * kernel's own bookkeeping (queue persistence, orphan-mutation accounting)
 * and are not exposed to product surfaces.
 */
const KERNEL_INTERNAL_METHODS = new Set<string>([
    'constructor',
    'getCommand',
    'saveCommand',
    'recordOrphanMutation',
]);

/**
 * Methods on PolicyEnforcedKernel that are intentional additions (not present
 * on ClusterKernel) — exposed for callers that need policy-layer state
 * (visibility checks) or backdoor access (the `_kernel` getter used by tests).
 */
const POLICY_KERNEL_EXTRAS = new Set<string>([
    'constructor',
    'enforce',
    'collectRedactionRules',
    'checkVisibility',
    '_kernel',
]);

function publicMethodsOf(klass: { prototype: object }, internalNames: Set<string>): string[] {
    return Object.getOwnPropertyNames(klass.prototype)
        .filter((name) => !name.startsWith('_') && !internalNames.has(name))
        .sort();
}

describe('Verb parity between ClusterKernel and PolicyEnforcedKernel (KERNEL-014)', () => {
    it('every public verb on ClusterKernel has a wrapper on PolicyEnforcedKernel', () => {
        const ckVerbs = publicMethodsOf(ClusterKernel, KERNEL_INTERNAL_METHODS);
        const pekVerbs = new Set(Object.getOwnPropertyNames(PolicyEnforcedKernel.prototype));

        const missing = ckVerbs.filter((v) => !pekVerbs.has(v));

        // The error message is load-bearing for the regression net — when this
        // ever fails again, the list of missing verbs IS the bug.
        expect(missing, `PolicyEnforcedKernel is missing wrappers for: ${missing.join(', ')}`).toEqual([]);
    });

    it('PolicyEnforcedKernel does not introduce undocumented extras', () => {
        // Catches the inverse drift — someone widening PolicyEnforcedKernel's
        // public surface without a matching counterpart on ClusterKernel.
        // Any genuine new policy-only API should be added to
        // POLICY_KERNEL_EXTRAS in this test (with a comment explaining why).
        const pekVerbs = publicMethodsOf(PolicyEnforcedKernel, POLICY_KERNEL_EXTRAS);
        const ckVerbs = new Set(publicMethodsOf(ClusterKernel, KERNEL_INTERNAL_METHODS));

        const undocumented = pekVerbs.filter((v) => !ckVerbs.has(v));
        expect(
            undocumented,
            `PolicyEnforcedKernel has public methods not on ClusterKernel — ` +
                `either add them to POLICY_KERNEL_EXTRAS (with a comment) or ` +
                `mirror them on ClusterKernel: ${undocumented.join(', ')}`,
        ).toEqual([]);
    });

    it('the seven KERNEL-001 verbs are concretely wrapped', () => {
        // The original gap. Pin it explicitly so a refactor that re-removes any
        // of these is impossible-to-miss obvious in the test output.
        const required = [
            'ingestArtifact',
            'createEntity',
            'linkEvidence',
            'traceProvenance',
            'indexStatus',
            'traceBundle',
            'explainTrace',
        ];
        const pekVerbs = new Set(Object.getOwnPropertyNames(PolicyEnforcedKernel.prototype));
        for (const verb of required) {
            expect(pekVerbs.has(verb), `PolicyEnforcedKernel missing wrapper for ${verb}`).toBe(true);
        }
    });
});
