/**
 * STORES-R2-002 negative type test fixture.
 *
 * A class that claims to implement ArtifactStore but omits `importSnapshot`.
 * See incomplete-canonical-store.fixture.ts for the rationale.
 */

import type {
    ArtifactStore,
    ArtifactFilter,
    ArtifactIngestInput,
} from '../../src/contracts/artifact-store.js';
import type { Artifact } from '../../src/types/artifact.js';

// @ts-expect-error — class deliberately omits required `importSnapshot`.
export class IncompleteArtifactStore implements ArtifactStore {
    async get(_id: string): Promise<Artifact | null> { return null; }
    async getContent(_id: string): Promise<Buffer | null> { return null; }
    async list(_filter?: ArtifactFilter): Promise<Artifact[]> { return []; }
    async exists(_id: string): Promise<boolean> { return false; }
    async ingest(_input: ArtifactIngestInput): Promise<Artifact> {
        throw new Error('not implemented');
    }
    async versions(_filename: string): Promise<Artifact[]> { return []; }
}
