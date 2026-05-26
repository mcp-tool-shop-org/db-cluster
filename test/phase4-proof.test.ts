import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createLocalCluster } from '../src/adapters/local/index.js';
import { ClusterKernel } from '../src/kernel/cluster-kernel.js';
import { TraceBuilder } from '../src/provenance/trace-builder.js';
import type { ClusterStores } from '../src/contracts/index.js';
import type { ProvenanceGraph } from '../src/types/provenance-graph.js';

const TEST_DIR = join(import.meta.dirname, '.test-phase4-proof');

describe('Phase 4 — Provenance Graph Proof Tests', () => {
    let cluster: ClusterStores;
    let kernel: ClusterKernel;

    beforeEach(() => {
        rmSync(TEST_DIR, { recursive: true, force: true });
        mkdirSync(TEST_DIR, { recursive: true });
        cluster = createLocalCluster(TEST_DIR);
        kernel = new ClusterKernel(cluster, { dataDir: TEST_DIR });
    });

    afterEach(() => {
        rmSync(TEST_DIR, { recursive: true, force: true });
    });

    // ─── Proof 1: Cross-store trace ────────────────────────────────────

    describe('Proof 1: Cross-store trace', () => {
        it('entity trace crosses canonical → ledger → artifact when evidence is linked', async () => {
            const { artifact } = await kernel.ingestArtifact({
                filename: 'spec.md',
                content: Buffer.from('# Specification'),
                mimeType: 'text/markdown',
                actorId: 'alice',
            });
            const { entity } = await kernel.createEntity({
                kind: 'requirement',
                name: 'Auth Flow',
                attributes: { priority: 'high' },
                actorId: 'alice',
            });
            await kernel.linkEvidence({
                artifactId: artifact.id,
                entityId: entity.id,
                actorId: 'alice',
            });

            const graph = await kernel.traceObject(`cluster://canonical/${entity.id}`, {
                direction: 'backward',
            });

            // Graph crosses stores
            const stores = new Set(graph.nodes.map((n) => n.ownerStore));
            expect(stores.has('canonical')).toBe(true);
            expect(stores.has('ledger')).toBe(true);
            expect(stores.has('artifact')).toBe(true);

            // All nodes carry cluster URIs
            for (const node of graph.nodes) {
                expect(node.uri).toMatch(/^cluster:\/\//);
            }

            // All edges carry reason + source event
            const meaningfulEdges = graph.edges.filter((e) => !e.isWarning);
            for (const edge of meaningfulEdges) {
                expect(edge.reason).toBeTruthy();
            }
        });
    });

    // ─── Proof 2: Derivative visibility ────────────────────────────────

    describe('Proof 2: Derivative visibility', () => {
        it('graph distinguishes source truth vs derivative (index)', async () => {
            await kernel.createEntity({
                kind: 'concept',
                name: 'TestConcept',
                attributes: {},
                actorId: 'bob',
            });

            const bundle = await kernel.retrieveBundle('TestConcept');
            const entityUri = bundle.resolvedEntities[0].uri;

            const graph = await kernel.traceObject(entityUri, {
                direction: 'bidirectional',
                includeIndex: true,
            });

            // Source truth nodes
            const sourceTruth = graph.nodes.filter((n) => n.isSourceTruth);
            expect(sourceTruth.length).toBeGreaterThan(0);

            // Derivative nodes (index records)
            const derivative = graph.nodes.filter((n) => !n.isSourceTruth && !n.isGap);
            expect(derivative.length).toBeGreaterThan(0);
            expect(derivative.every((n) => n.type === 'index_record')).toBe(true);

            // Summary correctly counts
            expect(graph.summary.sourceTruthNodes).toBe(sourceTruth.length);
            expect(graph.summary.derivativeNodes).toBe(derivative.length);
        });
    });

    // ─── Proof 3: Stale projection ────────────────────────────────────

    describe('Proof 3: Stale projection surfaces in trace', () => {
        it('stale index record emits warning in provenance graph', async () => {
            const { entity } = await kernel.createEntity({
                kind: 'feature',
                name: 'LoginButton',
                attributes: {},
                actorId: 'user',
            });

            // Rename directly on store (bypasses kernel auto-index) to create staleness
            await cluster.canonical.update(entity.id, { name: 'LogoutButton' });

            // Trace from index record (which is now stale)
            const records = await cluster.index.search({ limit: 10 });
            const staleRecord = records.find((r) => r.sourceId === entity.id);
            expect(staleRecord).toBeTruthy();

            const graph = await kernel.traceObject(`cluster://index/${staleRecord!.id}`, {
                direction: 'backward',
            });

            // Should have stale warning
            expect(graph.warnings.length).toBeGreaterThan(0);
            const staleWarning = graph.warnings.find((w) => w.type === 'stale_index');
            expect(staleWarning).toBeTruthy();
            expect(staleWarning!.subjectUri).toContain(staleRecord!.id);

            // Should have a stale_projection_of edge
            const staleEdge = graph.edges.find((e) => e.type === 'stale_projection_of');
            expect(staleEdge).toBeTruthy();
            expect(staleEdge!.isWarning).toBe(true);
        });
    });

    // ─── Proof 4: Missing truth ────────────────────────────────────────

    describe('Proof 4: Missing truth surfaces as gap', () => {
        it('tracing a non-existent URI produces gap node, not crash', async () => {
            const graph = await kernel.traceObject('cluster://canonical/nonexistent-id', {
                direction: 'backward',
            });

            expect(graph.gaps.length).toBeGreaterThan(0);
            const gap = graph.gaps[0];
            expect(gap.expectedUri).toBe('cluster://canonical/nonexistent-id');
            expect(gap.impact).toBe('high');

            // Node should be marked as gap
            const gapNode = graph.nodes.find((n) => n.isGap);
            expect(gapNode).toBeTruthy();
            expect(gapNode!.label).toContain('MISSING');
        });
    });

    // ─── Proof 5: Receipts connected to mutations ─────────────────────

    describe('Proof 5: Receipts are connected to mutations in trace', () => {
        it('entity trace includes receipts that cover it', async () => {
            const { entity } = await kernel.createEntity({
                kind: 'task',
                name: 'Build System',
                attributes: { status: 'open' },
                actorId: 'dev',
            });

            const graph = await kernel.traceObject(`cluster://canonical/${entity.id}`, {
                direction: 'backward',
                includeReceipts: true,
            });

            const receiptNodes = graph.nodes.filter((n) => n.type === 'receipt');
            expect(receiptNodes.length).toBeGreaterThan(0);

            // Receipt nodes carry cluster URIs in receipt namespace
            for (const r of receiptNodes) {
                expect(r.uri).toMatch(/^cluster:\/\/receipt\//);
            }

            expect(graph.summary.receiptCount).toBe(receiptNodes.length);
        });
    });

    // ─── Proof 6: Bundle trace ────────────────────────────────────────

    describe('Proof 6: Bundle trace covers all resolved objects', () => {
        it('traceBundle produces combined graph for all bundle evidence', async () => {
            await kernel.ingestArtifact({
                filename: 'design.md',
                content: Buffer.from('# Design'),
                mimeType: 'text/markdown',
                actorId: 'a',
            });
            await kernel.createEntity({
                kind: 'concept',
                name: 'design',
                attributes: {},
                actorId: 'a',
            });

            const bundle = await kernel.retrieveBundle('design');
            expect(bundle.resolvedEntities.length + bundle.resolvedArtifacts.length).toBeGreaterThan(0);

            const graph = await kernel.traceBundle(bundle, { direction: 'backward' });

            // Graph has nodes from both entity and artifact traces
            expect(graph.nodes.length).toBeGreaterThan(0);
            expect(graph.summary.nodeCount).toBe(graph.nodes.length);
            expect(graph.summary.edgeCount).toBe(graph.edges.length);
            expect(graph.focalUri).toContain('bundle://');
        });
    });

    // ─── Proof 7: Cross-process trace ────────────────────────────────

    describe('Proof 7: Trace works across process boundaries (persistent state)', () => {
        it('graph built from second kernel instance sees full provenance', async () => {
            // First process: create data
            const { entity } = await kernel.createEntity({
                kind: 'project',
                name: 'Alpha',
                attributes: {},
                actorId: 'p1',
            });

            // Second process: new kernel instance, same store
            const kernel2 = new ClusterKernel(createLocalCluster(TEST_DIR), { dataDir: TEST_DIR });
            const graph = await kernel2.traceObject(`cluster://canonical/${entity.id}`, {
                direction: 'backward',
            });

            // Should find the entity and its provenance
            expect(graph.nodes.length).toBeGreaterThan(1);
            const entityNode = graph.nodes.find((n) => n.type === 'entity');
            expect(entityNode).toBeTruthy();
            expect(entityNode!.label).toContain('Alpha');
        });
    });

    // ─── Proof 8: Stable ordering ────────────────────────────────────

    describe('Proof 8: Graph ordering is stable', () => {
        it('same trace produces same node/edge order', async () => {
            const { entity } = await kernel.createEntity({
                kind: 'item',
                name: 'StableTest',
                attributes: {},
                actorId: 'x',
            });
            await kernel.ingestArtifact({
                filename: 'data.txt',
                content: Buffer.from('data'),
                mimeType: 'text/plain',
                actorId: 'x',
            });

            const uri = `cluster://canonical/${entity.id}`;
            const g1 = await kernel.traceObject(uri, { direction: 'backward' });
            const g2 = await kernel.traceObject(uri, { direction: 'backward' });

            expect(g1.nodes.map((n) => n.uri)).toEqual(g2.nodes.map((n) => n.uri));
            expect(g1.edges.map((e) => `${e.from}|${e.to}|${e.type}`))
                .toEqual(g2.edges.map((e) => `${e.from}|${e.to}|${e.type}`));
        });
    });

    // ─── Proof 9: explainTrace and why produce useful output ──────────

    describe('Proof 9: Human-readable trace output', () => {
        it('explainTrace returns meaningful multiline text', async () => {
            const { entity } = await kernel.createEntity({
                kind: 'module',
                name: 'CoreLib',
                attributes: {},
                actorId: 'dev',
            });

            const graph = await kernel.traceObject(`cluster://canonical/${entity.id}`, {
                direction: 'backward',
            });
            const text = kernel.explainTrace(graph);

            expect(text).toContain('Provenance trace from:');
            expect(text).toContain('Direction: backward');
            expect(text).toContain('Nodes:');
            expect(text).toContain('Edges:');
        });

        it('why returns compact explanation', async () => {
            const { entity } = await kernel.createEntity({
                kind: 'service',
                name: 'AuthService',
                attributes: {},
                actorId: 'ops',
            });

            const explanation = await kernel.why(`cluster://canonical/${entity.id}`);

            expect(explanation).toContain('AuthService');
            expect(explanation).toContain('entity');
            expect(explanation).toContain('canonical');
        });

        it('why on missing object reports not found', async () => {
            const explanation = await kernel.why('cluster://canonical/ghost');
            expect(explanation).toContain('not found');
        });
    });

    // ─── Proof 10: Golden path regression ─────────────────────────────

    describe('Proof 10: Golden path — ingest → create → link → trace → explain', () => {
        it('full lifecycle produces coherent provenance graph', async () => {
            // 1. Ingest artifact
            const { artifact } = await kernel.ingestArtifact({
                filename: 'evidence.pdf',
                content: Buffer.from('%PDF-fake'),
                mimeType: 'application/pdf',
                actorId: 'analyst',
            });

            // 2. Create entity
            const { entity } = await kernel.createEntity({
                kind: 'finding',
                name: 'Critical Bug in Auth',
                attributes: { severity: 'critical' },
                actorId: 'analyst',
            });

            // 3. Link evidence
            await kernel.linkEvidence({
                artifactId: artifact.id,
                entityId: entity.id,
                actorId: 'analyst',
            });

            // 4. Trace the entity
            const graph = await kernel.traceObject(`cluster://canonical/${entity.id}`, {
                direction: 'backward',
                includeReceipts: true,
                includeGaps: true,
            });

            // The graph is coherent
            expect(graph.nodes.length).toBeGreaterThan(0);
            expect(graph.edges.length).toBeGreaterThan(0);
            expect(graph.gaps.length).toBe(0); // No gaps — everything is properly provenanced
            expect(graph.warnings.length).toBe(0); // No warnings on fresh data

            // Entity node exists
            const entityNode = graph.nodes.find((n) => n.uri === `cluster://canonical/${entity.id}`);
            expect(entityNode).toBeTruthy();
            expect(entityNode!.isSourceTruth).toBe(true);
            expect(entityNode!.type).toBe('entity');

            // Artifact node exists (linked evidence)
            const artNode = graph.nodes.find((n) => n.uri === `cluster://artifact/${artifact.id}`);
            expect(artNode).toBeTruthy();
            expect(artNode!.isSourceTruth).toBe(true);
            expect(artNode!.type).toBe('artifact');

            // Has receipts
            expect(graph.summary.receiptCount).toBeGreaterThan(0);

            // 5. Explain produces readable output
            const text = kernel.explainTrace(graph);
            expect(text).toContain('Critical Bug in Auth');
            expect(text).toContain('evidence.pdf');

            // 6. Why produces compact output
            const whyText = await kernel.why(`cluster://canonical/${entity.id}`);
            expect(whyText).toContain('finding');
            expect(whyText).toContain('canonical');
        });
    });
});
