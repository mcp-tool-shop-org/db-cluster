import type { ClusterStores } from '../contracts/index.js';
import type { Entity } from '../types/entity.js';
import type { Artifact } from '../types/artifact.js';
import type { IndexRecord } from '../types/index-record.js';
import type { ProvenanceEvent } from '../types/provenance-event.js';
import type { Command } from '../types/command.js';
import type { Receipt } from '../types/receipt.js';
import { proposeCommand, validateCommand, markCommitted, markRejected } from './commands.js';
import { recordProvenance, traceSubjectProvenance } from './provenance.js';
import { emitReceipt } from './receipts.js';
import { NotFoundError, CommandNotValidatedError, CommandRejectedError } from './errors.js';
import { CommandQueue } from './command-queue.js';

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
                proposeCommand('create_entity', 'canonical', { entityId: entity.id }, input.actorId),
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
     * Commit a previously proposed mutation.
     * Validates, executes against the target store, emits provenance and receipt.
     */
    async commitMutation(commandId: string, actorId: string): Promise<CommitMutationResult> {
        const command = this.getCommand(commandId);
        if (!command) {
            throw new CommandNotValidatedError(commandId);
        }
        if (command.status !== 'proposed') {
            throw new CommandNotValidatedError(commandId);
        }

        // Validate
        let validated: Command;
        try {
            validated = validateCommand(command);
        } catch (err) {
            const rejected = markRejected(command);
            this.saveCommand(rejected);
            throw new CommandRejectedError(commandId, (err as Error).message);
        }

        // Execute the mutation against the target store
        const affectedIds: string[] = [];
        let resultSummary = '';

        switch (validated.verb) {
            case 'update_entity': {
                const { entityId, patch } = validated.payload as {
                    entityId: string;
                    patch: Record<string, unknown>;
                };
                const updated = await this.stores.canonical.update(entityId, patch as any);
                affectedIds.push(updated.id);
                resultSummary = `Updated entity: ${updated.name}`;
                break;
            }
            case 'create_entity': {
                const { kind, name, attributes } = validated.payload as {
                    kind: string;
                    name: string;
                    attributes: Record<string, unknown>;
                };
                const entity = await this.stores.canonical.create({ kind, name, attributes });
                affectedIds.push(entity.id);
                resultSummary = `Created entity: ${kind}/${name}`;
                break;
            }
            case 'ingest_artifact': {
                const { filename, content, mimeType } = validated.payload as {
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
                const { artifactId, entityId } = validated.payload as {
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
                const rejected = markRejected(validated);
                this.saveCommand(rejected);
                throw new CommandRejectedError(commandId, `Unknown verb: ${validated.verb}`);
            }
        }

        // Mark committed
        const committed = markCommitted(validated);
        this.saveCommand(committed);

        // Record provenance
        const provenance = await recordProvenance(
            this.stores.ledger,
            'mutation_committed',
            actorId,
            affectedIds[0] ?? commandId,
            validated.targetStore,
            { commandId, verb: validated.verb, payload: validated.payload },
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
     * List all receipts, optionally filtered.
     */
    async listReceipts(filter?: { commandId?: string; since?: string; limit?: number }): Promise<Receipt[]> {
        return this.stores.ledger.listReceipts(filter);
    }
}
