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
 *
 * KERNEL-C-008 (Wave C1-Amend) — each member field below carries a JSDoc
 * block describing the verb's intent, who throws what, and where to find
 * the implementation prose. The signature types are pulled from
 * {@link ClusterKernel} via index access — see the concrete kernel for
 * full `@param` / `@returns` / `@throws` / `@example` JSDoc.
 */
import type { ClusterKernel } from './cluster-kernel.js';

export interface ClusterKernelInterface {
    // ─── Helper write verbs ──────────────────────────────────────────────

    /**
     * Ingest a source artifact (filename + Buffer + mimeType) into the
     * cluster. Writes artifact store, index store, ledger. Returns the
     * stored artifact + its index record + the provenance event + the
     * receipt.
     *
     * Throws (delegated to `ClusterKernel.ingestArtifact`):
     *  - {@link ReceiptFailedError} — store mutated but receipt failed;
     *    `mutation_orphaned` ledger event attempted.
     *  - {@link PolicyDeniedError} — when called through
     *    {@link PolicyEnforcedKernel} with insufficient `commit_command`.
     *
     * See {@link ClusterKernel.ingestArtifact} for the full prose.
     */
    ingestArtifact: ClusterKernel['ingestArtifact'];

    /**
     * Create a canonical entity. Writes canonical store, index store,
     * ledger. Returns the stored entity + index record + provenance
     * event + receipt.
     *
     * Throws (delegated to `ClusterKernel.createEntity`):
     *  - {@link ReceiptFailedError}
     *  - {@link PolicyDeniedError} (via policy wrapper)
     *
     * See {@link ClusterKernel.createEntity} for the full prose.
     */
    createEntity: ClusterKernel['createEntity'];

    /**
     * Link an artifact as evidence for an entity. Writes only ledger
     * (provenance edge). Returns provenance event + receipt.
     *
     * Throws:
     *  - {@link NotFoundError} — artifact or entity does not exist.
     *  - {@link ReceiptFailedError} — ledger write failed post-validation.
     *  - {@link PolicyDeniedError} (via policy wrapper)
     */
    linkEvidence: ClusterKernel['linkEvidence'];

    // ─── Read / discovery verbs ──────────────────────────────────────────

    /**
     * Find sources through the index, then resolve owner truth.
     *
     * KERNEL-C-003 (Wave C1-Amend): when the result is empty, the
     * response carries `_meta.empty_reason` distinguishing `no_data` /
     * `no_match` / `all_filtered_by_policy` so the AI can branch
     * appropriately. See {@link FindSourcesResult}.
     *
     * Throws:
     *  - {@link PolicyDeniedError} — when called through
     *    {@link PolicyEnforcedKernel} with insufficient
     *    `discover_existence`.
     */
    findSources: ClusterKernel['findSources'];

    /**
     * Inspect a canonical entity by id. Returns the canonical truth
     * (NOT an index projection).
     *
     * Throws:
     *  - {@link NotFoundError} — entity does not exist.
     *  - {@link PolicyDeniedError} (via policy wrapper)
     */
    inspectEntity: ClusterKernel['inspectEntity'];

    /**
     * Trace provenance for a subject by walking the ledger lineage.
     * Returns the full event list ordered by ledger insertion.
     *
     * Throws:
     *  - {@link PolicyDeniedError} (via policy wrapper)
     */
    traceProvenance: ClusterKernel['traceProvenance'];

    /**
     * Retrieve a structured `EvidenceBundle` — index query → resolved
     * owner truth → provenance attachments → freshness / gap analysis.
     *
     * Throws:
     *  - {@link PolicyDeniedError} (via policy wrapper)
     */
    retrieveBundle: ClusterKernel['retrieveBundle'];

    /**
     * Render a human-readable explanation of an `EvidenceBundle`.
     */
    explainRetrieval: ClusterKernel['explainRetrieval'];

    // ─── Command lifecycle verbs ─────────────────────────────────────────

    /**
     * Propose a mutation. Does NOT mutate any store. Returns a `Command`
     * in 'proposed' status that must later be validated and committed.
     *
     * KERNEL-C-002 (Wave C1-Amend): wrap the result with
     * {@link withNextValidActions} to get the legal next-state moves.
     *
     * Throws:
     *  - {@link ContentHashMismatchError} — `ingest_artifact` with hash
     *    that doesn't match the content buffer.
     *  - {@link PolicyDeniedError} (via policy wrapper)
     */
    proposeMutation: ClusterKernel['proposeMutation'];

    /**
     * Commit a previously validated/approved mutation. Executes against
     * the target store, emits provenance + receipt.
     *
     * Throws (Wave C1-Amend KERNEL-C-005 — distinct typed errors):
     *  - {@link CommandNotFoundError} — id doesn't exist in queue.
     *  - {@link CommandNotValidatedError} — id is proposed-but-not-validated.
     *  - {@link CommandAlreadyTerminalError} — id is committed/compensated.
     *  - {@link CommandRejectedError} — id is rejected.
     *  - {@link InvalidStateTransitionError} — any other status.
     *  - {@link StagedContentTamperedError} — staging file rewritten
     *    between propose and commit (ingest_artifact only).
     *  - {@link ReceiptFailedError} — mutation succeeded but receipt failed.
     *  - {@link PolicyDeniedError} (via policy wrapper)
     */
    commitMutation: ClusterKernel['commitMutation'];

    /**
     * Validate a proposed command. Runs structural + semantic checks
     * and transitions 'proposed' → 'validated'. On validation failure
     * transitions 'proposed' → 'rejected'.
     *
     * Throws:
     *  - {@link NotFoundError} — id doesn't exist.
     *  - {@link CommandNotValidatedError} — command status is not 'proposed'.
     *  - {@link CommandRejectedError} — validation failed.
     *  - {@link PolicyDeniedError} (via policy wrapper)
     */
    validateMutation: ClusterKernel['validateMutation'];

    /**
     * Approve a validated command — operator/policy gate.
     *
     * Throws:
     *  - {@link NotFoundError} — id doesn't exist.
     *  - {@link InvalidStateTransitionError} — command not 'validated'.
     *  - {@link PolicyDeniedError} (via policy wrapper)
     */
    approveMutation: ClusterKernel['approveMutation'];

    /**
     * Reject a command from any non-terminal status.
     *
     * Throws:
     *  - {@link NotFoundError}
     *  - {@link InvalidStateTransitionError}
     *  - {@link PolicyDeniedError} (via policy wrapper)
     */
    rejectMutation: ClusterKernel['rejectMutation'];

    /**
     * Compensate a committed command — write a compensating command
     * that corrects without erasing history. Original receipt preserved.
     *
     * Throws:
     *  - {@link NotFoundError} — original id doesn't exist.
     *  - {@link InvalidStateTransitionError} — original not 'committed'.
     *  - {@link ReceiptFailedError}
     *  - {@link PolicyDeniedError} (via policy wrapper)
     */
    compensateMutation: ClusterKernel['compensateMutation'];

    // ─── Receipt + command inspection verbs ──────────────────────────────

    /**
     * Inspect a command's full lifecycle state.
     *
     * Throws:
     *  - {@link NotFoundError}
     *  - {@link PolicyDeniedError} (via policy wrapper)
     */
    inspectCommand: ClusterKernel['inspectCommand'];

    /**
     * List receipts, optionally filtered by commandId / since / limit.
     *
     * Throws:
     *  - {@link PolicyDeniedError} (via policy wrapper)
     */
    listReceipts: ClusterKernel['listReceipts'];

    // ─── Index verbs ─────────────────────────────────────────────────────

    /**
     * Rebuild the index from owner stores (canonical + artifact).
     * Atomic swap via {@link IndexStore.replaceAll}.
     *
     * Throws:
     *  - {@link ReceiptFailedError}
     *  - {@link PolicyDeniedError} (via policy wrapper)
     */
    rebuildIndex: ClusterKernel['rebuildIndex'];

    /**
     * Return the current index status: total count + per-store
     * breakdown + expected total + `possiblyStale` flag.
     *
     * Throws:
     *  - {@link PolicyDeniedError} (via policy wrapper)
     */
    indexStatus: ClusterKernel['indexStatus'];

    /**
     * Explain why an index record exists.
     *
     * Throws:
     *  - {@link NotFoundError}
     *  - {@link PolicyDeniedError} (via policy wrapper)
     */
    explainIndex: ClusterKernel['explainIndex'];

    /**
     * List all index records that are stale (source truth missing or
     * changed).
     *
     * Throws:
     *  - {@link PolicyDeniedError} (via policy wrapper)
     */
    listStaleRecords: ClusterKernel['listStaleRecords'];

    // ─── Trace verbs ─────────────────────────────────────────────────────

    /**
     * Build a navigable provenance graph from a URI.
     *
     * Throws:
     *  - {@link PolicyDeniedError} (via policy wrapper)
     */
    traceObject: ClusterKernel['traceObject'];

    /**
     * Trace all objects in a retrieval bundle — combined provenance graph.
     *
     * Throws:
     *  - {@link PolicyDeniedError} (via policy wrapper)
     */
    traceBundle: ClusterKernel['traceBundle'];

    /**
     * String renderer for a provenance graph.
     */
    explainTrace: ClusterKernel['explainTrace'];

    /**
     * Compact operator-facing "why does this object exist" explanation.
     *
     * Throws:
     *  - {@link PolicyDeniedError} (via policy wrapper)
     */
    why: ClusterKernel['why'];

    // ─── Lifecycle introspection (Wave C1-Amend KERNEL-C-002) ────────────

    /**
     * Wrap any `Command` with the legal next-state moves out of its
     * current status. Surface-side consumers (MCP / SDK / CLI) wrap
     * lifecycle responses with this helper so the AI / operator can
     * branch on what verbs are legal next without re-implementing the
     * state-transition table.
     *
     * Pure function (reads `validTransitions(command.status)`) — no
     * policy gate, no I/O.
     */
    withNextValidActions: ClusterKernel['withNextValidActions'];
}
