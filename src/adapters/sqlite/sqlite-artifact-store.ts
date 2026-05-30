/**
 * SqliteArtifactStore — SQLite-backed implementation of the ArtifactStore
 * contract. Behaviorally IDENTICAL to LocalArtifactStore: immutable writes,
 * content addressing, version identity, the same thrown error TYPES and the
 * same null/empty semantics. The kernel cannot tell them apart.
 *
 * Wave V3 (SQLite store, agent A1). Content is stored content-addressed in the
 * `artifact_content(content_hash PK, bytes BLOB)` table (dedup by hash); the
 * metadata lives in `artifacts`. There is NO update — re-ingesting the same
 * filename creates a new version.
 *
 * Two read-integrity gates on getContent, IDENTICAL to local:
 *  - Gate 1 (shape / path-traversal defence, STORES-R005): the contentHash must
 *    match `[a-f0-9]{64}` before it is used to key the blob — `isValidContentHash`
 *    → `InvalidContentHashError`.
 *  - Gate 2 (content read-integrity, PROV-001): sha256(on-disk bytes) must equal
 *    the recorded contentHash — `createHash` → `ContentReadIntegrityError`.
 *
 * SQL SAFETY: every query is parameterized with `?`. The only interpolated
 * tokens are A3's compile-time table-name constants (`ARTIFACTS_TABLE`,
 * `ARTIFACT_CONTENT_TABLE`) — never a filename/hash/content value.
 */

import { randomUUID, createHash } from 'node:crypto';
import type { Artifact } from '../../types/artifact.js';
import type {
    ArtifactStore,
    ArtifactFilter,
    ArtifactIngestInput,
} from '../../contracts/artifact-store.js';
import {
    InvalidContentHashError,
    ContentReadIntegrityError,
    isValidContentHash,
    assertContentMatch,
} from '../local/errors.js';
import { SqliteDb } from './sqlite-db.js';
import { ARTIFACTS_TABLE, ARTIFACT_CONTENT_TABLE } from './schema.js';

/** Column list shared by every metadata SELECT so the row shape rowToArtifact
 *  consumes stays in one place. */
const COLUMNS =
    'id, filename, content_hash, mime_type, size_bytes, version, storage_path, ingested_at, owner';

/** The shape of a raw artifacts row as better-sqlite3 returns it. */
interface ArtifactRow {
    id: string;
    filename: string;
    content_hash: string;
    mime_type: string;
    size_bytes: number;
    version: number;
    storage_path: string;
    ingested_at: string;
    owner: string;
}

export class SqliteArtifactStore implements ArtifactStore {
    constructor(private readonly db: SqliteDb) {}

    async get(id: string): Promise<Artifact | null> {
        const row = this.db.connection
            .prepare<[string], ArtifactRow>(`SELECT ${COLUMNS} FROM ${ARTIFACTS_TABLE} WHERE id = ?`)
            .get(id);
        return row ? this.rowToArtifact(row) : null;
    }

    async getContent(id: string): Promise<Buffer | null> {
        const row = this.db.connection
            .prepare<[string], ArtifactRow>(`SELECT ${COLUMNS} FROM ${ARTIFACTS_TABLE} WHERE id = ?`)
            .get(id);
        if (!row) return null;
        const artifact = this.rowToArtifact(row);

        // Gate 1 — shape / path-traversal defence (STORES-R005). Re-validate the
        // contentHash before using it to key the blob. The metadata table can be
        // tampered after the fact; importSnapshot validates on write, getContent
        // validates on read.
        if (!isValidContentHash(artifact.contentHash)) {
            throw new InvalidContentHashError(String(artifact.contentHash));
        }

        const contentRow = this.db.connection
            .prepare<[string], { bytes: Buffer }>(
                `SELECT bytes FROM ${ARTIFACT_CONTENT_TABLE} WHERE content_hash = ?`,
            )
            .get(artifact.contentHash);
        // Parity with local's "content file missing → null".
        if (!contentRow) return null;
        const buf = contentRow.bytes;

        // Gate 2 — content read-integrity (PROV-001). The store is
        // content-addressed and immutable: the stored bytes MUST hash to the
        // recorded contentHash. If they no longer do, the blob was altered out
        // from under its metadata — throw rather than hand back tampered bytes.
        const actualHash = createHash('sha256').update(buf).digest('hex');
        if (actualHash !== artifact.contentHash) {
            throw new ContentReadIntegrityError(artifact.id, artifact.contentHash, actualHash);
        }
        return buf;
    }

    async list(filter?: ArtifactFilter): Promise<Artifact[]> {
        // Insertion order (rowid ASC) matches local's Map iteration order.
        // mimeType is filtered in SQL (exact); filenameContains + limit are
        // applied in JS to match local's `filename.toLowerCase().includes(q)` /
        // `.slice(0, n)` exactly.
        const params: unknown[] = [];
        let where = '';
        if (filter?.mimeType) {
            where = ` WHERE mime_type = ?`;
            params.push(filter.mimeType);
        }
        const rows = this.db.connection
            .prepare<unknown[], ArtifactRow>(
                `SELECT ${COLUMNS} FROM ${ARTIFACTS_TABLE}${where} ORDER BY rowid ASC`,
            )
            .all(...params);

        let results = rows.map((row) => this.rowToArtifact(row));
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
        const row = this.db.connection
            .prepare<[string], { one: number }>(
                `SELECT 1 AS one FROM ${ARTIFACTS_TABLE} WHERE id = ? LIMIT 1`,
            )
            .get(id);
        return row !== undefined;
    }

    async ingest(input: ArtifactIngestInput): Promise<Artifact> {
        const contentHash = createHash('sha256').update(input.content).digest('hex');

        // Version = (count of existing artifacts with the same filename) + 1.
        const countRow = this.db.connection
            .prepare<[string], { n: number }>(
                `SELECT COUNT(*) AS n FROM ${ARTIFACTS_TABLE} WHERE filename = ?`,
            )
            .get(input.filename);
        const version = (countRow?.n ?? 0) + 1;

        const artifact: Artifact = {
            id: randomUUID(),
            filename: input.filename,
            contentHash,
            mimeType: input.mimeType,
            sizeBytes: input.content.length,
            version,
            // SQLite has no filesystem path; this synthetic locator is purely
            // informational — getContent keys the blob by hash, not this field.
            storagePath: `sqlite:${contentHash}`,
            ingestedAt: new Date().toISOString(),
            owner: 'artifact',
        };

        const conn = this.db.connection;
        const insertContent = conn.prepare(
            `INSERT OR IGNORE INTO ${ARTIFACT_CONTENT_TABLE} (content_hash, bytes) VALUES (?, ?)`,
        );
        const insertMeta = conn.prepare(
            `INSERT INTO ${ARTIFACTS_TABLE} (id, filename, content_hash, mime_type, size_bytes, version, storage_path, ingested_at, owner) ` +
                `VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );

        // One transaction: dedup the content blob (INSERT OR IGNORE — identical
        // bytes share one row) then INSERT the metadata. A crash between the two
        // writes leaves neither.
        this.db.transaction(() => {
            insertContent.run(contentHash, input.content);
            insertMeta.run(
                artifact.id,
                artifact.filename,
                artifact.contentHash,
                artifact.mimeType,
                artifact.sizeBytes,
                artifact.version,
                artifact.storagePath,
                artifact.ingestedAt,
                artifact.owner,
            );
        });
        return artifact;
    }

    async versions(filename: string): Promise<Artifact[]> {
        // All artifacts with this filename, ascending by version (matches local's
        // `.sort((a, b) => a.version - b.version)`).
        const rows = this.db.connection
            .prepare<[string], ArtifactRow>(
                `SELECT ${COLUMNS} FROM ${ARTIFACTS_TABLE} WHERE filename = ? ORDER BY version ASC`,
            )
            .all(filename);
        return rows.map((row) => this.rowToArtifact(row));
    }

    /**
     * Import a full artifact snapshot (metadata + content) preserving the
     * original id. Behaviorally identical to local:
     *  - Validate `metadata.contentHash` shape BEFORE touching the blob store
     *    (path-traversal defence) → InvalidContentHashError.
     *  - If an artifact with the same id exists, compare via assertContentMatch
     *    with `storagePath` excluded on BOTH sides (it is intentionally
     *    rewritten on import) → ImportConflictError on mismatch, existing
     *    returned on a true match.
     *  - Else INSERT OR IGNORE the content blob, INSERT metadata with
     *    `owner='artifact'` and `storagePath = sqlite:<hash>`, return.
     */
    async importSnapshot(metadata: Artifact, content: Buffer): Promise<Artifact> {
        if (!isValidContentHash(metadata.contentHash)) {
            throw new InvalidContentHashError(String(metadata.contentHash));
        }

        const existingRow = this.db.connection
            .prepare<[string], ArtifactRow>(`SELECT ${COLUMNS} FROM ${ARTIFACTS_TABLE} WHERE id = ?`)
            .get(metadata.id);

        if (existingRow) {
            const existing = this.rowToArtifact(existingRow);
            // Exclude storagePath on BOTH sides (rewritten on import) AND owner
            // (store-stamped — assertContentMatch elides owner internally). The
            // incoming comparable is normalized to rowToArtifact field order so
            // the key-order-sensitive JSON.stringify compares like-for-like.
            const existingComparable = {
                ...(existing as unknown as Record<string, unknown>),
                storagePath: undefined,
            };
            const incomingComparable = {
                ...(this.normalizeForCompare(metadata) as unknown as Record<string, unknown>),
                storagePath: undefined,
            };
            assertContentMatch('artifact', metadata.id, existingComparable, incomingComparable);
            return existing;
        }

        const artifact: Artifact = {
            ...metadata,
            storagePath: `sqlite:${metadata.contentHash}`,
            owner: 'artifact',
        };

        const conn = this.db.connection;
        const insertContent = conn.prepare(
            `INSERT OR IGNORE INTO ${ARTIFACT_CONTENT_TABLE} (content_hash, bytes) VALUES (?, ?)`,
        );
        const insertMeta = conn.prepare(
            `INSERT INTO ${ARTIFACTS_TABLE} (id, filename, content_hash, mime_type, size_bytes, version, storage_path, ingested_at, owner) ` +
                `VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        this.db.transaction(() => {
            insertContent.run(metadata.contentHash, content);
            insertMeta.run(
                artifact.id,
                artifact.filename,
                artifact.contentHash,
                artifact.mimeType,
                artifact.sizeBytes,
                artifact.version,
                artifact.storagePath,
                artifact.ingestedAt,
                artifact.owner,
            );
        });
        return artifact;
    }

    /**
     * Re-emit an Artifact with the SAME field order rowToArtifact produces so
     * the key-order-sensitive assertContentMatch JSON.stringify compares the
     * incoming snapshot against the stored row on equal footing.
     */
    private normalizeForCompare(metadata: Artifact): Artifact {
        return {
            id: metadata.id,
            filename: metadata.filename,
            contentHash: metadata.contentHash,
            mimeType: metadata.mimeType,
            sizeBytes: metadata.sizeBytes,
            version: metadata.version,
            storagePath: metadata.storagePath,
            ingestedAt: metadata.ingestedAt,
            owner: 'artifact',
        };
    }

    /** Map a raw artifacts row to an Artifact. `owner` is pinned to the literal
     *  'artifact'; timestamps are already ISO strings (stored as TEXT). */
    private rowToArtifact(row: ArtifactRow): Artifact {
        return {
            id: row.id,
            filename: row.filename,
            contentHash: row.content_hash,
            mimeType: row.mime_type,
            sizeBytes: Number(row.size_bytes),
            version: Number(row.version),
            storagePath: row.storage_path,
            ingestedAt: row.ingested_at,
            owner: 'artifact',
        };
    }
}
