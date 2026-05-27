/**
 * Redactor — applies redaction rules to cluster output objects.
 *
 * Redaction happens at the output layer, not storage. Data stays intact
 * in stores. When surfaced through the PolicyEnforcedKernel, restricted
 * content is stripped/masked/summarized/hashed based on active rules.
 *
 * ─── AGG-005 architectural contract (Stage B Wave B1-Amend) ────────────
 *
 * Pre-fix the redactor functions were DENYLISTS — they named the fields
 * to strip and silently forwarded everything else. A new field added to
 * any domain type (`Entity`, `Artifact`, `Command`, `Receipt`,
 * `ProvenanceEvent`, `IndexRecord`) leaked through every read surface
 * the next deploy.
 *
 * Post-fix the redactor functions are ALLOWLISTS. Each target type
 * declares a `PRESERVED_FIELDS_<TYPE>` constant naming the fields that
 * survive redaction unchanged. Every other field is either dropped or
 * marked with a {@link RedactedMarker} (per AGG-008). Adding a new
 * domain field leaks ONLY if explicitly added to the allowlist — the
 * default is closed.
 *
 * Every `switch (rule.behavior)` block now has a `default:` arm that
 * falls back to the SAFEST behavior (`strip`) when the runtime sees a
 * policy with an unknown behavior literal. The TS compiler protects the
 * compile-time union; the runtime default arm protects against
 * runtime-loaded / network-loaded / disk-loaded policy files whose
 * shape escaped the compiler.
 *
 * ─── Type-system migration discipline ────────────────────────────────
 *
 * The EXTERNAL return-type signatures stay the same (`redactArtifact(...)`
 * still returns `Artifact`) to keep cross-domain disruption bounded.
 * Marker structural-distinctness is the narrowing point: a consumer that
 * sees `art.storagePath` MUST `isRedactedMarker`-check before consuming
 * the value as a string. Downstream Surface / MCP / dashboard sanitizers
 * forward the marker through the boundary unchanged. The stronger
 * `Redacted<T>` type (every field becomes `T | RedactedMarker`) was
 * considered and deferred — it would cascade type errors across Surface
 * SDK + MCP consumers; the marker-as-structural-distinction approach
 * achieves the same runtime safety with bounded migration.
 *
 * ─── KERNEL-B-005 — redactErrorMessage helper ────────────────────────
 *
 * `redactErrorMessage(err)` strips absolute filesystem paths from error
 * messages. The MCP-side {@link import('../mcp/sanitize.js').redactError}
 * does the same scrubbing at the MCP boundary; this helper lives in the
 * kernel domain so the kernel can pre-scrub `cause.message` BEFORE it
 * persists into the ledger via `recordOrphanMutation` (kernel cannot
 * import from `src/mcp/` per the no-back-edge rule). The MCP-side
 * sanitizer can re-import the scrubber from here once a coordinator
 * pass aligns the two paths; cross-domain breadcrumb left in the
 * surface-domain report.
 */

import type { Entity } from '../types/entity.js';
import type { Artifact } from '../types/artifact.js';
import type { ProvenanceGraph, ProvenanceNode, ProvenanceEdge, TraceGap, TraceWarning } from '../types/provenance-graph.js';
import type { Receipt } from '../types/receipt.js';
import type { Command } from '../types/command.js';
import type { IndexRecord } from '../types/index-record.js';
import type { ProvenanceEvent } from '../types/provenance-event.js';
import type { RedactionRule, VisibilityRule } from '../types/policy.js';
import { checkVisibility } from '../policy/policy-engine.js';
import { redactedMarker, isRedactedMarker } from '../types/redaction.js';
import type { RedactedMarker } from '../types/redaction.js';

// ─── Redacted markers (legacy string for back-compat) ──────────────────────

const REDACTED = '[REDACTED]';
const REDACTED_HASH_PREFIX = 'sha256:redacted:';

// ─── Allowlist contracts (AGG-005) ─────────────────────────────────────────
//
// PRESERVED_FIELDS_<TYPE> enumerates the fields that survive a redactor
// pass on each domain type. Every other own-enumerable field gets
// dropped or replaced with a {@link RedactedMarker(kind:_, reason:'unknown_field')}.
//
// To add a field to the allowlist, edit the constant AND the
// `test/wave-b1-kernel-regression.test.ts::B1-AGG-005-a` test that
// asserts the membership. The test forces a reviewer to acknowledge
// the new field is intentional.
//
// The lists below are sorted by the type's declaration order
// (`src/types/<type>.ts`) so adding a field at the bottom of a type
// declaration mirrors the bottom of its allowlist.

export const PRESERVED_FIELDS_ARTIFACT: ReadonlyArray<keyof Artifact> = [
    'id',
    'filename',
    'contentHash',
    'mimeType',
    'sizeBytes',
    'version',
    'storagePath',
    'ingestedAt',
    'owner',
] as const;

export const PRESERVED_FIELDS_ENTITY: ReadonlyArray<keyof Entity> = [
    'id',
    'kind',
    'name',
    'attributes',
    'createdAt',
    'updatedAt',
    'owner',
] as const;

export const PRESERVED_FIELDS_COMMAND: ReadonlyArray<keyof Command> = [
    'id',
    'verb',
    'targetStore',
    'payload',
    'proposedAt',
    'proposedBy',
    'status',
    'validation',
    'rejectionReason',
    'rejectedBy',
    'rejectedAt',
    'approvedBy',
    'approvedAt',
    'approvalNote',
    'committedAt',
    'committedBy',
    'compensatedBy',
    'compensatedAt',
    'compensatingCommandId',
] as const;

export const PRESERVED_FIELDS_RECEIPT: ReadonlyArray<keyof Receipt> = [
    'id',
    'commandId',
    'committedAt',
    'resultSummary',
    'affectedIds',
    'provenanceEventId',
] as const;

export const PRESERVED_FIELDS_PROVENANCE_EVENT: ReadonlyArray<keyof ProvenanceEvent> = [
    'id',
    'timestamp',
    'action',
    'actorId',
    'subjectId',
    'subjectStore',
    'detail',
    'parentEventId',
    'owner',
] as const;

export const PRESERVED_FIELDS_INDEX_RECORD: ReadonlyArray<keyof IndexRecord> = [
    'id',
    'sourceId',
    'sourceStore',
    'text',
    'metadata',
    'embedding',
    'indexedAt',
    'owner',
] as const;

// ─── Allowlist helper ──────────────────────────────────────────────────────

/**
 * Apply the AGG-005 allowlist contract to an object: any own-enumerable
 * field NOT in the allowlist is replaced with a {@link RedactedMarker}
 * carrying `reason: 'unknown_field'`. Allowlisted fields are returned
 * unchanged. The marker's `kind` is inferred from `typeof value`.
 *
 * Returns a NEW object (does not mutate input). The return type uses
 * `T & Record<string, unknown>` so consumers see the structural shape
 * a sidecar field might carry post-redaction.
 */
function applyAllowlist<T extends Record<string, unknown>>(
    obj: T,
    allowlist: ReadonlyArray<keyof T | string>,
): T {
    const allowed = new Set<string>(allowlist as ReadonlyArray<string>);
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(obj)) {
        const v = (obj as Record<string, unknown>)[key];
        if (allowed.has(key)) {
            result[key] = v;
        } else {
            result[key] = redactedMarker(inferMarkerKind(v), 'unknown_field');
        }
    }
    return result as T;
}

function inferMarkerKind(v: unknown): RedactedMarker['kind'] {
    if (typeof v === 'string') return 'string';
    if (typeof v === 'number') return 'number';
    if (Buffer.isBuffer(v)) return 'buffer';
    if (Array.isArray(v)) return 'array';
    if (typeof v === 'object' && v !== null) return 'object';
    return 'unknown';
}

// ─── Artifact content redaction ────────────────────────────────────────────

export function redactArtifact(artifact: Artifact, rules: RedactionRule[]): Artifact {
    const contentRules = rules.filter((r) => r.target === 'artifact_content');
    // AGG-005: even when NO content rule matches, the allowlist still
    // applies — unknown sidecar fields are stripped. Pre-fix early-returned
    // `artifact` unchanged, leaking sidecar fields.
    const baseline = applyAllowlist(artifact as unknown as Record<string, unknown>, PRESERVED_FIELDS_ARTIFACT as ReadonlyArray<string>) as unknown as Artifact;
    if (contentRules.length === 0) return baseline;

    const rule = contentRules[0];
    const redacted: Artifact = { ...baseline };

    switch (rule.behavior) {
        case 'strip':
            // Remove storagePath (prevents content access)
            return { ...redacted, storagePath: REDACTED };
        case 'mask':
            return {
                ...redacted,
                storagePath: REDACTED,
                filename: `${REDACTED}.${artifact.mimeType.split('/')[1] ?? 'bin'}`,
            };
        case 'summarize':
            return { ...redacted, storagePath: REDACTED };
        case 'hash':
            return {
                ...redacted,
                storagePath: `${REDACTED_HASH_PREFIX}${artifact.contentHash}`,
            };
        default:
            // KERNEL-B-003: runtime-loaded policy with unknown behavior.
            // Fall back to the SAFEST shape (strip) instead of returning
            // undefined (which the function signature lies about) or
            // returning the raw artifact (which leaks).
            return { ...redacted, storagePath: REDACTED };
    }
}

// ─── Entity attribute redaction ────────────────────────────────────────────

export function redactEntity(entity: Entity, rules: RedactionRule[]): Entity {
    const attrRules = rules.filter((r) => r.target === 'entity_attributes');
    const baseline = applyAllowlist(entity as unknown as Record<string, unknown>, PRESERVED_FIELDS_ENTITY as ReadonlyArray<string>) as unknown as Entity;
    if (attrRules.length === 0) return baseline;

    const rule = attrRules[0];
    switch (rule.behavior) {
        case 'strip':
            return { ...baseline, attributes: {} };
        case 'mask': {
            const masked: Record<string, unknown> = {};
            for (const key of Object.keys(entity.attributes)) {
                masked[key] = REDACTED;
            }
            return { ...baseline, attributes: masked };
        }
        case 'summarize':
            return {
                ...baseline,
                attributes: {
                    _summary: `${Object.keys(entity.attributes).length} attributes redacted`,
                },
            };
        case 'hash':
            return {
                ...baseline,
                attributes: {
                    _hash: `${REDACTED_HASH_PREFIX}${Object.keys(entity.attributes).length}`,
                },
            };
        default:
            // KERNEL-B-003 default arm: safest behavior is `strip`.
            return { ...baseline, attributes: {} };
    }
}

// ─── Command payload redaction ─────────────────────────────────────────────

export function redactCommand(command: Command, rules: RedactionRule[]): Command {
    const payloadRules = rules.filter((r) => r.target === 'command_payload');
    const baseline = applyAllowlist(command as unknown as Record<string, unknown>, PRESERVED_FIELDS_COMMAND as ReadonlyArray<string>) as unknown as Command;
    if (payloadRules.length === 0) return baseline;

    const rule = payloadRules[0];
    switch (rule.behavior) {
        case 'strip':
            return { ...baseline, payload: {} };
        case 'mask': {
            const masked: Record<string, unknown> = {};
            for (const key of Object.keys(command.payload)) {
                masked[key] = REDACTED;
            }
            return { ...baseline, payload: masked };
        }
        case 'summarize':
            return {
                ...baseline,
                payload: {
                    _summary: `${Object.keys(command.payload).length} fields redacted`,
                    verb: command.verb,
                },
            };
        case 'hash':
            return { ...baseline, payload: { _hash: REDACTED } };
        default:
            return { ...baseline, payload: {} };
    }
}

// ─── Receipt detail redaction ──────────────────────────────────────────────

export function redactReceipt(receipt: Receipt, rules: RedactionRule[]): Receipt {
    const receiptRules = rules.filter((r) => r.target === 'receipt_details');
    const baseline = applyAllowlist(receipt as unknown as Record<string, unknown>, PRESERVED_FIELDS_RECEIPT as ReadonlyArray<string>) as unknown as Receipt;
    if (receiptRules.length === 0) return baseline;

    const rule = receiptRules[0];
    // Preserve audit shape: id, commandId, timestamps, but redact description/affected details
    switch (rule.behavior) {
        case 'strip':
            return { ...baseline, resultSummary: REDACTED, affectedIds: [] };
        case 'mask':
            return {
                ...baseline,
                resultSummary: REDACTED,
                affectedIds: receipt.affectedIds.map(() => REDACTED),
            };
        case 'summarize':
            return {
                ...baseline,
                resultSummary: `[Redacted: ${receipt.affectedIds.length} objects affected]`,
                affectedIds: [],
            };
        case 'hash':
            // KERNEL-B-002 fix: previously `hash` left `affectedIds` exposed,
            // which produced a covert side-channel (count + value of the IDs).
            // Now mask `affectedIds` as well so `hash` is strictly more
            // protective than `strip` on the count dimension only.
            return {
                ...baseline,
                resultSummary: REDACTED,
                affectedIds: receipt.affectedIds.map(() => REDACTED),
            };
        default:
            return { ...baseline, resultSummary: REDACTED, affectedIds: [] };
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
 * AGG-005: the allowlist is applied unconditionally. Unknown sidecar
 * fields on the event (a future contributor adding a new domain field)
 * are collapsed to a `RedactedMarker` regardless of which rules fire.
 */
export function redactProvenanceEvent(
    event: ProvenanceEvent,
    rules: RedactionRule[],
): ProvenanceEvent {
    const baseline = applyAllowlist(event as unknown as Record<string, unknown>, PRESERVED_FIELDS_PROVENANCE_EVENT as ReadonlyArray<string>) as unknown as ProvenanceEvent;
    if (rules.length === 0) return baseline;

    let detail = baseline.detail;
    let actorId = baseline.actorId;

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

    return { ...baseline, actorId, detail };
}

// ─── Provenance actor redaction ────────────────────────────────────────────

export function redactProvenanceActors(graph: ProvenanceGraph, rules: RedactionRule[]): ProvenanceGraph {
    const actorRules = rules.filter((r) => r.target === 'provenance_actors');
    if (actorRules.length === 0) return graph;

    const rule = actorRules[0];
    const redactLabel = (label: string): string => {
        // Labels often contain "by <actor>" — mask the actor.
        // KERNEL-B-016: this regex is a tactical band-aid. The structural
        // fix lives in TraceBuilder (KERNEL-B-006) which now stores
        // labelData and renders labels at consumer boundary; this regex
        // remains as a defense-in-depth pass over any label strings that
        // bypass the renderer.
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

// ─── Index record redaction ────────────────────────────────────────────────

/**
 * AGG-005: dedicated redactor for IndexRecord. Pre-fix only the
 * `redactIndexSourceUri` helper existed (and it was dead code — V2-011).
 * Now every IndexRecord surfaced through a redactor pass goes through
 * the same allowlist contract as the other domain types: unknown
 * sidecar fields collapse to {@link RedactedMarker}.
 *
 * Rules consulted:
 * - `index_source_uri` → strips `sourceId` (per the pre-fix V2-011
 *   contract, which is now active via this function).
 */
export function redactIndexRecord(record: IndexRecord, rules: RedactionRule[]): IndexRecord {
    const baseline = applyAllowlist(record as unknown as Record<string, unknown>, PRESERVED_FIELDS_INDEX_RECORD as ReadonlyArray<string>) as unknown as IndexRecord;
    const uriRules = rules.filter((r) => r.target === 'index_source_uri');
    if (uriRules.length === 0) return baseline;

    const rule = uriRules[0];
    switch (rule.behavior) {
        case 'strip':
            return { ...baseline, sourceId: REDACTED };
        case 'mask':
            return { ...baseline, sourceId: REDACTED };
        case 'summarize':
            return { ...baseline, sourceId: REDACTED };
        case 'hash':
            return { ...baseline, sourceId: `${REDACTED_HASH_PREFIX}${record.sourceId.length}` };
        default:
            return { ...baseline, sourceId: REDACTED };
    }
}

// ─── Index source URI redaction (legacy, V2-011) ───────────────────────────

/**
 * Legacy helper preserved for any external consumer that imports it.
 * New call sites should use {@link redactIndexRecord} which applies the
 * full AGG-005 allowlist contract.
 */
export function redactIndexSourceUri(record: { sourceId: string; sourceStore: string }, rules: RedactionRule[]): { sourceId: string; sourceStore: string } {
    const uriRules = rules.filter((r) => r.target === 'index_source_uri');
    if (uriRules.length === 0) return record;

    return { ...record, sourceId: REDACTED, sourceStore: record.sourceStore };
}

// ─── Error message scrubber (KERNEL-B-005) ────────────────────────────────

/**
 * Path-scrubbing regex. Matches Posix absolute paths (`/foo/bar`) and
 * Windows absolute paths (`C:\foo\bar` or `C:/foo/bar`, including UNC
 * `\\host\share\…`). Each match is replaced with the literal `<path>`.
 *
 * Mirrors the regex in `src/mcp/sanitize.ts::PATH_REGEX`. The two MUST
 * stay aligned — Surface re-imports this helper in a future wave to
 * collapse the duplication. Until then the regexes are kept identical
 * by convention; if you edit one, edit the other.
 */
const PATH_REGEX = /(?:[A-Za-z]:[\\/]|\\\\[^\s"'`)]+[\\/]|\/)[^\s"'`)]+/g;

/**
 * Strip absolute filesystem paths from an error message.
 *
 * Why this lives here (KERNEL-B-005):
 * The kernel's `recordOrphanMutation` (`src/kernel/cluster-kernel.ts:129`)
 * persists `cause.message` into the ledger detail. Pre-fix that message
 * could carry Windows or POSIX absolute paths verbatim, which then
 * surfaced through `retrieveBundle.provenanceEvents`,
 * `traceProvenance`, and `inspectCommand`. The MCP-side `redactError`
 * scrubber is downstream of persistence — by the time it runs, the
 * path is already in the ledger forever. The kernel must scrub BEFORE
 * persisting.
 *
 * The kernel cannot import from `src/mcp/` (no back-edge rule
 * documented at the top of `src/kernel/errors.ts`). So the scrubber
 * lives here, in the kernel-domain policy package. The MCP-side
 * `redactError` SHOULD re-import this in a follow-up wave; leaving a
 * breadcrumb in the Wave B1-Amend Kernel report.
 *
 * Accepts either an `Error` instance or a string (defensive — `cause`
 * sometimes arrives as a plain value).
 */
export function redactErrorMessage(err: unknown): string {
    let raw: string;
    if (err instanceof Error) {
        raw = err.message || err.name || 'unknown error';
    } else if (typeof err === 'string') {
        raw = err;
    } else if (err === null || err === undefined) {
        return 'unknown error';
    } else {
        raw = String(err);
    }
    return raw.replace(PATH_REGEX, '<path>');
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function storeFromUri(uri: string): string | undefined {
    const match = uri.match(/^cluster:\/\/(\w+)\//);
    return match?.[1];
}

export { REDACTED, isRedactedMarker, redactedMarker };
export type { RedactedMarker };
