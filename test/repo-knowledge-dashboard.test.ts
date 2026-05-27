import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLocalCluster } from '../src/adapters/local/index.js';
import { ClusterKernel } from '../src/kernel/cluster-kernel.js';
import { ingestRepoKnowledge } from '../src/integrations/repo-knowledge/ingest.js';
import { generateRepoKnowledgeSnapshot } from '../scripts/repo-knowledge-dashboard-snapshot.js';
import { inspectEntity } from '../src/dashboard/inspector-data.js';
import type { IngestSource } from '../src/integrations/repo-knowledge/ingest.js';

describe('Repo-knowledge dashboard inspection', () => {
    let kernel: ClusterKernel;
    let TEST_DIR: string;
    let SOURCES_DIR: string;
    let CLUSTER_DIR: string;

    beforeEach(async () => {
        TEST_DIR = mkdtempSync(join(tmpdir(), 'db-cluster-rk-dashboard-'));
        SOURCES_DIR = join(TEST_DIR, 'sources');
        CLUSTER_DIR = join(TEST_DIR, 'cluster');
        mkdirSync(SOURCES_DIR, { recursive: true });
        const cluster = createLocalCluster(CLUSTER_DIR);
        kernel = new ClusterKernel(cluster, { dataDir: CLUSTER_DIR });

        // Seed with repo-knowledge content
        writeFileSync(join(SOURCES_DIR, 'README.md'),
            '# db-cluster\n\nAI-native federated database cluster.\n\n## Status\n\nPhase 13 complete.\n');
        writeFileSync(join(SOURCES_DIR, 'memory.md'),
            '# Project Memory\n\n## Key Fact\n\nThe system uses strict TypeScript.\n');
        writeFileSync(join(SOURCES_DIR, 'CHANGELOG.md'),
            '# Changelog\n\n## Phase 12\n\nArtifact restore repaired.\n');

        const sources: IngestSource[] = [
            { path: join(SOURCES_DIR, 'README.md') },
            { path: join(SOURCES_DIR, 'memory.md') },
            { path: join(SOURCES_DIR, 'CHANGELOG.md') },
        ];

        await ingestRepoKnowledge(kernel, sources, {
            repoName: 'db-cluster',
            projectName: 'db-cluster',
            actorId: 'test-agent',
        });
    });

    afterEach(() => {
        try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
    });

    it('generates dashboard snapshot from imported memory', async () => {
        const snapshot = await generateRepoKnowledgeSnapshot(CLUSTER_DIR, 'db-cluster');

        expect(snapshot.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(snapshot.repoName).toBe('db-cluster');
        expect(snapshot.objects.length).toBeGreaterThan(0);
    });

    it('snapshot includes repo entity', async () => {
        const snapshot = await generateRepoKnowledgeSnapshot(CLUSTER_DIR, 'db-cluster');

        const repoObj = snapshot.objects.find((o) => o.type === 'entity' && o.object.kind === 'repo');
        expect(repoObj).toBeDefined();
        expect(repoObj!.ownerStore).toBe('canonical');
        expect(repoObj!.sourceType).toBe('owner-truth');
    });

    it('snapshot includes project entity', async () => {
        const snapshot = await generateRepoKnowledgeSnapshot(CLUSTER_DIR, 'db-cluster');

        const projectObj = snapshot.objects.find((o) => o.type === 'entity' && o.object.kind === 'project');
        expect(projectObj).toBeDefined();
        expect(projectObj!.name).toBe('db-cluster');
    });

    it('fact trace shows source artifact', async () => {
        const snapshot = await generateRepoKnowledgeSnapshot(CLUSTER_DIR, 'db-cluster');

        // Find a fact-type entity with provenance
        const factObj = snapshot.objects.find(
            (o) => o.type === 'entity' && (o.object.kind === 'fact' || o.object.kind === 'source'),
        );

        if (factObj) {
            // Should have provenance graph
            expect(factObj.provenanceGraph).toBeDefined();
            expect(factObj.provenanceGraph.nodes.length).toBeGreaterThan(0);
        }
    });

    it('index records labeled derivative', async () => {
        const snapshot = await generateRepoKnowledgeSnapshot(CLUSTER_DIR, 'db-cluster');

        const indexObjs = snapshot.objects.filter((o) => o.ownerStore === 'index');
        for (const obj of indexObjs) {
            expect(obj.sourceType).toBe('derivative');
        }
    });

    it('receipts visible for ingest operations', async () => {
        const snapshot = await generateRepoKnowledgeSnapshot(CLUSTER_DIR, 'db-cluster');

        // At least some entities should have receipts
        const withReceipts = snapshot.objects.filter((o) => o.receipts.length > 0);
        expect(withReceipts.length).toBeGreaterThan(0);
    });

    it('operations health is included', async () => {
        const snapshot = await generateRepoKnowledgeSnapshot(CLUSTER_DIR, 'db-cluster');

        expect(snapshot.operations).toBeDefined();
        expect(snapshot.operations.overall).toBeDefined();
        expect(snapshot.operations.stores.length).toBeGreaterThan(0);
    });

    it('entity inspection shows owner store and source type', async () => {
        const results = await kernel.findSources({ query: 'db-cluster' });
        if (results.resolvedEntities.length > 0) {
            const obj = await inspectEntity(kernel, results.resolvedEntities[0].id);
            expect(obj.ownerStore).toBe('canonical');
            expect(obj.sourceType).toBe('owner-truth');
            expect(obj.uri).toMatch(/^cluster:\/\/canonical\/entity\//);
        }
    });
});
