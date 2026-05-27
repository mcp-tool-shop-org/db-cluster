/**
 * Public kernel surface — every type, function, and class an external
 * consumer (SDK, MCP, dashboard, CLI) needs to interact with the
 * cluster contract.
 *
 * KERNEL-C-006 (Wave C1-Amend): pre-fix only 6 of 11 typed errors were
 * exported and the command-lifecycle helpers were not surfaced.
 * Developers had to deep-import to call `validTransitions` or
 * `instanceof` on subclasses. This file is the single import path —
 * `import { PolicyDeniedError, validTransitions } from '@mcptoolshop/db-cluster/kernel'`
 * (or, for repos that import the package root, `from '@mcptoolshop/db-cluster'`).
 */

export { ClusterKernel } from './cluster-kernel.js';
export type {
    KernelOptions,
    IngestArtifactInput,
    CreateEntityInput,
    LinkEvidenceInput,
    FindSourcesInput,
    FindSourcesResult,
    ProposeMutationInput,
    CommitMutationResult,
    CommandLifecycleEnvelope,
    IndexStatusResult,
    IndexExplanation,
    StaleRecord,
    RetrievalExplanation,
} from './cluster-kernel.js';
export { CommandQueue } from './command-queue.js';
export {
    proposeCommand,
    validateCommand,
    // KERNEL-C-006: command-lifecycle helpers (pre-fix not exported).
    approveCommand,
    rejectCommand,
    markCommitted,
    markRejected,
    markCompensated,
    isValidTransition,
    validTransitions,
    CommandValidationFailedError,
} from './commands.js';
export { recordProvenance, traceSubjectProvenance } from './provenance.js';
export { emitReceipt } from './receipts.js';
export {
    // Base type + the union.
    ClusterError,
    type ClusterErrorCode,
    CLUSTER_ERROR_CODES,
    // KERNEL-C-006: pre-fix only 6 were exported. Now all 14 subclasses
    // surface for `instanceof` branching.
    NotFoundError,
    ProvenanceMissingError,
    CommandNotValidatedError,
    CommandNotFoundError,
    CommandAlreadyTerminalError,
    CommandRejectedError,
    InvalidStateTransitionError,
    ReceiptFailedError,
    CommandQueueCorruptError,
    CommandQueuePersistenceLostError,
    ContentHashMismatchError,
    StagedContentTamperedError,
    BufferSideChannelNotSupportedError,
    InvalidContentShapeError,
} from './errors.js';
// KERNEL-C-006: PolicyEnforcedKernel + PolicyDeniedError live in
// `policy-enforced-kernel.ts` but are part of the public kernel surface.
export { PolicyEnforcedKernel, PolicyDeniedError } from './policy-enforced-kernel.js';
export type {
    PolicyContext,
    PolicyKernelOptions,
} from './policy-enforced-kernel.js';
export type { ClusterKernelInterface } from './cluster-kernel-interface.js';
