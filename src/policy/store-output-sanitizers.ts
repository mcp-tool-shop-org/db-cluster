/**
 * Store output sanitizers — strip internal fields from index records,
 * ledger events, and other store-output objects before they leave the
 * SDK / MCP boundary.
 *
 * Why this exists (SURFACE-R2-003):
 * The MCP-output sanitizers in `src/mcp/sanitize.ts` cover artifact, entity,
 * and receipt — three of the five owner-store types resolvable through the
 * cluster resolver. The remaining two (index records and ledger events)
 * have no sanitizer, so an MCP-host call to `cluster_resolve` against an
 * index URI returns the raw IndexRecord (with `metadata`, which mirrors
 * entity content) and against a ledger URI returns the raw ProvenanceEvent
 * (with `actorId` + `detail.payload`).
 *
 * These sanitizers attach `_sourceType` markers consistent with
 * src/mcp/sanitize.ts and strip the leakiest fields. Routes that need
 * fine-grained policy-driven behavior (mask vs. summarize vs. hash) should
 * still go through `src/policy/redactor.ts` first — these are the
 * unconditional baseline that applies even with no policies configured.
 *
 * Kernel agent owns `redactor.ts` this wave, so this file is scoped to
 * Surface and lives under `src/policy/`.
 */

import type { IndexRecord } from '../types/index-record.js';
import type { ProvenanceEvent } from '../types/provenance-event.js';
import type { ProvenanceNode, ProvenanceEdge, ProvenanceGraph } from '../types/provenance-graph.js';

/**
 * Sanitized index record — `metadata` mirrors entity content (sensitive)
 * and is replaced with a marker indicating it was stripped at the boundary.
 */
export type SanitizedIndexRecord = Omit<IndexRecord, 'metadata'> & {
    _sourceType: 'derivative';
    _metadataPolicy: string;
};

const METADATA_POLICY_NOTICE =
    'Index record metadata is stripped at the SDK/MCP boundary. ' +
    'Metadata mirrors owner-truth content and may include sensitive fields. ' +
    'Resolve the owner URI directly to obtain a (policy-sanitized) entity.';

/**
 * Sanitize an index record for SDK/MCP output. Strips the `metadata` field
 * (which mirrors entity content) and attaches markers so callers see, at a
 * glance, that the record is derivative.
 */
export function sanitizeIndexRecordForOutput(
    record: IndexRecord | null | undefined,
): SanitizedIndexRecord | null {
    if (!record) return null;
    const { metadata: _unused, ...rest } = record;
    void _unused;
    return {
        ...(rest as Omit<IndexRecord, 'metadata'>),
        _sourceType: 'derivative',
        _metadataPolicy: METADATA_POLICY_NOTICE,
    };
}

/**
 * Sanitized provenance event — `actorId` is the actor identity and `detail`
 * carries the command payload, both sensitive. We replace `actorId` with
 * `[REDACTED]` and `detail` with `{}`. Audit-essential identifiers (id,
 * timestamp, action, subjectId, subjectStore) are preserved.
 */
export type SanitizedProvenanceEvent = Omit<ProvenanceEvent, 'actorId' | 'detail'> & {
    actorId: string;
    detail: Record<string, unknown>;
    _sourceType: 'audit-record';
};

/**
 * Sanitize a provenance event for SDK/MCP output. Masks `actorId` and
 * empties `detail` (which carries the original command payload). The
 * audit-essential identifiers remain so callers can still trace and reason
 * about the event's place in the ledger.
 */
export function sanitizeProvenanceEventForOutput(
    event: ProvenanceEvent | null | undefined,
): SanitizedProvenanceEvent | null {
    if (!event) return null;
    return {
        ...event,
        actorId: '[REDACTED]',
        detail: {},
        _sourceType: 'audit-record',
    };
}

// ─── Provenance graph sanitizers (AGG-A4-3 / Wave A4 fix-up) ──────────────

/**
 * Sanitize a provenance graph node for SDK/MCP output. Sibling of
 * sanitizeIndexRecordForOutput / sanitizeEntityForOutput targeted at the
 * cluster_trace + cluster_why MCP arms.
 *
 * Why this exists (AGG-A4-3 / Wave A4 fix-up):
 * The trace-builder bakes identifying content INTO the node label
 * (`${entity.kind}: ${entity.name}` / `${event.action} by ${event.actorId}` /
 * `Receipt: ${receipt.resultSummary}`) and reflects owner-truth fields into
 * `metadata` (actorId, kind, name, filename, …). The cluster_trace MCP arm
 * pre-fix spread `...graph` raw across the MCP boundary, surfacing those
 * baked-in identifiers verbatim — the same root cause as SURFACE-B-001
 * (find_sources LIST arm) which was closed in Wave A4 fix-1, but
 * cluster_trace was a missed sibling.
 *
 * The sanitizer preserves the graph's structural shape — URI, type,
 * ownerStore, isSourceTruth marker, isGap flag — so callers can still
 * navigate trace topology. It strips:
 *   - `label` → opaque `[${type} in ${ownerStore}]` placeholder
 *   - `metadata` → undefined (was the leakiest reflected-content field)
 *
 * This is the AGG-008 architectural direction (structured redaction at
 * render time) applied tactically as the AGG-002 unconditional-baseline
 * MCP-boundary sanitization. A full TraceBuilder refactor that separates
 * structural payload from rendered payload is B1-Amend work.
 */
export type SanitizedProvenanceNode = Omit<ProvenanceNode, 'label' | 'metadata'> & {
    label: string;
    metadata: undefined;
};

export function sanitizeProvenanceNodeForOutput(node: ProvenanceNode): SanitizedProvenanceNode {
    return {
        uri: node.uri,
        type: node.type,
        ownerStore: node.ownerStore,
        isSourceTruth: node.isSourceTruth,
        label: `[${node.type} in ${node.ownerStore ?? 'unknown'}]`,
        metadata: undefined,
        isGap: node.isGap,
    };
}

/**
 * Sanitize a provenance graph edge for SDK/MCP output. The `reason` field
 * is human-readable text constructed by the trace-builder and may embed
 * identifying owner-truth content (entity names, actor IDs, etc.). We
 * opaque-mark it. Structural fields (`from`/`to`/`type`/`sourceEventId`/
 * `timestamp`/`isWarning`) are preserved so callers can still navigate
 * the graph.
 */
export type SanitizedProvenanceEdge = Omit<ProvenanceEdge, 'reason'> & {
    reason: string;
};

export function sanitizeProvenanceEdgeForOutput(edge: ProvenanceEdge): SanitizedProvenanceEdge {
    return {
        from: edge.from,
        to: edge.to,
        type: edge.type,
        reason: '[redacted]',
        sourceEventId: edge.sourceEventId,
        timestamp: edge.timestamp,
        isWarning: edge.isWarning,
    };
}

/**
 * Sanitize an entire provenance graph for SDK/MCP output. Applies node + edge
 * sanitization in lock-step. Gaps and warnings are passed through because
 * they carry deliberately operator-actionable descriptions (gap.description
 * names what's missing, warning.message describes what's stale) — those are
 * operator-internal use, not owner-truth reflection. If a future audit shows
 * gap.description embedding entity names directly, we'll need to extend this
 * sanitizer; for now the trace-builder only embeds URIs in gap.description.
 *
 * The summary block is regenerated locally — pre-sanitization it embedded
 * `${focal.label}` in `oneLiner` which is exactly the field we just stripped.
 */
export type SanitizedProvenanceGraph = Omit<ProvenanceGraph, 'nodes' | 'edges'> & {
    nodes: SanitizedProvenanceNode[];
    edges: SanitizedProvenanceEdge[];
};

export function sanitizeProvenanceGraphForOutput(graph: ProvenanceGraph): SanitizedProvenanceGraph {
    const sanitizedNodes = graph.nodes.map(sanitizeProvenanceNodeForOutput);
    const sanitizedEdges = graph.edges.map(sanitizeProvenanceEdgeForOutput);
    return {
        ...graph,
        nodes: sanitizedNodes,
        edges: sanitizedEdges,
        summary: {
            ...graph.summary,
            // The oneLiner pre-fix could embed focal.label (which we just
            // stripped). Replace with a structural summary so MCP hosts
            // still see a one-line description without owner-truth content.
            oneLiner: `Provenance graph: ${sanitizedNodes.length} node(s), ${sanitizedEdges.length} edge(s)`,
        },
    };
}
