/**
 * ProvenanceGraph — a navigable, machine-readable truth graph.
 *
 * Not a visualization model. Not logs. Not raw JSON archaeology.
 * A first-class cluster object that any UI, MCP tool, SDK method,
 * or dogfood workflow can rely on for trace truth.
 */

export type TraceDirection = 'backward' | 'forward' | 'bidirectional';

export interface TraceOptions {
    direction: TraceDirection;
    depth?: number;
    includeIndex?: boolean;
    includeReceipts?: boolean;
    includeCommands?: boolean;
    includeGaps?: boolean;
}

export type NodeType =
    | 'entity'
    | 'artifact'
    | 'index_record'
    | 'provenance_event'
    | 'receipt'
    | 'command'
    | 'evidence_bundle';

export type EdgeType =
    | 'artifact_ingested_from'
    | 'entity_created_by'
    | 'evidence_linked_to'
    | 'index_record_derived_from'
    | 'bundle_resolved_from'
    | 'mutation_proposed_from'
    | 'mutation_committed_by'
    | 'receipt_emitted_for'
    | 'stale_projection_of'
    | 'missing_owner_truth'
    | 'missing_provenance';

export interface ProvenanceNode {
    /** Cluster URI for this node */
    uri: string;
    /** Node type */
    type: NodeType;
    /** Owner store (or null for gaps) */
    ownerStore: string | null;
    /** Is this source truth or derivative? */
    isSourceTruth: boolean;
    /** Display label */
    label: string;
    /** Optional metadata snapshot */
    metadata?: Record<string, unknown>;
    /** Whether this node represents a gap/warning */
    isGap?: boolean;
}

export interface ProvenanceEdge {
    /** Source node URI */
    from: string;
    /** Target node URI */
    to: string;
    /** Edge type — the reason this connection exists */
    type: EdgeType;
    /** Human-readable reason */
    reason: string;
    /** Provenance event ID that establishes this edge (if any) */
    sourceEventId?: string;
    /** Timestamp of the edge relationship */
    timestamp?: string;
    /** Is this edge a warning (stale, missing)? */
    isWarning?: boolean;
}

export interface TraceGap {
    /** What is missing */
    description: string;
    /** URI that should exist but doesn't */
    expectedUri?: string;
    /** The store where the gap was detected */
    store: string;
    /** Impact of this gap */
    impact: 'low' | 'medium' | 'high';
}

export interface TraceWarning {
    /** Warning type */
    type: 'stale_index' | 'missing_provenance' | 'missing_owner_truth' | 'orphan_record';
    /** What the warning applies to */
    subjectUri: string;
    /** Human-readable message */
    message: string;
}

export interface TraceSummary {
    /** The focal URI this trace was built from */
    focalUri: string;
    /** Trace direction used */
    direction: TraceDirection;
    /** Total nodes in graph */
    nodeCount: number;
    /** Total edges in graph */
    edgeCount: number;
    /** Source truth nodes (canonical, artifact, ledger) */
    sourceTruthNodes: number;
    /** Derivative nodes (index records) */
    derivativeNodes: number;
    /** Receipt count */
    receiptCount: number;
    /** Gap count */
    gapCount: number;
    /** Warning count */
    warningCount: number;
    /** Human-readable one-line summary */
    oneLiner: string;
}

export interface ProvenanceGraph {
    /** The focal URI — the object this graph was traced from */
    focalUri: string;
    /** Trace direction */
    direction: TraceDirection;
    /** All nodes in the graph */
    nodes: ProvenanceNode[];
    /** All edges in the graph */
    edges: ProvenanceEdge[];
    /** Gaps — missing provenance or truth */
    gaps: TraceGap[];
    /** Warnings — stale projections, missing chains */
    warnings: TraceWarning[];
    /** Summary statistics */
    summary: TraceSummary;
    /** When this graph was assembled */
    assembledAt: string;
}
