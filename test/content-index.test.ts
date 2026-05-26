import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalCluster } from '../src/adapters/local/index.js';
import { ClusterKernel } from '../src/kernel/cluster-kernel.js';
import { rebuildIndex } from '../src/ops/rebuild.js';
import { buildArtifactIndexText } from '../src/indexing/content-indexer.js';
import { extractHeadings, extractKeyTerms, tokenize } from '../src/indexing/tokenizer.js';

describe('Wave 5: Content-aware project-memory retrieval', () => {
    let dataDir: string;
    let kernel: ClusterKernel;

    beforeAll(async () => {
        dataDir = mkdtempSync(join(tmpdir(), 'content-idx-'));
        const stores = createLocalCluster(dataDir);
        kernel = new ClusterKernel(stores, { dataDir });

        // Ingest realistic project docs
        await kernel.ingestArtifact({
            filename: 'docs/phase-6-closeout.md',
            content: Buffer.from(`# Phase 6 — AI-Facing Interface: MCP and SDK
## Summary
Phase 6 introduced the MCP server and TypeScript SDK.
The MCP tools expose cluster thesis to AI agents.
16 tools provide full cluster access through JSON-RPC.
## Deliverables
- MCP server with tool catalog
- TypeScript SDK with type-safe methods
- Trust zone enforcement for AI-facing access`),
            mimeType: 'text/markdown',
            actorId: 'operator',
        });

        await kernel.ingestArtifact({
            filename: 'docs/phase-5-closeout.md',
            content: Buffer.from(`# Phase 5 — Mutation Law and Command Runtime
## Summary
Phase 5 proved that AI proposes, command runtime disposes.
Every mutation requires propose → validate → approve → commit.
No direct writes to truth stores.
## Key Decision
AI proposes, command runtime disposes.
This is the mutation law.`),
            mimeType: 'text/markdown',
            actorId: 'operator',
        });

        await kernel.ingestArtifact({
            filename: 'docs/phase-10-closeout.md',
            content: Buffer.from(`# Phase 10 — Developer Product Surface
## Summary
Phase 10 made the product developer-runnable.
Documentation, quickstart, CLI reference, SDK examples.
The cluster is legible and runnable as a developer product.
## Outcome
434 tests passing. Product is installable and documented.`),
            mimeType: 'text/markdown',
            actorId: 'operator',
        });

        await kernel.ingestArtifact({
            filename: 'docs/phase-8-closeout.md',
            content: Buffer.from(`# Phase 8 — Retrieval Bundles and Evidence Assembly
## Supporting Artifacts
Evidence bundles resolve to owner truth.
Freshness tracking prevents stale retrieval.
## RAG Drift Protection
This phase explicitly protects against RAG drift.
Retrieval returns structured evidence, not flat search hits.`),
            mimeType: 'text/markdown',
            actorId: 'operator',
        });

        await kernel.ingestArtifact({
            filename: 'docs/phase-11-dogfood-report.md',
            content: Buffer.from(`# Phase 11 — Dogfood Report
## Friction observed
1. restore does not restore artifacts
2. commitMutation does not auto-index
## Finding
Backup/restore does not preserve artifact truth.`),
            mimeType: 'text/markdown',
            actorId: 'operator',
        });

        // Rebuild with content-aware indexing
        const stores2 = createLocalCluster(dataDir);
        await rebuildIndex(stores2);
    });

    afterAll(() => {
        rmSync(dataDir, { recursive: true, force: true });
    });

    it('artifact content is indexed', async () => {
        const stores = createLocalCluster(dataDir);
        const results = await stores.index.search({ text: 'mutation law' });
        expect(results.length).toBeGreaterThan(0);
        expect(results.some((r) => r.sourceStore === 'artifact')).toBe(true);
    });

    it('changelog/closeout text is indexed', async () => {
        const stores = createLocalCluster(dataDir);
        const results = await stores.index.search({ text: 'developer product' });
        expect(results.length).toBeGreaterThan(0);
    });

    it('closeout headings are indexed', async () => {
        const stores = createLocalCluster(dataDir);
        // Phase 6 heading mentions MCP
        const results = await stores.index.search({ text: 'MCP' });
        expect(results.length).toBeGreaterThan(0);
    });

    it('dogfood retrieval finds Phase 6 for MCP', async () => {
        const stores = createLocalCluster(dataDir);
        const results = await stores.index.search({ text: 'MCP' });
        const phase6 = results.find((r) => r.text.includes('phase-6'));
        expect(phase6).toBeDefined();
    });

    it('dogfood retrieval finds Phase 5 for mutation law', async () => {
        const stores = createLocalCluster(dataDir);
        const results = await stores.index.search({ text: 'mutation' });
        const phase5 = results.find((r) => r.text.includes('phase-5'));
        expect(phase5).toBeDefined();
    });

    it('dogfood retrieval finds Phase 10 for developer-runnable', async () => {
        const stores = createLocalCluster(dataDir);
        const results = await stores.index.search({ text: 'developer' });
        const phase10 = results.find((r) => r.text.includes('phase-10'));
        expect(phase10).toBeDefined();
    });

    it('retrieval returns owner truth, not index-only text', async () => {
        const stores = createLocalCluster(dataDir);
        const kernel2 = new ClusterKernel(stores, { dataDir });
        const results = await stores.index.search({ text: 'MCP' });
        expect(results.length).toBeGreaterThan(0);

        // Verify we can resolve to the actual artifact (owner truth)
        const artifact = await stores.artifact.get(results[0].sourceId);
        expect(artifact).not.toBeNull();
        expect(artifact!.filename).toContain('phase-6');
    });

    it('index remains rebuildable and derivative', async () => {
        const stores = createLocalCluster(dataDir);
        // Clear index
        await stores.index.clear();
        const empty = await stores.index.search({ text: 'MCP' });
        expect(empty.length).toBe(0);

        // Rebuild
        await rebuildIndex(stores);
        const rebuilt = await stores.index.search({ text: 'MCP' });
        expect(rebuilt.length).toBeGreaterThan(0);
    });

    // Unit tests for tokenizer
    it('tokenizer: extractHeadings finds markdown headings', () => {
        const md = '# Title\n## Subtitle\nBody text\n### Deep heading';
        const headings = extractHeadings(md);
        expect(headings).toEqual(['Title', 'Subtitle', 'Deep heading']);
    });

    it('tokenizer: extractKeyTerms removes stop words', () => {
        const text = 'The mutation law is the core principle of the command runtime';
        const terms = extractKeyTerms(text);
        expect(terms).toContain('mutation');
        expect(terms).toContain('command');
        expect(terms).toContain('runtime');
        expect(terms).not.toContain('the');
        expect(terms).not.toContain('is');
    });
});
