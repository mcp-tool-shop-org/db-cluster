import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLocalCluster } from '../src/adapters/local/index.js';
import { ClusterKernel } from '../src/kernel/cluster-kernel.js';
import { ingestRepoKnowledge, extractFacts } from '../src/integrations/repo-knowledge/ingest.js';
import type { IngestSource } from '../src/integrations/repo-knowledge/ingest.js';

const TEST_DIR = join(import.meta.dirname, '.test-rk-ingest');
const SOURCES_DIR = join(TEST_DIR, 'sources');

describe('Repo-knowledge parallel ingest', () => {
    let kernel: ClusterKernel;

    beforeEach(() => {
        rmSync(TEST_DIR, { recursive: true, force: true });
        mkdirSync(SOURCES_DIR, { recursive: true });
        const cluster = createLocalCluster(join(TEST_DIR, 'cluster'));
        kernel = new ClusterKernel(cluster, { dataDir: join(TEST_DIR, 'cluster') });

        // Create sample source files
        writeFileSync(join(SOURCES_DIR, 'README.md'), '# Test Repo\n\nA test repository.\n\n## Status\n\nPhase 2 complete.\n');
        writeFileSync(join(SOURCES_DIR, 'CHANGELOG.md'), '# Changelog\n\n## v1.0.0\n\n- Initial release\n');
        writeFileSync(join(SOURCES_DIR, 'memory.md'), '# Project Memory\n\n## Key Fact\n\nThe system uses ESM.\n\n## Decision\n\nWe chose TypeScript.\n');
    });

    afterEach(() => {
        rmSync(TEST_DIR, { recursive: true, force: true });
    });

    it('creates artifacts from source files', async () => {
        const sources: IngestSource[] = [
            { path: join(SOURCES_DIR, 'README.md') },
            { path: join(SOURCES_DIR, 'CHANGELOG.md') },
        ];

        const result = await ingestRepoKnowledge(kernel, sources, {
            repoName: 'test-repo',
            actorId: 'ingest-agent',
        });

        expect(result.artifactIds.length).toBe(2);
    });

    it('creates canonical repo entity', async () => {
        const sources: IngestSource[] = [
            { path: join(SOURCES_DIR, 'README.md') },
        ];

        const result = await ingestRepoKnowledge(kernel, sources, {
            repoName: 'test-repo',
            actorId: 'ingest-agent',
        });

        expect(result.repoEntityId).toBeTruthy();
        const entity = await kernel.inspectEntity(result.repoEntityId);
        expect(entity.kind).toBe('repo');
        expect(entity.name).toBe('test-repo');
    });

    it('creates project entity when projectName specified', async () => {
        const sources: IngestSource[] = [
            { path: join(SOURCES_DIR, 'README.md') },
        ];

        const result = await ingestRepoKnowledge(kernel, sources, {
            repoName: 'test-repo',
            projectName: 'my-project',
            actorId: 'ingest-agent',
        });

        expect(result.projectEntityId).toBeTruthy();
        const entity = await kernel.inspectEntity(result.projectEntityId!);
        expect(entity.kind).toBe('project');
        expect(entity.name).toBe('my-project');
    });

    it('links facts to source artifacts', async () => {
        const sources: IngestSource[] = [
            { path: join(SOURCES_DIR, 'README.md') },
        ];

        const result = await ingestRepoKnowledge(kernel, sources, {
            repoName: 'test-repo',
            actorId: 'ingest-agent',
        });

        expect(result.provenanceLinks).toBeGreaterThan(0);
    });

    it('emits receipts for every operation', async () => {
        const sources: IngestSource[] = [
            { path: join(SOURCES_DIR, 'README.md') },
            { path: join(SOURCES_DIR, 'CHANGELOG.md') },
        ];

        const result = await ingestRepoKnowledge(kernel, sources, {
            repoName: 'test-repo',
            actorId: 'ingest-agent',
        });

        expect(result.receipts).toBeGreaterThan(0);
        // Verify receipts exist in the ledger
        const receipts = await kernel.listReceipts({ limit: 100 });
        expect(receipts.length).toBeGreaterThan(0);
    });

    it('skips non-existent files without error', async () => {
        const sources: IngestSource[] = [
            { path: join(SOURCES_DIR, 'README.md') },
            { path: join(SOURCES_DIR, 'DOES_NOT_EXIST.md') },
        ];

        const result = await ingestRepoKnowledge(kernel, sources, {
            repoName: 'test-repo',
            actorId: 'ingest-agent',
        });

        expect(result.artifactIds.length).toBe(1);
        expect(result.skipped).toContain(join(SOURCES_DIR, 'DOES_NOT_EXIST.md'));
    });

    it('re-ingest creates new artifact versions (not overwrites)', async () => {
        const sources: IngestSource[] = [
            { path: join(SOURCES_DIR, 'README.md') },
        ];

        const result1 = await ingestRepoKnowledge(kernel, sources, {
            repoName: 'test-repo',
            actorId: 'ingest-agent',
        });

        // Modify source and re-ingest
        writeFileSync(join(SOURCES_DIR, 'README.md'), '# Updated Repo\n\nNew content.\n');

        const result2 = await ingestRepoKnowledge(kernel, sources, {
            repoName: 'test-repo-v2',
            actorId: 'ingest-agent',
        });

        // Both artifacts exist — new version, not overwrite
        expect(result1.artifactIds[0]).not.toBe(result2.artifactIds[0]);
    });

    it('does not modify source files', async () => {
        const originalContent = '# Test Repo\n\nA test repository.\n\n## Status\n\nPhase 2 complete.\n';
        const readmePath = join(SOURCES_DIR, 'README.md');

        const sources: IngestSource[] = [
            { path: readmePath },
        ];

        await ingestRepoKnowledge(kernel, sources, {
            repoName: 'test-repo',
            actorId: 'ingest-agent',
        });

        // Source file unchanged
        const { readFileSync } = await import('node:fs');
        const afterContent = readFileSync(readmePath, 'utf-8');
        expect(afterContent).toBe(originalContent);
    });

    it('extractFacts creates fact entities from headings', async () => {
        const sources: IngestSource[] = [
            { path: join(SOURCES_DIR, 'memory.md') },
        ];

        const result = await ingestRepoKnowledge(kernel, sources, {
            repoName: 'test-repo',
            actorId: 'ingest-agent',
        });

        const factIds = await extractFacts(
            kernel,
            result.artifactIds[0],
            '# Project Memory\n\n## Key Fact\n\nThe system uses ESM.\n\n## Decision\n\nWe chose TypeScript.\n',
            { actorId: 'ingest-agent', repoEntityId: result.repoEntityId },
        );

        expect(factIds.length).toBeGreaterThan(0);

        // Each fact is a canonical entity
        for (const id of factIds) {
            const entity = await kernel.inspectEntity(id);
            expect(entity.kind).toBe('fact');
        }
    });
});
