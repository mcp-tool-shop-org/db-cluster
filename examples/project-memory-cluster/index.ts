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
import { ClusterSDK } from 'db-cluster/sdk';
import { createLocalCluster, backup, restore, doctor } from 'db-cluster';

async function main() {
    const dataDir = mkdtempSync(join(tmpdir(), 'project-memory-'));
    const sdk = new ClusterSDK({ clusterDir: dataDir });

    console.log('=== Project Memory Cluster ===\n');

    async function ingest(filename: string, content: string, mimeType: string) {
        const cmd = await sdk.proposeMutation({
            verb: 'ingest_artifact',
            targetStore: 'artifact',
            payload: { filename, content: Buffer.from(content), mimeType },
            proposedBy: 'developer',
        });
        await sdk.validateMutation(cmd.id);
        const { receipt } = await sdk.commitMutation(cmd.id, 'developer');
        return receipt.affectedIds[0];
    }

    async function create(name: string, kind: string, attributes: Record<string, unknown>) {
        const cmd = await sdk.proposeMutation({
            verb: 'create_entity',
            targetStore: 'canonical',
            payload: { kind, name, attributes },
            proposedBy: 'developer',
        });
        await sdk.validateMutation(cmd.id);
        const { receipt } = await sdk.commitMutation(cmd.id, 'developer');
        return receipt.affectedIds[0];
    }

    // Ingest meeting notes and docs
    const notesId = await ingest(
        'architecture-meeting-2026-05-20.md',
        '# Architecture Meeting\n\nDecision: adopt command-gated mutation for all DB writes.\nRationale: prevents unauthorized state changes, provides audit trail.',
        'text/markdown',
    );

    const specId = await ingest(
        'api-spec-v2.yaml',
        'openapi: 3.0\ninfo:\n  title: Project API\n  version: 2.0',
        'application/yaml',
    );

    console.log('Docs ingested:', notesId, specId);

    // Create entities: repo, task, decision
    const repoId = await create('project-api', 'repo', { language: 'typescript', team: 'platform' });
    const decisionId = await create('Adopt command-gated mutation', 'decision', {
        status: 'accepted',
        meeting: '2026-05-20',
        sourceNote: notesId,
    });
    const taskId = await create('Implement mutation lifecycle', 'task', {
        status: 'in-progress',
        assignee: 'developer',
        decision: decisionId,
    });

    console.log('Entities:', repoId, '|', decisionId, '|', taskId);

    // Trace decision to source note
    console.log('\n--- Trace decision provenance ---');
    const graph = await sdk.traceObject(`cluster://canonical/${decisionId}`);
    console.log('Decision trace nodes:', graph.nodes.length);

    // Command-gated update (task completion)
    console.log('\n--- Command-gated mutation ---');
    const cmd = await sdk.proposeMutation({
        verb: 'update_entity',
        targetStore: 'canonical',
        payload: { entityId: taskId, patch: { attributes: { status: 'completed' } } },
        proposedBy: 'developer',
    });
    console.log('Proposed:', cmd.id, '→', cmd.status);

    const { command, receipt } = await sdk.commitMutation(cmd.id, 'developer');
    console.log('Committed:', command.status);
    console.log('Receipt:', receipt.id, '→ affected:', receipt.affectedIds);

    // List all receipts
    const receipts = await sdk.listReceipts();
    console.log('\n--- Receipts ---');
    console.log('Total receipts:', receipts.length);

    // Backup/restore — these still operate on raw ClusterStores from createLocalCluster.
    // Construct a parallel stores handle for the same data directory.
    console.log('\n--- Backup/Restore ---');
    const stores = createLocalCluster(dataDir);
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
