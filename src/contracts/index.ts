import type { CanonicalStore } from './canonical-store.js';
import type { ArtifactStore } from './artifact-store.js';
import type { IndexStore } from './index-store.js';
import type { LedgerStore } from './ledger-store.js';

export type { CanonicalStore, EntityFilter } from './canonical-store.js';
export type { ArtifactStore, ArtifactFilter, ArtifactIngestInput } from './artifact-store.js';
export type { IndexStore, IndexQuery } from './index-store.js';
export type { LedgerStore, LedgerFilter, ReceiptFilter } from './ledger-store.js';

/**
 * ClusterStores — the full set of truth stores that compose the cluster.
 * The kernel receives this to coordinate access across stores.
 */
export interface ClusterStores {
    canonical: CanonicalStore;
    artifact: ArtifactStore;
    index: IndexStore;
    ledger: LedgerStore;
}
