/**
 * Rebuild — reconstructs derivative state from owner truth.
 * Never mutates canonical, artifact, or ledger stores.
 */

import type { ClusterStores } from '../contracts/index.js';

export interface RebuildResult {
    rebuilt: number;
    removed: number;
    errors: string[];
    dryRun: boolean;
}

export interface StaleRecord {
    type: 'missing_from_index' | 'orphan_index_record';
    sourceId: string;
    sourceStore: string;
    message: string;
}

/**
 * Rebuild the index from canonical + artifact owner truth.
 * Does NOT mutate canonical, artifact, or ledger.
 */
export async function rebuildIndex(stores: ClusterStores, options?: { dryRun?: boolean }): Promise<RebuildResult> {
    const dryRun = options?.dryRun ?? false;
    const errors: string[] = [];
    let rebuilt = 0;
    let removed = 0;

    // Clear existing index (unless dry run)
    if (!dryRun) {
        await stores.index.clear();
    }

    // Re-index all canonical entities
    const entities = await stores.canonical.list({});
    for (const entity of entities) {
        try {
            if (!dryRun) {
                await stores.index.index({
                    sourceId: entity.id,
                    sourceStore: 'canonical',
                    text: `${entity.kind}: ${entity.name}`,
                    metadata: { kind: entity.kind, ...entity.attributes },
                });
            }
            rebuilt++;
        } catch (err: any) {
            errors.push(`Failed to index entity ${entity.id}: ${err.message}`);
        }
    }

    // Re-index all artifacts
    const artifacts = await stores.artifact.list({});
    for (const artifact of artifacts) {
        try {
            if (!dryRun) {
                await stores.index.index({
                    sourceId: artifact.id,
                    sourceStore: 'artifact',
                    text: `${artifact.filename} v${artifact.version}`,
                    metadata: { filename: artifact.filename, mimeType: artifact.mimeType, version: artifact.version },
                });
            }
            rebuilt++;
        } catch (err: any) {
            errors.push(`Failed to index artifact ${artifact.id}: ${err.message}`);
        }
    }

    return { rebuilt, removed, errors, dryRun };
}

/**
 * Check for stale index records — orphan pointers or missing entries.
 */
export async function checkStale(stores: ClusterStores): Promise<StaleRecord[]> {
    const stale: StaleRecord[] = [];

    // Check index records pointing to non-existent sources
    const indexRecords = await stores.index.search({});
    for (const record of indexRecords) {
        if (record.sourceStore === 'canonical') {
            const exists = await stores.canonical.exists(record.sourceId);
            if (!exists) {
                stale.push({
                    type: 'orphan_index_record',
                    sourceId: record.sourceId,
                    sourceStore: 'canonical',
                    message: `Index record references non-existent canonical entity ${record.sourceId}`,
                });
            }
        } else if (record.sourceStore === 'artifact') {
            const exists = await stores.artifact.exists(record.sourceId);
            if (!exists) {
                stale.push({
                    type: 'orphan_index_record',
                    sourceId: record.sourceId,
                    sourceStore: 'artifact',
                    message: `Index record references non-existent artifact ${record.sourceId}`,
                });
            }
        }
    }

    // Check entities/artifacts missing from index
    const entities = await stores.canonical.list({});
    for (const entity of entities) {
        const results = await stores.index.search({ text: `${entity.kind}: ${entity.name}`, limit: 1 });
        const found = results.some((r) => r.sourceId === entity.id);
        if (!found) {
            stale.push({
                type: 'missing_from_index',
                sourceId: entity.id,
                sourceStore: 'canonical',
                message: `Entity ${entity.id} (${entity.kind}: ${entity.name}) not indexed`,
            });
        }
    }

    return stale;
}
