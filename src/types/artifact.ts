/**
 * Artifact — a raw source object (file, document, generated output).
 * Lives in the artifact store. Immutable by default; corrections create new versions.
 */
export interface Artifact {
    id: string;
    filename: string;
    contentHash: string;
    mimeType: string;
    sizeBytes: number;
    version: number;
    storagePath: string;
    ingestedAt: string;
    owner: 'artifact';
}
