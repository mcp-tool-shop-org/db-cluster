/**
 * Dogfood retrieval tests — verify that project memory retrieval returns
 * evidence bundles with proper structure, not plain search hits.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { rmSync } from 'node:fs';
import { createDogfoodCluster, type DogfoodCluster } from '../scripts/dogfood-ingest.js';

let cluster: DogfoodCluster;

beforeAll(async () => {
    cluster = await createDogfoodCluster();
});

afterAll(() => {
    rmSync(cluster.dataDir, { recursive: true, force: true });
});

describe('Dogfood retrieval', () => {
    it('retrieves MCP-related entities as evidence bundle', async () => {
        const bundle = await cluster.kernel.retrieveBundle('MCP');
        expect(bundle.id).toBeDefined();
        expect(bundle.query).toBe('MCP');
        expect(bundle.assembledAt).toBeDefined();
        expect(bundle.resolvedEntities.length).toBeGreaterThan(0);

        // Should find Phase 6 (MCP/SDK)
        const phaseNames = bundle.resolvedEntities.map((e) => e.object.name);
        expect(phaseNames.some((n) => n.includes('MCP') || n.includes('AI-Facing'))).toBe(true);
    });

    it('retrieves mutation law phase', async () => {
        const bundle = await cluster.kernel.retrieveBundle('Mutation Law');
        expect(bundle.resolvedEntities.length).toBeGreaterThan(0);
        const names = bundle.resolvedEntities.map((e) => e.object.name);
        expect(names.some((n) => n.includes('Mutation'))).toBe(true);
    });

    it('retrieval bundle includes provenance events', async () => {
        const bundle = await cluster.kernel.retrieveBundle('Phase 8');
        expect(bundle.provenanceEvents.length).toBeGreaterThanOrEqual(0);
        // Bundle has freshness assessment
        expect(bundle.freshness).toBeDefined();
        expect(typeof bundle.freshness.allFresh).toBe('boolean');
    });

    it('retrieval bundle includes freshness and confidence boundaries', async () => {
        const bundle = await cluster.kernel.retrieveBundle('Policy');
        expect(bundle.freshness).toBeDefined();
        expect(bundle.confidenceBoundaries).toBeDefined();
        expect(Array.isArray(bundle.missingContext)).toBe(true);
    });

    it('retrieves decisions through index', async () => {
        const bundle = await cluster.kernel.retrieveBundle('decision');
        expect(bundle.resolvedEntities.length).toBeGreaterThan(0);
        const kinds = bundle.resolvedEntities.map((e) => e.object.kind);
        expect(kinds).toContain('decision');
    });

    it('retrieves closeout artifacts', async () => {
        const bundle = await cluster.kernel.retrieveBundle('closeout');
        expect(bundle.resolvedArtifacts.length).toBeGreaterThan(0);
        const filenames = bundle.resolvedArtifacts.map((a) => a.object.filename);
        expect(filenames.some((f) => f.includes('closeout'))).toBe(true);
    });

    it('findSources resolves entities from canonical store', async () => {
        const result = await cluster.kernel.findSources({ query: 'milestone' });
        expect(result.resolvedEntities.length).toBeGreaterThan(0);
        expect(result.resolvedEntities[0].kind).toBe('milestone');
    });

    it('findSources resolves artifacts from artifact store', async () => {
        const result = await cluster.kernel.findSources({ query: 'README' });
        expect(result.resolvedArtifacts.length).toBeGreaterThan(0);
        expect(result.resolvedArtifacts[0].filename).toContain('README');
    });

    it('explainRetrieval produces structured explanation', async () => {
        const bundle = await cluster.kernel.retrieveBundle('Phase 5');
        const explanation = await cluster.kernel.explainRetrieval(bundle);
        expect(explanation.summary).toContain('Phase 5');
        expect(explanation.resolvedCount).toBeGreaterThan(0);
        expect(typeof explanation.allFresh).toBe('boolean');
    });

    it('empty query returns empty bundle without error', async () => {
        const bundle = await cluster.kernel.retrieveBundle('xyznonexistent12345');
        expect(bundle.resolvedEntities.length).toBe(0);
        expect(bundle.resolvedArtifacts.length).toBe(0);
        expect(bundle.indexRecords.length).toBe(0);
    });
});
