/**
 * Structured redaction markers — AGG-008 (Stage B Wave B1-Amend).
 *
 * Pre-fix the redactor returned an irregular mix of forms for redacted
 * values: the bare string `'[REDACTED]'`, the object `{_redacted: true}`,
 * the empty string `''`, or a bare deletion of the field. Downstream
 * consumers (MCP sanitizers, dashboard consumers, tests) had to special-case
 * each shape to detect that a value had been redacted.
 *
 * This module establishes the structural contract for redacted values
 * surfaced through any cluster output. A `RedactedMarker` is a small
 * tagged object every downstream consumer can `isRedactedMarker`-check
 * uniformly. The two carried fields ({@link RedactedMarker.kind},
 * {@link RedactedMarker.reason}) preserve enough information that:
 *   - audit log shippers can count denials by capability vs cycle vs
 *     unknown-field reasons,
 *   - dashboard / SDK consumers can render the marker as `[REDACTED]`
 *     with the original kind preserved for layout (a redacted number
 *     renders differently from a redacted string),
 *   - the AGG-005 allowlist refactor can mark unknown-field strips
 *     with `reason: 'unknown_field'` and distinguish those at the
 *     boundary from policy-driven denials.
 *
 * Why this lives in `src/types/`:
 * The marker is a contract surface — the Surface domain's MCP sanitizers
 * (`sanitizeProvenanceEventForOutput`, `sanitizeIndexRecordForOutput`)
 * import it directly to forward markers through the boundary, and the
 * dashboard consumes the same shape. Keeping the type module under
 * `src/types/` (re-exported from `src/types/index.ts`) means consumers
 * don't transitively pull in the policy / redactor implementation.
 *
 * Stability promise (load-bearing):
 * The marker shape MUST stay stable during this wave. Surface's
 * SURFACE-B-008 (`sanitizeProvenanceEventForOutput`) and the dashboard
 * consumers read the public API; breaking this shape after agent-handoff
 * would cascade across all five domains.
 */

/**
 * A tagged marker emitted in place of a value that has been redacted.
 *
 * The `_redacted: true` literal is the discriminator — consumers detect
 * redaction by checking that property (see {@link isRedactedMarker}). The
 * `kind` and `reason` fields are advisory and let dashboard renderers and
 * audit log shippers categorize the redaction without re-evaluating
 * policy.
 *
 * The marker is intentionally NOT a class — it is plain JSON and
 * round-trips through ledger persistence and MCP boundary serialization
 * unchanged.
 */
export type RedactedMarker = {
    /** Discriminator — `true` literal. */
    _redacted: true;
    /**
     * The shape the original value had. Lets a renderer choose how to
     * display the marker:
     *   - `string` → `[REDACTED]`
     *   - `number` → `[REDACTED]` (UI may layout numerically)
     *   - `buffer` → `[REDACTED bytes]`
     *   - `object` → `{}` placeholder
     *   - `array`  → `[]` placeholder
     *   - `unknown` → fallback when the producer can't determine the kind
     */
    kind: 'string' | 'number' | 'buffer' | 'object' | 'array' | 'unknown';
    /**
     * Why the value was redacted. Lets audit log shippers count denials by
     * cause without re-running policy.
     *   - `capability_denied` — a policy explicitly denied this field.
     *   - `sensitive_field` — the field is on the allowlist's denylist
     *     (e.g. an artifact's storagePath, an entity's attributes).
     *   - `unknown_field` — the field is not in the allowlist for its
     *     type and was stripped by default. AGG-005 contract.
     *   - `cycle_detected` — value redacted to break a serialization cycle.
     */
    reason:
        | 'capability_denied'
        | 'sensitive_field'
        | 'unknown_field'
        | 'cycle_detected';
};

/**
 * Type guard for {@link RedactedMarker}. The check is structural —
 * `_redacted === true` is the load-bearing discriminator. Consumers
 * use this guard at every boundary that may carry a marker:
 *
 *   if (isRedactedMarker(node.label)) {
 *       // render '[REDACTED]' instead of crashing on string ops
 *   }
 */
export function isRedactedMarker(v: unknown): v is RedactedMarker {
    return (
        typeof v === 'object' &&
        v !== null &&
        (v as { _redacted?: unknown })._redacted === true
    );
}

/**
 * Factory for {@link RedactedMarker}. Centralizes shape creation so the
 * `_redacted: true` literal lives in exactly one place. Consumers should
 * use this factory rather than constructing markers inline — that way a
 * future addition of a `redactedAt` timestamp lands in one site.
 */
export function redactedMarker(
    kind: RedactedMarker['kind'],
    reason: RedactedMarker['reason'],
): RedactedMarker {
    return { _redacted: true, kind, reason };
}
