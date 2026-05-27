/**
 * apply-redaction — shared redaction logic for the dashboard UI.
 *
 * Extracted from dashboard/components/PolicyViewToggle.jsx (TESTS-004) so
 * tests and the UI exercise the SAME function, not divergent mirrors.
 *
 * SECURITY NOTE: this is a view-layer cosmetic filter — NOT a security
 * enforcement layer. Source truth is never mutated. The kernel /
 * PolicyEnforcedKernel does the actual policy work; this function only
 * shapes what the dashboard chooses to render to a given operator view.
 *
 * Returns a deep copy with redacted paths replaced:
 *   - full-object redaction (store not in `policyView.visible`, or
 *     `policyView.redacted` includes `<store>.*`) → `object` is set to
 *     `{ _redacted: true }`. Using an object marker (not a string)
 *     lets consumers structurally distinguish "redacted" from a literal
 *     `"[REDACTED]"` string value.
 *   - field-level redaction (`<store>.<path>`) → the named field is
 *     replaced with the string `"[REDACTED]"`.
 *
 * The source object passed in is never mutated.
 *
 * @template {import('../../dist/dashboard/dashboard-model.js').DashboardObject} T
 * @param {T} dashObj
 * @param {{
 *   principal: string,
 *   trustZone: string,
 *   visible: string[],
 *   redacted: string[],
 * }} policyView
 * @returns {T}
 */
export function applyRedaction(dashObj, policyView) {
    if (!dashObj || !policyView) return dashObj;

    const copy = /** @type {T} */ (JSON.parse(JSON.stringify(dashObj)));
    const visible = new Set(policyView.visible);

    // If the object's owner store isn't visible, redact everything.
    if (!visible.has(copy.ownerStore)) {
        copy.object = /** @type {Record<string, unknown>} */ ({ _redacted: true });
        copy.provenanceGraph = {
            nodes: [],
            edges: [],
            warnings: [{ type: 'redacted', message: 'store not visible to this principal' }],
        };
        copy.receipts = [];
        copy.warnings = [
            ...(copy.warnings || []),
            { type: 'redacted', severity: 'info', message: 'full object redacted for this view' },
        ];
        return copy;
    }

    // Apply field-level redaction.
    for (const field of policyView.redacted || []) {
        const [store, path] = field.split('.');
        if (
            store === copy.ownerStore
            || (store === 'artifact' && copy.type === 'artifact')
        ) {
            if (path === '*') {
                copy.object = /** @type {Record<string, unknown>} */ ({ _redacted: true });
            } else if (copy.object && typeof copy.object === 'object' && path in copy.object) {
                /** @type {Record<string, unknown>} */ (copy.object)[path] = '[REDACTED]';
            }
        }
    }

    return copy;
}
