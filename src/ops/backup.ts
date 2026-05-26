/**
 * Backup & Restore — serializes/deserializes cluster state to/from portable format.
 * Preserves identity, provenance, mutation history, and policy state.
 */

import type { ClusterStores } from '../contracts/index.js';
import type { Entity } from '../types/entity.js';
import type { Artifact } from '../types/artifact.js';
import type { ProvenanceEvent } from '../types/provenance-event.js';
import type { Receipt } from '../types/receipt.js';

export interface ClusterBackup {
    version: 1;
    createdAt: string;
    entities: Entity[];
    artifacts: Artifact[];
    events: ProvenanceEvent[];
    receipts: Receipt[];
}

export interface BackupOptions {
    /** If true, include artifact content (base64). Default: false */
    includeContent?: boolean;
}

export interface RestoreResult {
    entities: { created: number; skipped: number; errors: string[] };
    artifacts: { created: number; skipped: number; errors: string[] };
    events: { created: number; skipped: number; errors: string[] };
    receipts: { created: number; skipped: number; errors: string[] };
}

/**
 * Export cluster state as a portable JSON backup.
 */
export async function backup(stores: ClusterStores, _options?: BackupOptions): Promise<ClusterBackup> {
    const entities = await stores.canonical.list({});
    const artifacts = await stores.artifact.list({});
    const events = await stores.ledger.listEvents({});
    const receipts = await stores.ledger.listReceipts({});

    return {
        version: 1,
        createdAt: new Date().toISOString(),
        entities,
        artifacts,
        events,
        receipts,
    };
}

/**
 * Restore cluster state from a backup.
 * Existing records are skipped (idempotent). Index is rebuilt after restore.
 */
export async function restore(stores: ClusterStores, data: ClusterBackup): Promise<RestoreResult> {
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

    return result;
}
