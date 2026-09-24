/**
 * STORES-R2-002 negative type test fixture.
 *
 * A class that claims to implement ArtifactStore but omits `importSnapshot`.
 * See incomplete-canonical-store.fixture.ts for the rationale.
 */

import type { ArtifactStore } from '../../src/contracts/artifact-store.js';

export interface IncompleteArtifactStore extends Omit<ArtifactStore, 'importSnapshot'> {}

// @ts-expect-error — class deliberately omits required `importSnapshot`.
export class IncompleteArtifactStore implements ArtifactStore {}
