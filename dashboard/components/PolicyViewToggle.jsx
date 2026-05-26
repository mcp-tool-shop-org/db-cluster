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
 * applyRedaction — filter DashboardObject fields for the given policy view.
 * Returns a copy with redacted paths replaced by '[REDACTED]'.
 * Source truth is never modified.
 */
function applyRedaction(dashObj, policyView) {
    if (!dashObj || !policyView) return dashObj;

    const copy = JSON.parse(JSON.stringify(dashObj));
    const visible = new Set(policyView.visible);

    // If the object's store isn't visible, redact everything
    if (!visible.has(copy.ownerStore)) {
        copy.object = '[REDACTED]';
        copy.provenanceGraph = { nodes: [], edges: [], warnings: ['store not visible to this principal'] };
        copy.receipts = [];
        copy.warnings = [...copy.warnings, 'full object redacted for this view'];
        return copy;
    }

    // Apply field-level redaction
    for (const field of policyView.redacted) {
        const [store, path] = field.split('.');
        if (store === copy.ownerStore || (store === 'artifact' && copy.type === 'artifact')) {
            if (path === '*') {
                copy.object = '[REDACTED]';
            } else if (copy.object && typeof copy.object === 'object') {
                if (path in copy.object) {
                    copy.object[path] = '[REDACTED]';
                }
            }
        }
    }

    return copy;
}

window.PolicyViewToggle = PolicyViewToggle;
window.applyRedaction = applyRedaction;
