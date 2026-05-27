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
