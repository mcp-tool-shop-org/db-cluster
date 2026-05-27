/**
 * SDK Example: Full mutation lifecycle.
 *
 * Demonstrates: propose → validate → approve → commit → receipt → trace,
 * all through the SDK (the only public path for callers).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClusterSDK } from 'db-cluster/sdk';

async function main() {
    const dataDir = mkdtempSync(join(tmpdir(), 'db-cluster-mutation-'));
    const sdk = new ClusterSDK({ clusterDir: dataDir });

    // Seed: create an entity through the lifecycle so we have something to update.
    const seedCmd = await sdk.proposeMutation({
        verb: 'create_entity',
        targetStore: 'canonical',
        payload: {
            kind: 'decision',
            name: 'Use command-gated mutation',
            attributes: { status: 'proposed', confidence: 'medium' },
        },
        proposedBy: 'architect',
    });
    await sdk.validateMutation(seedCmd.id);
    const { receipt: seedReceipt } = await sdk.commitMutation(seedCmd.id, 'architect');
    const entityId = seedReceipt.affectedIds[0];
    console.log('Entity created:', entityId);

    // Step 1: Propose a mutation
    const command = await sdk.proposeMutation({
        verb: 'update_entity',
        targetStore: 'canonical',
        payload: {
            entityId,
            patch: { name: 'Use command-gated mutation (confirmed)', attributes: { status: 'confirmed', confidence: 'high' } },
        },
        proposedBy: 'architect',
    });
    console.log('\n1. Proposed:', command.id, '→ status:', command.status);

    // Step 2: Validate
    const validated = await sdk.validateMutation(command.id);
    const failedChecks = validated.validation?.checks.filter((c) => !c.passed).length ?? 0;
    console.log('2. Validated:', validated.status, '→ failed checks:', failedChecks);

    // Step 3: Approve
    const approved = await sdk.approveMutation(command.id, 'tech-lead', 'Reviewed in architecture meeting');
    console.log('3. Approved:', approved.status, '→ by tech-lead');

    // Step 4: Commit — THIS is where the store writes happen
    const { command: committed, receipt } = await sdk.commitMutation(command.id, 'tech-lead');
    console.log('4. Committed:', committed.status);
    console.log('   Receipt:', receipt.id);
    console.log('   Affected IDs:', receipt.affectedIds);
    console.log('   Provenance event:', receipt.provenanceEventId);

    // Step 5: Verify the entity was updated via resolve()
    const { object: updated } = await sdk.resolve(`cluster://canonical/${entityId}`);
    console.log('\n5. Entity after commit:', (updated as { name: string }).name);

    // Step 6: Trace provenance
    const graph = await sdk.traceObject(`cluster://canonical/${entityId}`);
    console.log('\n6. Provenance trace:');
    for (const node of graph.nodes) {
        console.log(`   ${node.label} (${node.uri})`);
    }

    // Step 7: List all receipts
    const receipts = await sdk.listReceipts();
    console.log('\n7. Total receipts:', receipts.length);

    // Cleanup
    rmSync(dataDir, { recursive: true, force: true });
    console.log('\nDone.');
}

main().catch(console.error);
