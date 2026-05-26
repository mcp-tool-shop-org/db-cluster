import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ClusterStores } from '../../contracts/index.js';
import { LocalCanonicalStore } from './local-canonical-store.js';
import { LocalArtifactStore } from './local-artifact-store.js';
import { LocalIndexStore } from './local-index-store.js';
import { LocalLedgerStore } from './local-ledger-store.js';

/**
 * Create a local cluster with four separate store directories.
 * Each store gets its own subdirectory — hard physical separation.
 */
export function createLocalCluster(rootDir: string): ClusterStores {
    mkdirSync(rootDir, { recursive: true });

    return {
        canonical: new LocalCanonicalStore(join(rootDir, 'canonical')),
        artifact: new LocalArtifactStore(join(rootDir, 'artifact')),
        index: new LocalIndexStore(join(rootDir, 'index')),
        ledger: new LocalLedgerStore(join(rootDir, 'ledger')),
    };
}

export { LocalCanonicalStore } from './local-canonical-store.js';
export { LocalArtifactStore } from './local-artifact-store.js';
export { LocalIndexStore } from './local-index-store.js';
export { LocalLedgerStore } from './local-ledger-store.js';
