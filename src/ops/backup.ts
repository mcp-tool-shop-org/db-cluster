/**
 * Backup & Restore — serializes/deserializes cluster state to/from portable format.
 * Preserves identity, provenance, mutation history, and policy state.
 */

import { createHash } from 'node:crypto';
import type { ClusterStores } from '../contracts/index.js';
import type { Entity } from '../types/entity.js';
import type { Artifact } from '../types/artifact.js';
import type { ProvenanceEvent } from '../types/provenance-event.js';
import type { Receipt } from '../types/receipt.js';
import type { Command } from '../types/command.js';

export interface ArtifactSnapshot {
    metadata: Artifact;
    /** Base64-encoded artifact content. Present when backup includes content. */
    contentBase64?: string;
}

export interface ClusterBackup {
    version: 1;
    createdAt: string;
    entities: Entity[];
    /** @deprecated Use artifactSnapshots instead. Kept for backward compat. */
    artifacts: Artifact[];
    /** Full artifact snapshots with content for complete restore. */
    artifactSnapshots?: ArtifactSnapshot[];
    events: ProvenanceEvent[];
    receipts: Receipt[];
    /** Command queue state (if kernel uses persistent commands). */
    commands?: Command[];
}

export interface BackupOptions {
    /** If true, include artifact content (base64). Default: true */
    includeContent?: boolean;
    /** CommandQueue instance to include in backup. */
    commandQueue?: { list(): Command[] };
}

export interface RestoreResult {
    entities: { created: number; skipped: number; errors: string[] };
    artifacts: { created: number; skipped: number; errors: string[] };
    events: { created: number; skipped: number; errors: string[] };
    receipts: { created: number; skipped: number; errors: string[] };
    commands?: { restored: number };
}

export interface RestoreOptions {
    /** CommandQueue instance to restore commands into. */
    commandQueue?: { save(command: Command): void; list(): Command[] };
}

/**
 * Export cluster state as a portable JSON backup.
 * Includes artifact content by default for complete restore.
 */
export async function backup(stores: ClusterStores, options?: BackupOptions): Promise<ClusterBackup> {
    const includeContent = options?.includeContent ?? true;
    const entities = await stores.canonical.list({});
    const artifacts = await stores.artifact.list({});
    const events = await stores.ledger.listEvents({});
    const receipts = await stores.ledger.listReceipts({});

    const artifactSnapshots: ArtifactSnapshot[] = [];
    for (const artifact of artifacts) {
        const snapshot: ArtifactSnapshot = { metadata: artifact };
        if (includeContent) {
            const content = await stores.artifact.getContent(artifact.id);
            if (content) {
                snapshot.contentBase64 = content.toString('base64');
            }
        }
        artifactSnapshots.push(snapshot);
    }

    const commands = options?.commandQueue ? options.commandQueue.list() : undefined;

    return {
        version: 1,
        createdAt: new Date().toISOString(),
        entities,
        artifacts,
        artifactSnapshots,
        events,
        receipts,
        commands,
    };
}

/**
 * Restore cluster state from a backup.
 * Existing records are skipped (idempotent). Index is rebuilt after restore.
 */
export async function restore(stores: ClusterStores, data: ClusterBackup, options?: RestoreOptions): Promise<RestoreResult> {
    if (data.version !== 1) {
        throw new Error(`Unsupported backup version: ${data.version}`);
    }

    const result: RestoreResult = {
        entities: { created: 0, skipped: 0, errors: [] },
        artifacts: { created: 0, skipped: 0, errors: [] },
        events: { created: 0, skipped: 0, errors: [] },
        receipts: { created: 0, skipped: 0, errors: [] },
    };

    // Restore entities
    for (const entity of data.entities) {
        try {
            const exists = await stores.canonical.exists(entity.id);
            if (exists) {
                result.entities.skipped++;
            } else {
                await stores.canonical.create({
                    kind: entity.kind,
                    name: entity.name,
                    attributes: entity.attributes,
                });
                result.entities.created++;
            }
        } catch (err: any) {
            result.entities.errors.push(`Entity ${entity.id}: ${err.message}`);
        }
    }

    // Restore artifacts (from snapshots if available, otherwise metadata-only)
    const snapshots: ArtifactSnapshot[] = data.artifactSnapshots ?? data.artifacts.map((a) => ({ metadata: a }));
    for (const snapshot of snapshots) {
        try {
            const exists = await stores.artifact.exists(snapshot.metadata.id);
            if (exists) {
                result.artifacts.skipped++;
            } else if (snapshot.contentBase64) {
                const content = Buffer.from(snapshot.contentBase64, 'base64');
                // Verify content integrity
                const hash = createHash('sha256').update(content).digest('hex');
                if (hash !== snapshot.metadata.contentHash) {
                    result.artifacts.errors.push(
                        `Artifact ${snapshot.metadata.id}: content checksum mismatch (expected ${snapshot.metadata.contentHash}, got ${hash})`,
                    );
                    continue;
                }
                // Use importSnapshot if available, otherwise ingest
                if ('importSnapshot' in stores.artifact && typeof stores.artifact.importSnapshot === 'function') {
                    await (stores.artifact as any).importSnapshot(snapshot.metadata, content);
                } else {
                    await stores.artifact.ingest({
                        filename: snapshot.metadata.filename,
                        content,
                        mimeType: snapshot.metadata.mimeType,
                    });
                }
                result.artifacts.created++;
            } else {
                // Metadata-only backup — cannot restore content
                result.artifacts.errors.push(
                    `Artifact ${snapshot.metadata.id}: no content in backup (metadata-only)`,
                );
            }
        } catch (err: any) {
            result.artifacts.errors.push(`Artifact ${snapshot.metadata.id}: ${err.message}`);
        }
    }

    // Restore provenance events
    for (const event of data.events) {
        try {
            const exists = await stores.ledger.getEvent(event.id);
            if (exists) {
                result.events.skipped++;
            } else {
                await stores.ledger.append({
                    action: event.action,
                    actorId: event.actorId,
                    subjectId: event.subjectId,
                    subjectStore: event.subjectStore,
                    detail: event.detail,
                    parentEventId: event.parentEventId,
                });
                result.events.created++;
            }
        } catch (err: any) {
            result.events.errors.push(`Event ${event.id}: ${err.message}`);
        }
    }

    // Restore receipts
    for (const receipt of data.receipts) {
        try {
            const exists = await stores.ledger.getReceipt(receipt.id);
            if (exists) {
                result.receipts.skipped++;
            } else {
                await stores.ledger.appendReceipt({
                    commandId: receipt.commandId,
                    resultSummary: receipt.resultSummary,
                    affectedIds: receipt.affectedIds,
                    provenanceEventId: receipt.provenanceEventId,
                });
                result.receipts.created++;
            }
        } catch (err: any) {
            result.receipts.errors.push(`Receipt ${receipt.id}: ${err.message}`);
        }
    }

    // Rebuild index after restore
    const { rebuildIndex } = await import('./rebuild.js');
    await rebuildIndex(stores);

    // Restore commands if command queue provided
    if (data.commands && options?.commandQueue) {
        for (const command of data.commands) {
            options.commandQueue.save(command);
        }
        result.commands = { restored: data.commands.length };
    }

    return result;
}
