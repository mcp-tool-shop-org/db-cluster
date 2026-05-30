/**
 * Opaque cursor pagination (SDK-002).
 *
 * ONE pagination idiom: the cursor is an OPAQUE wrapper over V1's numeric
 * `IndexQuery.offset` (RETR-005). Consumers pass `cursor`, never a raw offset;
 * the SDK encodes/decodes it. The token carries ONLY the offset (base64url of
 * `{o}`) — never internal record ids — so it cannot leak cluster internals nor
 * be used as an existence oracle. This is the SDK/kernel-layer wrapper over the
 * offset V1 shipped, not a second pagination scheme.
 */
export interface Page<T> {
    /** The page of items. */
    items: T[];
    /**
     * Opaque cursor for the NEXT page, or `null` when this is the last page.
     * Feed it back as `{ cursor }` to fetch the following page.
     */
    nextCursor: string | null;
}

/** Encode a numeric offset into an opaque cursor token (internal-only shape). */
export function encodeCursor(offset: number): string {
    const o = Math.max(0, Math.floor(offset));
    return Buffer.from(JSON.stringify({ o }), 'utf-8').toString('base64url');
}

/**
 * Decode an opaque cursor back to its numeric offset. Absent/malformed cursors
 * decode to offset 0 — never throws, never trusts the token's contents blindly.
 */
export function decodeCursor(cursor?: string | null): number {
    if (!cursor) return 0;
    try {
        const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf-8')) as { o?: unknown };
        const offset = Number(parsed?.o);
        return Number.isInteger(offset) && offset >= 0 ? offset : 0;
    } catch {
        return 0;
    }
}
