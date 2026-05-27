import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { Artifact } from '../../types/artifact.js';
import type {
    ArtifactStore,
    ArtifactFilter,
    ArtifactIngestInput,
} from '../../contracts/artifact-store.js';
import { CorruptStoreError, InvalidContentHashError, isValidContentHash } from './errors.js';

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
        this.artifacts = this.load();
    }

    async get(id: string): Promise<Artifact | null> {
        return this.artifacts.get(id) ?? null;
    }

    async getContent(id: string): Promise<Buffer | null> {
        const artifact = this.artifacts.get(id);
        if (!artifact) return null;
        // Defense-in-depth (STORES-R005): re-validate contentHash before using
        // it as a path component. The in-memory map mirrors artifacts.json; if
        // that file is tampered after load, the hash here could carry a path
        // traversal payload. importSnapshot validates on write; getContent
        // validates on read. Both gates are required.
        if (!isValidContentHash(artifact.contentHash)) {
            throw new InvalidContentHashError(String(artifact.contentHash));
        }
        const contentPath = join(this.contentDir, artifact.contentHash);
        if (!existsSync(contentPath)) return null;
        return readFileSync(contentPath);
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

        // Write content by hash — content-addressed, deduplicates identical content
        const contentPath = join(this.contentDir, contentHash);
        if (!existsSync(contentPath)) {
            writeFileSync(contentPath, input.content);
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
     * Idempotent: returns the existing record if an artifact with the same id
     * is already present.
     */
    async importSnapshot(metadata: Artifact, content: Buffer): Promise<Artifact> {
        if (!isValidContentHash(metadata.contentHash)) {
            throw new InvalidContentHashError(String(metadata.contentHash));
        }

        const existing = this.artifacts.get(metadata.id);
        if (existing) {
            return existing;
        }

        // Write content by hash — safe to join now that we've validated the hash shape.
        const contentPath = join(this.contentDir, metadata.contentHash);
        if (!existsSync(contentPath)) {
            writeFileSync(contentPath, content);
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
        const tmpPath = `${this.metaPath}.tmp`;
        writeFileSync(tmpPath, JSON.stringify(arr, null, 2));
        renameSync(tmpPath, this.metaPath);
    }
}
