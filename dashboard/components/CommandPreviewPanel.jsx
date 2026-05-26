/**
 * CommandPreviewPanel — visualizes the mutation command lifecycle.
 *
 * Makes clear:
 * - Proposed commands are NOT truth
 * - Validation is separate from commit
 * - Approval is a gate
 * - Commit emits receipt
 * - Compensation does not erase history
 */

function CommandPreviewPanel({ commandState, receipts, onClose }) {
    if (!commandState) return null;

    const stages = [
        { key: 'proposed', label: 'proposed', description: 'AI or actor proposes a typed command' },
        { key: 'validated', label: 'validated', description: 'Kernel checks rules and structure' },
        { key: 'approved', label: 'approved', description: 'Operator gates the mutation' },
        { key: 'committed', label: 'committed', description: 'Kernel executes + emits receipt' },
    ];

    // Additional terminal states
    const isRejected = commandState.status === 'rejected';
    const isCompensated = commandState.status === 'compensated';

    const statusIndex = stages.findIndex((s) => s.key === commandState.status);
    const activeIndex = isRejected ? 1 : isCompensated ? 4 : statusIndex;

    const stageColor = (idx) => {
        if (isRejected && idx >= 2) return 'text-ink-600';
        if (idx <= activeIndex) return 'text-ok';
        return 'text-ink-600';
    };

    const stageDot = (idx) => {
        if (isRejected && idx === 1) return 'bg-danger';
        if (idx <= activeIndex) return 'bg-ok';
        return 'bg-ink-700';
    };

    return (
        <div className="border border-warn-line/60 bg-warn-soft/30 rounded-md">
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-warn-line/50">
                <div className="flex items-center gap-2">
                    <span className="mono text-[10.5px] uppercase tracking-[0.12em] text-warn">command lifecycle</span>
                    <span className={`mono text-[11px] ${isRejected ? 'text-danger' : isCompensated ? 'text-ink-400' : 'text-ok'}`}>
                        {commandState.status}
                    </span>
                </div>
                {onClose && (
                    <button onClick={onClose} className="mono text-[10.5px] text-ink-500 hover:text-ink-200">close ×</button>
                )}
            </div>

            <div className="grid grid-cols-[220px,1fr]">
                {/* Lifecycle stages */}
                <div className="p-4 border-r border-ink-800">
                    <div className="mono text-[10px] uppercase tracking-[0.12em] text-ink-500 mb-3">lifecycle</div>
                    <div className="space-y-3">
                        {stages.map((stage, idx) => (
                            <div key={stage.key} className="flex items-start gap-2.5 relative">
                                {/* Connector line */}
                                {idx < stages.length - 1 && (
                                    <span className={`absolute left-[5px] top-[14px] w-px h-5 ${idx < activeIndex ? 'bg-ok/50' : 'bg-ink-800'}`}></span>
                                )}
                                <span className={`w-[11px] h-[11px] rounded-full mt-0.5 shrink-0 ${stageDot(idx)}`}></span>
                                <div>
                                    <span className={`mono text-[11px] block ${stageColor(idx)}`}>{stage.label}</span>
                                    <span className="text-[10px] text-ink-500 block">{stage.description}</span>
                                </div>
                            </div>
                        ))}
                        {isRejected && (
                            <div className="flex items-start gap-2.5">
                                <span className="w-[11px] h-[11px] rounded-full mt-0.5 shrink-0 bg-danger"></span>
                                <div>
                                    <span className="mono text-[11px] block text-danger">rejected</span>
                                    <span className="text-[10px] text-ink-500 block">Operator denied — command will not execute</span>
                                </div>
                            </div>
                        )}
                        {isCompensated && (
                            <div className="flex items-start gap-2.5">
                                <span className="w-[11px] h-[11px] rounded-full mt-0.5 shrink-0 bg-ink-400"></span>
                                <div>
                                    <span className="mono text-[11px] block text-ink-400">compensated</span>
                                    <span className="text-[10px] text-ink-500 block">Effect reversed — history preserved</span>
                                </div>
                            </div>
                        )}
                    </div>

                    {/* Key principle */}
                    <div className="mt-5 pt-3 border-t border-ink-800">
                        <div className="mono text-[10px] text-warn/80 leading-relaxed">
                            proposed ≠ truth<br />
                            validation ≠ commit<br />
                            approval = gate<br />
                            commit → receipt<br />
                            compensate ≠ delete
                        </div>
                    </div>
                </div>

                {/* Command detail */}
                <div className="p-4 space-y-3">
                    <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 mono text-[11px]">
                        <div className="flex justify-between border-b border-ink-850 pb-1">
                            <span className="text-ink-500">id</span>
                            <span className="text-ink-200">{commandState.id}</span>
                        </div>
                        <div className="flex justify-between border-b border-ink-850 pb-1">
                            <span className="text-ink-500">verb</span>
                            <span className="text-ink-200">{commandState.verb}</span>
                        </div>
                        <div className="flex justify-between border-b border-ink-850 pb-1">
                            <span className="text-ink-500">proposed by</span>
                            <span className="text-ink-200">{commandState.proposedBy}</span>
                        </div>
                        <div className="flex justify-between border-b border-ink-850 pb-1">
                            <span className="text-ink-500">proposed at</span>
                            <span className="text-ink-200">{commandState.proposedAt?.replace('T', ' ').slice(0, 19)}</span>
                        </div>
                        {commandState.approvedBy && (
                            <div className="flex justify-between border-b border-ink-850 pb-1">
                                <span className="text-ink-500">approved by</span>
                                <span className="text-ok">{commandState.approvedBy}</span>
                            </div>
                        )}
                        {commandState.committedAt && (
                            <div className="flex justify-between border-b border-ink-850 pb-1">
                                <span className="text-ink-500">committed</span>
                                <span className="text-ok">{commandState.committedAt?.replace('T', ' ').slice(0, 19)}</span>
                            </div>
                        )}
                        {commandState.rejectedBy && (
                            <div className="flex justify-between border-b border-ink-850 pb-1">
                                <span className="text-ink-500">rejected by</span>
                                <span className="text-danger">{commandState.rejectedBy}</span>
                            </div>
                        )}
                        {commandState.rejectionReason && (
                            <div className="col-span-2 flex justify-between border-b border-ink-850 pb-1">
                                <span className="text-ink-500">reason</span>
                                <span className="text-danger">{commandState.rejectionReason}</span>
                            </div>
                        )}
                    </div>

                    {/* Payload */}
                    <div>
                        <div className="mono text-[10px] uppercase tracking-[0.12em] text-ink-500 mb-1.5">payload</div>
                        <pre className="mono text-[11px] text-ink-200 bg-ink-900 border border-ink-800 rounded p-2.5 overflow-auto max-h-[120px]">
                            {JSON.stringify(commandState.payload, null, 2)}
                        </pre>
                    </div>

                    {/* Linked receipts */}
                    {receipts && receipts.length > 0 && (
                        <div>
                            <div className="mono text-[10px] uppercase tracking-[0.12em] text-ink-500 mb-1.5">receipts</div>
                            <div className="space-y-1">
                                {receipts.map((r) => (
                                    <div key={r.id} className="flex items-center gap-2 mono text-[10.5px] px-2 py-1.5 rounded border border-ok-line/40 bg-ok-soft/20">
                                        <span className="text-ok">{r.id}</span>
                                        <span className="text-ink-500">·</span>
                                        <span className="text-ink-300">{r.summary}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Disclaimer */}
                    <div className="pt-2 border-t border-ink-800 mono text-[10.5px] text-ink-500">
                        This panel shows command state. It does not provide a direct edit form.
                        Mutations flow through: <span className="text-warn">propose → validate → approve → commit</span>
                    </div>
                </div>
            </div>
        </div>
    );
}

window.CommandPreviewPanel = CommandPreviewPanel;
