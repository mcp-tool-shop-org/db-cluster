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
import { ImportSnapshotNotSupportedError } from './errors.js';

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

    // Restore entities — preserves original IDs (STORES-001).
    // `importSnapshot(entity)` is mandatory; falling back to `create()` would
    // assign a fresh randomUUID and break every restored entity's provenance
    // chain (the post-restore provenance events still reference the original
    // subjectId). If the adapter doesn't implement it, fail loudly.
    const canonicalImport = (stores.canonical as { importSnapshot?: (entity: Entity) => Promise<Entity> }).importSnapshot;
    if (typeof canonicalImport !== 'function') {
        throw new ImportSnapshotNotSupportedError('canonical', 'importSnapshot');
    }
    for (const entity of data.entities) {
        try {
            const exists = await stores.canonical.exists(entity.id);
            if (exists) {
                result.entities.skipped++;
            } else {
                await canonicalImport.call(stores.canonical, entity);
                result.entities.created++;
            }
        } catch (err: any) {
            result.entities.errors.push(`Entity ${entity.id}: ${err.message}`);
        }
    }

    // Restore artifacts (from snapshots if available, otherwise metadata-only).
    // `importSnapshot(metadata, content)` is mandatory for the same reason as
    // canonical — the silent `ingest()` fallback assigned new UUIDs and lost
    // original IDs (STORES-003). If the adapter doesn't implement it, fail
    // loudly before mutating anything.
    const snapshots: ArtifactSnapshot[] = data.artifactSnapshots ?? data.artifacts.map((a) => ({ metadata: a }));
    if (snapshots.length > 0) {
        const artifactImport = (stores.artifact as { importSnapshot?: (metadata: Artifact, content: Buffer) => Promise<Artifact> }).importSnapshot;
        if (typeof artifactImport !== 'function') {
            throw new ImportSnapshotNotSupportedError('artifact', 'importSnapshot');
        }
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
                    await artifactImport.call(stores.artifact, snapshot.metadata, content);
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
    }

    // Restore provenance events — preserves original IDs + timestamps + parent
    // links (STORES-002). `append()` always assigns a fresh randomUUID, so a
    // re-run finds the original id absent and re-inserts → silent duplication.
    // `importEvent(event)` is mandatory; if missing, fail loudly.
    const ledgerImportEvent = (stores.ledger as { importEvent?: (event: ProvenanceEvent) => Promise<ProvenanceEvent> }).importEvent;
    if (data.events.length > 0 && typeof ledgerImportEvent !== 'function') {
        throw new ImportSnapshotNotSupportedError('ledger', 'importEvent');
    }
    for (const event of data.events) {
        try {
            const exists = await stores.ledger.getEvent(event.id);
            if (exists) {
                result.events.skipped++;
            } else {
                await ledgerImportEvent!.call(stores.ledger, event);
                result.events.created++;
            }
        } catch (err: any) {
            result.events.errors.push(`Event ${event.id}: ${err.message}`);
        }
    }

    // Restore receipts — same story as events: `appendReceipt()` re-numbers
    // ids, breaking idempotency. `importReceipt(receipt)` is mandatory.
    const ledgerImportReceipt = (stores.ledger as { importReceipt?: (receipt: Receipt) => Promise<Receipt> }).importReceipt;
    if (data.receipts.length > 0 && typeof ledgerImportReceipt !== 'function') {
        throw new ImportSnapshotNotSupportedError('ledger', 'importReceipt');
    }
    for (const receipt of data.receipts) {
        try {
            const exists = await stores.ledger.getReceipt(receipt.id);
            if (exists) {
                result.receipts.skipped++;
            } else {
                await ledgerImportReceipt!.call(stores.ledger, receipt);
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
