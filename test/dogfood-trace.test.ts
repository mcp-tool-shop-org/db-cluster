/**
 * Dogfood trace tests — verify provenance tracing works on project memory.
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

describe('Dogfood trace', () => {
    it('traces a phase entity to provenance events', async () => {
        const phaseId = cluster.entities.get('Phase 6 — AI-Facing Interface: MCP and SDK')!;
        const uri = `cluster://canonical/${phaseId}`;
        const graph = await cluster.kernel.traceObject(uri);

        expect(graph.focalUri).toBe(uri);
        expect(graph.nodes.length).toBeGreaterThan(0);
        expect(graph.edges.length).toBeGreaterThan(0);
    });

    it('why() explains a decision back to source', async () => {
        const decisionId = cluster.entities.get('AI proposes, command runtime disposes')!;
        const uri = `cluster://canonical/${decisionId}`;
        const why = await cluster.kernel.why(uri);

        expect(why).toBeDefined();
        expect(why.length).toBeGreaterThan(0);
    });

    it('traces a finding back to observed-in artifact', async () => {
        const findingId = cluster.entities.get('Index is always rebuildable from owner truth')!;
        const uri = `cluster://canonical/${findingId}`;
        const graph = await cluster.kernel.traceObject(uri);

        // Should have provenance nodes
        expect(graph.nodes.length).toBeGreaterThan(0);

        // The provenance trail should show evidence_linked action
        const events = await cluster.kernel.traceProvenance(findingId);
        expect(events.length).toBeGreaterThan(0);
        const hasEvidenceLink = events.some((e) => e.action === 'evidence_linked');
        expect(hasEvidenceLink).toBe(true);
    });

    it('traces an artifact to its ingestion event', async () => {
        const artifactId = cluster.artifacts.get('docs/phase-10-closeout.md')!;
        const uri = `cluster://artifact/${artifactId}`;
        const graph = await cluster.kernel.traceObject(uri);

        expect(graph.focalUri).toBe(uri);
        expect(graph.nodes.length).toBeGreaterThan(0);
    });

    it('traces a milestone entity', async () => {
        const milestoneId = cluster.entities.get('434 tests across 29 files')!;
        const uri = `cluster://canonical/${milestoneId}`;
        const graph = await cluster.kernel.traceObject(uri);

        expect(graph.focalUri).toBe(uri);
        expect(graph.nodes.length).toBeGreaterThan(0);
    });

    it('provenance events include entity_created and evidence_linked', async () => {
        const decisionId = cluster.entities.get('Cluster is the product')!;
        const events = await cluster.kernel.traceProvenance(decisionId);

        const actions = events.map((e) => e.action);
        expect(actions).toContain('entity_created');
        expect(actions).toContain('evidence_linked');
    });

    it('why() returns non-empty explanation for artifacts', async () => {
        const artifactId = cluster.artifacts.get('README.md')!;
        const uri = `cluster://artifact/${artifactId}`;
        const why = await cluster.kernel.why(uri);
        expect(why.length).toBeGreaterThan(0);
    });
});
