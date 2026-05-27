/**
 * OperationsPanel — cluster health and integrity at a glance.
 *
 * Not a full dashboard. Just cluster integrity.
 * Actions are command suggestions, not silent mutations.
 */

function OperationsPanel({ opsData, onClose }) {
    if (!opsData) return null;

    const overallColor = {
        healthy: 'text-ok',
        degraded: 'text-warn',
        unhealthy: 'text-danger',
        unknown: 'text-ink-400',
    };

    // AGG-B1-5: reads the actual OpsModel shape — `opsData.overall` (top-
    // level, not nested under a doctor field), `opsData.stores` (the array
    // of per-store health), and `provenanceHealth.totalReceipts` /
    // `.totalEvents` (not `.receipts` / `.events`). The pre-fix references
    // read fields that don't exist on the OpsModel interface declared in
    // `src/dashboard/ops-model.ts`, so the panel rendered '—' everywhere.
    return (
        <div className="border border-ledger-line/60 bg-ledger-soft/30 rounded-md">
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-ledger-line/50">
                <div className="flex items-center gap-2">
                    <span className="mono text-[10.5px] uppercase tracking-[0.12em] text-ledger">operations</span>
                    <span className={`mono text-[11px] ${overallColor[opsData.overall || 'unknown']}`}>
                        {opsData.overall || 'unknown'}
                    </span>
                </div>
                {onClose && (
                    <button onClick={onClose} className="mono text-[10.5px] text-ink-500 hover:text-ink-200">close ×</button>
                )}
            </div>

            <div className="p-4 grid grid-cols-2 gap-4">
                {/* Store health */}
                <div>
                    <div className="mono text-[10px] uppercase tracking-[0.12em] text-ink-500 mb-2">store health</div>
                    <div className="space-y-1.5">
                        {(opsData.stores || []).map((check) => (
                            <div key={check.store} className="flex items-center gap-2 mono text-[11px]">
                                <span className={`w-1.5 h-1.5 rounded-full ${check.status === 'healthy' ? 'bg-ok' : 'bg-danger'}`}></span>
                                <span className="text-ink-300">{check.store}</span>
                                <span className="text-ink-500 ml-auto">{check.status}</span>
                            </div>
                        ))}
                    </div>
                </div>

                {/* Index health */}
                <div>
                    <div className="mono text-[10px] uppercase tracking-[0.12em] text-ink-500 mb-2">index health</div>
                    <div className="space-y-1.5 mono text-[11px]">
                        <div className="flex justify-between">
                            <span className="text-ink-400">total records</span>
                            <span className="text-ink-200">{opsData.indexHealth?.total ?? '—'}</span>
                        </div>
                        <div className="flex justify-between">
                            <span className="text-ok">fresh</span>
                            <span className="text-ink-200">{opsData.indexHealth?.fresh ?? '—'}</span>
                        </div>
                        <div className="flex justify-between">
                            <span className="text-warn">stale</span>
                            <span className="text-ink-200">{opsData.indexHealth?.stale ?? 0}</span>
                        </div>
                        <div className="flex justify-between">
                            <span className="text-danger">missing</span>
                            <span className="text-ink-200">{opsData.indexHealth?.missing ?? 0}</span>
                        </div>
                    </div>
                </div>

                {/* Provenance health */}
                <div>
                    <div className="mono text-[10px] uppercase tracking-[0.12em] text-ink-500 mb-2">provenance</div>
                    <div className="space-y-1.5 mono text-[11px]">
                        <div className="flex justify-between">
                            <span className="text-ink-400">receipts</span>
                            <span className="text-ink-200">{opsData.provenanceHealth?.totalReceipts ?? '—'}</span>
                        </div>
                        <div className="flex justify-between">
                            <span className="text-ink-400">events</span>
                            <span className="text-ink-200">{opsData.provenanceHealth?.totalEvents ?? '—'}</span>
                        </div>
                        {/*
                          SURFACE-B-011 (Wave B1-Amend): render the
                          mutation_orphaned count. Wave A3 wired the
                          orphan-event family into verify()/doctor() but
                          the dashboard view-layer was blind. The row
                          colors warn when > 0 to signal investigation
                          is needed.
                        */}
                        <div className="flex justify-between">
                            <span className={
                                opsData.provenanceHealth?.orphanEvents === null
                                    ? "text-warn"
                                    : (opsData.provenanceHealth?.orphanEvents ?? 0) > 0
                                        ? "text-warn"
                                        : "text-ink-400"
                            }>
                                orphaned
                            </span>
                            <span className="text-ink-200">
                                {/* V1-B1-007: render '?' when null (count
                                  unavailable — runtime error in countEvents).
                                  Distinguishes degraded ("we don't know")
                                  from healthy ("we know there are zero"). */}
                                {opsData.provenanceHealth?.orphanEvents === null
                                    ? '?'
                                    : (opsData.provenanceHealth?.orphanEvents ?? 0)}
                            </span>
                        </div>
                        {opsData.provenanceHealth?.degradedReason && (
                            <div className="text-warn text-[10.5px] leading-tight pt-1">
                                {opsData.provenanceHealth.degradedReason}
                            </div>
                        )}
                        {(opsData.provenanceHealth?.orphanEvents ?? 0) > 0 && !opsData.provenanceHealth?.degradedReason && (
                            <div className="text-warn text-[10.5px] leading-tight pt-1">
                                Investigate <code>mutation_orphaned</code> events — receipt write failed; entity state may be out of sync with ledger.
                            </div>
                        )}
                    </div>
                </div>

                {/* Artifact integrity */}
                <div>
                    <div className="mono text-[10px] uppercase tracking-[0.12em] text-ink-500 mb-2">artifact integrity</div>
                    <div className="space-y-1.5 mono text-[11px]">
                        <div className="flex justify-between">
                            <span className="text-ink-400">total</span>
                            <span className="text-ink-200">{opsData.artifactIntegrity?.total ?? '—'}</span>
                        </div>
                        <div className="flex justify-between">
                            <span className="text-ok">verified</span>
                            <span className="text-ink-200">{opsData.artifactIntegrity?.verified ?? '—'}</span>
                        </div>
                        <div className="flex justify-between">
                            <span className="text-danger">corrupt</span>
                            <span className="text-ink-200">{opsData.artifactIntegrity?.corrupt ?? 0}</span>
                        </div>
                    </div>
                </div>
            </div>

            {/* Repair suggestions */}
            <div className="px-4 pb-4">
                <div className="mono text-[10px] uppercase tracking-[0.12em] text-ink-500 mb-2">suggested actions</div>
                <div className="space-y-2">
                    <SuggestedAction command="db-cluster reindex" description="Rebuild index from owner stores" />
                    <SuggestedAction command="db-cluster doctor" description="Run full cluster health check" />
                    <SuggestedAction command="db-cluster verify" description="Verify data consistency" />
                    <SuggestedAction command="db-cluster backup" description="Create cluster backup" />
                </div>
            </div>
        </div>
    );
}

function SuggestedAction({ command, description }) {
    return (
        <div className="flex items-center gap-3 px-2.5 py-2 rounded border border-ink-850 bg-ink-900/50">
            <span className="mono text-[11px] text-ledger">{command}</span>
            <span className="mono text-[10.5px] text-ink-500">{description}</span>
        </div>
    );
}

window.OperationsPanel = OperationsPanel;
