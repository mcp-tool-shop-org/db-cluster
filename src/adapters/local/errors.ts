/**
 * Typed errors for the local store adapters.
 *
 * - CorruptStoreError — raised by load() when a persistence file fails JSON.parse
 *   or otherwise looks unreadable. Carries the file path and a recovery hint.
 * - InvalidContentHashError — raised by LocalArtifactStore.importSnapshot AND
 *   LocalArtifactStore.getContent when the contentHash does not match the
 *   expected `[a-f0-9]{64}` shape. Prevents path traversal via tampered backup
 *   metadata or tampered artifacts.json (STORES-006 / STORES-R005).
 */

export class CorruptStoreError extends Error {
    public readonly filePath: string;
    public readonly cause?: unknown;
    constructor(filePath: string, cause?: unknown) {
        const causeMsg = cause instanceof Error ? cause.message : String(cause ?? 'unknown');
        super(
            `Local store file is unreadable or corrupt: ${filePath} (${causeMsg}). ` +
                `The store cannot start safely. Recovery: restore from a backup, ` +
                `delete the file to start fresh, or inspect the file by hand.`,
        );
        this.name = 'CorruptStoreError';
        this.filePath = filePath;
        this.cause = cause;
    }
}

const CONTENT_HASH_PATTERN = /^[a-f0-9]{64}$/;

export class InvalidContentHashError extends Error {
    public readonly contentHash: string;
    constructor(contentHash: string) {
        super(
            `Invalid artifact contentHash: ${JSON.stringify(contentHash)}. ` +
                `Expected a 64-character lowercase hex string (sha256). ` +
                `Refusing to write artifact content to a path derived from untrusted input.`,
        );
        this.name = 'InvalidContentHashError';
        this.contentHash = contentHash;
    }
}

export function isValidContentHash(hash: unknown): hash is string {
    return typeof hash === 'string' && CONTENT_HASH_PATTERN.test(hash);
}
