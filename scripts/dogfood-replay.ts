/**
 * Dogfood Replay — replays the Phase 11 workflow after Phase 12 repairs.
 * Verifies none of the four original findings reproduce.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalCluster } from '../src/adapters/local/index.js';
import { ClusterKernel } from '../src/kernel/cluster-kernel.js';
import { CommandQueue } from '../src/kernel/command-queue.js';
import { backup, restore } from '../src/ops/backup.js';
import { rebuildIndex } from '../src/ops/rebuild.js';
import { doctor } from '../src/ops/doctor.js';

export interface ReplayResult {
    findings: {
        artifactRestoreFails: boolean;
        commandAutoIndexFails: boolean;
        commandPersistenceFails: boolean;
        contentRetrievalFails: boolean;
    };
    stats: {
        artifacts: number;
        entities: number;
        commands: number;
    };
}

export async function runDogfoodReplay(): Promise<ReplayResult> {
    const dataDir = mkdtempSync(join(tmpdir(), 'dogfood-replay-'));
    const stores = createLocalCluster(dataDir);
    const kernel = new ClusterKernel(stores, { dataDir });

    // 1. Ingest project docs
    await kernel.ingestArtifact({
        filename: 'docs/phase-5-closeout.md',
        content: Buffer.from('# Phase 5 — Mutation Law\nAI proposes, command runtime disposes.\nEvery mutation requires propose → validate → approve → commit.'),
        mimeType: 'text/markdown',
        actorId: 'operator',
    });
    await kernel.ingestArtifact({
        filename: 'docs/phase-6-closeout.md',
        content: Buffer.from('# Phase 6 — AI-Facing Interface: MCP and SDK\nMCP tools expose cluster thesis. 16 tools via JSON-RPC.'),
        mimeType: 'text/markdown',
        actorId: 'operator',
    });
    await kernel.ingestArtifact({
        filename: 'docs/phase-10-closeout.md',
        content: Buffer.from('# Phase 10 — Developer Product Surface\nThe cluster is legible and runnable as a developer product.'),
        mimeType: 'text/markdown',
        actorId: 'operator',
    });

    // 2. Create entities
    await kernel.createEntity({ kind: 'phase', name: 'Phase 5 — Mutation Law', attributes: {}, actorId: 'operator' });
    await kernel.createEntity({ kind: 'phase', name: 'Phase 6 — MCP and SDK', attributes: {}, actorId: 'operator' });
    await kernel.createEntity({ kind: 'phase', name: 'Phase 10 — Developer Product', attributes: {}, actorId: 'operator' });
    await kernel.createEntity({ kind: 'milestone', name: '484 tests across 35 files', attributes: {}, actorId: 'operator' });
    await kernel.createEntity({ kind: 'decision', name: 'AI proposes, command runtime disposes', attributes: {}, actorId: 'operator' });

    // 3. Test content retrieval (Finding 4 regression)
    await rebuildIndex(stores);
    const mcpResults = await stores.index.search({ text: 'MCP' });
    const mutationResults = await stores.index.search({ text: 'mutation' });
    const developerResults = await stores.index.search({ text: 'developer product' });
    const contentRetrievalFails = mcpResults.length === 0 || mutationResults.length === 0 || developerResults.length === 0;

    // 4. Test command-created entity auto-index (Finding 2 regression)
    const proposal = await kernel.proposeMutation({
        verb: 'create_entity',
        targetStore: 'canonical',
        payload: { kind: 'finding', name: 'Replay test finding', attributes: {} },
        proposedBy: 'agent',
    });
    await kernel.validateMutation(proposal.id);
    await kernel.approveMutation(proposal.id, 'operator');
    await kernel.commitMutation(proposal.id, 'operator');
    const cmdIndexResults = await stores.index.search({ text: 'Replay test finding' });
    const commandAutoIndexFails = cmdIndexResults.length === 0;

    // 5. Test command persistence across instances (Finding 3 regression)
    const proposal2 = await kernel.proposeMutation({
        verb: 'create_entity',
        targetStore: 'canonical',
        payload: { kind: 'finding', name: 'Persistence test', attributes: {} },
        proposedBy: 'agent',
    });
    await kernel.validateMutation(proposal2.id);
    // New kernel instance can see the command
    const kernel2 = new ClusterKernel(stores, { dataDir });
    const inspected = await kernel2.inspectCommand(proposal2.id);
    const commandPersistenceFails = !inspected || inspected.status !== 'validated';

    // 6. Backup and restore (Finding 1 regression)
    const queue = new CommandQueue(dataDir);
    const backupData = await backup(stores, { commandQueue: queue });
    const restoreDir = mkdtempSync(join(tmpdir(), 'dogfood-replay-restore-'));
    const restoreStores = createLocalCluster(restoreDir);
    const restoreQueue = new CommandQueue(restoreDir);
    const restoreResult = await restore(restoreStores, backupData, { commandQueue: restoreQueue });

    // Artifacts must be restored
    const restoredArtifacts = await restoreStores.artifact.list({});
    const artifactRestoreFails = restoredArtifacts.length === 0 || restoreResult.artifacts.created === 0;

    // 7. Doctor/verify after restore
    await doctor(restoreStores);

    const stats = {
        artifacts: (await stores.artifact.list({})).length,
        entities: (await stores.canonical.list({})).length,
        commands: queue.list().length,
    };

    rmSync(dataDir, { recursive: true, force: true });
    rmSync(restoreDir, { recursive: true, force: true });

    return {
        findings: {
            artifactRestoreFails,
            commandAutoIndexFails,
            commandPersistenceFails,
            contentRetrievalFails,
        },
        stats,
    };
}
