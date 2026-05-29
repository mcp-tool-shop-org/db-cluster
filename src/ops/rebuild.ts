/**
 * Rebuild — reconstructs derivative state from owner truth.
 * Never mutates canonical, artifact, or ledger stores.
 */

import { createHash } from 'node:crypto';
import type { ClusterStores } from '../contracts/index.js';
import type { IndexRecord } from '../types/index-record.js';
import { buildArtifactIndexText } from '../indexing/content-indexer.js';

/**
 * Structurally detect a content-read integrity failure thrown by the hardened
 * `ArtifactStore.getContent` (PROV-001). Matched by `name` / `code` rather than
 * `instanceof` so the ops layer does NOT take a hard import on the adapter
 * package (no back-edge) and so it recognizes the error regardless of which
 * concrete class the adapter throws (`ContentReadIntegrityError`, and the
 * adjacent `InvalidContentHashError` path-traversal guard). Both mean "the
 * stored content cannot be trusted — do not index it."
 */
function isContentIntegrityError(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    const name = (err as { name?: unknown }).name;
    const code = (err as { code?: unknown }).code;
    if (typeof name === 'string' && /ContentReadIntegrity|InvalidContentHash/i.test(name)) {
        return true;
    }
    if (typeof code === 'string' && /CONTENT_READ_INTEGRITY|INVALID_CONTENT_HASH/i.test(code)) {
        return true;
    }
    return false;
}

export interface RebuildResult {
    rebuilt: number;
    removed: number;
    errors: string[];
    dryRun: boolean;
}

export interface RebuildOptions {
    /** Stage + show plan without mutating. Default: false. */
    dryRun?: boolean;
    /**
     * Progress callback fired between records as they are staged + after the
     * atomic swap completes (STORES-C-002). `current` is the count of records
     * staged so far, `total` is the count of canonical entities plus artifacts
     * the rebuild will walk. Optional — CLI subscribes for a progress bar.
     */
    onProgress?: (current: number, total: number, message?: string) => void;
}

export interface StaleRecord {
    type: 'missing_from_index' | 'orphan_index_record';
    sourceId: string;
    sourceStore: string;
    message: string;
    /**
     * Operator-facing remediation hint (STORES-C-008). Always names the
     * `db-cluster rebuild index` command so a stale-records render at the
     * CLI / dashboard can append `→ fix: db-cluster rebuild index` without
     * the consumer knowing the remediation surface.
     */
    suggestedCommand: string;
}

/** A staged index record — same shape as IndexStore.index() input. */
type StagedRecord = Omit<IndexRecord, 'id' | 'indexedAt' | 'owner'>;

/**
 * Rebuild the index from canonical + artifact owner truth.
 *
 * Strategy (STORES-008 / STORES-R003): build the full list of replacement
 * records in memory BEFORE touching the live index, then atomically swap them
 * in via `IndexStore.replaceAll` — a method that is now required on the
 * contract (was previously duck-typed). The empty-index window collapses to
 * a single filesystem rename on the local adapter. Pre-STORES-R003 the
 * function fell back to clear() + index() if the method was missing; that
 * fallback is gone now that the contract guarantees the method exists.
 *
 * Long-running on large clusters: ~1ms per record on warm hardware, ~5ms per
 * record with content extraction on text artifacts. Callers should pass
 * `options.onProgress` to render a progress bar (STORES-C-002).
 *
 * @param stores   ClusterStores bundle. Reads canonical.list + artifact.list
 *                 + artifact.getContent. Never mutates canonical/artifact/ledger.
 * @param options  See {@link RebuildOptions}. `dryRun: true` stages records
 *                 and returns counts WITHOUT calling `index.replaceAll`.
 * @returns        {@link RebuildResult} carrying rebuilt count + errors[] +
 *                 the echoed `dryRun` flag.
 * @throws         Doesn't normally throw — per-record staging errors are
 *                 collected in `result.errors[]`. The only path that throws
 *                 is `index.replaceAll` failure (rendered as an error and
 *                 surfaced via the result's `errors[]`).
 *
 * @example
 *   const result = await rebuildIndex(stores, {
 *       onProgress: (current, total, label) => {
 *           process.stdout.write(`\r${current}/${total} ${label ?? ''}`);
 *       },
 *   });
 *   console.log(`\nRebuilt ${result.rebuilt} records, ${result.errors.length} errors`);
 */
export async function rebuildIndex(stores: ClusterStores, options?: RebuildOptions): Promise<RebuildResult> {
    const dryRun = options?.dryRun ?? false;
    const onProgress = options?.onProgress;
    const errors: string[] = [];
    let rebuilt = 0;
    const removed = 0;

    // 1. STAGE — build replacement records without touching the live index.
    const staged: StagedRecord[] = [];

    // Canonical entities + artifacts make up the total walk. Fetch both lists
    // up front so we have an honest `total` for progress reporting.
    const entities = await stores.canonical.list({});
    const artifacts = await stores.artifact.list({});
    const total = entities.length + artifacts.length;
    let current = 0;
    const tick = (label?: string) => {
        try {
            onProgress?.(current, total, label);
        } catch {
            // Best-effort.
        }
    };

    // Canonical entities
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
        current++;
        tick(`staging entity ${entity.id}`);
    }

    // Artifacts (content-aware text extraction)
    //
    // PROV-001 (Wave S2-A1): content is obtained via the HARDENED
    // `stores.artifact.getContent(id)`, which re-hashes the on-disk bytes
    // against the metadata `contentHash` and THROWS a `ContentReadIntegrityError`
    // when they no longer match (tampered blob). We catch the throw and surface
    // it LOUDLY in `errors[]` — the artifact is NOT staged, so a rebuild can
    // never index poisoned content. This is the load-bearing "skip + report,
    // never silently index poison" behaviour the finding requires. A generic
    // staging failure is reported with the same channel but a distinct prefix
    // so operators can tell a tamper from a transient I/O blip.
    for (const artifact of artifacts) {
        try {
            const contentBuf = await stores.artifact.getContent(artifact.id);
            // PROV-001 defense-in-depth: the hardened adapter throws on a
            // hash mismatch, but the rebuild ALSO re-hashes the returned bytes
            // against the recorded contentHash before indexing. This adjacent
            // `createHash('sha256')` integrity check means a tampered blob is
            // refused even on an adapter that has not yet adopted verify-on-read
            // — poisoned content never reaches the index. Throwing here routes
            // into the integrity-aware catch below.
            if (contentBuf) {
                const actualHash = createHash('sha256').update(contentBuf).digest('hex');
                if (actualHash !== artifact.contentHash) {
                    const integrityError: Error & { code?: string } = new Error(
                        `sha256(on-disk bytes)=${actualHash} != recorded contentHash=${artifact.contentHash}`,
                    );
                    integrityError.name = 'ContentReadIntegrityError';
                    integrityError.code = 'CONTENT_READ_INTEGRITY';
                    throw integrityError;
                }
            }
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
            if (isContentIntegrityError(err)) {
                errors.push(
                    `Refusing to index artifact ${artifact.id} (${artifact.filename}): content integrity ` +
                        `check failed — the on-disk bytes do not hash to the recorded contentHash ` +
                        `(tampered blob). ${err.message ?? ''}`.trim(),
                );
            } else {
                errors.push(`Failed to stage artifact ${artifact.id}: ${err.message}`);
            }
        }
        current++;
        tick(`staging artifact ${artifact.id}`);
    }

    if (dryRun) {
        tick('dry-run complete');
        return { rebuilt, removed, errors, dryRun };
    }

    // 2. SWAP — atomic replacement via contract method. The empty-index window
    //    is one filesystem rename on the local adapter.
    try {
        await stores.index.replaceAll(staged);
        tick('atomic swap complete');
    } catch (err: any) {
        errors.push(`Atomic index swap failed: ${err.message}`);
    }

    return { rebuilt, removed, errors, dryRun };
}

/**
 * Check for stale index records — orphan pointers or missing entries.
 *
 * Returns a list of {@link StaleRecord} entries; each carries
 * `suggestedCommand: 'db-cluster rebuild index'` so CLI/dashboard surfaces
 * can render `→ fix: ${suggestedCommand}` without conditional branching
 * (STORES-C-008).
 *
 * @param stores  ClusterStores bundle. Reads index.search + canonical.list /
 *                .exists + artifact.exists. Never mutates state.
 * @returns       List of stale records. Empty array means the index is in
 *                sync with owner truth.
 * @throws        Adapter-level exceptions from index.search / canonical.list
 *                propagate; callers should catch and route to the doctor /
 *                verify surface as a check failure.
 *
 * @example
 *   const stale = await checkStale(stores);
 *   if (stale.length > 0) {
 *       console.error(`${stale.length} stale records`);
 *       // Same fix command for every entry; render once at the bottom:
 *       console.error(`→ fix: ${stale[0].suggestedCommand}`);
 *   }
 */
export async function checkStale(stores: ClusterStores): Promise<StaleRecord[]> {
    const stale: StaleRecord[] = [];
    const FIX = 'db-cluster rebuild index';

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
                    suggestedCommand: FIX,
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
                    suggestedCommand: FIX,
                });
            }
        } else if (record.sourceStore === 'ledger') {
            // RETR-006: ledger-sourced index records were silently skipped. A
            // ledger record pointing at a deleted event is an orphan, mirroring
            // the canonical/artifact arms. getEvent throws on tamper (PROV-004)
            // — an integrity concern, not an orphan — so treat a throw as present.
            let present = true;
            try {
                present = (await stores.ledger.getEvent(record.sourceId)) !== null;
            } catch {
                present = true;
            }
            if (!present) {
                stale.push({
                    type: 'orphan_index_record',
                    sourceId: record.sourceId,
                    sourceStore: 'ledger',
                    message: `Index record references non-existent ledger event ${record.sourceId}`,
                    suggestedCommand: FIX,
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
                suggestedCommand: FIX,
            });
        }
    }

    return stale;
}
