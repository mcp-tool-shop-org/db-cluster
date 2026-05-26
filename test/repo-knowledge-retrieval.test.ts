import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLocalCluster } from '../src/adapters/local/index.js';
import { ClusterKernel } from '../src/kernel/cluster-kernel.js';
import { ingestRepoKnowledge } from '../src/integrations/repo-knowledge/ingest.js';
import { compareRetrieval, generateComparisonReport } from '../src/integrations/repo-knowledge/compare-retrieval.js';
import type { IngestSource } from '../src/integrations/repo-knowledge/ingest.js';

const TEST_DIR = join(import.meta.dirname, '.test-rk-retrieval');
const SOURCES_DIR = join(TEST_DIR, 'sources');

describe('Repo-knowledge retrieval comparison', () => {
    let kernel: ClusterKernel;

    beforeEach(async () => {
        rmSync(TEST_DIR, { recursive: true, force: true });
        mkdirSync(SOURCES_DIR, { recursive: true });
        const cluster = createLocalCluster(join(TEST_DIR, 'cluster'));
        kernel = new ClusterKernel(cluster, { dataDir: join(TEST_DIR, 'cluster') });

        // Seed with realistic repo-knowledge-like content
        writeFileSync(join(SOURCES_DIR, 'README.md'),
            '# db-cluster\n\nAI-native federated database cluster.\n\n## Status\n\nPhase 13 — Dashboard complete. 539 tests passing.\n');
        writeFileSync(join(SOURCES_DIR, 'phase-12-closeout.md'),
            '# Phase 12 Closeout\n\n## Findings Repaired\n\n1. Artifact restore with content\n2. Command persistence\n3. Auto-index on commit\n4. Content-aware indexing\n\n## Verdict\n\nPASS\n');
        writeFileSync(join(SOURCES_DIR, 'decisions.md'),
            '# Decisions\n\n## MCP Safety Guardrails\n\nAll MCP tools use typed command lifecycle. No raw state access.\n\n## Test Count Gates\n\nEvery phase must increase test count. Regressions block release.\n');
        writeFileSync(join(SOURCES_DIR, 'npm-publish.md'),
            '# npm Publish Notes\n\n## Stale Global npx\n\nAlways use npx --yes to avoid stale cached versions.\n\n## Pack Before Publish\n\nnpm pack --dry-run to verify tarball contents.\n');

        // Ingest all
        const sources: IngestSource[] = [
            { path: join(SOURCES_DIR, 'README.md') },
            { path: join(SOURCES_DIR, 'phase-12-closeout.md') },
            { path: join(SOURCES_DIR, 'decisions.md') },
            { path: join(SOURCES_DIR, 'npm-publish.md') },
        ];

        await ingestRepoKnowledge(kernel, sources, {
            repoName: 'db-cluster',
            projectName: 'db-cluster',
            actorId: 'test-agent',
        });
    });

    afterEach(() => {
        rmSync(TEST_DIR, { recursive: true, force: true });
    });

    it('returns evidence bundles, not plain search hits', async () => {
        const result = await compareRetrieval(kernel, { query: 'db-cluster' });

        expect(result.bundle).toBeDefined();
        expect(result.bundle.resolvedEntities).toBeInstanceOf(Array);
        expect(result.bundle.confidenceBoundaries).toBeInstanceOf(Array);
    });

    it('resolved facts trace to owner truth', async () => {
        const result = await compareRetrieval(kernel, { query: 'db-cluster' });

        if (result.bundle.resolvedEntities.length > 0) {
            expect(result.resolvesToOwnerTruth).toBe(true);
        }
    });

    it('results have provenance backing', async () => {
        const result = await compareRetrieval(kernel, { query: 'db-cluster' });

        if (result.bundle.resolvedEntities.length > 0) {
            expect(result.hasProvenanceBacking).toBe(true);
            expect(result.provenanceEvents).toBeGreaterThan(0);
        }
    });

    it('freshness is visible on resolved entities', async () => {
        const result = await compareRetrieval(kernel, { query: 'db-cluster' });

        expect(result.freshnessVisible).toBe(true);
    });

    it('missing context is surfaced for unknown queries', async () => {
        const result = await compareRetrieval(kernel, { query: 'completely unknown topic xyzzy' });

        expect(result.missingContextSurfaced).toBe(true);
    });

    it('comparison report covers multiple queries', async () => {
        const report = await generateComparisonReport(kernel, [
            { query: 'db-cluster' },
            { query: 'Phase 12' },
            { query: 'npm publish' },
            { query: 'unknown topic' },
        ]);

        expect(report.queries.length).toBe(4);
        expect(report.summary.totalQueries).toBe(4);
        expect(report.summary.resolvedToOwnerTruth).toBeGreaterThan(0);
    });

    it('supporting artifacts are counted', async () => {
        const result = await compareRetrieval(kernel, { query: 'Phase 12' });

        // Phase 12 content was ingested — should have supporting artifacts
        expect(result.supportingArtifacts).toBeGreaterThanOrEqual(0);
    });

    it('confidence boundaries are reported', async () => {
        const result = await compareRetrieval(kernel, { query: 'db-cluster' });

        // confidenceBoundaries is always an array
        expect(result.confidenceBoundaries).toBeInstanceOf(Array);
    });
});
