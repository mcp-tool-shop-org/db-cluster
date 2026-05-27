/**
 * PolicyViewToggle — switch dashboard perspective by role.
 *
 * Shows what's visible vs. redacted vs. hidden for each principal.
 * Redaction never mutates source truth — it's a view-layer filter only.
 */

function PolicyViewToggle({ currentView, views, onViewChange, children }) {
    const viewKeys = Object.keys(views || {});
    if (viewKeys.length === 0) return children || null;

    const active = views[currentView] || views[viewKeys[0]];
    const activeKey = currentView || viewKeys[0];

    const trustBadge = {
        internal: { label: 'internal', color: 'text-ok' },
        'external-read': { label: 'ext-read', color: 'text-warn' },
        external: { label: 'external', color: 'text-danger' },
    };

    const badge = trustBadge[active.trustZone] || { label: active.trustZone, color: 'text-ink-400' };

    return (
        <div className="space-y-3">
            {/* Toggle bar */}
            <div className="flex items-center gap-1 px-3 py-2 bg-ink-900 border border-ink-800 rounded-md">
                <span className="mono text-[10px] uppercase tracking-[0.12em] text-ink-500 mr-2">view as</span>
                {viewKeys.map((key) => (
                    <button
                        key={key}
                        onClick={() => onViewChange && onViewChange(key)}
                        className={`mono text-[11px] px-2 py-1 rounded transition-colors ${key === activeKey
                                ? 'bg-ink-700 text-ink-100'
                                : 'text-ink-500 hover:text-ink-300 hover:bg-ink-800'
                            }`}
                    >
                        {key}
                    </button>
                ))}
                <span className="ml-auto flex items-center gap-1.5">
                    <span className={`mono text-[10px] ${badge.color}`}>{badge.label}</span>
                    <span className="mono text-[10px] text-ink-600">·</span>
                    <span className="mono text-[10px] text-ink-500">{active.principal}</span>
                </span>
            </div>

            {/* Visibility matrix */}
            <div className="grid grid-cols-2 gap-3">
                <div className="border border-ok-line/40 bg-ok-soft/10 rounded px-3 py-2">
                    <div className="mono text-[10px] uppercase tracking-[0.12em] text-ok mb-1.5">visible stores</div>
                    <div className="space-y-1">
                        {active.visible.map((store) => (
                            <div key={store} className="mono text-[11px] text-ink-200">{store}</div>
                        ))}
                    </div>
                </div>
                <div className="border border-danger-line/40 bg-danger-soft/10 rounded px-3 py-2">
                    <div className="mono text-[10px] uppercase tracking-[0.12em] text-danger mb-1.5">redacted fields</div>
                    <div className="space-y-1">
                        {active.redacted.length === 0 ? (
                            <div className="mono text-[11px] text-ink-500">none</div>
                        ) : (
                            active.redacted.map((field) => (
                                <div key={field} className="mono text-[11px] text-ink-300">{field}</div>
                            ))
                        )}
                    </div>
                </div>
            </div>

            {/* Redaction notice */}
            <div className="mono text-[10px] text-ink-500 px-1">
                Redaction is a view-layer filter. Source truth is never mutated by policy mode changes.
            </div>

            {/* Children rendered under current policy */}
            {children}
        </div>
    );
}

/**
 * `applyRedaction` is no longer inlined here (SURFACE-R010 fix).
 *
 * The canonical implementation lives at `dashboard/lib/apply-redaction.js`
 * and is loaded by `dashboard/index.html` via a `<script type="module">`
 * tag that assigns the export to `window.applyRedaction`. The dashboard
 * UI and `test/dashboard-policy-view.test.ts` now exercise byte-identical
 * logic — TESTS-004's "security boundary tests its own mirror" risk is
 * closed.
 *
 * Note on the lib's contract: full-object redaction yields
 * `{ _redacted: true }` (a structural object marker), NOT the string
 * `'[REDACTED]'`. Field-level redaction yields the literal string
 * `'[REDACTED]'`. Renderers that need to display a placeholder must
 * detect `obj._redacted === true` at the view layer and emit their own
 * string (typically `'[REDACTED]'`) for the human-readable surface.
 */

/**
 * Render-time adapter for the redacted-marker contract.
 *
 * Wave C1-Amend §2d (SURFACE-C-019): the contract documented above was
 * never actually wired at consumer panels — `{_redacted: true}` markers
 * would JSON.stringify to literal `{"_redacted":true}` text. This helper
 * walks an arbitrary object and replaces any redacted-marker objects
 * (detected via `_redacted === true`) with the string `'[REDACTED]'`.
 * Field-level `'[REDACTED]'` strings already pass through unchanged.
 *
 * Pre-fix: `<pre>{JSON.stringify(obj, null, 2)}</pre>` would render the
 * literal marker. Post-fix: consumer panels call
 * `window.renderRedactionMarkers(obj)` before passing to JSON.stringify,
 * and operators see `[REDACTED]` everywhere a value was withheld.
 *
 * The contract test in test/wave-c1-surface-regression.test.ts asserts
 * the conversion. Sibling consumer panels (OperationsPanel,
 * CommandPreviewPanel, ClusterTruthInspector payload preview) call
 * through this helper when rendering policy-filtered data.
 *
 * @param {*} value — the object to walk
 * @returns {*} A structurally-identical clone with markers replaced.
 */
function renderRedactionMarkers(value) {
    if (value === null || value === undefined) return value;
    if (typeof value !== 'object') return value;
    // Marker detection — the load-bearing discriminator from
    // src/types/redaction.ts is `_redacted === true`.
    if (value._redacted === true) return '[REDACTED]';
    if (Array.isArray(value)) return value.map(renderRedactionMarkers);
    const out = {};
    for (const key of Object.keys(value)) {
        out[key] = renderRedactionMarkers(value[key]);
    }
    return out;
}

if (typeof window !== 'undefined') {
    window.PolicyViewToggle = PolicyViewToggle;
    window.renderRedactionMarkers = renderRedactionMarkers;
}
