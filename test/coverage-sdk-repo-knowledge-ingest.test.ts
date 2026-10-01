/**
 * Coverage — repo-knowledge ingest: mime-type mapping from file extension,
 * skipping of paths that are missing or not regular files, entity-kind
 * inference from names and content, and heading-based fact extraction bounds.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLocalCluster } from '../src/adapters/local/index.js';
import { ClusterKernel } from '../src/kernel/cluster-kernel.js';
import { ingestRepoKnowledge, extractFacts } from '../src/integrations/repo-knowledge/ingest.js';
import type { ClusterStores } from '../src/contracts/index.js';

describe('repo-knowledge ingest', () => {
    let root: string;
    let sources: string;
    let stores: ClusterStores;
    let kernel: ClusterKernel;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'cov-rk-ingest-'));
        sources = join(root, 'sources');
        mkdirSync(sources, { recursive: true });
        stores = createLocalCluster(join(root, 'cluster'));
        kernel = new ClusterKernel(stores, { dataDir: join(root, 'cluster') });
    });
    afterEach(() => {
        rmSync(root, { recursive: true, force: true });
    });

    const write = (name: string, body = 'plain body') => {
        const p = join(sources, name);
        writeFileSync(p, body);
        return p;
    };

    it('maps file extensions to mime types (case-insensitively) with an octet-stream default', async () => {
        const files = {
            'notes.md': 'text/markdown',
            'LOUD.MD': 'text/markdown',
            'data.json': 'application/json',
            'code.ts': 'text/typescript',
            'script.js': 'text/javascript',
            'plain.txt': 'text/plain',
            'config.yaml': 'text/yaml',
            'config.yml': 'text/yaml',
            'blob.bin': 'application/octet-stream',
            'noext': 'application/octet-stream',
        } as const;
        const entries = Object.keys(files).map((name) => ({ path: write(name) }));
        const result = await ingestRepoKnowledge(kernel, entries, { repoName: 'mime-repo', actorId: 'ingester' });
        expect(result.artifactIds).toHaveLength(Object.keys(files).length);

        const artifacts = await stores.artifact.list();
        const mimeByName = Object.fromEntries(artifacts.map((a) => [a.filename, a.mimeType]));
        expect(mimeByName).toEqual(files);
    });

    it('skips missing paths and directories, recording them without failing the run', async () => {
        const good = write('good.md');
        const dirPath = join(sources, 'a-directory');
        mkdirSync(dirPath);
        const missing = join(sources, 'does-not-exist.md');

        const result = await ingestRepoKnowledge(
            kernel,
            [{ path: missing }, { path: dirPath }, { path: good }],
            { repoName: 'skip-repo', actorId: 'ingester' },
        );
        expect(result.skipped).toEqual([missing, dirPath]);
        expect(result.artifactIds).toHaveLength(1);
        expect((await stores.artifact.get(result.artifactIds[0]))?.filename).toBe('good.md');
    });

    it('creates the repo entity, an optional project entity, and counts receipts and provenance links', async () => {
        const result = await ingestRepoKnowledge(
            kernel,
            [{ path: write('README.md', '# Title') }],
            { repoName: 'counted-repo', projectName: 'counted-project', actorId: 'ingester', tags: ['t1'] },
        );
        const repo = await stores.canonical.get(result.repoEntityId);
        expect(repo).toMatchObject({ kind: 'repo', name: 'counted-repo' });
        expect(repo?.attributes.tags).toEqual(['t1']);
        const project = await stores.canonical.get(result.projectEntityId!);
        expect(project).toMatchObject({ kind: 'project', name: 'counted-project' });
        expect(project?.attributes.repo).toBe('counted-repo');
        // repo + project entity, artifact ingest, source entity + 2 links.
        expect(result.entityIds).toHaveLength(3);
        expect(result.provenanceLinks).toBe(2);
        expect(result.receipts).toBe(6);
    });

    it.each([
        ['README.md', 'anything', 'source'],
        ['CHANGELOG.md', 'anything', 'source'],
        ['phase-closeout.md', 'anything', 'phase'],
        ['finding-01.md', 'anything', 'finding'],
        ['decision-log.md', 'anything', 'decision'],
        ['phase-2.md', 'anything', 'phase'],
        ['status.md', '## Status\nok', 'project'],
        ['obs.md', '## Observation\nx', 'finding'],
        ['verdict.md', '## Verdict\nx', 'decision'],
        ['misc.md', 'no markers here', 'fact'],
    ])('infers the entity kind for %s', async (filename, body, expectedKind) => {
        const result = await ingestRepoKnowledge(
            kernel,
            [{ path: write(filename, body), attributes: { origin: 'test' } }],
            { repoName: 'infer-repo', actorId: 'ingester' },
        );
        const sourceEntity = await stores.canonical.get(result.entityIds[1]);
        expect(sourceEntity?.kind).toBe(expectedKind);
        expect(sourceEntity?.name).toBe(filename.replace(/\.md$/, ''));
        expect(sourceEntity?.attributes).toMatchObject({ sourceFile: filename, origin: 'test' });
    });

    it('an explicit entityKind overrides inference', async () => {
        const result = await ingestRepoKnowledge(
            kernel,
            [{ path: write('README.md', 'x'), entityKind: 'decision' }],
            { repoName: 'override-repo', actorId: 'ingester' },
        );
        expect((await stores.canonical.get(result.entityIds[1]))?.kind).toBe('decision');
    });

    it('extractFacts creates a fact per H1-H3 heading whose text is 4-199 characters, linked to the artifact', async () => {
        const { artifact } = await kernel.ingestArtifact({
            filename: 'facts.md', content: Buffer.from('x'), mimeType: 'text/markdown', actorId: 'ingester',
        });
        const longHeading = 'L'.repeat(200);
        const content = [
            '# Valid heading one',
            'body text',
            '## Abc',              // 3 chars: too short
            '### Another valid heading',
            '#### too deep to count',
            `## ${longHeading}`,   // 200 chars: too long
            'not a heading',
        ].join('\n');

        const factIds = await extractFacts(kernel, artifact.id, content, { actorId: 'ingester', repoEntityId: 'unused' });
        expect(factIds).toHaveLength(2);
        const facts = await Promise.all(factIds.map((id) => stores.canonical.get(id)));
        expect(facts.map((f) => f?.name)).toEqual(['Valid heading one', 'Another valid heading']);
        expect(facts[0]).toMatchObject({ kind: 'fact', attributes: { sourceArtifact: artifact.id, extractedFrom: 'heading' } });
        const links = await stores.ledger.listEvents({ action: 'evidence_linked' });
        expect(links.map((e) => e.subjectId).sort()).toEqual([...factIds].sort());
    });

    it('extractFacts returns nothing for content with no qualifying headings', async () => {
        const { artifact } = await kernel.ingestArtifact({
            filename: 'empty.md', content: Buffer.from('x'), mimeType: 'text/markdown', actorId: 'ingester',
        });
        expect(await extractFacts(kernel, artifact.id, 'just prose\nand more prose', { actorId: 'a', repoEntityId: 'r' })).toEqual([]);
    });
});
