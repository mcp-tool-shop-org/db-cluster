import { describe, it, expect } from 'vitest';
import { runDogfoodReplay } from '../scripts/dogfood-replay.js';

describe('Wave 6: Dogfood replay regression', () => {
    it('Finding 1: restore() now restores artifacts', async () => {
        const result = await runDogfoodReplay();
        expect(result.findings.artifactRestoreFails).toBe(false);
    });

    it('Finding 2: commitMutation(create_entity) now auto-indexes', async () => {
        const result = await runDogfoodReplay();
        expect(result.findings.commandAutoIndexFails).toBe(false);
    });

    it('Finding 3: command state persists across kernel instances', async () => {
        const result = await runDogfoodReplay();
        expect(result.findings.commandPersistenceFails).toBe(false);
    });

    it('Finding 4: content retrieval finds docs by body content', async () => {
        const result = await runDogfoodReplay();
        expect(result.findings.contentRetrievalFails).toBe(false);
    });

    it('no Phase 11 finding reproduces', async () => {
        const result = await runDogfoodReplay();
        const allFixed = Object.values(result.findings).every((f) => f === false);
        expect(allFixed).toBe(true);
    });

    it('dogfood replay produces meaningful cluster state', async () => {
        const result = await runDogfoodReplay();
        expect(result.stats.artifacts).toBeGreaterThanOrEqual(3);
        expect(result.stats.entities).toBeGreaterThanOrEqual(5);
    });
});
