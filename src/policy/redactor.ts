/**
 * Redactor — applies redaction rules to cluster output objects.
 *
 * Redaction happens at the output layer, not storage. Data stays intact
 * in stores. When surfaced through the PolicyEnforcedKernel, restricted
 * content is stripped/masked/summarized/hashed based on active rules.
 */

import type { Entity } from '../types/entity.js';
import type { Artifact } from '../types/artifact.js';
import type { ProvenanceGraph, ProvenanceNode, ProvenanceEdge, TraceGap, TraceWarning } from '../types/provenance-graph.js';
import type { Receipt } from '../types/receipt.js';
import type { Command } from '../types/command.js';
import type { RedactionRule, RedactionTarget, VisibilityRule } from '../types/policy.js';
import { checkVisibility } from '../policy/policy-engine.js';

// ─── Redacted marker ───────────────────────────────────────────────────────

const REDACTED = '[REDACTED]';
const REDACTED_HASH_PREFIX = 'sha256:redacted:';

// ─── Artifact content redaction ────────────────────────────────────────────

export function redactArtifact(artifact: Artifact, rules: RedactionRule[]): Artifact {
    const contentRules = rules.filter((r) => r.target === 'artifact_content');
    if (contentRules.length === 0) return artifact;

    const rule = contentRules[0];
    // Artifact type doesn't carry content directly (it's in storagePath),
    // but we strip any metadata that might expose content details
    const redacted = { ...artifact };

    switch (rule.behavior) {
        case 'strip':
            // Remove storagePath (prevents content access)
            return { ...redacted, storagePath: REDACTED };
        case 'mask':
            return { ...redacted, storagePath: REDACTED, filename: `${REDACTED}.${artifact.mimeType.split('/')[1] ?? 'bin'}` };
        case 'summarize':
            return { ...redacted, storagePath: REDACTED };
        case 'hash':
            return { ...redacted, storagePath: `${REDACTED_HASH_PREFIX}${artifact.contentHash}` };
    }
}

// ─── Entity attribute redaction ────────────────────────────────────────────

export function redactEntity(entity: Entity, rules: RedactionRule[]): Entity {
    const attrRules = rules.filter((r) => r.target === 'entity_attributes');
    if (attrRules.length === 0) return entity;

    const rule = attrRules[0];
    switch (rule.behavior) {
        case 'strip':
            return { ...entity, attributes: {} };
        case 'mask':
            const masked: Record<string, unknown> = {};
            for (const key of Object.keys(entity.attributes)) {
                masked[key] = REDACTED;
            }
            return { ...entity, attributes: masked };
        case 'summarize':
            return { ...entity, attributes: { _summary: `${Object.keys(entity.attributes).length} attributes redacted` } };
        case 'hash':
            return { ...entity, attributes: { _hash: `${REDACTED_HASH_PREFIX}${Object.keys(entity.attributes).length}` } };
    }
}

// ─── Command payload redaction ─────────────────────────────────────────────

export function redactCommand(command: Command, rules: RedactionRule[]): Command {
    const payloadRules = rules.filter((r) => r.target === 'command_payload');
    if (payloadRules.length === 0) return command;

    const rule = payloadRules[0];
    switch (rule.behavior) {
        case 'strip':
            return { ...command, payload: {} };
        case 'mask':
            const masked: Record<string, unknown> = {};
            for (const key of Object.keys(command.payload)) {
                masked[key] = REDACTED;
            }
            return { ...command, payload: masked };
        case 'summarize':
            return { ...command, payload: { _summary: `${Object.keys(command.payload).length} fields redacted`, verb: command.verb } };
        case 'hash':
            return { ...command, payload: { _hash: REDACTED } };
    }
}

// ─── Receipt detail redaction ──────────────────────────────────────────────

export function redactReceipt(receipt: Receipt, rules: RedactionRule[]): Receipt {
    const receiptRules = rules.filter((r) => r.target === 'receipt_details');
    if (receiptRules.length === 0) return receipt;

    const rule = receiptRules[0];
    // Preserve audit shape: id, commandId, timestamps, but redact description/affected details
    switch (rule.behavior) {
        case 'strip':
            return { ...receipt, resultSummary: REDACTED, affectedIds: [] };
        case 'mask':
            return { ...receipt, resultSummary: REDACTED, affectedIds: receipt.affectedIds.map(() => REDACTED) };
        case 'summarize':
            return { ...receipt, resultSummary: `[Redacted: ${receipt.affectedIds.length} objects affected]`, affectedIds: [] };
        case 'hash':
            return { ...receipt, resultSummary: REDACTED };
    }
}

// ─── Provenance event redaction (single event, not graph) ─────────────────

/**
 * Redact a single ProvenanceEvent surfaced through {@link
 * import('../kernel/cluster-kernel.js').ClusterKernel.explainIndex} when
 * the index record points at a ledger source, or through any flat-event
 * surface (e.g. `traceProvenance`, `retrieveBundle.provenanceEvents`).
 * The shape parallels {@link redactEntity}: we strip leaky fields based
 * on rules but keep the audit-essential identifiers (id, action,
 * timestamp, subjectId, subjectStore). KERNEL-R005 / KERNEL-R2-006.
 *
 * Rules consulted:
 * - `command_payload` → strips `detail.payload`, `detail.commandId`,
 *   AND identifying fields that the kernel emits into `detail` for
 *   synthetic command provenance: `kind`, `entityId`, `name`. Those
 *   leak entity identity through the ledger surface for callers with
 *   no owner-truth grant.
 * - `provenance_actors` → masks `actorId`. Both `strip` and `mask`
 *   emit the `REDACTED` sentinel (truthy, distinguishable from a
 *   missing field — pre-fix `strip` emitted `''` which collided with
 *   "no actor recorded").
 * - `receipt_details` → strips the full `detail` object (the most
 *   aggressive — covers the leakage above).
 *
 * If no rule fires, the event is returned unchanged.
 */
export function redactProvenanceEvent(
    event: import('../types/provenance-event.js').ProvenanceEvent,
    rules: RedactionRule[],
): import('../types/provenance-event.js').ProvenanceEvent {
    if (rules.length === 0) return event;

    let detail = event.detail;
    let actorId = event.actorId;

    const receiptRule = rules.find((r) => r.target === 'receipt_details');
    const payloadRule = rules.find((r) => r.target === 'command_payload');
    const actorRule = rules.find((r) => r.target === 'provenance_actors');

    if (receiptRule) {
        // Aggressive: drop the whole detail object.
        detail = {};
    } else if (payloadRule) {
        const next: Record<string, unknown> = { ...detail };
        // Command payload + commandId — original strip behavior.
        if ('payload' in next) delete next.payload;
        if ('commandId' in next) delete next.commandId;
        // KERNEL-R2-006: kernel helpers emit `kind`, `entityId`, `name`
        // into the detail object for synthetic-command provenance.
        // Those mirror the same information that lives in the entity
        // owner-truth, so the command_payload redaction rule must
        // strip them as well — otherwise a caller with discovery-only
        // grants reads owner truth through this surface.
        if ('kind' in next) delete next.kind;
        if ('entityId' in next) delete next.entityId;
        if ('name' in next) delete next.name;
        detail = next;
    }

    if (actorRule) {
        // KERNEL-R2-006: both `strip` and `mask` emit the truthy
        // `REDACTED` sentinel. Pre-fix `strip` emitted `''` (falsy),
        // which (a) was indistinguishable from "no actor recorded"
        // and (b) downstream `if (event.actorId)` checks treated the
        // redaction as a missing-actor signal.
        actorId = REDACTED;
    }

    return { ...event, actorId, detail };
}

// ─── Provenance actor redaction ────────────────────────────────────────────

export function redactProvenanceActors(graph: ProvenanceGraph, rules: RedactionRule[]): ProvenanceGraph {
    const actorRules = rules.filter((r) => r.target === 'provenance_actors');
    if (actorRules.length === 0) return graph;

    const rule = actorRules[0];
    const redactLabel = (label: string): string => {
        // Labels often contain "by <actor>" — mask the actor
        return label.replace(/by\s+[\w\-@.]+/g, `by ${REDACTED}`);
    };

    return {
        ...graph,
        nodes: graph.nodes.map((n) => ({
            ...n,
            label: rule.behavior === 'strip' ? redactLabel(n.label) : n.label,
            metadata: n.metadata ? redactMetadataActors(n.metadata, rule) : undefined,
        })),
        edges: graph.edges.map((e) => ({
            ...e,
            reason: rule.behavior === 'strip' ? redactLabel(e.reason) : e.reason,
        })),
    };
}

function redactMetadataActors(metadata: Record<string, unknown>, rule: RedactionRule): Record<string, unknown> {
    const result = { ...metadata };
    for (const key of ['actorId', 'actor', 'proposedBy', 'approvedBy', 'rejectedBy', 'committedBy', 'compensatedBy']) {
        if (key in result) {
            result[key] = rule.behavior === 'strip' ? undefined : REDACTED;
        }
    }
    return result;
}

// ─── Provenance graph node filtering (visibility) ──────────────────────────

/**
 * Remove nodes from a provenance graph that the caller cannot see,
 * while preserving graph structure (gaps inserted where nodes removed).
 */
export function redactGraphNodes(
    graph: ProvenanceGraph,
    isNodeVisible: (node: ProvenanceNode) => boolean,
): ProvenanceGraph {
    const visibleNodes: ProvenanceNode[] = [];
    const hiddenUris = new Set<string>();

    for (const node of graph.nodes) {
        if (isNodeVisible(node)) {
            visibleNodes.push(node);
        } else {
            hiddenUris.add(node.uri);
            // Insert a redacted placeholder node
            visibleNodes.push({
                uri: node.uri,
                type: node.type,
                ownerStore: null,
                isSourceTruth: false,
                label: '[Access restricted]',
                isGap: true,
            });
        }
    }

    // Edges referencing hidden nodes: keep structure but redact reason
    const edges = graph.edges.map((e) => {
        if (hiddenUris.has(e.from) || hiddenUris.has(e.to)) {
            return { ...e, reason: '[Restricted]', sourceEventId: undefined };
        }
        return e;
    });

    // Do not expose hidden URIs in gaps/warnings
    const gaps = graph.gaps.filter((g) => !g.expectedUri || !hiddenUris.has(g.expectedUri));
    const warnings = graph.warnings.filter((w) => !hiddenUris.has(w.subjectUri));

    return {
        ...graph,
        nodes: visibleNodes,
        edges,
        gaps,
        warnings,
        summary: {
            ...graph.summary,
            nodeCount: visibleNodes.length,
            edgeCount: edges.length,
            gapCount: gaps.length,
            warningCount: warnings.length,
        },
    };
}

// ─── Stale/missing warning URI sanitization ────────────────────────────────

/**
 * Remove hidden URIs from stale/missing warnings to prevent leakage.
 */
export function sanitizeWarnings(
    warnings: TraceWarning[],
    gaps: TraceGap[],
    visibilityRules: VisibilityRule[],
): { warnings: TraceWarning[]; gaps: TraceGap[] } {
    const safeWarnings = warnings.filter((w) => {
        const vis = checkVisibility(w.subjectUri, storeFromUri(w.subjectUri), visibilityRules);
        return vis.existenceVisible;
    });

    const safeGaps = gaps.filter((g) => {
        if (!g.expectedUri) return true;
        const vis = checkVisibility(g.expectedUri, storeFromUri(g.expectedUri), visibilityRules);
        return vis.existenceVisible;
    });

    return { warnings: safeWarnings, gaps: safeGaps };
}

// ─── Index source URI redaction ────────────────────────────────────────────

export function redactIndexSourceUri(record: { sourceId: string; sourceStore: string }, rules: RedactionRule[]): { sourceId: string; sourceStore: string } {
    const uriRules = rules.filter((r) => r.target === 'index_source_uri');
    if (uriRules.length === 0) return record;

    return { ...record, sourceId: REDACTED, sourceStore: record.sourceStore };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function storeFromUri(uri: string): string | undefined {
    const match = uri.match(/^cluster:\/\/(\w+)\//);
    return match?.[1];
}

export { REDACTED };
