import type { Artifact } from '../types/artifact.js';

/**
 * ArtifactStore contract.
 * Owns: raw files, documents, source text, generated outputs.
 * Immutable by default. New versions create new entries, never overwrite.
 */
export interface ArtifactStore {
    get(id: string): Promise<Artifact | null>;
    getContent(id: string): Promise<Buffer | null>;
    list(filter?: ArtifactFilter): Promise<Artifact[]>;
    exists(id: string): Promise<boolean>;
    ingest(input: ArtifactIngestInput): Promise<Artifact>;
    /** Returns all versions of an artifact by its original filename or lineage. */
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
