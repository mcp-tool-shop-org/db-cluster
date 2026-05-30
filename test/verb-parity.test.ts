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
 *
 * TESTS-R007 — explicit allowlist rather than `!name.startsWith('_')`. An
 * `internalFoo`-style helper that needs to stay internal (no policy wrapper)
 * would otherwise silently pass the parity check. Adding a method here is a
 * deliberate decision; the next reviewer can see the intent.
 */
const KERNEL_INTERNAL_METHODS = new Set<string>([
    'constructor',
    'getCommand',
    'saveCommand',
    'recordOrphanMutation',
    // Private method used by the kernel's own commitMutation('reindex') path
    // and by rebuildIndex(). Marked `private` in TypeScript; mechanically on
    // the prototype since TS private is compile-time only. No reason to
    // expose this through the policy wrapper.
    'performIndexRebuild',
    // Wave A4 KERNEL-B-007 (Buffer side-channel): private helpers for the
    // pending-content staging area at `.db-cluster/pending-content/`. The
    // kernel writes Buffer payloads here at propose-time (keyed by sha256)
    // and reads them back at commit-time after re-validation. Both are
    // `private` on the class; mechanically on the prototype. They are not
    // verbs — they're persistence-layer plumbing for the ingest_artifact
    // lifecycle path. PolicyEnforcedKernel intentionally does not wrap them.
    'getStagingDir',
    'deleteStagingFile',
    // Wave A4 fix-up (AGG-A4-2): inline orphan-sweep for the staging dir.
    // Mirrors the local-store adapters' constructor-time sweep. Private
    // persistence-layer plumbing — same rationale as getStagingDir /
    // deleteStagingFile above. PolicyEnforcedKernel does not wrap it.
    'sweepStagingOrphans',
]);

/**
 * Methods on PolicyEnforcedKernel that are intentional additions (not present
 * on ClusterKernel) — exposed for callers that need policy-layer state
 * (visibility checks).
 *
 * TESTS-R007: the `_kernel` getter was removed in Wave A2 (KERNEL-R003 /
 * SURFACE-R001 fix — the surface CLI was using it to bypass policy at 10+
 * call sites). It is no longer in this allowlist; if anyone re-introduces it
 * the inverse-drift test will flag it.
 */
const POLICY_KERNEL_EXTRAS = new Set<string>([
    'constructor',
    'enforce',
    'collectRedactionRules',
    'checkVisibility',
    // AGG-004 fix-up (Wave A3) — `hasAnyPerResourceRule` is a private
    // helper used by the double-enforce pattern in `inspectEntity` /
    // `inspectCommand`. It inspects this kernel's policy bundle to decide
    // whether NotFoundError after a coarse-allow should be unified to
    // PolicyDeniedError (closes the per-resource refinement oracle).
    // Marked `private` in TypeScript, but TS private is compile-time only —
    // the method is mechanically on the prototype. No reason to expose
    // through ClusterKernel since ClusterKernel has no policy bundle.
    'hasAnyPerResourceRule',
    // AGG-B1-1b fix-up (Wave B1-Amend) — `rerenderLabelsWithPolicy` is a
    // private helper used by `traceObject` / `traceBundle` to re-render
    // node labels via `renderProvenanceLabel(metadata.labelData,
    // policyView)`. It applies the `entity_name` / `artifact_filename`
    // RedactionTargets at the policy boundary. ClusterKernel doesn't
    // mirror it because ClusterKernel emits the literal label (the
    // policy boundary is THIS class's responsibility).
    'rerenderLabelsWithPolicy',
    // KERNEL-004 fix-up (Wave S2-A2) — `assertOwnerStore` is a private
    // propose-time validator: it checks `input.targetStore` against the
    // {canonical,artifact,index,ledger} set BEFORE `enforce`, replacing the
    // prior `targetStore as any` cast that let an unknown store slip into the
    // policy engine where a wildcard `allow` could absorb it. TS `private` is
    // compile-time only, so the method is mechanically on the prototype.
    // ClusterKernel has no policy gate to validate against, so it isn't
    // mirrored there.
    'assertOwnerStore',
    // S-1 (Wave V5) — `redactResolvedArtifact` is a private policy-layer helper
    // used by `retrieveBundle` (per-object loop + bundle-level map) to redact
    // the ResolvedEvidence WRAPPER: it redacts `.object` via redactArtifact AND
    // drops the content `snippet` when an `artifact_content` rule applies (the
    // snippet rides the wrapper, outside redactArtifact's reach). TS `private`
    // is compile-time only, so the method is mechanically on the prototype.
    // ClusterKernel has no policy bundle / redaction layer, so it isn't
    // mirrored there — a sibling of `collectRedactionRules` / `assertOwnerStore`.
    'redactResolvedArtifact',
]);

/**
 * TESTS-R007: iterate both string AND symbol-keyed own properties on the
 * prototype. `Object.getOwnPropertyNames` alone skips Symbol-keyed methods,
 * so anyone defining `[Symbol.for('write')]() { ... }` would slip past the
 * parity check.
 */
function allOwnKeys(klass: { prototype: object }): Array<string | symbol> {
    return [
        ...Object.getOwnPropertyNames(klass.prototype),
        ...Object.getOwnPropertySymbols(klass.prototype),
    ];
}

function publicMethodsOf(klass: { prototype: object }, internalNames: Set<string>): Array<string | symbol> {
    return allOwnKeys(klass)
        .filter((name) => {
            // Skip the explicit internal list. For string-keyed names also
            // skip those whose name matches the allowlist exactly; do NOT
            // use `startsWith('_')` (TESTS-R007).
            if (typeof name === 'string' && internalNames.has(name)) return false;
            // Symbol-keyed methods on the kernel are by definition extras —
            // we keep them in the result so the parity tests can flag them
            // until they're explicitly added to one of the allowlists.
            return true;
        })
        .sort((a, b) => {
            const sa = typeof a === 'string' ? a : a.toString();
            const sb = typeof b === 'string' ? b : b.toString();
            return sa.localeCompare(sb);
        });
}

function describeKey(key: string | symbol): string {
    return typeof key === 'string' ? key : key.toString();
}

describe('Verb parity between ClusterKernel and PolicyEnforcedKernel (KERNEL-014)', () => {
    it('every public verb on ClusterKernel has a wrapper on PolicyEnforcedKernel', () => {
        const ckVerbs = publicMethodsOf(ClusterKernel, KERNEL_INTERNAL_METHODS);
        const pekKeys = new Set<string | symbol>(allOwnKeys(PolicyEnforcedKernel));

        const missing = ckVerbs.filter((v) => !pekKeys.has(v));

        // The error message is load-bearing for the regression net — when this
        // ever fails again, the list of missing verbs IS the bug.
        expect(
            missing,
            `PolicyEnforcedKernel is missing wrappers for: ${missing.map(describeKey).join(', ')}`,
        ).toEqual([]);
    });

    it('PolicyEnforcedKernel does not introduce undocumented extras', () => {
        // Catches the inverse drift — someone widening PolicyEnforcedKernel's
        // public surface without a matching counterpart on ClusterKernel.
        // Any genuine new policy-only API should be added to
        // POLICY_KERNEL_EXTRAS in this test (with a comment explaining why).
        const pekVerbs = publicMethodsOf(PolicyEnforcedKernel, POLICY_KERNEL_EXTRAS);
        const ckKeys = new Set<string | symbol>(publicMethodsOf(ClusterKernel, KERNEL_INTERNAL_METHODS));

        const undocumented = pekVerbs.filter((v) => !ckKeys.has(v));
        expect(
            undocumented,
            `PolicyEnforcedKernel has public methods not on ClusterKernel — ` +
                `either add them to POLICY_KERNEL_EXTRAS (with a comment) or ` +
                `mirror them on ClusterKernel: ${undocumented.map(describeKey).join(', ')}`,
        ).toEqual([]);
    });

    it('_kernel getter is gone (KERNEL-R003 / SURFACE-R001)', () => {
        // The `_kernel` getter was the bypass primitive: the CLI and
        // repo-knowledge ingest used it to unwrap PolicyEnforcedKernel and
        // call the raw ClusterKernel directly, defeating the policy layer.
        // It was deleted in Wave A2. This test pins the deletion so the
        // bypass can't quietly come back.
        const pekKeys = new Set(allOwnKeys(PolicyEnforcedKernel).map(describeKey));
        expect(pekKeys.has('_kernel')).toBe(false);
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
