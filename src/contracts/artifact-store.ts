import type { Artifact } from '../types/artifact.js';

/**
 * ArtifactStore contract.
 * Owns: raw files, documents, source text, generated outputs.
 * Immutable by default. New versions create new entries, never overwrite.
 */
export interface ArtifactStore {
    /**
     * Fetch artifact metadata by id, or `null` if absent.
     *
     * Returns ONLY the metadata record — content bytes are fetched
     * separately via {@link getContent}. This split keeps the metadata
     * fast-path cheap (no I/O for content blobs) and lets MCP boundaries
     * sanitize metadata-only paths without forcing content reads.
     *
     * @param id  Artifact id stamped at `ingest()` / `importSnapshot()` time.
     */
    get(id: string): Promise<Artifact | null>;

    /**
     * Fetch the raw content bytes for an artifact, or `null` if the artifact
     * doesn't exist OR its content has been moved (e.g. archived adapter).
     *
     * Implementations MUST verify the on-disk hash matches the metadata's
     * `contentHash` before returning the bytes — STORES-006 / STORES-R005
     * defence against tampered artifacts.json overwriting the content path.
     *
     * @param id  Artifact id.
     * @returns   Buffer of raw content, or `null` if absent.
     * @throws    {@link InvalidContentHashError} when the `contentHash` on
     *            the metadata record fails the 64-char-hex shape check
     *            (path-traversal defence).
     */
    getContent(id: string): Promise<Buffer | null>;

    /**
     * List artifact metadata matching the filter.
     *
     * @param filter  Optional. `mimeType` narrows by MIME; `filenameContains`
     *                substring matches; `limit` caps count.
     * @returns       Array of artifact metadata records. Content is NOT
     *                fetched — call {@link getContent} per id when needed.
     */
    list(filter?: ArtifactFilter): Promise<Artifact[]>;

    /**
     * Check whether an artifact with the given id exists. Cheaper than
     * `get(id)` on adapters that can answer via membership test.
     */
    exists(id: string): Promise<boolean>;

    /**
     * Ingest a new artifact, stamping `id`, `version`, `contentHash`,
     * `sizeBytes`, `ingestedAt`, and `owner='artifact'` at the adapter
     * boundary. Caller-supplied values for those fields are IGNORED.
     *
     * Postconditions:
     *  - Returned Artifact has all generated fields stamped.
     *  - The content bytes are stored under a path derived from the
     *    `contentHash` (NOT from `filename` — preventing collision
     *    surprises when two artifacts share a filename).
     *  - `versions(filename)` returning this artifact via the lineage.
     */
    ingest(input: ArtifactIngestInput): Promise<Artifact>;

    /**
     * Return all versions of an artifact by its original filename or lineage.
     *
     * Used by content-versioning surfaces (`db-cluster ingest <file>` with
     * a filename that's been seen before). Adapters implement this via a
     * filename → ids index.
     *
     * @param filename  The filename to look up.
     * @returns         All artifacts that share this filename, ordered by
     *                  `ingestedAt` ascending. Empty array if no versions.
     */
    versions(filename: string): Promise<Artifact[]>;

    /**
     * Import a full artifact snapshot (metadata + content) preserving the
     * original ID. Used by backup/restore — STORES-003 requires this so
     * restored artifacts keep their original IDs (otherwise provenance
     * events that cite the original subjectId no longer resolve).
     *
     * REQUIRED on the contract (STORES-R2-002): every adapter must
     * implement this. The previous optional-on-contract / required-at-
     * runtime asymmetry let new adapters compile cleanly without it and
     * only fail at restore-time.
     *
     * Preconditions:
     *  - `metadata` carries its original `id`, `version`, `contentHash`,
     *    `sizeBytes`, `ingestedAt` from the source cluster.
     *  - `sha256(content) === metadata.contentHash`. The caller is
     *    responsible for the hash; the adapter MAY re-verify and reject
     *    on mismatch.
     *
     * Postconditions:
     *  - Returned Artifact preserves the original metadata fields verbatim.
     *  - Content stored under the canonical hash-derived path.
     *
     * @param metadata Full artifact metadata snapshot.
     * @param content  Raw content bytes matching `metadata.contentHash`.
     * @throws         {@link ImportConflictError} on id collision with
     *                 different content; {@link InvalidContentHashError}
     *                 when the contentHash fails the shape check.
     */
    importSnapshot(metadata: Artifact, content: Buffer): Promise<Artifact>;
}

export interface ArtifactFilter {
    mimeType?: string;
    filenameContains?: string;
    limit?: number;
}

export interface ArtifactIngestInput {
    filename: string;
    content: Buffer;
    mimeType: string;
}
