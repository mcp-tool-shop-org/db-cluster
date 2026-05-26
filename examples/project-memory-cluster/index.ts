/**
 * Example: Project Memory Cluster
 *
 * A development team tracks decisions, tasks, and source documentation.
 * The cluster proves: trace decision to source note, command-gated update,
 * receipts, backup/restore.
 *
 * Uses: artifact store (docs/notes), canonical store (repos/tasks/decisions),
 *       index store (discovery), ledger store (provenance + receipts).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalCluster } from '../../src/adapters/local/index.js';
import { ClusterKernel } from '../../src/kernel/cluster-kernel.js';
import { backup, restore } from '../../src/ops/backup.js';
import { doctor } from '../../src/ops/doctor.js';

async function main() {
    const dataDir = mkdtempSync(join(tmpdir(), 'project-memory-'));
    const stores = createLocalCluster(dataDir);
    const kernel = new ClusterKernel(stores, { dataDir });

    console.log('=== Project Memory Cluster ===\n');

    // Ingest meeting notes and docs
    const notes = await kernel.ingestArtifact({
        filename: 'architecture-meeting-2026-05-20.md',
        content: Buffer.from('# Architecture Meeting\n\nDecision: adopt command-gated mutation for all DB writes.\nRationale: prevents unauthorized state changes, provides audit trail.'),
        mimeType: 'text/markdown',
    });

    const spec = await kernel.ingestArtifact({
        filename: 'api-spec-v2.yaml',
        content: Buffer.from('openapi: 3.0\ninfo:\n  title: Project API\n  version: 2.0'),
        mimeType: 'application/yaml',
    });

    console.log('Docs ingested:', notes.filename, spec.filename);

    // Create entities: repo, task, decision
    const repo = await kernel.createEntity({
        kind: 'repo',
        name: 'project-api',
        attributes: { language: 'typescript', team: 'platform' },
    });

    const decision = await kernel.createEntity({
        kind: 'decision',
        name: 'Adopt command-gated mutation',
        attributes: { status: 'accepted', meeting: '2026-05-20', sourceNote: notes.id },
    });

    const task = await kernel.createEntity({
        kind: 'task',
        name: 'Implement mutation lifecycle',
        attributes: { status: 'in-progress', assignee: 'developer', decision: decision.id },
    });

    console.log('Entities:', repo.name, '|', decision.name, '|', task.name);

    // Trace decision to source note
    console.log('\n--- Trace decision provenance ---');
    const graph = await kernel.traceObject(`cluster://canonical/${decision.id}`);
    console.log('Decision trace nodes:', graph.nodes.length);

    // Command-gated update (task completion)
    console.log('\n--- Command-gated mutation ---');
    const cmd = await kernel.proposeMutation({
        verb: 'update_entity',
        targetStore: 'canonical',
        payload: { entityId: task.id, patch: { attributes: { status: 'completed' } } },
        proposedBy: 'developer',
    });
    console.log('Proposed:', cmd.id, '→', cmd.status);

    const { command, receipt } = await kernel.commitMutation(cmd.id, 'developer');
    console.log('Committed:', command.status);
    console.log('Receipt:', receipt.id, '→ affected:', receipt.affectedIds);

    // List all receipts
    const receipts = await kernel.listReceipts();
    console.log('\n--- Receipts ---');
    console.log('Total receipts:', receipts.length);

    // Backup
    console.log('\n--- Backup/Restore ---');
    const backupData = await backup(stores);
    console.log('Backup: entities:', backupData.entities.length, 'artifacts:', backupData.artifacts.length, 'events:', backupData.events.length);

    // Restore into fresh cluster
    const freshDir = mkdtempSync(join(tmpdir(), 'project-memory-restored-'));
    const freshStores = createLocalCluster(freshDir);
    const result = await restore(freshStores, backupData);
    console.log('Restored: entities:', result.entities.created, 'events:', result.events.created);

    // Doctor on restored cluster
    const health = await doctor(freshStores);
    console.log('Restored cluster health:', health.status);

    // Cleanup
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(freshDir, { recursive: true, force: true });
    console.log('\nDone.');
}

main().catch(console.error);
