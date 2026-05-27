/**
 * ClusterKernelInterface — verb-parity contract between ClusterKernel and PolicyEnforcedKernel.
 *
 * Both kernels MUST implement every verb declared here with the same signature.
 * If PolicyEnforcedKernel forgets a wrapper for a new ClusterKernel verb,
 * the compiler will surface the gap immediately (this is exactly how KERNEL-001
 * escaped: there was no contract enforcing wrapper coverage).
 *
 * The signatures are derived from {@link ClusterKernel} so the two stay
 * in lock-step automatically — adding a new method to ClusterKernel forces
 * PolicyEnforcedKernel to either implement it or explicitly opt out at the
 * type level. Tests (`test/kernel-verb-parity.test.ts`) add a runtime check
 * for belt-and-braces.
 */
import type { ClusterKernel } from './cluster-kernel.js';

export interface ClusterKernelInterface {
    // ─── Helper write verbs ──────────────────────────────────────────────
    ingestArtifact: ClusterKernel['ingestArtifact'];
    createEntity: ClusterKernel['createEntity'];
    linkEvidence: ClusterKernel['linkEvidence'];

    // ─── Read / discovery verbs ──────────────────────────────────────────
    findSources: ClusterKernel['findSources'];
    inspectEntity: ClusterKernel['inspectEntity'];
    traceProvenance: ClusterKernel['traceProvenance'];
    retrieveBundle: ClusterKernel['retrieveBundle'];
    explainRetrieval: ClusterKernel['explainRetrieval'];

    // ─── Command lifecycle verbs ─────────────────────────────────────────
    proposeMutation: ClusterKernel['proposeMutation'];
    commitMutation: ClusterKernel['commitMutation'];
    validateMutation: ClusterKernel['validateMutation'];
    approveMutation: ClusterKernel['approveMutation'];
    rejectMutation: ClusterKernel['rejectMutation'];
    compensateMutation: ClusterKernel['compensateMutation'];

    // ─── Receipt + command inspection verbs ──────────────────────────────
    inspectCommand: ClusterKernel['inspectCommand'];
    listReceipts: ClusterKernel['listReceipts'];

    // ─── Index verbs ─────────────────────────────────────────────────────
    rebuildIndex: ClusterKernel['rebuildIndex'];
    indexStatus: ClusterKernel['indexStatus'];
    explainIndex: ClusterKernel['explainIndex'];
    listStaleRecords: ClusterKernel['listStaleRecords'];

    // ─── Trace verbs ─────────────────────────────────────────────────────
    traceObject: ClusterKernel['traceObject'];
    traceBundle: ClusterKernel['traceBundle'];
    explainTrace: ClusterKernel['explainTrace'];
    why: ClusterKernel['why'];
}
