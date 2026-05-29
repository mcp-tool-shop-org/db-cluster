import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import type { Artifact } from '../../types/artifact.js';
import type {
    ArtifactStore,
    ArtifactFilter,
    ArtifactIngestInput,
} from '../../contracts/artifact-store.js';
import {
    CorruptStoreError,
    InvalidContentHashError,
    ContentReadIntegrityError,
    isValidContentHash,
    assertContentMatch,
} from './errors.js';
import {
    buildRandomTmpPath,
    cleanupOrphanTmpFiles,
    sweepContentDirOrphans,
} from './tmp-cleanup.js';

/**
 * Local artifact store — filesystem-backed immutable artifact persistence.
 * Content is stored as individual files addressed by hash.
 * Metadata is stored in artifacts.json.
 * Proves: immutable write, content addressing, version identity.
 * NO update method. Re-ingesting the same filename creates a new version.
 *
 * Writes to artifacts.json are atomic via tmp + rename. Reads fail loudly
 * with CorruptStoreError on malformed JSON.
 */
export class LocalArtifactStore implements ArtifactStore {
    private readonly metaPath: string;
    private readonly contentDir: string;
    private artifacts: Map<string, Artifact>;

    constructor(dataDir: string) {
        mkdirSync(dataDir, { recursive: true });
        this.metaPath = join(dataDir, 'artifacts.json');
        this.contentDir = join(dataDir, 'content');
        mkdirSync(this.contentDir, { recursive: true });
        // STORES-B-001: sweep orphan random-suffix tmp files for the
        // metadata file AND for every content-hash file in the content dir.
        // The content dir's basenames are sha256 hex hashes — we can't list
        // every basename, so we sweep with a permissive base pattern. Since
        // content files are named [a-f0-9]{64} their tmp variants look like
        // `<hash>.<pid>-<rand>.tmp` — the existing helper takes a baseName
        // so we run the sweep for each .tmp suffix file we discover.
        cleanupOrphanTmpFiles(dirname(this.metaPath), basename(this.metaPath));
        sweepContentDirOrphans(this.contentDir);
        this.artifacts = this.load();
    }

    async get(id: string): Promise<Artifact | null> {
        return this.artifacts.get(id) ?? null;
    }

    async getContent(id: string): Promise<Buffer | null> {
        const artifact = this.artifacts.get(id);
        if (!artifact) return null;
        // Gate 1 — shape / path-traversal defence (STORES-R005). Re-validate
        // contentHash before using it as a path component. The in-memory map
        // mirrors artifacts.json; if that file is tampered after load, the hash
        // here could carry a path traversal payload. importSnapshot validates
        // on write; getContent validates on read.
        if (!isValidContentHash(artifact.contentHash)) {
            throw new InvalidContentHashError(String(artifact.contentHash));
        }
        const contentPath = join(this.contentDir, artifact.contentHash);
        if (!existsSync(contentPath)) return null;
        const buf = readFileSync(contentPath);
        // Gate 2 — content read-integrity (PROV-001). The artifact store is
        // content-addressed and immutable: the bytes at this path MUST hash to
        // the recorded contentHash. If they no longer do, the on-disk blob was
        // altered out from under its metadata (the exact tamper STORES-006 /
        // STORES-R005 defends). The prior implementation returned these bytes
        // verbatim — promoted here from aspirational to an enforced throw. Both
        // gates are required: gate 1 stops a malicious *path*, gate 2 stops
        // malicious *bytes* at a legitimate path.
        const actualHash = createHash('sha256').update(buf).digest('hex');
        if (actualHash !== artifact.contentHash) {
            // Deliberately pass the contentHash (not the absolute contentPath)
            // so no absolute filesystem path leaks into the error message.
            throw new ContentReadIntegrityError(
                artifact.id,
                artifact.contentHash,
                actualHash,
            );
        }
        return buf;
    }

    async list(filter?: ArtifactFilter): Promise<Artifact[]> {
        let results = Array.from(this.artifacts.values());

        if (filter?.mimeType) {
            results = results.filter((a) => a.mimeType === filter.mimeType);
        }
        if (filter?.filenameContains) {
            const q = filter.filenameContains.toLowerCase();
            results = results.filter((a) => a.filename.toLowerCase().includes(q));
        }
        if (filter?.limit) {
            results = results.slice(0, filter.limit);
        }
        return results;
    }

    async exists(id: string): Promise<boolean> {
        return this.artifacts.has(id);
    }

    async ingest(input: ArtifactIngestInput): Promise<Artifact> {
        const contentHash = createHash('sha256').update(input.content).digest('hex');

        // Determine version — count existing artifacts with the same filename
        const existing = Array.from(this.artifacts.values()).filter(
            (a) => a.filename === input.filename,
        );
        const version = existing.length + 1;

        const artifact: Artifact = {
            id: randomUUID(),
            filename: input.filename,
            contentHash,
            mimeType: input.mimeType,
            sizeBytes: input.content.length,
            version,
            storagePath: join(this.contentDir, contentHash),
            ingestedAt: new Date().toISOString(),
            owner: 'artifact',
        };

        // Write content by hash — content-addressed, deduplicates identical content.
        //
        // STORES-R2-005: write atomically via tmp + rename so a crash
        // mid-write does not leave a partial content file. The pre-fix
        // plain `writeFileSync(contentPath, ...)` left an orphan partial
        // file if the process died after `writeFileSync` opened/truncated
        // the target but before it finished writing. The metadata persist
        // path is already atomic — this brings the content write into
        // symmetry. On failure we unlink the tmp file (best-effort) so no
        // `.tmp` orphan accumulates and rethrow so the caller sees the
        // failure (matches the previous semantics).
        //
        // STORES-B-001 (Wave A4): the tmp path now embeds process.pid and
        // a random suffix so two processes ingesting the same content
        // concurrently never race on the same tmp file. The dedup gate
        // (`if (!existsSync(contentPath))`) still wins on the final path —
        // content addressing means both writers produce byte-identical
        // bytes anyway, so the loser's renameSync is harmless.
        const contentPath = join(this.contentDir, contentHash);
        if (!existsSync(contentPath)) {
            const tmpContentPath = buildRandomTmpPath(contentPath);
            try {
                writeFileSync(tmpContentPath, input.content);
                renameSync(tmpContentPath, contentPath);
            } catch (err) {
                // Best-effort cleanup — if the tmp file was created before
                // the failure, remove it so we don't leak `.tmp` orphans.
                try {
                    if (existsSync(tmpContentPath)) {
                        unlinkSync(tmpContentPath);
                    }
                } catch {
                    // Cleanup is best-effort. The primary error wins.
                }
                throw err;
            }
        }

        this.artifacts.set(artifact.id, artifact);
        this.persist();
        return artifact;
    }

    async versions(filename: string): Promise<Artifact[]> {
        return Array.from(this.artifacts.values())
            .filter((a) => a.filename === filename)
            .sort((a, b) => a.version - b.version);
    }

    /**
     * Import a full artifact snapshot preserving original ID and metadata.
     * Used by restore to recreate artifacts exactly as backed up.
     *
     * SECURITY: validates `metadata.contentHash` against /^[a-f0-9]{64}$/ BEFORE
     * using it as a path component. Without this check, a tampered backup with
     * `contentHash = '../../escape'` would write outside the artifact contentDir
     * (STORES-006). InvalidContentHashError is thrown on bad input.
     *
     * Idempotent on byte-identical re-import: if an artifact with the same id
     * is already present and its metadata content equals the incoming snapshot
     * (excluding store-stamped `owner` and `storagePath` which is rewritten on
     * import), the existing record is returned.
     *
     * Throws ImportConflictError (STORES-B-003) when an artifact with the same
     * id exists but its metadata DIFFERS. Pre-fix the existing record was
     * silently returned, masking tampered backups. We exclude `storagePath`
     * from the comparison because that field is intentionally rewritten on
     * import to point at the current cluster's contentDir — so two snapshots
     * of the same artifact in two different clusters legitimately have
     * different storagePath values.
     */
    async importSnapshot(metadata: Artifact, content: Buffer): Promise<Artifact> {
        if (!isValidContentHash(metadata.contentHash)) {
            throw new InvalidContentHashError(String(metadata.contentHash));
        }

        const existing = this.artifacts.get(metadata.id);
        if (existing) {
            // STORES-B-003: assert content equality between existing and
            // incoming, excluding owner (store-stamped) and storagePath
            // (intentionally rewritten on import).
            const existingComparable = {
                ...(existing as unknown as Record<string, unknown>),
                storagePath: undefined,
            };
            const incomingComparable = {
                ...(metadata as unknown as Record<string, unknown>),
                storagePath: undefined,
            };
            assertContentMatch(
                'artifact',
                metadata.id,
                existingComparable,
                incomingComparable,
            );
            return existing;
        }

        // Write content by hash — safe to join now that we've validated the hash shape.
        //
        // V1-004 fix (Wave A3 fix-up): mirror the STORES-R2-005 atomic
        // tmp+rename pattern that ingest() uses. Pre-fix this sibling
        // helper still used plain `writeFileSync(contentPath, content)`,
        // which leaves an orphan partial file if the process dies after
        // writeFileSync opens/truncates the target but before it finishes
        // writing. The restore path now matches the ingest path: write to
        // tmp, rename atomically, clean up tmp on failure.
        //
        // STORES-B-001 (Wave A4): tmp path uses random suffix so a
        // concurrent restore in a sibling process cannot race on the
        // same tmp file.
        const contentPath = join(this.contentDir, metadata.contentHash);
        if (!existsSync(contentPath)) {
            const tmpContentPath = buildRandomTmpPath(contentPath);
            try {
                writeFileSync(tmpContentPath, content);
                renameSync(tmpContentPath, contentPath);
            } catch (err) {
                // Best-effort cleanup — if the tmp file was created before
                // the failure, remove it so we don't leak `.tmp` orphans.
                try {
                    if (existsSync(tmpContentPath)) {
                        unlinkSync(tmpContentPath);
                    }
                } catch {
                    // Cleanup is best-effort. The primary error wins.
                }
                throw err;
            }
        }

        // Preserve original metadata including ID; rewrite storagePath to the
        // current cluster's contentDir so the restored artifact is reachable.
        const artifact: Artifact = {
            ...metadata,
            storagePath: contentPath,
            owner: 'artifact',
        };

        this.artifacts.set(artifact.id, artifact);
        this.persist();
        return artifact;
    }

    private load(): Map<string, Artifact> {
        if (!existsSync(this.metaPath)) {
            return new Map();
        }
        let raw: string;
        try {
            raw = readFileSync(this.metaPath, 'utf-8');
        } catch (err) {
            throw new CorruptStoreError(this.metaPath, err);
        }
        try {
            const arr: Artifact[] = JSON.parse(raw);
            if (!Array.isArray(arr)) {
                throw new Error(`expected JSON array, got ${typeof arr}`);
            }
            return new Map(arr.map((a) => [a.id, a]));
        } catch (err) {
            throw new CorruptStoreError(this.metaPath, err);
        }
    }

    private persist(): void {
        const arr = Array.from(this.artifacts.values());
        // STORES-B-001: random-suffix tmp path. See local-canonical-store.
        const tmpPath = buildRandomTmpPath(this.metaPath);
        writeFileSync(tmpPath, JSON.stringify(arr, null, 2));
        renameSync(tmpPath, this.metaPath);
    }
}
