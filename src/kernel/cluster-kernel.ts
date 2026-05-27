import { createHash, randomBytes } from 'node:crypto';
import {
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { ClusterStores } from '../contracts/index.js';
import type { Entity } from '../types/entity.js';
import type { Artifact } from '../types/artifact.js';
import type { IndexRecord } from '../types/index-record.js';
import type { ProvenanceEvent } from '../types/provenance-event.js';
import type { Command } from '../types/command.js';
import type { Receipt } from '../types/receipt.js';
import type { EvidenceBundle } from '../types/evidence-bundle.js';
import type { ProvenanceGraph, TraceOptions, TraceSummary } from '../types/provenance-graph.js';
import { proposeCommand, validateCommand, approveCommand, rejectCommand, markCommitted, markRejected, markCompensated } from './commands.js';
import { recordProvenance, traceSubjectProvenance } from './provenance.js';
import { emitReceipt } from './receipts.js';
import {
    NotFoundError,
    CommandNotValidatedError,
    CommandRejectedError,
    ReceiptFailedError,
    ContentHashMismatchError,
    StagedContentTamperedError,
} from './errors.js';
import { CommandQueue } from './command-queue.js';
import { RetrievalPlanner } from '../retrieval/retrieval-planner.js';
import { TraceBuilder } from '../provenance/trace-builder.js';
import type { ClusterKernelInterface } from './cluster-kernel-interface.js';

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
export class ClusterKernel implements ClusterKernelInterface {
    private commandQueue: CommandQueue | null;
    private memoryCommands = new Map<string, Command>();
    /**
     * Kernel-local working directory. When `dataDir` is provided to the
     * constructor we use it as the root for both the {@link CommandQueue}
     * and the `ingest_artifact` staging area (KERNEL-B-007). When omitted
     * (in-memory kernel) Buffer payloads on ingest_artifact still flow
     * through commitMutation via the in-memory command map without touching
     * disk — the staging-area path is bypassed and content is held in the
     * payload itself, which is safe because no JSON round-trip happens.
     */
    private readonly dataDir: string | null;
    /**
     * Set to true after the first call to {@link getStagingDir} has performed
     * the one-shot orphan sweep of the staging directory. Cached so subsequent
     * proposeMutation calls don't repeatedly scan disk.
     */
    private stagingSwept = false;

    constructor(
        private readonly stores: ClusterStores,
        options?: KernelOptions,
    ) {
        this.dataDir = options?.dataDir ?? null;
        this.commandQueue = options?.dataDir
            ? new CommandQueue(options.dataDir)
            : null;
    }

    /**
     * Resolve the staging directory for ingest_artifact buffer payloads
     * (KERNEL-B-007). Returns null in the in-memory mode (no `dataDir`).
     * Creates the directory on first call AND sweeps orphan random-suffix
     * tmp files from any previous crashed process (AGG-A4-2 / Wave A4 fix-up).
     */
    private getStagingDir(): string | null {
        if (!this.dataDir) return null;
        const stagingDir = join(this.dataDir, 'pending-content');
        if (!existsSync(stagingDir)) mkdirSync(stagingDir, { recursive: true });
        if (!this.stagingSwept) {
            // AGG-A4-2 / Wave A4 fix-up: orphan-sweep mirrors the local-store
            // adapters' constructor-time sweep. Pre-fix the kernel produced
            // `<hash>.<pid>-<rand16>.tmp` tmp files but had NO sweep — a crash
            // between writeFileSync and renameSync left them lingering forever.
            // We can't simply call sweepContentDirOrphans because the kernel
            // is forbidden from importing adapters/ (no back-edge rule
            // documented in src/kernel/errors.ts). Inline the same shape +
            // 5-min age threshold so the producer + sweep agree mechanically.
            //
            // The regex matches `<sha256-hex>.<pid>-<1-6 hex>.tmp` which is
            // what the proposeMutation arm below produces.
            try {
                this.sweepStagingOrphans(stagingDir);
            } catch {
                // Best-effort: a half-broken filesystem must not block ingest.
            }
            this.stagingSwept = true;
        }
        return stagingDir;
    }

    /**
     * Inline orphan-sweep for the staging dir. Mirrors
     * src/adapters/local/tmp-cleanup.ts::sweepContentDirOrphans but lives
     * here to honour the no-back-edge rule (kernel → adapters import is
     * forbidden). 5-minute age threshold protects young tmp files belonging
     * to actively-writing sibling processes.
     */
    private sweepStagingOrphans(stagingDir: string): void {
        const maxAgeMs = 5 * 60 * 1000;
        const cutoff = Date.now() - maxAgeMs;
        const orphanPattern = /^[a-f0-9]{64}\.\d+-[a-z0-9]{1,6}\.tmp$/;
        let entries: string[];
        try {
            entries = readdirSync(stagingDir);
        } catch {
            return;
        }
        for (const entry of entries) {
            if (!orphanPattern.test(entry)) continue;
            const fullPath = join(stagingDir, entry);
            let mtimeMs: number;
            try {
                mtimeMs = statSync(fullPath).mtimeMs;
            } catch {
                continue;
            }
            if (mtimeMs >= cutoff) continue;
            try {
                unlinkSync(fullPath);
            } catch {
                // Best-effort.
            }
        }
    }

    /**
     * Best-effort cleanup of a staging file for a rejected / compensated
     * ingest_artifact command. Silent on file-not-present. Errors swallowed
     * because rejection/compensation paths cannot fail on lateral cleanup —
     * the worst case is a stale staging file that the next sweep can clear.
     */
    private deleteStagingFile(contentHash: unknown): void {
        const stagingDir = this.getStagingDir();
        if (!stagingDir || typeof contentHash !== 'string' || !contentHash) return;
        const stagingPath = join(stagingDir, contentHash);
        try {
            if (existsSync(stagingPath)) unlinkSync(stagingPath);
        } catch {
            // Silent: see method docstring.
        }
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
     * Best-effort record an `mutation_orphaned` ledger event when the
     * post-mutation provenance/receipt sequence fails after the store has
     * already mutated. If the ledger itself is the failing component there
     * is no place to record the orphan; in that case we log to stderr so
     * operators get a signal (KERNEL-R009 — prior implementation swallowed
     * silently and no `ops/` consumer ever sees the orphan when the ledger
     * is broken). The caller then throws {@link ReceiptFailedError}; we
     * attach the orphan-write failure as a `secondaryError` field on
     * `(cause as any)` so the cause chain surfaces both faults to whatever
     * lens unpacks the error.
     */
    private async recordOrphanMutation(
        subjectId: string,
        subjectStore: ProvenanceEvent['subjectStore'],
        commandId: string | undefined,
        cause: Error,
        detail: Record<string, unknown> = {},
    ): Promise<void> {
        try {
            await recordProvenance(
                this.stores.ledger,
                'mutation_orphaned',
                'kernel',
                subjectId,
                subjectStore,
                {
                    ...detail,
                    commandId,
                    error: cause.message,
                    errorName: cause.name,
                },
            );
        } catch (orphanErr) {
            // Secondary failure — the ledger itself is unhealthy. We cannot
            // record the orphan but we MUST surface a signal: silent swallowing
            // is what KERNEL-R009 fixed. Two prongs:
            //  1. Log to stderr with a stable prefix `[db-cluster]` so
            //     operator log shippers can pattern-match.
            //  2. Attach the secondary failure to the primary cause so any
            //     downstream `(err as ReceiptFailedError).cause` inspection
            //     can also reach the orphan-write failure.
            const message = orphanErr instanceof Error ? orphanErr.message : String(orphanErr);
            // eslint-disable-next-line no-console
            console.error(
                `[db-cluster] Failed to record orphan mutation for ` +
                    `${subjectStore}/${subjectId}` +
                    `${commandId ? ` (command ${commandId})` : ''}: ${message}`,
            );
            try {
                (cause as Error & { secondaryError?: Error }).secondaryError =
                    orphanErr instanceof Error ? orphanErr : new Error(String(orphanErr));
            } catch {
                // Defensive: if the cause object is frozen we still have the
                // stderr signal above.
            }
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
        // 1. Write artifact (truth mutation — once this returns, the store is dirty)
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

        // 3-5. Provenance + synthetic command persistence + receipt — all wrapped
        // so a ledger blip doesn't leave the artifact store dirty without an
        // inspectable command + receipt (see KERNEL-005, KERNEL-002).
        const cmd = markCommitted(
            validateCommand(
                proposeCommand('ingest_artifact', 'artifact', { artifactId: artifact.id }, input.actorId),
            ),
        );
        let provenance: ProvenanceEvent;
        let receipt: Receipt;
        try {
            provenance = await recordProvenance(
                this.stores.ledger,
                'artifact_ingested',
                input.actorId,
                artifact.id,
                'artifact',
                { filename: input.filename, version: artifact.version },
            );

            // Persist the synthetic command so inspectCommand(receipt.commandId)
            // resolves. Prior versions manufactured cmd inline and never saved it.
            this.saveCommand(cmd);

            receipt = await emitReceipt(
                this.stores.ledger,
                cmd,
                `Ingested artifact: ${input.filename} v${artifact.version}`,
                [artifact.id, indexRecord.id],
                provenance.id,
            );
        } catch (err) {
            const cause = err as Error;
            await this.recordOrphanMutation(artifact.id, 'artifact', cmd.id, cause, {
                verb: 'ingest_artifact',
                filename: input.filename,
                actorId: input.actorId,
            });
            throw new ReceiptFailedError(artifact.id, cmd.id, cause);
        }

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
        // 1. Write entity (truth mutation — canonical store is now dirty)
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

        // 3-5. Provenance + synthetic command persistence + receipt
        // (see KERNEL-002, KERNEL-005)
        const cmd = markCommitted(
            validateCommand(
                proposeCommand('create_entity', 'canonical', { entityId: entity.id, kind: input.kind, name: input.name }, input.actorId),
            ),
        );
        let provenance: ProvenanceEvent;
        let receipt: Receipt;
        try {
            provenance = await recordProvenance(
                this.stores.ledger,
                'entity_created',
                input.actorId,
                entity.id,
                'canonical',
                { kind: input.kind, name: input.name },
            );

            this.saveCommand(cmd);

            receipt = await emitReceipt(
                this.stores.ledger,
                cmd,
                `Created entity: ${input.kind}/${input.name}`,
                [entity.id, indexRecord.id],
                provenance.id,
            );
        } catch (err) {
            const cause = err as Error;
            await this.recordOrphanMutation(entity.id, 'canonical', cmd.id, cause, {
                verb: 'create_entity',
                kind: input.kind,
                name: input.name,
                actorId: input.actorId,
            });
            throw new ReceiptFailedError(entity.id, cmd.id, cause);
        }

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
        // Verify both exist before touching the ledger (pre-mutation, safe to throw)
        if (!(await this.stores.artifact.exists(input.artifactId))) {
            throw new NotFoundError('artifact', input.artifactId);
        }
        if (!(await this.stores.canonical.exists(input.entityId))) {
            throw new NotFoundError('canonical', input.entityId);
        }

        // Provenance + synthetic command persistence + receipt
        // (see KERNEL-002, KERNEL-005).
        //
        // KERNEL-R2-005: the recordProvenance call was previously OUTSIDE
        // the try/catch. A failure at that write produced a bare ledger
        // Error rather than `ReceiptFailedError`, and no
        // `mutation_orphaned` event was attempted. Both writes (the
        // evidence_linked event and the receipt) now live in the same
        // try/catch so that ANY ledger-write failure on the link path
        // surfaces as the typed `ReceiptFailedError` and triggers a
        // best-effort orphan record. If the provenance step itself fails
        // there is no `provenance.id` to attach to the orphan detail,
        // but the orphan path runs anyway (we capture the entity id +
        // command id + cause so `doctor()` / `verify()` can flag it).
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

        let provenance: ProvenanceEvent;
        let receipt: Receipt;
        try {
            provenance = await recordProvenance(
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

            this.saveCommand(cmd);

            receipt = await emitReceipt(
                this.stores.ledger,
                cmd,
                `Linked artifact ${input.artifactId} as evidence for entity ${input.entityId}`,
                [input.artifactId, input.entityId],
                provenance.id,
            );
        } catch (err) {
            const cause = err as Error;
            await this.recordOrphanMutation(input.entityId, 'canonical', cmd.id, cause, {
                verb: 'link_evidence',
                artifactId: input.artifactId,
                entityId: input.entityId,
                actorId: input.actorId,
            });
            throw new ReceiptFailedError(input.entityId, cmd.id, cause);
        }

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
     *
     * KERNEL-B-007 (Buffer side-channel for ingest_artifact): when the verb is
     * `ingest_artifact` and `payload.content` is a Buffer, we:
     *
     *  1. Recompute `sha256(content)` and verify it equals the caller's
     *     supplied `payload.contentHash`. Mismatch throws
     *     {@link ContentHashMismatchError} BEFORE any disk write so a
     *     misbehaving caller can never seed a poisoned hash → buffer mapping.
     *  2. Write the Buffer to a staging file at
     *     `.db-cluster/pending-content/{contentHash}` via tmp+rename so the
     *     write is atomic. Crash mid-write leaves the prior good state.
     *  3. Replace `payload.content` with the contentHash string so the
     *     command persists as pure JSON (no Buffer round-trip corruption).
     *     Persisted payload shape:
     *     `{ filename, content: '<contentHash>', mimeType, contentHash }`.
     *
     * Commit-time then reads the buffer back from staging, re-validates the
     * hash (catching post-propose tampering), and only then calls the
     * artifact store. See {@link commitMutation} `ingest_artifact` arm.
     *
     * When the kernel is constructed without a `dataDir` (in-memory mode),
     * the staging-area path is bypassed because the in-memory command map
     * does not serialize the payload — the Buffer survives intact.
     */
    async proposeMutation(input: ProposeMutationInput): Promise<Command> {
        let payload = input.payload;
        if (input.verb === 'ingest_artifact' && Buffer.isBuffer(payload.content)) {
            const stagingDir = this.getStagingDir();
            if (stagingDir) {
                const buffer = payload.content as Buffer;
                const claimedHash = typeof payload.contentHash === 'string' ? payload.contentHash : '';
                const actualHash = createHash('sha256').update(buffer).digest('hex');
                if (claimedHash !== actualHash) {
                    throw new ContentHashMismatchError(claimedHash || '<missing>', actualHash);
                }
                // Atomic stage: write to a per-pid+rand tmp then rename.
                // AGG-A4-2 / Wave A4 fix-up: the random suffix shrunk from
                // randomBytes(8) (16 hex chars) to randomBytes(3) (6 hex chars)
                // so it matches the staging-orphan sweep regex
                // `[a-f0-9]{64}\.\d+-[a-z0-9]{1,6}\.tmp$`. Collision risk over
                // a single propose lifecycle (the tmp file lives milliseconds
                // between writeFileSync and renameSync) is negligible — pid +
                // 24 bits of randomness is plenty.
                const stagingPath = join(stagingDir, actualHash);
                const tmpPath = `${stagingPath}.${process.pid}-${randomBytes(3).toString('hex')}.tmp`;
                writeFileSync(tmpPath, buffer);
                renameSync(tmpPath, stagingPath);
                // Mutate the payload: content field becomes the hash string.
                payload = {
                    ...payload,
                    content: actualHash,
                    contentHash: actualHash,
                };
            }
        }
        const command = proposeCommand(
            input.verb,
            input.targetStore,
            payload,
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

        // Only validated or approved commands are committable.
        // We deliberately DROP 'proposed' (see KERNEL-006) — callers must call
        // validateMutation() explicitly. This makes the validate→commit gate
        // visible in the lifecycle instead of letting commitMutation silently
        // validate-inline, which used to allow approval to be skipped entirely.
        const committableStatuses: Command['status'][] = ['validated', 'approved'];
        if (!committableStatuses.includes(command.status)) {
            if (command.status === 'rejected') {
                throw new CommandRejectedError(commandId, command.rejectionReason ?? 'Previously rejected');
            }
            if (command.status === 'proposed') {
                throw new CommandNotValidatedError(commandId);
            }
            throw new CommandNotValidatedError(commandId);
        }

        const readyCommand: Command = command; // already validated or approved

        // Execute the mutation against the target store.
        // We track affectedIds + the pre-mutation phase separately from the
        // post-mutation phase. Any exception inside the switch is a clean
        // failure — the store has not yet mutated (or has not yet completed
        // mutation). The post-mutation phase (provenance + saveCommand +
        // receipt) is wrapped in try/catch to catch the orphan-mutation
        // window (see KERNEL-005).
        const affectedIds: string[] = [];
        let resultSummary = '';
        let primarySubjectStore: ProvenanceEvent['subjectStore'] = readyCommand.targetStore;

        switch (readyCommand.verb) {
            case 'update_entity': {
                const { entityId, patch } = readyCommand.payload as {
                    entityId: string;
                    patch: Record<string, unknown>;
                };
                // KERNEL-017 alignment: only forward the fields CanonicalStore.update
                // accepts (`name`, `attributes`). Other keys are dropped to
                // honour the contract typing instead of bypassing with `as any`.
                const allowedPatch: { name?: string; attributes?: Record<string, unknown> } = {};
                if (typeof patch.name === 'string') allowedPatch.name = patch.name;
                if (patch.attributes && typeof patch.attributes === 'object') {
                    allowedPatch.attributes = patch.attributes as Record<string, unknown>;
                }
                const updated = await this.stores.canonical.update(entityId, allowedPatch);
                affectedIds.push(updated.id);
                resultSummary = `Updated entity: ${updated.name}`;
                primarySubjectStore = 'canonical';
                // Refresh index: remove stale record, re-index with current truth
                const staleRecords = await this.stores.index.search({ text: '', metadata: {} });
                const matching = staleRecords.filter((r) => r.sourceId === entityId && r.sourceStore === 'canonical');
                for (const old of matching) {
                    await this.stores.index.remove(old.id);
                }
                await this.stores.index.index({
                    sourceId: updated.id,
                    sourceStore: 'canonical',
                    text: `${updated.kind}: ${updated.name}`,
                    metadata: { kind: updated.kind, ...updated.attributes },
                });
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
                primarySubjectStore = 'canonical';
                // Auto-index: same behavior as createEntity()
                await this.stores.index.index({
                    sourceId: entity.id,
                    sourceStore: 'canonical',
                    text: `${entity.kind}: ${entity.name}`,
                    metadata: { kind: entity.kind, ...entity.attributes },
                });
                break;
            }
            case 'ingest_artifact': {
                const { filename, content, mimeType, contentHash } = readyCommand.payload as {
                    filename: string;
                    content: unknown;
                    mimeType: string;
                    contentHash?: string;
                };

                // KERNEL-B-007: resolve the actual buffer to ingest. Two paths:
                //  - dataDir present + payload.content is the hash string: read
                //    from the staging area + re-validate the hash to catch
                //    post-propose tampering. This is the primary, safe path.
                //  - in-memory kernel: payload.content is still a Buffer (no
                //    JSON round-trip happened); use it directly.
                let resolvedContent: Buffer;
                let stagingPathForCleanup: string | null = null;
                const stagingDir = this.getStagingDir();
                if (stagingDir && typeof content === 'string' && contentHash && content === contentHash) {
                    const stagingPath = join(stagingDir, contentHash);
                    if (!existsSync(stagingPath)) {
                        throw new StagedContentTamperedError(contentHash, stagingPath, '<missing>');
                    }
                    const stagedBuffer = readFileSync(stagingPath);
                    const actualHash = createHash('sha256').update(stagedBuffer).digest('hex');
                    if (actualHash !== contentHash) {
                        // Tampered. Throw WITHOUT deleting the staging file so
                        // operators can inspect the corrupt bytes.
                        throw new StagedContentTamperedError(contentHash, stagingPath, actualHash);
                    }
                    resolvedContent = stagedBuffer;
                    stagingPathForCleanup = stagingPath;
                } else if (Buffer.isBuffer(content)) {
                    // In-memory kernel path: Buffer survived because no JSON
                    // serialization happened. No staging area, no hash check
                    // required (no round-trip risk).
                    resolvedContent = content;
                } else {
                    // Defensive: unknown shape. Should not happen — propose
                    // either staged the Buffer or kept it in-memory.
                    throw new ContentHashMismatchError(
                        typeof contentHash === 'string' ? contentHash : '<missing>',
                        '<no-content>',
                    );
                }

                const artifact = await this.stores.artifact.ingest({
                    filename,
                    content: resolvedContent,
                    mimeType,
                });
                affectedIds.push(artifact.id);
                resultSummary = `Ingested artifact: ${filename}`;
                primarySubjectStore = 'artifact';
                // KERNEL-008: switch arm must index the artifact too, matching
                // the helper. Previously this was a silent inconsistency: helper
                // indexed, switch arm did not.
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

                // Clean up the staging file ONLY on successful artifact ingest.
                // If we reach here the artifact store has the bytes and the
                // index entry exists; the staging file has served its purpose.
                if (stagingPathForCleanup) {
                    try {
                        unlinkSync(stagingPathForCleanup);
                    } catch {
                        // Best-effort: a leftover staging file is recoverable
                        // out-of-band; don't fail commit on cleanup.
                    }
                }
                break;
            }
            case 'link_evidence': {
                const { artifactId, entityId } = readyCommand.payload as {
                    artifactId: string;
                    entityId: string;
                };
                // KERNEL-007: this arm WAS a no-op. The helper linkEvidence()
                // verifies existence + appends an evidence_linked provenance
                // event. The switch arm must do the same — otherwise the
                // command path produces only a generic mutation_committed
                // event and TraceBuilder.traceEntity (which matches on
                // action === 'evidence_linked') sees no link.
                if (!(await this.stores.artifact.exists(artifactId))) {
                    throw new NotFoundError('artifact', artifactId);
                }
                if (!(await this.stores.canonical.exists(entityId))) {
                    throw new NotFoundError('canonical', entityId);
                }
                await recordProvenance(
                    this.stores.ledger,
                    'evidence_linked',
                    actorId,
                    entityId,
                    'canonical',
                    { artifactId, entityId },
                );
                affectedIds.push(artifactId, entityId);
                resultSummary = `Linked evidence: ${artifactId} → ${entityId}`;
                primarySubjectStore = 'canonical';
                break;
            }
            case 'reindex': {
                // KERNEL-R008: prior implementation was a no-op — it set
                // `resultSummary` and `primarySubjectStore` but never touched
                // the index. The arm now invokes the shared rebuild helper
                // ({@link performIndexRebuild}) so the actual rebuild work
                // happens. The surrounding `commitMutation` flow emits the
                // single `mutation_committed` provenance + receipt; we do
                // NOT call {@link rebuildIndex} here because that would
                // double-emit (its own provenance/receipt sequence runs
                // independently of this commit flow).
                const rebuilt = await this.performIndexRebuild();
                affectedIds.push('index');
                resultSummary = `Index rebuilt: ${rebuilt} records from owner stores`;
                primarySubjectStore = 'index';
                break;
            }
            default: {
                const rejected = markRejected(readyCommand, actorId, `Unknown verb: ${readyCommand.verb}`);
                this.saveCommand(rejected);
                throw new CommandRejectedError(commandId, `Unknown verb: ${readyCommand.verb}`);
            }
        }

        // Mark committed (in memory only — persistence + receipt are wrapped
        // in try/catch so a saveCommand-then-ledger-fail does not leave the
        // command marked 'committed' without a receipt).
        const committed = markCommitted(readyCommand, actorId);

        let provenance: ProvenanceEvent;
        let receipt: Receipt;
        try {
            provenance = await recordProvenance(
                this.stores.ledger,
                'mutation_committed',
                actorId,
                affectedIds[0] ?? commandId,
                readyCommand.targetStore,
                { commandId, verb: readyCommand.verb, payload: readyCommand.payload },
            );

            // Persist the committed-state command AFTER provenance so we never
            // have a 'committed' record without an associated provenance event.
            this.saveCommand(committed);

            receipt = await emitReceipt(
                this.stores.ledger,
                committed,
                resultSummary,
                affectedIds,
                provenance.id,
            );
        } catch (err) {
            const cause = err as Error;
            await this.recordOrphanMutation(
                affectedIds[0] ?? commandId,
                primarySubjectStore,
                commandId,
                cause,
                { verb: readyCommand.verb, payload: readyCommand.payload, actorId },
            );
            throw new ReceiptFailedError(affectedIds[0] ?? commandId, commandId, cause);
        }

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
            const reason = (err as Error).message;
            const rejected = markRejected(command, 'kernel:validator', reason);
            this.saveCommand(rejected);
            throw new CommandRejectedError(commandId, reason);
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
     *
     * KERNEL-B-007: ingest_artifact commands stage their Buffer payload to
     * `.db-cluster/pending-content/{contentHash}`. Rejection cleans that
     * file up so a rejected propose doesn't leak staged content into the
     * working directory.
     */
    async rejectMutation(commandId: string, rejectedBy: string, reason: string): Promise<Command> {
        const command = this.getCommand(commandId);
        if (!command) throw new NotFoundError('command', commandId);

        const rejected = rejectCommand(command, rejectedBy, reason);
        this.saveCommand(rejected);

        // Cleanup any staged Buffer payload for ingest_artifact rejections.
        if (command.verb === 'ingest_artifact') {
            this.deleteStagingFile((command.payload as { contentHash?: unknown }).contentHash);
        }

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

        // KERNEL-B-007: belt-and-suspenders cleanup. A committed
        // ingest_artifact's staging file is normally deleted on successful
        // commit. If something pathological left it behind and the command
        // is now being compensated, sweep it now.
        if (original.verb === 'ingest_artifact') {
            this.deleteStagingFile((original.payload as { contentHash?: unknown }).contentHash);
        }

        // Fast-track: validate + commit the compensating command
        const validated = validateCommand(compensatingCmd);
        const committed = markCommitted(validated, compensatedBy);

        let provenance: ProvenanceEvent;
        let receipt: Receipt;
        try {
            this.saveCommand(committed);

            // Mark the original as compensated
            const compensated = markCompensated(original, committed.id, compensatedBy);
            this.saveCommand(compensated);

            // Record provenance for compensation
            provenance = await recordProvenance(
                this.stores.ledger,
                'command_compensated',
                compensatedBy,
                originalCommandId,
                'ledger',
                { compensatingCommandId: committed.id, reason },
            );

            // Emit receipt for compensation
            receipt = await emitReceipt(
                this.stores.ledger,
                committed,
                `Compensated command ${originalCommandId}: ${reason}`,
                [originalCommandId],
                provenance.id,
            );

            return { compensatingCommand: committed, originalCommand: compensated, receipt };
        } catch (err) {
            const cause = err as Error;
            await this.recordOrphanMutation(
                originalCommandId,
                'ledger',
                committed.id,
                cause,
                {
                    verb: 'compensate',
                    originalCommandId,
                    compensatingCommandId: committed.id,
                    reason,
                    actorId: compensatedBy,
                },
            );
            throw new ReceiptFailedError(originalCommandId, committed.id, cause);
        }
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
     * Internal index rebuild — re-derives the index from canonical +
     * artifact source truth via the atomic {@link IndexStore.replaceAll}
     * contract method. Returns the count of records rebuilt.
     *
     * Factored out of {@link rebuildIndex} so that the `'reindex'` arm of
     * {@link commitMutation} can perform the actual rebuild work without
     * double-emitting provenance/receipt (KERNEL-R008). The two call sites
     * share this helper for the truth-mutation phase and emit their own
     * surrounding provenance/receipt sequence.
     *
     * KERNEL-R2-003 (regression-of-A2): the previous implementation
     * called `index.clear()` then looped `index.index(...)` calls, opening
     * an empty-index window between the clear and the first re-insert.
     * Concurrent readers during that window saw zero records. Wave A2
     * required adapters to implement `replaceAll` as an atomic swap
     * (STORES-R003) — `ops/rebuild.ts` was updated to use it, but this
     * helper was missed. We now build the full record set in memory and
     * commit it in one `replaceAll` call.
     */
    private async performIndexRebuild(): Promise<number> {
        const staged: Omit<IndexRecord, 'id' | 'indexedAt' | 'owner'>[] = [];

        // Stage all entities
        const entities = await this.stores.canonical.list();
        for (const entity of entities) {
            staged.push({
                sourceId: entity.id,
                sourceStore: 'canonical',
                text: `${entity.kind}: ${entity.name}`,
                metadata: { kind: entity.kind, ...entity.attributes },
            });
        }

        // Stage all artifacts
        const artifacts = await this.stores.artifact.list();
        for (const artifact of artifacts) {
            staged.push({
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
        }

        // Atomic swap. The contract guarantees `replaceAll` exists on
        // every adapter (STORES-R003), so no duck-typed fallback.
        await this.stores.index.replaceAll(staged);
        return staged.length;
    }

    /**
     * Rebuild the index from owner stores (canonical, artifact, ledger).
     * Clears the entire index, then re-derives from source truth.
     * Returns the count of records rebuilt.
     */
    async rebuildIndex(actorId: string): Promise<{ rebuilt: number; provenance: ProvenanceEvent; receipt: Receipt }> {
        const rebuilt = await this.performIndexRebuild();

        // Provenance + synthetic command persistence + receipt
        // (see KERNEL-002, KERNEL-005). Index mutation has already happened
        // at this point.
        const cmd = markCommitted(
            validateCommand(
                proposeCommand('reindex', 'index', { rebuilt }, actorId),
            ),
        );
        let provenance: ProvenanceEvent;
        let receipt: Receipt;
        try {
            provenance = await recordProvenance(
                this.stores.ledger,
                'index_rebuilt',
                actorId,
                'index',
                'index',
                { rebuilt, clearedFirst: true },
            );

            this.saveCommand(cmd);

            receipt = await emitReceipt(
                this.stores.ledger,
                cmd,
                `Index rebuilt: ${rebuilt} records from owner stores`,
                [],
                provenance.id,
            );
        } catch (err) {
            const cause = err as Error;
            await this.recordOrphanMutation('index', 'index', cmd.id, cause, {
                verb: 'reindex',
                rebuilt,
                actorId,
            });
            throw new ReceiptFailedError('index', cmd.id, cause);
        }

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
