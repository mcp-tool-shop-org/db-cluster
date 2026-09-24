/**
 * STORES-R2-002 negative type test fixture.
 *
 * This fixture defines a class that claims to implement CanonicalStore but
 * omits the `importSnapshot` method. After the Wave A3 contract promotion
 * (importSnapshot becomes required), `implements CanonicalStore` here must
 * fail to compile with a "missing member" error — and the `@ts-expect-error`
 * directive below silences exactly that error.
 *
 * Pre-fix (importSnapshot optional): no error, directive is unused, tsc
 * fails with TS2578.
 *
 * Post-fix (importSnapshot required): real error, directive matches, tsc
 * exits cleanly.
 *
 * The class takes every OTHER member from the interface merged into it, so
 * `importSnapshot` stays the only thing it lacks as the contract grows. The
 * members used to be written out by hand; when the contract later gained
 * `listVersions` and `getVersion` the class went on missing those as well,
 * the directive stayed satisfied either way, and the test could no longer
 * fail.
 */

import type { CanonicalStore } from '../../src/contracts/canonical-store.js';

// Declaration merging: the class's instance type gains every CanonicalStore
// member except `importSnapshot`, without having to implement them.
export interface IncompleteCanonicalStore extends Omit<CanonicalStore, 'importSnapshot'> {}

// @ts-expect-error — class deliberately omits required `importSnapshot`.
export class IncompleteCanonicalStore implements CanonicalStore {}
