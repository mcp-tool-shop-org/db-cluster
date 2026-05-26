import type { ClusterStores } from '../contracts/index.js';
import type { Entity } from '../types/entity.js';
import type { Artifact } from '../types/artifact.js';
import type { IndexRecord } from '../types/index-record.js';
import type { ProvenanceEvent } from '../types/provenance-event.js';
import type { Receipt } from '../types/receipt.js';
import { parseClusterUri, type ClusterUri } from '../uri/cluster-uri.js';

/**
 * The resolved object returned by the resolver.
 * Always includes the URI and the owner store name.
 */
export type ResolvedObject =
    | { kind: 'entity'; uri: string; store: 'canonical'; object: Entity }
    | { kind: 'artifact'; uri: string; store: 'artifact'; object: Artifact }
    | { kind: 'index-record'; uri: string; store: 'index'; object: IndexRecord }
    | { kind: 'event'; uri: string; store: 'ledger'; object: ProvenanceEvent }
    | { kind: 'receipt'; uri: string; store: 'receipt'; object: Receipt };

export class ResolveError extends Error {
    constructor(
        public readonly uri: string,
        message: string,
    ) {
        super(message);
        this.name = 'ResolveError';
    }
}

/**
 * ClusterResolver — resolves cluster URIs to their owner-store objects.
 *
 * Resolution always goes to the owner store. Never the index.
 * If the URI points to a missing object, throws ResolveError.
 */
export class ClusterResolver {
    constructor(private readonly stores: ClusterStores) { }

    /**
     * Resolve a single cluster URI to its owner-store object.
     */
    async resolve(uri: string): Promise<ResolvedObject> {
        const parsed = parseClusterUri(uri);
        return this.resolveFromParsed(parsed);
    }

    /**
     * Resolve multiple URIs. Returns results in the same order.
     * Throws on the first unresolvable URI.
     */
    async resolveAll(uris: string[]): Promise<ResolvedObject[]> {
        const results: ResolvedObject[] = [];
        for (const uri of uris) {
            results.push(await this.resolve(uri));
        }
        return results;
    }

    /**
     * Try to resolve a URI. Returns null instead of throwing on missing objects.
     */
    async tryResolve(uri: string): Promise<ResolvedObject | null> {
        try {
            return await this.resolve(uri);
        } catch (err) {
            if (err instanceof ResolveError) return null;
            throw err;
        }
    }

    private async resolveFromParsed(parsed: ClusterUri): Promise<ResolvedObject> {
        switch (parsed.store) {
            case 'canonical': {
                const entity = await this.stores.canonical.get(parsed.id);
                if (!entity) throw new ResolveError(parsed.raw, `Entity not found: ${parsed.id}`);
                return { kind: 'entity', uri: parsed.raw, store: 'canonical', object: entity };
            }
            case 'artifact': {
                const artifact = await this.stores.artifact.get(parsed.id);
                if (!artifact) throw new ResolveError(parsed.raw, `Artifact not found: ${parsed.id}`);
                return { kind: 'artifact', uri: parsed.raw, store: 'artifact', object: artifact };
            }
            case 'index': {
                const record = await this.stores.index.get(parsed.id);
                if (!record) throw new ResolveError(parsed.raw, `Index record not found: ${parsed.id}`);
                return { kind: 'index-record', uri: parsed.raw, store: 'index', object: record };
            }
            case 'ledger': {
                const event = await this.stores.ledger.getEvent(parsed.id);
                if (!event) throw new ResolveError(parsed.raw, `Provenance event not found: ${parsed.id}`);
                return { kind: 'event', uri: parsed.raw, store: 'ledger', object: event };
            }
            case 'receipt': {
                const receipt = await this.stores.ledger.getReceipt(parsed.id);
                if (!receipt) throw new ResolveError(parsed.raw, `Receipt not found: ${parsed.id}`);
                return { kind: 'receipt', uri: parsed.raw, store: 'receipt', object: receipt };
            }
        }
    }
}
