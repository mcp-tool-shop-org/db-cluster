import type { ClusterStores } from '../contracts/index.js';
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
import type { RedactionRule } from '../types/policy.js';
import { redactedMarker } from '../types/redaction.js';

const DEFAULT_OPTIONS: TraceOptions = {
    direction: 'backward',
    depth: 10,
    includeIndex: true,
    includeReceipts: true,
    includeCommands: true,
    includeGaps: true,
};

/**
 * Structured label payload (KERNEL-B-006 / AGG-008 — Stage B Wave B1-Amend).
 *
 * Pre-fix, `addNode` accepted a pre-baked `label` string like
 * `${entity.kind}: ${entity.name}` and stored it on the node. Even when
 * a policy declared `provenance_actors`-redaction, the actor regex only
 * scrubbed `by <actor>` patterns — entity names, filenames, action
 * verbs all leaked through the literal label string.
 *
 * Post-fix, callers pass a structured {@link LabelData} object. The
 * trace-builder stores both the structured `labelData` AND a rendered
 * unredacted `label` string (so the public `ProvenanceNode.label`
 * field, which the type signature claims is a string, still works for
 * consumers that don't apply policy). PolicyEnforcedKernel surfaces
 * call `renderProvenanceLabel(labelData, policyView)` to produce a
 * redacted display string under policy.
 *
 * The label-stored-on-node IS the rendered form; consumers that need
 * to RE-render under policy can find `labelData` on the node's
 * `metadata.labelData` field (we serialize it there so it round-trips
 * through every consumer that walks `metadata`).
 */
export type LabelData =
    | {
          kind: 'entity';
          /** The entity.kind value (`'document'`, `'project'`, ...). */
          kind_value: string;
          /** The entity.name value (sensitive — gated by `entity_name` rule). */
          name: string;
      }
    | {
          kind: 'artifact';
          /** The artifact filename (sensitive — gated by `artifact_filename` rule). */
          filename: string;
          /** Artifact version number. */
          version: number;
      }
    | {
          kind: 'provenance_event';
          /** Event action verb (e.g. 'entity_created'). */
          action: string;
          /** Actor ID (sensitive — gated by `provenance_actors` rule). */
          actorId: string;
      }
    | {
          kind: 'index_record';
          /** The index record's text snapshot. */
          text: string;
      }
    | {
          kind: 'receipt';
          /** Receipt's result summary. */
          resultSummary: string;
      }
    | {
          kind: 'gap';
          /** Free-form description of what's missing. */
          description: string;
      };

/**
 * Render a structured {@link LabelData} into a display string under a
 * policy view. The policy view is a list of `RedactionRule`s — any rule
 * targeting a label-bound axis (`entity_name`, `artifact_filename`,
 * `provenance_actors`) gates the corresponding label component.
 *
 * When a component is denied by policy, it is replaced by `[REDACTED]`
 * in the rendered string. The structural {@link
 * import('../types/redaction.js').RedactedMarker} is the canonical
 * shape for redacted values OUTSIDE label rendering — for the
 * concatenated label string we collapse to the user-visible
 * `[REDACTED]` token (so a label like "document: [REDACTED]" is
 * obviously redacted to a human reading the graph).
 *
 * No policy → unredacted label.
 *
 * This function lives in the trace-builder module so call sites that
 * need redacted labels don't have to walk a second module boundary.
 */
export function renderProvenanceLabel(
    labelData: LabelData,
    policyView: ReadonlyArray<RedactionRule>,
): string {
    const has = (target: RedactionRule['target']) =>
        policyView.some((r) => r.target === target);
    const REDACT = '[REDACTED]';
    switch (labelData.kind) {
        case 'entity': {
            const name = has('entity_name') ? REDACT : labelData.name;
            return `${labelData.kind_value}: ${name}`;
        }
        case 'artifact': {
            const fn = has('artifact_filename') ? REDACT : labelData.filename;
            return `${fn} v${labelData.version}`;
        }
        case 'provenance_event': {
            const actor = has('provenance_actors') ? REDACT : labelData.actorId;
            return `${labelData.action} by ${actor}`;
        }
        case 'index_record':
            return `[index] ${labelData.text}`;
        case 'receipt':
            return `Receipt: ${labelData.resultSummary}`;
        case 'gap':
            return `[MISSING] ${labelData.description}`;
        default: {
            // AGG-005 / KERNEL-B-003: runtime-loaded labelData with an
            // unexpected kind. Return a safe sentinel rather than
            // crashing or leaking through string-coercion.
            const _exhaustive: never = labelData;
            void _exhaustive;
            return REDACT;
        }
    }
}

/**
 * TraceBuilder — builds cross-store provenance graphs from any cluster URI.
 *
 * Not just ledger parent chains. Crosses all four stores + receipts.
 * Surfaces gaps, warnings, stale projections honestly.
 *
 * KERNEL-B-006 / AGG-008: nodes now carry both a rendered `label` string
 * (back-compat with the `ProvenanceNode.label: string` contract) AND a
 * structured `metadata.labelData` payload that policy surfaces can use
 * to RE-render with redaction. The `label` produced here is the
 * unredacted form (no policy applied). Policy-aware consumers
 * (PolicyEnforcedKernel.traceObject, dashboard) read `metadata.labelData`
 * and call `renderProvenanceLabel(labelData, policyView)` to get the
 * gated display string.
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

        // KERNEL-B-006: previously baked `${entity.kind}: ${entity.name}`
        // into the label string. The entity name leaked through every
        // traceObject / why surface. Now stored as structured labelData;
        // the rendered label here is for back-compat with the
        // `ProvenanceNode.label: string` contract, but policy-aware
        // consumers should re-render via `renderProvenanceLabel(metadata.labelData, policyView)`.
        // The structured labelData lives on `metadata.labelData` and
        // round-trips through every consumer that walks `metadata`.
        this.addStructuredNode(uri, 'entity', 'canonical', true,
            { kind: 'entity', kind_value: entity.kind, name: entity.name },
            {
                kind: entity.kind,
                name: entity.name,
                createdAt: entity.createdAt,
            },
        );

        // Backward: find provenance events for this entity
        if (this.options.direction !== 'forward') {
            const events = await this.stores.ledger.listEvents({ subjectId: id });
            for (const event of events) {
                const eventUri = formatClusterUri('ledger', event.id);
                this.addStructuredNode(eventUri, 'provenance_event', 'ledger', true,
                    { kind: 'provenance_event', action: event.action, actorId: event.actorId },
                    {
                        action: event.action,
                        actorId: event.actorId,
                        timestamp: event.timestamp,
                    },
                );

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
                    // KERNEL-B-006: warning message previously interpolated
                    // `${entity.kind}/${entity.name}`. Surfaces through the
                    // warnings array on retrieveBundle. Replace name with a
                    // RedactedMarker stand-in (string form) so the warning
                    // shape stays a string for back-compat. Consumers that
                    // want the structured form should call traceObject and
                    // pull labelData from the node, not parse the warning
                    // message.
                    message: `Entity ${entity.kind}/[name] exists without supporting provenance`,
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

        this.addStructuredNode(uri, 'artifact', 'artifact', true,
            { kind: 'artifact', filename: artifact.filename, version: artifact.version },
            {
                filename: artifact.filename,
                version: artifact.version,
                mimeType: artifact.mimeType,
                ingestedAt: artifact.ingestedAt,
            },
        );

        // Backward: find ingestion event
        if (this.options.direction !== 'forward') {
            const events = await this.stores.ledger.listEvents({ subjectId: id });
            for (const event of events) {
                const eventUri = formatClusterUri('ledger', event.id);
                this.addStructuredNode(eventUri, 'provenance_event', 'ledger', true,
                    { kind: 'provenance_event', action: event.action, actorId: event.actorId },
                    {
                        action: event.action,
                        actorId: event.actorId,
                        timestamp: event.timestamp,
                    },
                );
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
                    // KERNEL-B-006: filename interpolation. Replace with
                    // [filename] placeholder; structured form is on the
                    // node's metadata.labelData.
                    message: `Artifact [filename] exists without supporting provenance`,
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

        this.addStructuredNode(uri, 'index_record', 'index', false,
            { kind: 'index_record', text: record.text },
            {
                sourceStore: record.sourceStore,
                sourceId: record.sourceId,
                indexedAt: record.indexedAt,
            },
        );

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

        this.addStructuredNode(uri, 'provenance_event', 'ledger', true,
            { kind: 'provenance_event', action: event.action, actorId: event.actorId },
            {
                action: event.action,
                actorId: event.actorId,
                subjectId: event.subjectId,
                subjectStore: event.subjectStore,
                timestamp: event.timestamp,
            },
        );

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

        this.addStructuredNode(uri, 'receipt', 'ledger', true,
            { kind: 'receipt', resultSummary: receipt.resultSummary },
            {
                commandId: receipt.commandId,
                committedAt: receipt.committedAt,
                resultSummary: receipt.resultSummary,
            },
        );

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
            this.addStructuredNode(indexUri, 'index_record', 'index', false,
                { kind: 'index_record', text: record.text },
                {
                    sourceStore: record.sourceStore,
                    sourceId: record.sourceId,
                },
            );
            this.addEdge(sourceUri, indexUri, 'index_record_derived_from', 'Index derived from this truth');
        }
    }

    private async traceRelatedReceipts(subjectId: string, subjectUri: string, depth: number): Promise<void> {
        const receipts = await this.stores.ledger.listReceipts();
        const related = receipts.filter((r) => r.affectedIds.includes(subjectId));
        for (const receipt of related) {
            const receiptUri = formatClusterUri('receipt', receipt.id);
            this.addStructuredNode(receiptUri, 'receipt', 'ledger', true,
                { kind: 'receipt', resultSummary: receipt.resultSummary },
                {
                    commandId: receipt.commandId,
                    committedAt: receipt.committedAt,
                },
            );
            this.addEdge(receiptUri, subjectUri, 'receipt_emitted_for', 'Receipt covers this object');
        }
    }

    /**
     * Internal: store a node with structured labelData.
     *
     * KERNEL-B-006 / AGG-B1-1a (post-coordinator-fixup doctrine):
     * the rendered `label` string emitted here is the LITERAL form
     * (i.e. `renderProvenanceLabel(labelData, [])` — no policy applied).
     * The bare ClusterKernel surface is treated as trusted-internal:
     * its `node.label` carries the literal identifier for back-compat
     * with the `ProvenanceNode.label: string` contract.
     *
     * Policy-aware redaction happens at the BOUNDARY, not here:
     *   - `PolicyEnforcedKernel.traceObject` / `traceBundle` re-render
     *     every node's label via `renderProvenanceLabel(metadata.labelData,
     *     policyView)` where `policyView` is the redaction rule set
     *     collected from the matched policy + trust zone.
     *   - The MCP boundary (`cluster_trace` route) consumes graphs that
     *     have already passed through a PolicyEnforcedKernel, so the
     *     literal label has been replaced upstream when policy required.
     *   - The dashboard inspector renders the policy-aware label via
     *     the same helper.
     *
     * Why we still set `label: string` on the node (not `string |
     * RedactedMarker`): the `ProvenanceNode.label: string` contract is
     * consumed by every SDK / dashboard / why surface. Migrating that
     * to a sum type would cascade across all five domains; B2 may
     * promote the boundary upstream via branded `BareGraph` types but
     * for B1-Amend the doctrine is: literal at bare kernel, re-rendered
     * at the policy boundary. Consumers that hold a bare ClusterKernel
     * graph MUST NOT surface its labels to AI-facing trust zones
     * without going through PolicyEnforcedKernel first.
     */
    private addStructuredNode(
        uri: string,
        type: NodeType,
        ownerStore: string | null,
        isSourceTruth: boolean,
        labelData: LabelData,
        metadata?: Record<string, unknown>,
        isGap?: boolean,
    ): void {
        if (!this.nodes.has(uri)) {
            // KERNEL-B-006 / AGG-B1-1a: produce the LITERAL label at the
            // bare ClusterKernel surface (no policy applied). The
            // PolicyEnforcedKernel / MCP / dashboard boundary re-renders
            // this label via `renderProvenanceLabel(metadata.labelData,
            // policyView)` before surfacing to AI-facing trust zones.
            // Holding a bare ClusterKernel graph carries the trust
            // assumption that its labels are not surfaced unredacted.
            const label = this.renderPublicLabel(labelData);
            const fullMetadata: Record<string, unknown> = {
                ...(metadata ?? {}),
                labelData,
            };
            this.nodes.set(uri, { uri, type, ownerStore, isSourceTruth, label, metadata: fullMetadata, isGap });
        }
    }

    /**
     * Render the literal `node.label: string` for the bare ClusterKernel
     * graph. Per the KERNEL-B-006 / AGG-B1-1a doctrine: render-once-at-
     * bare-kernel-with-no-policy, re-render-at-the-PolicyEnforced-boundary-
     * with-policy-view.
     *
     * The bare ClusterKernel is the trust boundary's INSIDE — its
     * `node.label` carries the literal identifier. PolicyEnforcedKernel
     * is the boundary that gates AI-facing access; its `traceObject` /
     * `traceBundle` re-render every node via
     * {@link renderProvenanceLabel}(metadata.labelData, policyView)
     * where `policyView` comes from the matched policy + trust zone.
     * The MCP `cluster_trace` and the dashboard inspector consume
     * already-re-rendered graphs from a PolicyEnforcedKernel and never
     * see the bare-kernel literal.
     *
     * Equivalent to `renderProvenanceLabel(labelData, [])`.
     */
    private renderPublicLabel(labelData: LabelData): string {
        return renderProvenanceLabel(labelData, []);
    }

    private addGapNode(uri: string, type: NodeType, store: string, description: string): void {
        // Gap node: label is purely descriptive (not derived from sensitive
        // identifiers) so we render via the structured path with the
        // `gap` kind. Note: `description` may contain identifiers (entity
        // ID, etc.). Callers should pass IDs they're comfortable
        // surfacing in the public label.
        this.addStructuredNode(uri, type, null, false, { kind: 'gap', description }, undefined, true);
        // Mark the resulting node as a gap node:
        const node = this.nodes.get(uri);
        if (node) node.isGap = true;
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
            // STORES-R2-004: 'mutation_orphaned' means the store mutation
            // landed but the receipt write failed — the provenance chain
            // is incomplete by construction. Use 'missing_provenance' so
            // trace consumers surface the broken chain, not a misleading
            // "entity created by X" edge. (Adding a dedicated edge type
            // would require touching src/types/provenance-graph.ts which
            // is out of the Stores domain scope for this wave.)
            case 'mutation_orphaned': return 'missing_provenance';
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

// Suppress unused import warning while the marker import documents the
// structural relationship with AGG-008 markers.
void redactedMarker;
