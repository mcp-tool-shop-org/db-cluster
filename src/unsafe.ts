/**
 * ⚠️  UNSAFE — raw store handles that BYPASS PolicyEnforcedKernel.  ⚠️
 * ============================================================================
 *
 * Everything exported here returns RAW {@link ClusterStores} (or a raw
 * stores-plus-pool bundle). A raw store handle has:
 *
 *   - NO policy enforcement      (anyone holding it can read/write any store)
 *   - NO redaction               (restricted fields are returned verbatim)
 *   - NO receipts                (mutations leave no content-addressable proof)
 *   - NO provenance              (writes are not recorded in the ledger)
 *   - NO mutation law            (you can mutate truth without propose→commit)
 *
 * This module exists for OPERATOR TOOLING and TESTS that legitimately need the
 * bare adapters (e.g. building a custom kernel, fixtures, migration scripts).
 *
 * The POLICED path is the package ROOT:
 *
 *   import { createSafeCluster } from '@mcptoolshop/db-cluster';
 *
 * `createSafeCluster` returns a handle whose only door to cluster truth is a
 * PolicyEnforcedKernel. Reach for `/unsafe` ONLY when you have decided, on
 * purpose, to step outside that envelope.
 *
 * ============================================================================
 */

export { createCluster, createClusterFromEnv } from './adapters/factory.js';
export type { ClusterConfig, ClusterWithPool } from './adapters/factory.js';
export { createLocalCluster } from './adapters/local/index.js';

import { createLocalCluster as _createLocalCluster } from './adapters/local/index.js';

/**
 * Alias for {@link createLocalCluster} that spells out the danger at the call
 * site: `createUnsafeStores('.db-cluster')` reads as "I am intentionally
 * building raw, unpoliced stores." Identical behaviour to `createLocalCluster`.
 */
export const createUnsafeStores = _createLocalCluster;
