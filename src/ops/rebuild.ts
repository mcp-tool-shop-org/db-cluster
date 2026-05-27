/**
 * Rebuild — reconstructs derivative state from owner truth.
 * Never mutates canonical, artifact, or ledger stores.
 */

import type { ClusterStores } from '../contracts/index.js';
import type { IndexRecord } from '../types/index-record.js';
import { buildArtifactIndexText } from '../indexing/content-indexer.js';

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

/** A staged index record — same shape as IndexStore.index() input. */
type StagedRecord = Omit<IndexRecord, 'id' | 'indexedAt' | 'owner'>;

/**
 * Rebuild the index from canonical + artifact owner truth.
 * Uses content-aware indexing for artifacts.
 * Does NOT mutate canonical, artifact, or ledger.
 *
 * Strategy (STORES-008): build the full list of replacement records in memory
 * BEFORE touching the live index, then either
 *   - call `replaceAll` (if available) for an atomic in-place swap, or
 *   - fall back to clear() + index() in tight succession.
 * Both paths keep the "empty index" window as short as possible. The old code
 * cleared the index unconditionally at the top of the function, leaving readers
 * to see a fully-empty index if the function crashed mid-way through reindexing.
 */
export async function rebuildIndex(stores: ClusterStores, options?: { dryRun?: boolean }): Promise<RebuildResult> {
    const dryRun = options?.dryRun ?? false;
    const errors: string[] = [];
    let rebuilt = 0;
    const removed = 0;

    // 1. STAGE — build replacement records without touching the live index.
    const staged: StagedRecord[] = [];

    // Canonical entities
    const entities = await stores.canonical.list({});
    for (const entity of entities) {
        try {
            staged.push({
                sourceId: entity.id,
                sourceStore: 'canonical',
                text: `${entity.kind}: ${entity.name}`,
                metadata: { kind: entity.kind, ...entity.attributes },
            });
            rebuilt++;
        } catch (err: any) {
            errors.push(`Failed to stage entity ${entity.id}: ${err.message}`);
        }
    }

    // Artifacts (content-aware text extraction)
    const artifacts = await stores.artifact.list({});
    for (const artifact of artifacts) {
        try {
            const contentBuf = await stores.artifact.getContent(artifact.id);
            let indexText: string;
            if (
                contentBuf &&
                (artifact.mimeType.startsWith('text/') ||
                    artifact.filename.endsWith('.md') ||
                    artifact.filename.endsWith('.txt'))
            ) {
                const content = contentBuf.toString('utf-8');
                indexText = buildArtifactIndexText(artifact, content);
            } else {
                indexText = `${artifact.filename} v${artifact.version}`;
            }
            staged.push({
                sourceId: artifact.id,
                sourceStore: 'artifact',
                text: indexText,
                metadata: {
                    filename: artifact.filename,
                    mimeType: artifact.mimeType,
                    version: artifact.version,
                },
            });
            rebuilt++;
        } catch (err: any) {
            errors.push(`Failed to stage artifact ${artifact.id}: ${err.message}`);
        }
    }

    if (dryRun) {
        return { rebuilt, removed, errors, dryRun };
    }

    // 2. SWAP — atomic if the store supports replaceAll, otherwise clear+index
    //    in tight succession. The empty-index window is one filesystem rename
    //    on the replaceAll path; on the fallback path it is the time taken to
    //    re-emit `staged.length` records (small but non-zero).
    const indexStore = stores.index as unknown as {
        replaceAll?: (records: StagedRecord[]) => Promise<void>;
    };
    if (typeof indexStore.replaceAll === 'function') {
        try {
            await indexStore.replaceAll(staged);
        } catch (err: any) {
            errors.push(`Atomic index swap failed: ${err.message}`);
        }
    } else {
        await stores.index.clear();
        for (const record of staged) {
            try {
                await stores.index.index(record);
            } catch (err: any) {
                errors.push(`Failed to write index record for ${record.sourceId}: ${err.message}`);
            }
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
