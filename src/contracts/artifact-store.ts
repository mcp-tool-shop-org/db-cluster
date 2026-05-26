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
