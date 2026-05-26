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

const URI_REGEX = /^cluster:\/\/([a-z]+)\/(.+)$/;

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
