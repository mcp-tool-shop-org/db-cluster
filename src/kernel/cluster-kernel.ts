import type { ClusterStores } from '../contracts/index.js';
import type { Entity } from '../types/entity.js';
import type { Artifact } from '../types/artifact.js';
import type { IndexRecord } from '../types/index-record.js';
import type { ProvenanceEvent } from '../types/provenance-event.js';
import type { Command } from '../types/command.js';
import type { Receipt } from '../types/receipt.js';
import type { EvidenceBundle } from '../types/evidence-bundle.js';
import type { ProvenanceGraph, TraceOptions, TraceSummary } from '../types/provenance-graph.js';
import { proposeCommand, validateCommand, approveCommand, rejectCommand, markCommitted, markRejected, markCompensated, isValidTransition } from './commands.js';
import { recordProvenance, traceSubjectProvenance } from './provenance.js';
import { emitReceipt } from './receipts.js';
import { NotFoundError, CommandNotValidatedError, CommandRejectedError } from './errors.js';
import { CommandQueue } from './command-queue.js';
import { RetrievalPlanner } from '../retrieval/retrieval-planner.js';
import { TraceBuilder } from '../provenance/trace-builder.js';

export interface KernelOptions {
    /** Directory for kernel working state (command queue). If omitted, commands live in-memory only. */
    dataDir?: string;
}

export interface IngestArtifactInput {
    filename: string;
    content: Buffer;
    mimeType: string;
    actorId: string;
}

export interface CreateEntityInput {
    kind: string;
    name: string;
    attributes: Record<string, unknown>;
    actorId: string;
}

export interface LinkEvidenceInput {
    artifactId: string;
    entityId: string;
    actorId: string;
    detail?: Record<string, unknown>;
}

export interface FindSourcesInput {
    query: string;
    limit?: number;
}

export interface FindSourcesResult {
    indexRecords: IndexRecord[];
    resolvedEntities: Entity[];
    resolvedArtifacts: Artifact[];
}

export interface ProposeMutationInput {
    verb: Command['verb'];
    targetStore: Command['targetStore'];
    payload: Record<string, unknown>;
    proposedBy: string;
}

export interface CommitMutationResult {
    command: Command;
    receipt: Receipt;
}

/**
 * ClusterKernel — the coordination layer over the four truth stores.
 *
 * Routes all operations through typed verbs. No caller accesses stores directly.
 * Every write produces provenance. Every committed command produces a receipt.
 */
export class ClusterKernel {
    private commandQueue: CommandQueue | null;
    private memoryCommands = new Map<string, Command>();

    constructor(
        private readonly stores: ClusterStores,
        options?: KernelOptions,
    ) {
        this.commandQueue = options?.dataDir
            ? new CommandQueue(options.dataDir)
            : null;
    }

    private getCommand(id: string): Command | undefined {
        if (this.commandQueue) return this.commandQueue.get(id);
        return this.memoryCommands.get(id);
    }

    private saveCommand(command: Command): void {
        if (this.commandQueue) {
            this.commandQueue.save(command);
        } else {
            this.memoryCommands.set(command.id, command);
        }
    }

    /**
     * Ingest a source artifact into the cluster.
     * Writes: artifact store, index store, ledger.
     */
    async ingestArtifact(input: IngestArtifactInput): Promise<{
        artifact: Artifact;
        indexRecord: IndexRecord;
        provenance: ProvenanceEvent;
        receipt: Receipt;
    }> {
        // 1. Write artifact
        const artifact = await this.stores.artifact.ingest({
            filename: input.filename,
            content: input.content,
            mimeType: input.mimeType,
        });

        // 2. Index the artifact
        const indexRecord = await this.stores.index.index({
            sourceId: artifact.id,
            sourceStore: 'artifact',
            text: `${input.filename} [${input.mimeType}]`,
            metadata: {
                filename: input.filename,
                mimeType: input.mimeType,
                contentHash: artifact.contentHash,
                version: artifact.version,
            },
        });

        // 3. Record provenance
        const provenance = await recordProvenance(
            this.stores.ledger,
            'artifact_ingested',
            input.actorId,
            artifact.id,
            'artifact',
            { filename: input.filename, version: artifact.version },
        );

        // 4. Emit receipt via internal command
        const cmd = markCommitted(
            validateCommand(
                proposeCommand('ingest_artifact', 'artifact', { artifactId: artifact.id }, input.actorId),
            ),
        );
        const receipt = await emitReceipt(
            this.stores.ledger,
            cmd,
            `Ingested artifact: ${input.filename} v${artifact.version}`,
            [artifact.id, indexRecord.id],
            provenance.id,
        );

        return { artifact, indexRecord, provenance, receipt };
    }

    /**
     * Create a canonical entity.
     * Writes: canonical store, index store, ledger.
     */
    async createEntity(input: CreateEntityInput): Promise<{
        entity: Entity;
        indexRecord: IndexRecord;
        provenance: ProvenanceEvent;
        receipt: Receipt;
    }> {
        // 1. Write entity
        const entity = await this.stores.canonical.create({
            kind: input.kind,
            name: input.name,
            attributes: input.attributes,
        });

        // 2. Index the entity
        const indexRecord = await this.stores.index.index({
            sourceId: entity.id,
            sourceStore: 'canonical',
            text: `${entity.kind}: ${entity.name}`,
            metadata: { kind: entity.kind, ...entity.attributes },
        });

        // 3. Record provenance
        const provenance = await recordProvenance(
            this.stores.ledger,
            'entity_created',
            input.actorId,
            entity.id,
            'canonical',
            { kind: input.kind, name: input.name },
        );

        // 4. Emit receipt
        const cmd = markCommitted(
            validateCommand(
                proposeCommand('create_entity', 'canonical', { entityId: entity.id, kind: input.kind, name: input.name }, input.actorId),
            ),
        );
        const receipt = await emitReceipt(
            this.stores.ledger,
            cmd,
            `Created entity: ${input.kind}/${input.name}`,
            [entity.id, indexRecord.id],
            provenance.id,
        );

        return { entity, indexRecord, provenance, receipt };
    }

    /**
     * Link an artifact as evidence for an entity.
     * Writes: ledger (provenance edge).
     */
    async linkEvidence(input: LinkEvidenceInput): Promise<{
        provenance: ProvenanceEvent;
        receipt: Receipt;
    }> {
        // Verify both exist
        if (!(await this.stores.artifact.exists(input.artifactId))) {
            throw new NotFoundError('artifact', input.artifactId);
        }
        if (!(await this.stores.canonical.exists(input.entityId))) {
            throw new NotFoundError('canonical', input.entityId);
        }

        // Record the link as a provenance event
        const provenance = await recordProvenance(
            this.stores.ledger,
            'evidence_linked',
            input.actorId,
            input.entityId,
            'canonical',
            {
                artifactId: input.artifactId,
                entityId: input.entityId,
                ...(input.detail ?? {}),
            },
        );

        // Emit receipt
        const cmd = markCommitted(
            validateCommand(
                proposeCommand(
                    'link_evidence',
                    'ledger',
                    { artifactId: input.artifactId, entityId: input.entityId },
                    input.actorId,
                ),
            ),
        );
        const receipt = await emitReceipt(
            this.stores.ledger,
            cmd,
            `Linked artifact ${input.artifactId} as evidence for entity ${input.entityId}`,
            [input.artifactId, input.entityId],
            provenance.id,
        );

        return { provenance, receipt };
    }

    /**
     * Find sources through the index, then resolve from owner stores.
     * Reads: index store → canonical store, artifact store.
     */
    async findSources(input: FindSourcesInput): Promise<FindSourcesResult> {
        const indexRecords = await this.stores.index.search({
            text: input.query,
            limit: input.limit,
        });

        const resolvedEntities: Entity[] = [];
        const resolvedArtifacts: Artifact[] = [];

        for (const record of indexRecords) {
            if (record.sourceStore === 'canonical') {
                const entity = await this.stores.canonical.get(record.sourceId);
                if (entity) resolvedEntities.push(entity);
            } else if (record.sourceStore === 'artifact') {
                const artifact = await this.stores.artifact.get(record.sourceId);
                if (artifact) resolvedArtifacts.push(artifact);
            }
        }

        return { indexRecords, resolvedEntities, resolvedArtifacts };
    }

    /**
     * Inspect an entity — returns canonical truth, not index projection.
     */
    async inspectEntity(id: string): Promise<Entity> {
        const entity = await this.stores.canonical.get(id);
        if (!entity) throw new NotFoundError('canonical', id);
        return entity;
    }

    /**
     * Trace provenance for a subject. Walks ledger lineage.
     */
    async traceProvenance(subjectId: string): Promise<ProvenanceEvent[]> {
        return traceSubjectProvenance(this.stores.ledger, subjectId);
    }

    /**
     * Propose a mutation. Does NOT mutate any store.
     * Returns a command that can later be committed.
     */
    async proposeMutation(input: ProposeMutationInput): Promise<Command> {
        const command = proposeCommand(
            input.verb,
            input.targetStore,
            input.payload,
            input.proposedBy,
        );
        this.saveCommand(command);
        return command;
    }

    /**
     * Commit a previously proposed (or validated/approved) mutation.
     * Validates if needed, executes against the target store, emits provenance and receipt.
     */
    async commitMutation(commandId: string, actorId: string): Promise<CommitMutationResult> {
        const command = this.getCommand(commandId);
        if (!command) {
            throw new CommandNotValidatedError(commandId);
        }

        // Accept proposed, validated, or approved
        const committableStatuses = ['proposed', 'validated', 'approved'];
        if (!committableStatuses.includes(command.status)) {
            if (command.status === 'rejected') {
                throw new CommandRejectedError(commandId, command.rejectionReason ?? 'Previously rejected');
            }
            throw new CommandNotValidatedError(commandId);
        }

        // Validate if still proposed
        let readyCommand: Command;
        if (command.status === 'proposed') {
            try {
                readyCommand = validateCommand(command);
            } catch (err) {
                const rejected = markRejected(command);
                this.saveCommand(rejected);
                throw new CommandRejectedError(commandId, (err as Error).message);
            }
        } else {
            readyCommand = command; // already validated or approved
        }

        // Execute the mutation against the target store
        const affectedIds: string[] = [];
        let resultSummary = '';

        switch (readyCommand.verb) {
            case 'update_entity': {
                const { entityId, patch } = readyCommand.payload as {
                    entityId: string;
                    patch: Record<string, unknown>;
                };
                const updated = await this.stores.canonical.update(entityId, patch as any);
                affectedIds.push(updated.id);
                resultSummary = `Updated entity: ${updated.name}`;
                break;
            }
            case 'create_entity': {
                const { kind, name, attributes } = readyCommand.payload as {
                    kind: string;
                    name: string;
                    attributes: Record<string, unknown>;
                };
                const entity = await this.stores.canonical.create({ kind, name, attributes: attributes ?? {} });
                affectedIds.push(entity.id);
                resultSummary = `Created entity: ${kind}/${name}`;
                break;
            }
            case 'ingest_artifact': {
                const { filename, content, mimeType } = readyCommand.payload as {
                    filename: string;
                    content: Buffer;
                    mimeType: string;
                };
                const artifact = await this.stores.artifact.ingest({ filename, content, mimeType });
                affectedIds.push(artifact.id);
                resultSummary = `Ingested artifact: ${filename}`;
                break;
            }
            case 'link_evidence': {
                const { artifactId, entityId } = readyCommand.payload as {
                    artifactId: string;
                    entityId: string;
                };
                affectedIds.push(artifactId, entityId);
                resultSummary = `Linked evidence: ${artifactId} → ${entityId}`;
                break;
            }
            case 'reindex': {
                resultSummary = 'Reindex requested';
                break;
            }
            default: {
                const rejected = markRejected(readyCommand);
                this.saveCommand(rejected);
                throw new CommandRejectedError(commandId, `Unknown verb: ${readyCommand.verb}`);
            }
        }

        // Mark committed
        const committed = markCommitted(readyCommand, actorId);
        this.saveCommand(committed);

        // Record provenance
        const provenance = await recordProvenance(
            this.stores.ledger,
            'mutation_committed',
            actorId,
            affectedIds[0] ?? commandId,
            readyCommand.targetStore,
            { commandId, verb: readyCommand.verb, payload: readyCommand.payload },
        );

        // Emit receipt
        const receipt = await emitReceipt(
            this.stores.ledger,
            committed,
            resultSummary,
            affectedIds,
            provenance.id,
        );

        return { command: committed, receipt };
    }

    /**
     * Validate a proposed command without committing it.
     * Returns the validated command with check results.
     */
    async validateMutation(commandId: string): Promise<Command> {
        const command = this.getCommand(commandId);
        if (!command) throw new NotFoundError('command', commandId);
        if (command.status !== 'proposed') {
            throw new CommandNotValidatedError(commandId);
        }

        try {
            const validated = validateCommand(command);
            this.saveCommand(validated);
            return validated;
        } catch (err) {
            const rejected = markRejected(command);
            this.saveCommand(rejected);
            throw new CommandRejectedError(commandId, (err as Error).message);
        }
    }

    /**
     * Approve a validated command — operator/policy gate.
     */
    async approveMutation(commandId: string, approvedBy: string, note?: string): Promise<Command> {
        const command = this.getCommand(commandId);
        if (!command) throw new NotFoundError('command', commandId);

        const approved = approveCommand(command, approvedBy, note);
        this.saveCommand(approved);

        // Record approval provenance
        await recordProvenance(
            this.stores.ledger,
            'command_approved',
            approvedBy,
            commandId,
            'ledger',
            { note, commandVerb: command.verb },
        );

        return approved;
    }

    /**
     * Reject a proposed or validated command.
     */
    async rejectMutation(commandId: string, rejectedBy: string, reason: string): Promise<Command> {
        const command = this.getCommand(commandId);
        if (!command) throw new NotFoundError('command', commandId);

        const rejected = rejectCommand(command, rejectedBy, reason);
        this.saveCommand(rejected);

        // Record rejection provenance
        await recordProvenance(
            this.stores.ledger,
            'command_rejected',
            rejectedBy,
            commandId,
            'ledger',
            { reason, commandVerb: command.verb },
        );

        return rejected;
    }

    /**
     * Compensate a committed command — create a compensating command that corrects
     * without erasing history. The original receipt is preserved.
     */
    async compensateMutation(
        originalCommandId: string,
        compensatedBy: string,
        reason: string,
        compensatingPayload?: Record<string, unknown>,
    ): Promise<{ compensatingCommand: Command; originalCommand: Command; receipt: Receipt }> {
        const original = this.getCommand(originalCommandId);
        if (!original) throw new NotFoundError('command', originalCommandId);
        if (original.status !== 'committed') {
            throw new Error(`Cannot compensate command in status: ${original.status}. Must be 'committed'.`);
        }

        // Create compensating command
        const compPayload = compensatingPayload ?? {
            originalCommandId,
            reason,
            originalVerb: original.verb,
            originalPayload: original.payload,
        };

        const compensatingCmd = proposeCommand(
            'compensate',
            original.targetStore,
            { originalCommandId, reason, ...compPayload },
            compensatedBy,
        );

        // Fast-track: validate + commit the compensating command
        const validated = validateCommand(compensatingCmd);
        const committed = markCommitted(validated, compensatedBy);
        this.saveCommand(committed);

        // Mark the original as compensated
        const compensated = markCompensated(original, committed.id, compensatedBy);
        this.saveCommand(compensated);

        // Record provenance for compensation
        const provenance = await recordProvenance(
            this.stores.ledger,
            'command_compensated',
            compensatedBy,
            originalCommandId,
            'ledger',
            { compensatingCommandId: committed.id, reason },
        );

        // Emit receipt for compensation
        const receipt = await emitReceipt(
            this.stores.ledger,
            committed,
            `Compensated command ${originalCommandId}: ${reason}`,
            [originalCommandId],
            provenance.id,
        );

        return { compensatingCommand: committed, originalCommand: compensated, receipt };
    }

    /**
     * Inspect a command — full lifecycle state.
     */
    async inspectCommand(commandId: string): Promise<Command> {
        const command = this.getCommand(commandId);
        if (!command) throw new NotFoundError('command', commandId);
        return command;
    }

    /**
     * List all receipts, optionally filtered.
     */
    async listReceipts(filter?: { commandId?: string; since?: string; limit?: number }): Promise<Receipt[]> {
        return this.stores.ledger.listReceipts(filter);
    }

    /**
     * Rebuild the index from owner stores (canonical, artifact, ledger).
     * Clears the entire index, then re-derives from source truth.
     * Returns the count of records rebuilt.
     */
    async rebuildIndex(actorId: string): Promise<{ rebuilt: number; provenance: ProvenanceEvent; receipt: Receipt }> {
        // Clear
        await this.stores.index.clear();

        let rebuilt = 0;

        // Re-index all entities
        const entities = await this.stores.canonical.list();
        for (const entity of entities) {
            await this.stores.index.index({
                sourceId: entity.id,
                sourceStore: 'canonical',
                text: `${entity.kind}: ${entity.name}`,
                metadata: { kind: entity.kind, ...entity.attributes },
            });
            rebuilt++;
        }

        // Re-index all artifacts
        const artifacts = await this.stores.artifact.list();
        for (const artifact of artifacts) {
            await this.stores.index.index({
                sourceId: artifact.id,
                sourceStore: 'artifact',
                text: `${artifact.filename} [${artifact.mimeType}]`,
                metadata: {
                    filename: artifact.filename,
                    mimeType: artifact.mimeType,
                    contentHash: artifact.contentHash,
                    version: artifact.version,
                },
            });
            rebuilt++;
        }

        // Record provenance
        const provenance = await recordProvenance(
            this.stores.ledger,
            'index_rebuilt',
            actorId,
            'index',
            'index',
            { rebuilt, clearedFirst: true },
        );

        // Emit receipt
        const cmd = markCommitted(
            validateCommand(
                proposeCommand('reindex', 'index', { rebuilt }, actorId),
            ),
        );
        const receipt = await emitReceipt(
            this.stores.ledger,
            cmd,
            `Index rebuilt: ${rebuilt} records from owner stores`,
            [],
            provenance.id,
        );

        return { rebuilt, provenance, receipt };
    }

    /**
     * Returns the current index status: total count, and per-store breakdown.
     */
    async indexStatus(): Promise<IndexStatusResult> {
        const total = await this.stores.index.count();
        const allRecords = await this.stores.index.search({ limit: 100000 });

        const byStore: Record<string, number> = {};
        for (const rec of allRecords) {
            byStore[rec.sourceStore] = (byStore[rec.sourceStore] ?? 0) + 1;
        }

        // Count source truth objects
        const canonicalCount = (await this.stores.canonical.list()).length;
        const artifactCount = (await this.stores.artifact.list()).length;
        const expectedTotal = canonicalCount + artifactCount;

        return {
            total,
            byStore,
            expectedTotal,
            possiblyStale: total !== expectedTotal,
        };
    }

    /**
     * Explain why an index record exists: what owned truth it derives from,
     * whether that truth still exists, and whether the record appears stale.
     */
    async explainIndex(recordId: string): Promise<IndexExplanation> {
        const record = await this.stores.index.get(recordId);
        if (!record) {
            throw new NotFoundError('index', recordId);
        }

        let sourceExists = false;
        let sourceObject: Entity | Artifact | ProvenanceEvent | null = null;
        let stale = false;
        let staleCause: string | undefined;

        switch (record.sourceStore) {
            case 'canonical': {
                const entity = await this.stores.canonical.get(record.sourceId);
                sourceExists = !!entity;
                sourceObject = entity;
                if (entity) {
                    // Check if index text matches current state
                    const expectedText = `${entity.kind}: ${entity.name}`;
                    if (record.text !== expectedText) {
                        stale = true;
                        staleCause = `Index text "${record.text}" does not match current entity "${expectedText}"`;
                    }
                } else {
                    stale = true;
                    staleCause = `Source entity ${record.sourceId} no longer exists`;
                }
                break;
            }
            case 'artifact': {
                const artifact = await this.stores.artifact.get(record.sourceId);
                sourceExists = !!artifact;
                sourceObject = artifact;
                if (!artifact) {
                    stale = true;
                    staleCause = `Source artifact ${record.sourceId} no longer exists`;
                }
                break;
            }
            case 'ledger': {
                const event = await this.stores.ledger.getEvent(record.sourceId);
                sourceExists = !!event;
                sourceObject = event;
                if (!event) {
                    stale = true;
                    staleCause = `Source event ${record.sourceId} no longer exists`;
                }
                break;
            }
        }

        return {
            indexRecordId: record.id,
            sourceId: record.sourceId,
            sourceStore: record.sourceStore,
            indexedAt: record.indexedAt,
            text: record.text,
            sourceExists,
            sourceObject,
            stale,
            staleCause,
        };
    }

    /**
     * List all index records that are stale (source truth missing or changed).
     */
    async listStaleRecords(): Promise<StaleRecord[]> {
        const allRecords = await this.stores.index.search({ limit: 100000 });
        const stale: StaleRecord[] = [];

        for (const record of allRecords) {
            let cause: string | undefined;

            switch (record.sourceStore) {
                case 'canonical': {
                    const entity = await this.stores.canonical.get(record.sourceId);
                    if (!entity) {
                        cause = 'Source entity deleted';
                    } else {
                        const expectedText = `${entity.kind}: ${entity.name}`;
                        if (record.text !== expectedText) {
                            cause = 'Index text does not match current entity state';
                        }
                    }
                    break;
                }
                case 'artifact': {
                    const artifact = await this.stores.artifact.get(record.sourceId);
                    if (!artifact) {
                        cause = 'Source artifact deleted';
                    }
                    break;
                }
                case 'ledger': {
                    const event = await this.stores.ledger.getEvent(record.sourceId);
                    if (!event) {
                        cause = 'Source event deleted';
                    }
                    break;
                }
            }

            if (cause) {
                stale.push({
                    indexRecordId: record.id,
                    sourceId: record.sourceId,
                    sourceStore: record.sourceStore,
                    cause,
                });
            }
        }

        return stale;
    }

    /**
     * Retrieve an EvidenceBundle — structured cluster retrieval, not search.
     * Queries index → resolves owner truth → attaches provenance → classifies freshness/gaps.
     */
    async retrieveBundle(query: string, options?: { limit?: number }): Promise<EvidenceBundle> {
        const planner = new RetrievalPlanner(this.stores);
        return planner.plan(query, options);
    }

    /**
     * Explain a retrieval bundle — summarize what was found, what is missing,
     * and what confidence boundaries apply.
     */
    async explainRetrieval(bundle: EvidenceBundle): Promise<RetrievalExplanation> {
        const resolvedCount = bundle.resolvedEntities.length + bundle.resolvedArtifacts.length;
        const lines: string[] = [];

        lines.push(`Query: "${bundle.query}"`);
        lines.push(`Assembled: ${bundle.assembledAt}`);
        lines.push(`Index candidates: ${bundle.indexRecords.length}`);
        lines.push(`Resolved: ${resolvedCount} (${bundle.resolvedEntities.length} entities, ${bundle.resolvedArtifacts.length} artifacts)`);
        lines.push(`Provenance events: ${bundle.provenanceEvents.length}`);
        lines.push(`Freshness: ${bundle.freshness.allFresh ? 'ALL FRESH' : `${bundle.freshness.staleCount} stale, ${bundle.freshness.unprovenanced} unprovenanced`}`);

        if (bundle.missingContext.length > 0) {
            lines.push(`Missing context: ${bundle.missingContext.length} gap(s)`);
            for (const gap of bundle.missingContext) {
                lines.push(`  - [${gap.impact}] ${gap.description}`);
            }
        }

        if (bundle.confidenceBoundaries.length > 0) {
            lines.push(`Confidence boundaries:`);
            for (const b of bundle.confidenceBoundaries) {
                lines.push(`  - [${b.level}] ${b.claim}: ${b.reason}`);
            }
        }

        return {
            bundleId: bundle.id,
            summary: lines.join('\n'),
            resolvedCount,
            indexCandidates: bundle.indexRecords.length,
            missingCount: bundle.missingContext.length,
            allFresh: bundle.freshness.allFresh,
            boundaries: bundle.confidenceBoundaries,
        };
    }

    // ─── Phase 4: Provenance Graph Verbs ────────────────────────────────

    /**
     * Trace any cluster object — build a navigable provenance graph from a URI.
     */
    async traceObject(uri: string, options?: Partial<TraceOptions>): Promise<ProvenanceGraph> {
        const builder = new TraceBuilder(this.stores, uri, options);
        return builder.build();
    }

    /**
     * Trace all objects in a retrieval bundle — combined provenance graph.
     */
    async traceBundle(bundle: EvidenceBundle, options?: Partial<TraceOptions>): Promise<ProvenanceGraph> {
        // Build individual traces for each resolved evidence item
        const allNodes = new Map<string, ProvenanceGraph['nodes'][0]>();
        const allEdges: ProvenanceGraph['edges'] = [];
        const allGaps: ProvenanceGraph['gaps'] = [];
        const allWarnings: ProvenanceGraph['warnings'] = [];

        const uris: string[] = [];
        for (const e of bundle.resolvedEntities) {
            uris.push(e.uri);
        }
        for (const a of bundle.resolvedArtifacts) {
            uris.push(a.uri);
        }

        for (const uri of uris) {
            const graph = await this.traceObject(uri, options);
            for (const node of graph.nodes) allNodes.set(node.uri, node);
            allEdges.push(...graph.edges);
            allGaps.push(...graph.gaps);
            allWarnings.push(...graph.warnings);
        }

        // Dedup edges
        const edgeSet = new Set<string>();
        const dedupedEdges = allEdges.filter((e) => {
            const key = `${e.from}|${e.to}|${e.type}`;
            if (edgeSet.has(key)) return false;
            edgeSet.add(key);
            return true;
        });

        const nodesArr = [...allNodes.values()];
        const focalUri = `bundle://${bundle.id}`;

        const summary: TraceSummary = {
            focalUri,
            direction: options?.direction ?? 'backward',
            nodeCount: nodesArr.length,
            edgeCount: dedupedEdges.length,
            sourceTruthNodes: nodesArr.filter((n) => n.isSourceTruth && !n.isGap).length,
            derivativeNodes: nodesArr.filter((n) => !n.isSourceTruth && !n.isGap).length,
            receiptCount: nodesArr.filter((n) => n.type === 'receipt').length,
            gapCount: allGaps.length,
            warningCount: allWarnings.length,
            oneLiner: `Bundle trace: ${nodesArr.length} nodes, ${dedupedEdges.length} edges, ${allGaps.length} gaps`,
        };

        return {
            focalUri,
            direction: options?.direction ?? 'backward',
            nodes: nodesArr,
            edges: dedupedEdges,
            gaps: allGaps,
            warnings: allWarnings,
            summary,
            assembledAt: new Date().toISOString(),
        };
    }

    /**
     * Explain a provenance graph as human-readable text.
     */
    explainTrace(graph: ProvenanceGraph): string {
        const lines: string[] = [];
        lines.push(`Provenance trace from: ${graph.focalUri}`);
        lines.push(`Direction: ${graph.direction}`);
        lines.push(`Assembled: ${graph.assembledAt}`);
        lines.push('');
        lines.push(`Nodes: ${graph.summary.nodeCount} (${graph.summary.sourceTruthNodes} source truth, ${graph.summary.derivativeNodes} derivative, ${graph.summary.receiptCount} receipts)`);
        lines.push(`Edges: ${graph.summary.edgeCount}`);

        if (graph.nodes.length > 0) {
            lines.push('');
            lines.push('Objects:');
            for (const node of graph.nodes) {
                const gap = node.isGap ? ' [GAP]' : '';
                const truth = node.isSourceTruth ? 'truth' : 'derivative';
                lines.push(`  ${node.uri} — ${node.label} (${truth})${gap}`);
            }
        }

        if (graph.gaps.length > 0) {
            lines.push('');
            lines.push(`Gaps (${graph.gaps.length}):`);
            for (const gap of graph.gaps) {
                lines.push(`  [${gap.impact}] ${gap.description}`);
            }
        }

        if (graph.warnings.length > 0) {
            lines.push('');
            lines.push(`Warnings (${graph.warnings.length}):`);
            for (const w of graph.warnings) {
                lines.push(`  [${w.type}] ${w.message}`);
            }
        }

        if (graph.edges.length > 0) {
            lines.push('');
            lines.push('Edges:');
            for (const edge of graph.edges) {
                const warn = edge.isWarning ? ' ⚠' : '';
                lines.push(`  ${edge.from} → ${edge.to} [${edge.type}]${warn}`);
                lines.push(`    ${edge.reason}`);
            }
        }

        return lines.join('\n');
    }

    /**
     * Why does this object exist? Compact operator-facing explanation.
     */
    async why(uri: string): Promise<string> {
        const graph = await this.traceObject(uri, { direction: 'backward', depth: 5, includeReceipts: true, includeIndex: false, includeGaps: true, includeCommands: false });

        if (graph.nodes.length === 0) {
            return `${uri}: object not found in any store.`;
        }

        const focal = graph.nodes.find((n) => n.uri === uri);
        if (!focal) {
            return `${uri}: object not found.`;
        }

        const parts: string[] = [];
        parts.push(`${focal.label} (${focal.type} in ${focal.ownerStore})`);

        // Find creation edges
        const incomingEdges = graph.edges.filter((e) => e.to === uri);
        if (incomingEdges.length > 0) {
            const creationEdge = incomingEdges.find((e) => e.type === 'entity_created_by' || e.type === 'artifact_ingested_from');
            if (creationEdge) {
                parts.push(`Created by: ${creationEdge.reason}`);
            }
            const linkEdges = incomingEdges.filter((e) => e.type === 'evidence_linked_to');
            if (linkEdges.length > 0) {
                parts.push(`Evidence links: ${linkEdges.length}`);
            }
        }

        // Receipts
        const receiptNodes = graph.nodes.filter((n) => n.type === 'receipt');
        if (receiptNodes.length > 0) {
            parts.push(`Receipts: ${receiptNodes.length}`);
        }

        // Gaps/warnings
        if (graph.gaps.length > 0) {
            parts.push(`⚠ ${graph.gaps.length} gap(s) in provenance`);
        }

        return parts.join('\n');
    }
}

export interface RetrievalExplanation {
    bundleId: string;
    summary: string;
    resolvedCount: number;
    indexCandidates: number;
    missingCount: number;
    allFresh: boolean;
    boundaries: EvidenceBundle['confidenceBoundaries'];
}

export interface IndexStatusResult {
    total: number;
    byStore: Record<string, number>;
    expectedTotal: number;
    possiblyStale: boolean;
}

export interface IndexExplanation {
    indexRecordId: string;
    sourceId: string;
    sourceStore: string;
    indexedAt: string;
    text: string;
    sourceExists: boolean;
    sourceObject: Entity | Artifact | ProvenanceEvent | null;
    stale: boolean;
    staleCause?: string;
}

export interface StaleRecord {
    indexRecordId: string;
    sourceId: string;
    sourceStore: string;
    cause: string;
}
