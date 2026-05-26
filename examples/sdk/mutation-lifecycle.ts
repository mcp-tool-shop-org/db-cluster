/**
 * SDK Example: Full mutation lifecycle.
 *
 * Demonstrates: propose → validate → approve → commit → receipt → trace.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalCluster } from '../../src/adapters/local/index.js';
import { ClusterKernel } from '../../src/kernel/cluster-kernel.js';

async function main() {
    const dataDir = mkdtempSync(join(tmpdir(), 'db-cluster-mutation-'));
    const stores = createLocalCluster(dataDir);
    const kernel = new ClusterKernel(stores, { dataDir });

    // Create initial entity
    const entity = await kernel.createEntity({
        kind: 'decision',
        name: 'Use command-gated mutation',
        attributes: { status: 'proposed', confidence: 'medium' },
    });
    console.log('Entity created:', entity.id, entity.name);

    // Step 1: Propose a mutation
    const command = await kernel.proposeMutation({
        verb: 'update_entity',
        targetStore: 'canonical',
        payload: { entityId: entity.id, patch: { name: 'Use command-gated mutation (confirmed)', attributes: { status: 'confirmed', confidence: 'high' } } },
        proposedBy: 'architect',
    });
    console.log('\n1. Proposed:', command.id, '→ status:', command.status);

    // Step 2: Validate
    const validated = await kernel.validateCommand(command.id);
    console.log('2. Validated:', validated.status, '→ errors:', validated.validationResult?.errors.length ?? 0);

    // Step 3: Approve
    const approved = await kernel.approveCommand(command.id, 'tech-lead', 'Reviewed in architecture meeting');
    console.log('3. Approved:', approved.status, '→ by tech-lead');

    // Step 4: Commit — THIS is where the store writes happen
    const { command: committed, receipt } = await kernel.commitMutation(command.id, 'tech-lead');
    console.log('4. Committed:', committed.status);
    console.log('   Receipt:', receipt.id);
    console.log('   Affected IDs:', receipt.affectedIds);
    console.log('   Provenance event:', receipt.provenanceEventId);

    // Step 5: Verify the entity was updated
    const updated = await stores.canonical.get(entity.id);
    console.log('\n5. Entity after commit:', updated?.name);

    // Step 6: Trace provenance
    const graph = await kernel.traceObject(`cluster://canonical/${entity.id}`);
    console.log('\n6. Provenance trace:');
    for (const node of graph.nodes) {
        console.log(`   ${node.action} by ${node.actorId} at ${node.timestamp}`);
    }

    // Step 7: List all receipts
    const receipts = await kernel.listReceipts();
    console.log('\n7. Total receipts:', receipts.length);

    // Cleanup
    rmSync(dataDir, { recursive: true, force: true });
    console.log('\nDone.');
}

main().catch(console.error);
