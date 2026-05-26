/**
 * Inspector data — maps kernel verbs to DashboardObject instances.
 *
 * The dashboard consumes cluster data ONLY through this module.
 * No raw adapter access.
 */

import type { ClusterKernel } from '../kernel/cluster-kernel.js';
import type { Entity } from '../types/entity.js';
import type { Artifact } from '../types/artifact.js';
import type { Command } from '../types/command.js';
import type {
    DashboardObject,
    DashboardRelationship,
    DashboardProvenanceGraph,
    DashboardReceipt,
    DashboardCommandState,
    DashboardWarning,
    FreshnessStatus,
} from './dashboard-model.js';
import { storeToSourceType, buildUri } from './dashboard-model.js';

/**
 * Inspect a canonical entity and build a full DashboardObject.
 */
export async function inspectEntity(kernel: ClusterKernel, entityId: string): Promise<DashboardObject> {
    const entity = await kernel.inspectEntity(entityId);
    const uri = buildUri('canonical', 'entity', entity.id);

    // Provenance
    const graph = await kernel.traceObject(uri, { direction: 'backward' });
    const provenanceGraph = mapProvenanceGraph(graph);

    // Receipts
    const receipts = await kernel.listReceipts({ limit: 50 });
    const entityReceipts = receipts.filter(
        (r) => r.affectedIds?.includes(entity.id),
    );

    // Freshness — check if index records for this entity are stale
    const freshness = await getEntityFreshness(kernel, entity);

    // Relationships: find index records that project this entity
    const relationships = await getEntityRelationships(kernel, entity);

    // Warnings
    const warnings = await getEntityWarnings(kernel, entity);

    return {
        uri,
        id: entity.id,
        type: 'entity',
        name: entity.name,
        ownerStore: 'canonical',
        sourceType: 'owner-truth',
        freshness,
        object: entityToPlain(entity),
        relationships,
        provenanceGraph,
        receipts: entityReceipts.map(mapReceipt),
        warnings,
    };
}

/**
 * Inspect an artifact and build a full DashboardObject.
 */
export async function inspectArtifact(kernel: ClusterKernel, artifactId: string): Promise<DashboardObject> {
    const artifacts = await kernel.findSources({ query: artifactId });
    // Fall back to direct inspection if available
    const uri = buildUri('artifact', 'source', artifactId);

    const graph = await kernel.traceObject(uri, { direction: 'backward' });
    const provenanceGraph = mapProvenanceGraph(graph);

    const receipts = await kernel.listReceipts({ limit: 50 });
    const artifactReceipts = receipts.filter(
        (r) => r.affectedIds?.includes(artifactId),
    );

    // Find the artifact metadata from resolved results
    const artifactObj = artifacts.resolvedArtifacts?.find((a) => a.id === artifactId);

    return {
        uri,
        id: artifactId,
        type: 'artifact',
        name: artifactObj?.filename ?? artifactId,
        ownerStore: 'artifact',
        sourceType: 'source-truth',
        freshness: 'fresh',
        object: artifactObj ? artifactToPlain(artifactObj) : { id: artifactId },
        relationships: [],
        provenanceGraph,
        receipts: artifactReceipts.map(mapReceipt),
        warnings: [],
    };
}

/**
 * Inspect an index record and build a full DashboardObject.
 */
export async function inspectIndexRecord(kernel: ClusterKernel, recordId: string): Promise<DashboardObject> {
    const explanation = await kernel.explainIndex(recordId);
    const uri = buildUri('index', 'record', recordId);

    const graph = await kernel.traceObject(uri, { direction: 'backward' });
    const provenanceGraph = mapProvenanceGraph(graph);

    const warnings: DashboardWarning[] = [];
    let freshness: FreshnessStatus = 'fresh';

    if (explanation.stale) {
        freshness = 'stale';
        warnings.push({
            type: 'stale_index',
            severity: 'warn',
            message: explanation.staleCause ?? 'Index record is stale',
            subjectUri: uri,
            repairSuggestion: 'Run `db-cluster reindex` to rebuild from owner stores',
        });
    }

    if (!explanation.sourceExists) {
        freshness = 'missing';
        warnings.push({
            type: 'missing_source',
            severity: 'error',
            message: 'Source truth referenced by this index record no longer exists',
            subjectUri: uri,
            repairSuggestion: 'Run `db-cluster reindex` to remove orphan records',
        });
    }

    return {
        uri,
        id: recordId,
        type: 'index_record',
        name: `index/${recordId.slice(0, 8)}`,
        ownerStore: 'index',
        sourceType: 'derivative',
        freshness,
        object: {
            id: recordId,
            sourceStore: explanation.sourceStore,
            sourceId: explanation.sourceId,
            text: explanation.text,
            stale: explanation.stale,
            sourceExists: explanation.sourceExists,
        },
        relationships: explanation.sourceId
            ? [{
                uri: buildUri(explanation.sourceStore ?? 'canonical', 'entity', explanation.sourceId),
                edge: 'projects',
                targetStore: explanation.sourceStore ?? 'canonical',
                targetType: 'entity',
            }]
            : [],
        provenanceGraph,
        receipts: [],
        warnings,
    };
}

/**
 * Inspect a command and build a DashboardObject with command state.
 */
export async function inspectCommandObject(kernel: ClusterKernel, commandId: string): Promise<DashboardObject> {
    const command = await kernel.inspectCommand(commandId);
    const uri = buildUri('ledger', 'command', command.id);

    const receipts = await kernel.listReceipts({ commandId: command.id });

    return {
        uri,
        id: command.id,
        type: 'command',
        name: `${command.verb} (${command.status})`,
        ownerStore: 'ledger',
        sourceType: 'append-only',
        freshness: 'fresh',
        object: commandToPlain(command),
        relationships: [],
        provenanceGraph: { nodes: [], edges: [], warnings: [] },
        receipts: receipts.map(mapReceipt),
        commandState: mapCommandState(command),
        warnings: command.status === 'rejected'
            ? [{ type: 'rejected_command', severity: 'warn', message: command.rejectionReason ?? 'Command was rejected' }]
            : [],
    };
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function mapProvenanceGraph(graph: any): DashboardProvenanceGraph {
    return {
        nodes: (graph.nodes ?? []).map((n: any) => ({
            id: n.id ?? n.uri,
            uri: n.uri,
            store: n.store ?? 'unknown',
            label: n.label ?? n.uri?.split('/').pop() ?? 'unknown',
        })),
        edges: (graph.edges ?? []).map((e: any) => ({
            from: e.from ?? e.source,
            to: e.to ?? e.target,
            type: e.type ?? e.label ?? 'related',
            isWarning: e.isWarning ?? false,
        })),
        warnings: (graph.warnings ?? []).map((w: any) => ({
            type: w.type ?? 'unknown',
            message: w.message ?? '',
            subjectUri: w.subjectUri,
        })),
    };
}

function mapReceipt(r: any): DashboardReceipt {
    return {
        id: r.id,
        commandId: r.commandId ?? '',
        verb: r.verb ?? r.action ?? '',
        summary: r.summary ?? r.detail ?? '',
        committedAt: r.committedAt ?? r.timestamp ?? '',
    };
}

function mapCommandState(cmd: Command): DashboardCommandState {
    return {
        id: cmd.id,
        verb: cmd.verb,
        status: cmd.status,
        proposedBy: cmd.proposedBy,
        proposedAt: cmd.proposedAt,
        payload: cmd.payload,
        validatedAt: cmd.validation?.validatedAt,
        approvedBy: cmd.approvedBy,
        committedAt: cmd.committedAt,
        rejectedBy: cmd.rejectedBy,
        rejectionReason: cmd.rejectionReason,
        compensatedAt: cmd.compensatedAt,
    };
}

function entityToPlain(e: Entity): Record<string, unknown> {
    return {
        id: e.id,
        kind: e.kind,
        name: e.name,
        attributes: e.attributes,
        createdAt: e.createdAt,
        updatedAt: e.updatedAt,
    };
}

function artifactToPlain(a: Artifact): Record<string, unknown> {
    return {
        id: a.id,
        filename: a.filename,
        contentHash: a.contentHash,
        mimeType: a.mimeType,
        sizeBytes: a.sizeBytes,
        version: a.version,
        ingestedAt: a.ingestedAt,
    };
}

function commandToPlain(c: Command): Record<string, unknown> {
    return {
        id: c.id,
        verb: c.verb,
        targetStore: c.targetStore,
        payload: c.payload,
        status: c.status,
        proposedBy: c.proposedBy,
        proposedAt: c.proposedAt,
        committedAt: c.committedAt,
        rejectedBy: c.rejectedBy,
        rejectionReason: c.rejectionReason,
    };
}

async function getEntityFreshness(kernel: ClusterKernel, entity: Entity): Promise<FreshnessStatus> {
    try {
        const stale = await kernel.listStaleRecords();
        const isStale = stale.some((r) => r.sourceId === entity.id);
        return isStale ? 'stale' : 'fresh';
    } catch {
        return 'unknown';
    }
}

async function getEntityRelationships(kernel: ClusterKernel, entity: Entity): Promise<DashboardRelationship[]> {
    const relationships: DashboardRelationship[] = [];
    try {
        const bundle = await kernel.retrieveBundle(entity.name, { limit: 10 });
        for (const resolved of bundle.resolvedEntities ?? []) {
            if (resolved.object?.id !== entity.id && resolved.object?.id) {
                relationships.push({
                    uri: buildUri('canonical', 'entity', resolved.object.id),
                    edge: 'related',
                    targetStore: 'canonical',
                    targetType: 'entity',
                });
            }
        }
        for (const artifact of bundle.resolvedArtifacts ?? []) {
            if (artifact.object?.id) {
                relationships.push({
                    uri: buildUri('artifact', 'source', artifact.object.id),
                    edge: 'evidence',
                    targetStore: 'artifact',
                    targetType: 'artifact',
                });
            }
        }
    } catch {
        // Bundle retrieval may fail for entities with non-searchable names
    }
    return relationships;
}

async function getEntityWarnings(kernel: ClusterKernel, entity: Entity): Promise<DashboardWarning[]> {
    const warnings: DashboardWarning[] = [];
    try {
        const stale = await kernel.listStaleRecords();
        for (const record of stale) {
            if (record.sourceId === entity.id) {
                warnings.push({
                    type: 'stale_index',
                    severity: 'warn',
                    message: record.cause ?? 'Index record is stale',
                    subjectUri: buildUri('index', 'record', record.indexRecordId),
                    repairSuggestion: 'Run `db-cluster reindex`',
                });
            }
        }
    } catch {
        // Non-fatal
    }
    return warnings;
}
