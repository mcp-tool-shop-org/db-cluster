/**
 * Backup & Restore — serializes/deserializes cluster state to/from portable format.
 * Preserves identity, provenance, mutation history, and policy state.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ClusterStores } from '../contracts/index.js';
import type { Entity } from '../types/entity.js';
import type { Artifact } from '../types/artifact.js';
import type { ProvenanceEvent } from '../types/provenance-event.js';
import type { Receipt } from '../types/receipt.js';
import type { Command } from '../types/command.js';
import { ImportSnapshotNotSupportedError } from './errors.js';
import { assertContentMatch } from '../adapters/local/errors.js';

/**
 * Extract the stable identity-bearing fields from an Artifact metadata record
 * for the Wave A4 fix-up byte-equivalence check on re-restore. Excludes
 * `storagePath` (adapter-impl-specific, varies per data dir) and `owner`
 * (already excluded by assertContentMatch but spelled out here for clarity).
 *
 * If a backup tampers with id, filename, contentHash, mimeType, sizeBytes,
 * version, or ingestedAt, that mismatch surfaces as an ImportConflictError.
 * Tampering with storagePath alone is a no-op — the field is recomputed by
 * the artifact adapter on restore from contentHash, and pre-existing local
 * storagePath values for the same id naturally differ across data dirs.
 */
function stableArtifactFields(metadata: Record<string, unknown>): Record<string, unknown> {
    return {
        id: metadata.id,
        filename: metadata.filename,
        contentHash: metadata.contentHash,
        mimeType: metadata.mimeType,
        sizeBytes: metadata.sizeBytes,
        version: metadata.version,
        ingestedAt: metadata.ingestedAt,
    };
}

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
    /**
     * Pending-content staging files (V1-A4-004). Each entry is a base64-
     * encoded file from `<dataDir>/pending-content/`. Restored by
     * `restore()` into the target cluster's pending-content directory so
     * an in-flight ingest_artifact command's staged Buffer survives a
     * full backup→restore roundtrip.
     *
     * Optional: older backups (pre-Wave-B1-Amend) do not carry this
     * field; restore() treats its absence as "no staging files."
     */
    staging?: StagingSnapshot[];
}

/**
 * One staging file from `<dataDir>/pending-content/`. `contentHash` is the
 * filename (sha256 hex); `content` is the raw bytes base64-encoded.
 */
export interface StagingSnapshot {
    contentHash: string;
    content: string;
}

export interface BackupOptions {
    /** If true, include artifact content (base64). Default: true */
    includeContent?: boolean;
    /** CommandQueue instance to include in backup. */
    commandQueue?: { list(): Command[] };
    /**
     * Cluster data directory — required to include staging files
     * (V1-A4-004). Without it the staging snapshot is omitted. Most
     * call sites pass the same path used to construct the cluster.
     */
    dataDir?: string;
}

export interface RestoreResult {
    entities: { created: number; skipped: number; errors: string[] };
    artifacts: { created: number; skipped: number; errors: string[] };
    events: { created: number; skipped: number; errors: string[] };
    receipts: { created: number; skipped: number; errors: string[] };
    commands?: { restored: number };
    /**
     * Staging-file restore counts (V1-A4-004). `restored` is the number of
     * staging files written into `<dataDir>/pending-content/`. `errors`
     * accumulates per-file failures (e.g., contentHash mismatch).
     */
    staging?: { restored: number; skipped: number; errors: string[] };
}

export interface RestoreOptions {
    /** CommandQueue instance to restore commands into. */
    commandQueue?: { save(command: Command): void; list(): Command[] };
    /**
     * Cluster data directory — required to restore staging files
     * (V1-A4-004). Without it the staging snapshot is ignored. Most
     * call sites pass the same path used to construct the cluster.
     */
    dataDir?: string;
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

    // V1-A4-004: collect staging files from <dataDir>/pending-content/.
    // Each file's name is its sha256 hex contentHash; we keep that as the
    // entry id and base64-encode the bytes for transport. Tmp files
    // (`<hash>.<pid>-<rand>.tmp`) are NOT backed up — those are propose
    // in-flight noise that doctor's no_orphan_staging check sweeps away.
    let staging: StagingSnapshot[] | undefined;
    if (options?.dataDir) {
        const stagingDir = join(options.dataDir, 'pending-content');
        if (existsSync(stagingDir)) {
            staging = [];
            let entries: string[];
            try {
                entries = readdirSync(stagingDir);
            } catch {
                entries = [];
            }
            for (const entry of entries) {
                if (!/^[a-f0-9]{64}$/.test(entry)) continue;
                try {
                    const buf = readFileSync(join(stagingDir, entry));
                    staging.push({
                        contentHash: entry,
                        content: buf.toString('base64'),
                    });
                } catch {
                    // Best-effort: a transient read failure on one file
                    // should not fail the entire backup.
                }
            }
            if (staging.length === 0) staging = undefined;
        }
    }

    return {
        version: 1,
        createdAt: new Date().toISOString(),
        entities,
        artifacts,
        artifactSnapshots,
        events,
        receipts,
        commands,
        staging,
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
            const existsAlready = await stores.canonical.exists(entity.id);
            if (existsAlready) {
                // STORES-B-003 / Wave A4 fix-up: verify byte-equivalence before
                // declaring an idempotent skip. Pre-fix, restore() short-circuited
                // on exists() without ever calling importSnapshot() — so the new
                // ImportConflictError path inside the adapter was unreachable from
                // the end-to-end backup→restore flow, and a tampered backup with
                // a matching id but altered fields still silently masked. Calling
                // assertContentMatch here surfaces the mismatch via the
                // surrounding try/catch into result.entities.errors[].
                const existing = await stores.canonical.get(entity.id);
                if (existing) {
                    assertContentMatch('canonical', entity.id, existing as unknown as Record<string, unknown>, entity as unknown as Record<string, unknown>);
                }
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
                const existsAlready = await stores.artifact.exists(snapshot.metadata.id);
                if (existsAlready) {
                    // STORES-B-003 / Wave A4 fix-up: same rationale as the
                    // entities arm — short-circuiting on exists() without a
                    // byte-equivalence check meant a tampered artifact metadata
                    // record with a matching id but altered filename/mimeType/
                    // contentHash was silently masked. Fetch the existing
                    // metadata and call assertContentMatch; mismatches throw
                    // ImportConflictError, captured by the surrounding catch.
                    //
                    // Compare ONLY the operator-meaningful fields. `storagePath`
                    // is an implementation-only field stamped by the local
                    // adapter — its value reflects the target data dir, which
                    // differs from the backup's source data dir even for an
                    // identical artifact. Excluding it here keeps idempotent
                    // re-restore working while still surfacing tampering of
                    // the identity-bearing fields.
                    const existing = await stores.artifact.get(snapshot.metadata.id);
                    if (existing) {
                        const existingCmp = stableArtifactFields(existing as unknown as Record<string, unknown>);
                        const incomingCmp = stableArtifactFields(snapshot.metadata as unknown as Record<string, unknown>);
                        assertContentMatch('artifact', snapshot.metadata.id, existingCmp, incomingCmp);
                    }
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
            const existing = await stores.ledger.getEvent(event.id);
            if (existing) {
                // STORES-B-003 / Wave A4 fix-up: events are append-only by
                // intent, but a tampered backup could still try to overlay an
                // existing event id with altered detail/actorId/parentEventId.
                // Apply the same byte-equivalence gate as entities/artifacts
                // for symmetry — the silent first-write-wins hole would
                // otherwise persist on this arm.
                assertContentMatch('ledger-event', event.id, existing as unknown as Record<string, unknown>, event as unknown as Record<string, unknown>);
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
            const existing = await stores.ledger.getReceipt(receipt.id);
            if (existing) {
                // STORES-B-003 / Wave A4 fix-up: same byte-equivalence gate
                // as events for symmetry. A tampered backup could overlay an
                // existing receipt id with altered resultSummary/affectedIds.
                assertContentMatch('ledger-receipt', receipt.id, existing as unknown as Record<string, unknown>, receipt as unknown as Record<string, unknown>);
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

    // V1-A4-004: restore staging files into <dataDir>/pending-content/.
    // Each staging entry's contentHash field must match sha256(content) — a
    // mismatch indicates tampering and the entry is rejected per-file rather
    // than aborting the whole restore. Missing `data.staging` (older backup
    // format) is a no-op — silently treated as "no staging files."
    if (options?.dataDir && Array.isArray(data.staging) && data.staging.length > 0) {
        const stagingDir = join(options.dataDir, 'pending-content');
        try {
            mkdirSync(stagingDir, { recursive: true });
        } catch {
            // Defer error surfacing to the per-entry loop.
        }
        const stagingResult = { restored: 0, skipped: 0, errors: [] as string[] };
        for (const entry of data.staging) {
            try {
                if (!/^[a-f0-9]{64}$/.test(entry.contentHash)) {
                    stagingResult.errors.push(
                        `Staging entry rejected: invalid contentHash shape (${entry.contentHash.slice(0, 16)}...)`,
                    );
                    continue;
                }
                const buf = Buffer.from(entry.content, 'base64');
                const actualHash = createHash('sha256').update(buf).digest('hex');
                if (actualHash !== entry.contentHash) {
                    stagingResult.errors.push(
                        `Staging entry ${entry.contentHash}: content hash mismatch (got ${actualHash})`,
                    );
                    continue;
                }
                const targetPath = join(stagingDir, entry.contentHash);
                if (existsSync(targetPath)) {
                    stagingResult.skipped++;
                    continue;
                }
                writeFileSync(targetPath, buf);
                stagingResult.restored++;
            } catch (err: any) {
                stagingResult.errors.push(`Staging entry ${entry.contentHash}: ${err.message}`);
            }
        }
        result.staging = stagingResult;
    }

    return result;
}
