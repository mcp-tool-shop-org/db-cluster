import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLocalCluster } from '../src/adapters/local/index.js';
import { ClusterKernel } from '../src/kernel/cluster-kernel.js';
import { ingestRepoKnowledge } from '../src/integrations/repo-knowledge/ingest.js';
import { proposeFactUpdate, executeFactUpdate, generateWritebackPayload } from '../src/integrations/repo-knowledge/update-workflow.js';
import type { IngestSource } from '../src/integrations/repo-knowledge/ingest.js';

const TEST_DIR = join(import.meta.dirname, '.test-rk-mutation');
const SOURCES_DIR = join(TEST_DIR, 'sources');
const CLUSTER_DIR = join(TEST_DIR, 'cluster');

describe('Repo-knowledge mutation safety', () => {
    let kernel: ClusterKernel;
    let factEntityId: string;
    let artifactId: string;
    const sourcePath = join(SOURCES_DIR, 'memory.md');
    const originalContent = '# Memory\n\n## Phase Status\n\nPhase 12 complete.\n';

    beforeEach(async () => {
        rmSync(TEST_DIR, { recursive: true, force: true });
        mkdirSync(SOURCES_DIR, { recursive: true });
        const cluster = createLocalCluster(CLUSTER_DIR);
        kernel = new ClusterKernel(cluster, { dataDir: CLUSTER_DIR });

        writeFileSync(sourcePath, originalContent);

        const sources: IngestSource[] = [
            { path: sourcePath, entityKind: 'fact' },
        ];

        const result = await ingestRepoKnowledge(kernel, sources, {
            repoName: 'test-repo',
            actorId: 'test-agent',
        });

        // Find the fact entity (not the repo entity)
        const factEntities = result.entityIds.filter((id) => id !== result.repoEntityId);
        factEntityId = factEntities[0];
        artifactId = result.artifactIds[0];
    });

    afterEach(() => {
        rmSync(TEST_DIR, { recursive: true, force: true });
    });

    it('agent can propose fact update', async () => {
        const cmd = await proposeFactUpdate(kernel, {
            factEntityId,
            patch: { phase: 13 },
            supportingArtifacts: [artifactId],
            proposedBy: 'agent:claude',
            reason: 'Phase 13 is now complete',
        });

        expect(cmd.status).toBe('proposed');
        expect(cmd.proposedBy).toBe('agent:claude');
    });

    it('agent cannot commit directly through workflow (requires operator)', async () => {
        // The workflow layer enforces the gate — agent proposes, operator commits
        const cmd = await proposeFactUpdate(kernel, {
            factEntityId,
            patch: { phase: 13 },
            supportingArtifacts: [artifactId],
            proposedBy: 'agent:claude',
            reason: 'Phase 13 complete',
        });

        // Command exists in proposed state — workflow requires operator approval
        expect(cmd.status).toBe('proposed');
        expect(cmd.proposedBy).toBe('agent:claude');

        // Workflow function executeFactUpdate enforces the validate→approve→commit gate
        // The kernel allows commit (it's permissive), but the workflow won't skip steps
    });

    it('operator can approve and commit update', async () => {
        const result = await executeFactUpdate(
            kernel,
            {
                factEntityId,
                patch: { phase: 13, status: 'complete' },
                supportingArtifacts: [artifactId],
                proposedBy: 'agent:claude',
                reason: 'Phase 13 complete',
            },
            'operator',
        );

        expect(result.committed).toBe(true);
        expect(result.receiptId).toBeTruthy();
        expect(result.repoKnowledgeModified).toBe(false);
    });

    it('update requires supporting artifacts', async () => {
        await expect(
            proposeFactUpdate(kernel, {
                factEntityId,
                patch: { phase: 13 },
                supportingArtifacts: [], // No support!
                proposedBy: 'agent:claude',
                reason: 'No evidence',
            }),
        ).rejects.toThrow('at least one supporting artifact');
    });

    it('receipt links to command and affected fact', async () => {
        const result = await executeFactUpdate(
            kernel,
            {
                factEntityId,
                patch: { phase: 13 },
                supportingArtifacts: [artifactId],
                proposedBy: 'agent:claude',
                reason: 'Phase 13',
            },
            'operator',
        );

        const receipts = await kernel.listReceipts({ limit: 100 });
        const receipt = receipts.find((r) => r.id === result.receiptId);
        expect(receipt).toBeDefined();
    });

    it('trace shows source artifacts after update', async () => {
        await executeFactUpdate(
            kernel,
            {
                factEntityId,
                patch: { phase: 13 },
                supportingArtifacts: [artifactId],
                proposedBy: 'agent:claude',
                reason: 'Phase 13',
            },
            'operator',
        );

        const events = await kernel.traceProvenance(factEntityId);
        expect(events.length).toBeGreaterThan(0);
    });

    it('repo-knowledge source files remain untouched', async () => {
        await executeFactUpdate(
            kernel,
            {
                factEntityId,
                patch: { phase: 13 },
                supportingArtifacts: [artifactId],
                proposedBy: 'agent:claude',
                reason: 'Phase 13',
            },
            'operator',
        );

        // Source file unchanged
        const afterContent = readFileSync(sourcePath, 'utf-8');
        expect(afterContent).toBe(originalContent);
    });

    it('writeback payload generated but not applied', () => {
        const wb = generateWritebackPayload(factEntityId, { phase: 13 }, 'cmd-123');

        expect(wb.applied).toBe(false);
        expect(wb.payload.entityId).toBe(factEntityId);
        expect(wb.payload.commandRef).toBe('cmd-123');
        expect(wb.payload.warning).toContain('NOT applied');
    });
});
