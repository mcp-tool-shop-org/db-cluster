/**
 * Typed errors for the local store adapters.
 *
 * - CorruptStoreError — raised by load() when a persistence file fails JSON.parse
 *   or otherwise looks unreadable. Carries the file path and a recovery hint.
 * - InvalidContentHashError — raised by LocalArtifactStore.importSnapshot when
 *   the caller-supplied contentHash does not match the expected `[a-f0-9]{64}` shape.
 *   Prevents path traversal via tampered backup metadata (STORES-006).
 * - ImportSnapshotNotSupportedError — surfaced by ops/backup.ts (Surface domain)
 *   when an adapter does not implement the optional importSnapshot method. Defined
 *   here so adapter-side and surface-side code share a single error type.
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

export class ImportSnapshotNotSupportedError extends Error {
    public readonly storeName: string;
    constructor(storeName: string) {
        super(
            `Store ${storeName} does not implement importSnapshot. ` +
                `Restore cannot preserve original IDs/timestamps on this backend. ` +
                `Upgrade the adapter or use a backend that supports importSnapshot.`,
        );
        this.name = 'ImportSnapshotNotSupportedError';
        this.storeName = storeName;
    }
}
