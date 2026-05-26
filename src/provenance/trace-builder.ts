import type { ClusterStores } from '../contracts/index.js';
import type { Entity } from '../types/entity.js';
import type { Artifact } from '../types/artifact.js';
import type { IndexRecord } from '../types/index-record.js';
import type { ProvenanceEvent } from '../types/provenance-event.js';
import type { Receipt } from '../types/receipt.js';
import type {
    ProvenanceGraph,
    ProvenanceNode,
    ProvenanceEdge,
    TraceOptions,
    TraceGap,
    TraceWarning,
    TraceSummary,
    NodeType,
    EdgeType,
} from '../types/provenance-graph.js';
import { parseClusterUri, formatClusterUri, type ClusterUri } from '../uri/cluster-uri.js';

const DEFAULT_OPTIONS: TraceOptions = {
    direction: 'backward',
    depth: 10,
    includeIndex: true,
    includeReceipts: true,
    includeCommands: true,
    includeGaps: true,
};

/**
 * TraceBuilder — builds cross-store provenance graphs from any cluster URI.
 *
 * Not just ledger parent chains. Crosses all four stores + receipts.
 * Surfaces gaps, warnings, stale projections honestly.
 */
export class TraceBuilder {
    private nodes = new Map<string, ProvenanceNode>();
    private edges: ProvenanceEdge[] = [];
    private gaps: TraceGap[] = [];
    private warnings: TraceWarning[] = [];
    private visited = new Set<string>();
    private options: TraceOptions;
    private focalUri: string;

    constructor(
        private readonly stores: ClusterStores,
        focalUri: string,
        options?: Partial<TraceOptions>,
    ) {
        this.focalUri = focalUri;
        this.options = { ...DEFAULT_OPTIONS, ...options };
    }

    async build(): Promise<ProvenanceGraph> {
        const parsed = parseClusterUri(this.focalUri);
        await this.traceFrom(parsed, 0);

        const nodesArr = [...this.nodes.values()];
        const summary = this.buildSummary(nodesArr);

        return {
            focalUri: this.focalUri,
            direction: this.options.direction,
            nodes: nodesArr,
            edges: this.edges,
            gaps: this.gaps,
            warnings: this.warnings,
            summary,
            assembledAt: new Date().toISOString(),
        };
    }

    private async traceFrom(parsed: ClusterUri, depth: number): Promise<void> {
        if (depth >= (this.options.depth ?? 10)) return;
        const uri = formatClusterUri(parsed.store, parsed.id);
        if (this.visited.has(uri)) return;
        this.visited.add(uri);

        switch (parsed.store) {
            case 'canonical':
                await this.traceEntity(parsed.id, uri, depth);
                break;
            case 'artifact':
                await this.traceArtifact(parsed.id, uri, depth);
                break;
            case 'index':
                await this.traceIndexRecord(parsed.id, uri, depth);
                break;
            case 'ledger':
                await this.traceEvent(parsed.id, uri, depth);
                break;
            case 'receipt':
                await this.traceReceipt(parsed.id, uri, depth);
                break;
        }
    }

    private async traceEntity(id: string, uri: string, depth: number): Promise<void> {
        const entity = await this.stores.canonical.get(id);
        if (!entity) {
            this.addGapNode(uri, 'entity', 'canonical', `Entity ${id} not found`);
            return;
        }

        this.addNode(uri, 'entity', 'canonical', true, `${entity.kind}: ${entity.name}`, {
            kind: entity.kind,
            name: entity.name,
            createdAt: entity.createdAt,
        });

        // Backward: find provenance events for this entity
        if (this.options.direction !== 'forward') {
            const events = await this.stores.ledger.listEvents({ subjectId: id });
            for (const event of events) {
                const eventUri = formatClusterUri('ledger', event.id);
                this.addNode(eventUri, 'provenance_event', 'ledger', true, `${event.action} by ${event.actorId}`, {
                    action: event.action,
                    actorId: event.actorId,
                    timestamp: event.timestamp,
                });

                const edgeType = this.eventToEdgeType(event.action);
                this.addEdge(eventUri, uri, edgeType, `${event.action} at ${event.timestamp}`, event.id, event.timestamp);

                // If evidence_linked, trace the artifact
                if (event.action === 'evidence_linked' && event.detail?.artifactId) {
                    const artUri = formatClusterUri('artifact', event.detail.artifactId as string);
                    this.addEdge(artUri, uri, 'evidence_linked_to', 'Evidence link', event.id, event.timestamp);
                    await this.traceFrom(parseClusterUri(artUri), depth + 1);
                }
            }

            // If no events found, report missing provenance
            if (events.length === 0 && this.options.includeGaps) {
                this.gaps.push({
                    description: `Entity ${id} has no provenance trail`,
                    expectedUri: uri,
                    store: 'ledger',
                    impact: 'medium',
                });
                this.warnings.push({
                    type: 'missing_provenance',
                    subjectUri: uri,
                    message: `Entity ${entity.kind}/${entity.name} exists without supporting provenance`,
                });
            }
        }

        // Forward: find index records and dependent links
        if (this.options.direction !== 'backward') {
            if (this.options.includeIndex) {
                await this.traceForwardIndex(id, uri, depth);
            }
        }

        // Receipts
        if (this.options.includeReceipts) {
            await this.traceRelatedReceipts(id, uri, depth);
        }
    }

    private async traceArtifact(id: string, uri: string, depth: number): Promise<void> {
        const artifact = await this.stores.artifact.get(id);
        if (!artifact) {
            this.addGapNode(uri, 'artifact', 'artifact', `Artifact ${id} not found`);
            return;
        }

        this.addNode(uri, 'artifact', 'artifact', true, `${artifact.filename} v${artifact.version}`, {
            filename: artifact.filename,
            version: artifact.version,
            mimeType: artifact.mimeType,
            ingestedAt: artifact.ingestedAt,
        });

        // Backward: find ingestion event
        if (this.options.direction !== 'forward') {
            const events = await this.stores.ledger.listEvents({ subjectId: id });
            for (const event of events) {
                const eventUri = formatClusterUri('ledger', event.id);
                this.addNode(eventUri, 'provenance_event', 'ledger', true, `${event.action} by ${event.actorId}`, {
                    action: event.action,
                    actorId: event.actorId,
                    timestamp: event.timestamp,
                });
                this.addEdge(eventUri, uri, 'artifact_ingested_from', `${event.action}`, event.id, event.timestamp);
            }

            if (events.length === 0 && this.options.includeGaps) {
                this.gaps.push({
                    description: `Artifact ${id} has no provenance trail`,
                    expectedUri: uri,
                    store: 'ledger',
                    impact: 'medium',
                });
                this.warnings.push({
                    type: 'missing_provenance',
                    subjectUri: uri,
                    message: `Artifact ${artifact.filename} exists without supporting provenance`,
                });
            }
        }

        // Forward: find entities this artifact is linked to
        if (this.options.direction !== 'backward') {
            const events = await this.stores.ledger.listEvents({ subjectId: id });
            // Also look for events where this artifact is in detail
            const allEvents = await this.stores.ledger.listEvents();
            const linkedEvents = allEvents.filter(
                (e) => e.action === 'evidence_linked' && (e.detail?.artifactId === id),
            );
            for (const event of linkedEvents) {
                const entityId = event.subjectId;
                const entityUri = formatClusterUri('canonical', entityId);
                this.addEdge(uri, entityUri, 'evidence_linked_to', 'Evidence link (forward)', event.id, event.timestamp);
                await this.traceFrom(parseClusterUri(entityUri), depth + 1);
            }

            if (this.options.includeIndex) {
                await this.traceForwardIndex(id, uri, depth);
            }
        }
    }

    private async traceIndexRecord(id: string, uri: string, depth: number): Promise<void> {
        const record = await this.stores.index.get(id);
        if (!record) {
            this.addGapNode(uri, 'index_record', 'index', `Index record ${id} not found`);
            return;
        }

        this.addNode(uri, 'index_record', 'index', false, `[index] ${record.text}`, {
            sourceStore: record.sourceStore,
            sourceId: record.sourceId,
            indexedAt: record.indexedAt,
        });

        // Backward: trace to owner truth
        if (this.options.direction !== 'forward') {
            const ownerUri = formatClusterUri(
                record.sourceStore === 'ledger' ? 'ledger' : record.sourceStore,
                record.sourceId,
            );

            // Check if owner truth exists
            let ownerExists = false;
            let stale = false;

            if (record.sourceStore === 'canonical') {
                const entity = await this.stores.canonical.get(record.sourceId);
                ownerExists = !!entity;
                if (entity) {
                    const expectedText = `${entity.kind}: ${entity.name}`;
                    stale = record.text !== expectedText;
                }
            } else if (record.sourceStore === 'artifact') {
                ownerExists = await this.stores.artifact.exists(record.sourceId);
            }

            if (ownerExists) {
                if (stale) {
                    this.addEdge(uri, ownerUri, 'stale_projection_of', 'Index record is stale — does not match current owner truth', undefined, undefined, true);
                    this.warnings.push({
                        type: 'stale_index',
                        subjectUri: uri,
                        message: `Index record ${id} is a stale projection of ${ownerUri}`,
                    });
                } else {
                    this.addEdge(uri, ownerUri, 'index_record_derived_from', 'Derived from owner truth');
                }
                await this.traceFrom(parseClusterUri(ownerUri), depth + 1);
            } else {
                this.addEdge(uri, ownerUri, 'missing_owner_truth', 'Owner truth no longer exists', undefined, undefined, true);
                this.gaps.push({
                    description: `Index record ${id} references ${record.sourceStore}/${record.sourceId} which no longer exists`,
                    expectedUri: ownerUri,
                    store: record.sourceStore,
                    impact: 'high',
                });
                this.warnings.push({
                    type: 'missing_owner_truth',
                    subjectUri: uri,
                    message: `Owner truth for index record ${id} is missing`,
                });
            }
        }
    }

    private async traceEvent(id: string, uri: string, depth: number): Promise<void> {
        const event = await this.stores.ledger.getEvent(id);
        if (!event) {
            this.addGapNode(uri, 'provenance_event', 'ledger', `Event ${id} not found`);
            return;
        }

        this.addNode(uri, 'provenance_event', 'ledger', true, `${event.action} by ${event.actorId}`, {
            action: event.action,
            actorId: event.actorId,
            subjectId: event.subjectId,
            subjectStore: event.subjectStore,
            timestamp: event.timestamp,
        });

        // Backward: trace parent event
        if (this.options.direction !== 'forward' && event.parentEventId) {
            const parentUri = formatClusterUri('ledger', event.parentEventId);
            this.addEdge(parentUri, uri, 'entity_created_by', 'Parent event');
            await this.traceFrom(parseClusterUri(parentUri), depth + 1);
        }

        // Forward: trace subject
        if (this.options.direction !== 'backward') {
            const subjectUri = formatClusterUri(
                event.subjectStore === 'ledger' ? 'ledger' : event.subjectStore,
                event.subjectId,
            );
            this.addEdge(uri, subjectUri, this.eventToEdgeType(event.action), event.action, event.id, event.timestamp);
            await this.traceFrom(parseClusterUri(subjectUri), depth + 1);
        }
    }

    private async traceReceipt(id: string, uri: string, depth: number): Promise<void> {
        const receipt = await this.stores.ledger.getReceipt(id);
        if (!receipt) {
            this.addGapNode(uri, 'receipt', 'ledger', `Receipt ${id} not found`);
            return;
        }

        this.addNode(uri, 'receipt', 'ledger', true, `Receipt: ${receipt.resultSummary}`, {
            commandId: receipt.commandId,
            committedAt: receipt.committedAt,
            resultSummary: receipt.resultSummary,
        });

        // Backward: trace the provenance event that emitted this receipt
        if (this.options.direction !== 'forward' && receipt.provenanceEventId) {
            const eventUri = formatClusterUri('ledger', receipt.provenanceEventId);
            this.addEdge(eventUri, uri, 'receipt_emitted_for', 'Receipt emitted for committed command', receipt.provenanceEventId);
            await this.traceFrom(parseClusterUri(eventUri), depth + 1);
        }

        // Forward: trace affected IDs
        if (this.options.direction !== 'backward') {
            for (const affectedId of receipt.affectedIds) {
                // Try to find the affected object in canonical or artifact
                const entity = await this.stores.canonical.get(affectedId);
                if (entity) {
                    const entityUri = formatClusterUri('canonical', affectedId);
                    this.addEdge(uri, entityUri, 'mutation_committed_by', 'Affected by this receipt');
                    await this.traceFrom(parseClusterUri(entityUri), depth + 1);
                    continue;
                }
                const artifact = await this.stores.artifact.get(affectedId);
                if (artifact) {
                    const artUri = formatClusterUri('artifact', affectedId);
                    this.addEdge(uri, artUri, 'mutation_committed_by', 'Affected by this receipt');
                    await this.traceFrom(parseClusterUri(artUri), depth + 1);
                }
            }
        }
    }

    private async traceForwardIndex(sourceId: string, sourceUri: string, depth: number): Promise<void> {
        const records = await this.stores.index.search({ limit: 100 });
        const matching = records.filter((r) => r.sourceId === sourceId);
        for (const record of matching) {
            const indexUri = formatClusterUri('index', record.id);
            this.addNode(indexUri, 'index_record', 'index', false, `[index] ${record.text}`, {
                sourceStore: record.sourceStore,
                sourceId: record.sourceId,
            });
            this.addEdge(sourceUri, indexUri, 'index_record_derived_from', 'Index derived from this truth');
        }
    }

    private async traceRelatedReceipts(subjectId: string, subjectUri: string, depth: number): Promise<void> {
        const receipts = await this.stores.ledger.listReceipts();
        const related = receipts.filter((r) => r.affectedIds.includes(subjectId));
        for (const receipt of related) {
            const receiptUri = formatClusterUri('receipt', receipt.id);
            this.addNode(receiptUri, 'receipt', 'ledger', true, `Receipt: ${receipt.resultSummary}`, {
                commandId: receipt.commandId,
                committedAt: receipt.committedAt,
            });
            this.addEdge(receiptUri, subjectUri, 'receipt_emitted_for', 'Receipt covers this object');
        }
    }

    private addNode(
        uri: string,
        type: NodeType,
        ownerStore: string | null,
        isSourceTruth: boolean,
        label: string,
        metadata?: Record<string, unknown>,
        isGap?: boolean,
    ): void {
        if (!this.nodes.has(uri)) {
            this.nodes.set(uri, { uri, type, ownerStore, isSourceTruth, label, metadata, isGap });
        }
    }

    private addGapNode(uri: string, type: NodeType, store: string, description: string): void {
        this.addNode(uri, type, null, false, `[MISSING] ${description}`, undefined, true);
        this.gaps.push({ description, expectedUri: uri, store, impact: 'high' });
    }

    private addEdge(
        from: string,
        to: string,
        type: EdgeType,
        reason: string,
        sourceEventId?: string,
        timestamp?: string,
        isWarning?: boolean,
    ): void {
        // Avoid duplicate edges
        const exists = this.edges.some(
            (e) => e.from === from && e.to === to && e.type === type,
        );
        if (!exists) {
            this.edges.push({ from, to, type, reason, sourceEventId, timestamp, isWarning });
        }
    }

    private eventToEdgeType(action: string): EdgeType {
        switch (action) {
            case 'artifact_ingested': return 'artifact_ingested_from';
            case 'entity_created': return 'entity_created_by';
            case 'evidence_linked': return 'evidence_linked_to';
            case 'mutation_committed': return 'mutation_committed_by';
            case 'index_rebuilt': return 'index_record_derived_from';
            default: return 'entity_created_by';
        }
    }

    private buildSummary(nodes: ProvenanceNode[]): TraceSummary {
        const sourceTruthNodes = nodes.filter((n) => n.isSourceTruth && !n.isGap).length;
        const derivativeNodes = nodes.filter((n) => !n.isSourceTruth && !n.isGap).length;
        const receiptCount = nodes.filter((n) => n.type === 'receipt').length;

        const parts: string[] = [];
        parts.push(`${nodes.length} nodes`);
        parts.push(`${this.edges.length} edges`);
        if (this.gaps.length > 0) parts.push(`${this.gaps.length} gaps`);
        if (this.warnings.length > 0) parts.push(`${this.warnings.length} warnings`);

        return {
            focalUri: this.focalUri,
            direction: this.options.direction,
            nodeCount: nodes.length,
            edgeCount: this.edges.length,
            sourceTruthNodes,
            derivativeNodes,
            receiptCount,
            gapCount: this.gaps.length,
            warningCount: this.warnings.length,
            oneLiner: `Trace from ${this.focalUri}: ${parts.join(', ')}`,
        };
    }
}
