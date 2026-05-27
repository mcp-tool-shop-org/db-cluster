/**
 * StateBoundary — Wave C1-Amend §2d ComponentState + StateBoundary contract.
 *
 * Closes SURFACE-C-017 / SURFACE-C-018 / SURFACE-C-019 / SURFACE-C-020 by
 * giving every dashboard component a uniform way to render one of five
 * lifecycle states:
 *
 *   loading  — data is being fetched / panel is mounting
 *   empty    — request succeeded, no data exists (with a reason + hint)
 *   error    — request failed (with a remediation_hint and optional retry)
 *   redacted — data exists but is hidden by policy (count + reason)
 *   ready    — data is available; render via children
 *
 * Pre-C1-Amend each panel returned `null` on null/undefined data
 * (SURFACE-C-017). Operators couldn't distinguish "loading" from "broken"
 * from "healthy-empty". The StateBoundary makes those states explicit and
 * surfaces the actionability hint (`remediationHint` / `→ try:`) inline,
 * mirroring the CLI/MCP error-envelope discipline.
 *
 * The contract:
 *   <StateBoundary state={state}>
 *     {(data) => <YourPanel data={data} />}
 *   </StateBoundary>
 *
 * Children may be a render-prop function (called with `state.data` when
 * ready) OR a plain element (rendered as-is on ready). The render-prop
 * form is preferred for type clarity.
 *
 * This file ships as plain JSX (no `import` — the dashboard uses
 * React+Babel UMD; the script-tag in index.html exposes the component as
 * `window.StateBoundary`).
 */

function StateBoundary({ state, children }) {
    if (!state || typeof state !== 'object' || typeof state.kind !== 'string') {
        // Defensive: treat malformed state as a state-itself error.
        return (
            <div className="state-error mono text-[11px] text-danger p-3 border border-danger-line bg-danger-soft/40 rounded">
                <p>StateBoundary received malformed state.</p>
                <p className="text-ink-500 mt-1">Expected {`{ kind: 'loading' | 'empty' | 'error' | 'redacted' | 'ready', ... }`}</p>
            </div>
        );
    }

    switch (state.kind) {
        case 'loading':
            return (
                <div
                    role="status"
                    aria-live="polite"
                    className="state-loading mono text-[11px] text-ink-400 p-3 border border-ink-800 bg-ink-900/30 rounded animate-pulse"
                >
                    {state.label || 'Loading...'}
                </div>
            );

        case 'empty': {
            const reason = state.reason || 'no_data';
            const reasonText =
                reason === 'no_data' ? 'No data yet.' :
                reason === 'no_match' ? 'No matching results.' :
                // Wave C1-Amend fix-up (Cluster C — V1-C1-003 + V3-C1-002):
                // canonical value is 'all_filtered_by_policy', matching
                // the kernel-side producer + EmptyResultMeta. The legacy
                // 'all_filtered' branch is kept for transitional safety
                // in case any consumer still emits the old value.
                reason === 'all_filtered_by_policy' ? 'All results were filtered by policy.' :
                reason === 'all_filtered' ? 'All results were filtered by policy.' :
                'No data.';
            return (
                <div
                    role="status"
                    className="state-empty mono text-[11px] text-ink-400 p-3 border border-ink-800 bg-ink-900/30 rounded"
                >
                    <p>{reasonText}</p>
                    {state.remediationHint && (
                        <p className="text-ink-500 text-[10.5px] mt-1.5 hint">→ try: {state.remediationHint}</p>
                    )}
                </div>
            );
        }

        case 'error': {
            const err = state.error || {};
            return (
                <div
                    role="alert"
                    className="state-error mono text-[11px] text-danger p-3 border border-danger-line bg-danger-soft/40 rounded"
                >
                    <p>{err.message || 'An error occurred.'}</p>
                    {err.remediation_hint && (
                        <p className="text-ink-400 text-[10.5px] mt-1.5">→ try: {err.remediation_hint}</p>
                    )}
                    {state.retryAction && (
                        <button
                            type="button"
                            onClick={state.retryAction}
                            className="mono text-[10.5px] px-2 py-1 mt-2 rounded border border-warn-line text-warn hover:bg-warn-soft/40"
                        >
                            Retry
                        </button>
                    )}
                </div>
            );
        }

        case 'redacted': {
            const count = Array.isArray(state.markers) ? state.markers.length : 0;
            const reason = state.reason || 'capability_denied';
            return (
                <div
                    className="state-redacted mono text-[11px] text-ink-500 p-3 border border-ink-800 bg-ink-900/30 rounded"
                    aria-label={`${count} fields redacted: ${reason}`}
                >
                    {count} field{count === 1 ? '' : 's'} hidden ({reason.replace(/_/g, ' ')})
                </div>
            );
        }

        case 'ready': {
            const data = state.data;
            if (typeof children === 'function') {
                return children(data);
            }
            return children || null;
        }

        default:
            return (
                <div className="state-error mono text-[11px] text-danger p-3 border border-danger-line bg-danger-soft/40 rounded">
                    StateBoundary: unknown state.kind = {String(state.kind)}
                </div>
            );
    }
}

/**
 * Factory helpers — keep state construction localized so consumers don't
 * have to repeat the discriminator + field names.
 */
const ComponentState = {
    loading: (label) => ({ kind: 'loading', label }),
    empty: (reason, remediationHint) => ({ kind: 'empty', reason, remediationHint }),
    error: (error, retryAction) => ({ kind: 'error', error, retryAction }),
    redacted: (markers, reason) => ({ kind: 'redacted', markers: markers || [], reason }),
    ready: (data) => ({ kind: 'ready', data }),
};

// Expose to the global (the dashboard loads via Babel UMD — `import` is
// not available at runtime here; siblings read these off window).
if (typeof window !== 'undefined') {
    window.StateBoundary = StateBoundary;
    window.ComponentState = ComponentState;
}
