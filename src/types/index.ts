export type { Entity } from './entity.js';
export type { Artifact } from './artifact.js';
export type { IndexRecord } from './index-record.js';
export type { ProvenanceEvent } from './provenance-event.js';
export type { Command, CommandVerb, CommandStatus, ValidationResult, ValidationCheck } from './command.js';
export type { Receipt } from './receipt.js';
// Wave S2-A1 — ledger tamper-evidence (PROV-001 / PROV-004). Single source of
// truth for the integrity hash; both writers (adapters) and readers (ops/verify)
// MUST route through these.
export { canonicalSerialize, computeIntegrityHash } from './integrity.js';
export type {
    EvidenceBundle,
    ResolvedEvidence,
    FreshnessAssessment,
    MissingContext,
    ConfidenceBoundary,
} from './evidence-bundle.js';
export type {
    ProvenanceGraph,
    ProvenanceNode,
    ProvenanceEdge,
    TraceDirection,
    TraceOptions,
    TraceGap,
    TraceWarning,
    TraceSummary,
    NodeType,
    EdgeType,
} from './provenance-graph.js';
export type { RedactedMarker } from './redaction.js';
export { isRedactedMarker, redactedMarker } from './redaction.js';
// Wave C1-Amend §2a — AI envelope shapes (KERNEL-C-001).
export type { AiErrorEnvelope, EmptyResultMeta } from './ai-envelope.js';
// Wave C1-Amend §2d — Discriminated component state union for UI consumers.
export type { ComponentState } from './component-state.js';
