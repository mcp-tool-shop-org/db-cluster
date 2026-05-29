/**
 * ClusterUri — a stable, parseable address for any object in the cluster.
 *
 * Format: cluster://<store>/<id>
 *
 * Stores: canonical, artifact, index, ledger, receipt
 *
 * URIs encode ownership. The store segment IS the owner.
 */

export type ClusterStore = 'canonical' | 'artifact' | 'index' | 'ledger' | 'receipt';

export interface ClusterUri {
    store: ClusterStore;
    id: string;
    raw: string;
}

const VALID_STORES: Set<string> = new Set([
    'canonical',
    'artifact',
    'index',
    'ledger',
    'receipt',
]);

/**
 * URI grammar: `cluster://<store>/<id>`.
 *
 * INJECT-003 (Wave S2-A2) — the `id` group was previously `(.+)`, which
 * accepted ASCII control characters (\x00–\x1F), the space (\x20), and DEL
 * (\x7F). Those are inert today (the store is re-validated and the id is
 * consumed opaquely as a Map key / a `$1` parameter bind), but a null byte or
 * control char in an id is never legitimate and is a classic truncation /
 * log-injection / smuggling primitive. We exclude that range at the grammar
 * level so BOTH `parseClusterUri` (throws) and `isClusterUri` (returns false)
 * reject them from one source of truth.
 *
 * The exclusion is `[^\x00-\x20\x7f]+`:
 *  - C0 controls (\x00–\x1F) incl. NUL, BEL, TAB, LF, CR — rejected.
 *  - SPACE (\x20) — rejected (a raw space in a URI path is always malformed).
 *  - DEL (\x7F) — rejected.
 *  - Everything else printable — UUIDs, hyphens, dots, underscores, `@`,
 *    `+`, unicode letters, etc. — still valid.
 *
 * Note: `.` in the prior group already excluded LF/CR (JS regex without the
 * `s` flag), so newline rejection is preserved; this change additionally
 * closes NUL / other-control / TAB / space.
 */
const URI_REGEX = /^cluster:\/\/([a-z]+)\/([^\x00-\x20\x7f]+)$/;

/**
 * Parse a cluster URI string into structured form.
 * Throws on malformed or unrecognized store.
 */
export function parseClusterUri(uri: string): ClusterUri {
    const match = URI_REGEX.exec(uri);
    if (!match) {
        throw new ClusterUriError(`Invalid cluster URI: ${uri}`);
    }
    const [, store, id] = match;
    if (!VALID_STORES.has(store)) {
        throw new ClusterUriError(`Unknown store in URI: ${store} (valid: ${[...VALID_STORES].join(', ')})`);
    }
    if (!id || id.trim() === '') {
        throw new ClusterUriError(`Empty ID in cluster URI: ${uri}`);
    }
    return { store: store as ClusterStore, id, raw: uri };
}

/**
 * Format a cluster URI from store + id.
 */
export function formatClusterUri(store: ClusterStore, id: string): string {
    if (!VALID_STORES.has(store)) {
        throw new ClusterUriError(`Unknown store: ${store}`);
    }
    if (!id || id.trim() === '') {
        throw new ClusterUriError('ID cannot be empty');
    }
    return `cluster://${store}/${id}`;
}

/**
 * Check if a string is a valid cluster URI without throwing.
 */
export function isClusterUri(value: string): boolean {
    const match = URI_REGEX.exec(value);
    if (!match) return false;
    return VALID_STORES.has(match[1]) && match[2].trim() !== '';
}

/**
 * Derive the cluster URI for a typed object based on its owner field.
 */
export function uriForObject(obj: { id: string; owner: string }): string {
    const storeMap: Record<string, ClusterStore> = {
        canonical: 'canonical',
        artifact: 'artifact',
        index: 'index',
        ledger: 'ledger',
    };
    const store = storeMap[obj.owner];
    if (!store) {
        throw new ClusterUriError(`Cannot derive URI: unknown owner "${obj.owner}"`);
    }
    return formatClusterUri(store, obj.id);
}

export class ClusterUriError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ClusterUriError';
    }
}
