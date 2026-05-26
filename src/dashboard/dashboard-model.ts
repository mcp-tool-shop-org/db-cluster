/**
 * Dashboard data model — the shaped contract between db-cluster internals and the UI.
 *
 * The dashboard never reads raw adapter stores. It consumes DashboardObject instances
 * built from kernel verb outputs.
 */

export type SourceType = 'owner-truth' | 'source-truth' | 'derivative' | 'append-only';
export type FreshnessStatus = 'fresh' | 'stale' | 'missing' | 'unknown';
export type CommandStatus = 'proposed' | 'validated' | 'approved' | 'committed' | 'rejected' | 'compensated';

export interface DashboardRelationship {
    uri: string;
    edge: string;
    targetStore: string;
    targetType: string;
}

export interface DashboardProvenanceNode {
    id: string;
    uri: string;
    store: string;
    label: string;
}

export interface DashboardProvenanceEdge {
    from: string;
    to: string;
    type: string;
    isWarning?: boolean;
}

export interface DashboardProvenanceGraph {
    nodes: DashboardProvenanceNode[];
    edges: DashboardProvenanceEdge[];
    warnings: Array<{ type: string; message: string; subjectUri?: string }>;
}

export interface DashboardReceipt {
    id: string;
    commandId: string;
    verb: string;
    summary: string;
    committedAt: string;
}

export interface DashboardCommandState {
    id: string;
    verb: string;
    status: CommandStatus;
    proposedBy: string;
    proposedAt: string;
    payload: Record<string, unknown>;
    validatedAt?: string;
    approvedBy?: string;
    committedAt?: string;
    rejectedBy?: string;
    rejectionReason?: string;
    compensatedAt?: string;
}

export interface DashboardPolicyDecision {
    principal: string;
    trustZone: string;
    action: string;
    allowed: boolean;
    reason: string;
    redactedFields?: string[];
}

export interface DashboardWarning {
    type: string;
    severity: 'info' | 'warn' | 'error';
    message: string;
    subjectUri?: string;
    repairSuggestion?: string;
}

export interface DashboardObject {
    uri: string;
    id: string;
    type: string;
    name: string;
    ownerStore: 'canonical' | 'artifact' | 'index' | 'ledger';
    sourceType: SourceType;
    freshness: FreshnessStatus;
    object: Record<string, unknown>;
    relationships: DashboardRelationship[];
    provenanceGraph: DashboardProvenanceGraph;
    receipts: DashboardReceipt[];
    commandState?: DashboardCommandState;
    policyDecision?: DashboardPolicyDecision;
    warnings: DashboardWarning[];
}

/** Maps owner store → source type */
export function storeToSourceType(store: string): SourceType {
    switch (store) {
        case 'canonical': return 'owner-truth';
        case 'artifact': return 'source-truth';
        case 'index': return 'derivative';
        case 'ledger': return 'append-only';
        default: return 'owner-truth';
    }
}

/** Builds a cluster URI from store + type + id */
export function buildUri(store: string, type: string, id: string): string {
    return `cluster://${store}/${type}/${id}`;
}
