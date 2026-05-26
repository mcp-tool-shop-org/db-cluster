/**
 * Dogfood mutation workflow — update project memory through command lifecycle.
 *
 * Scenario: Record a new finding "Phase 10 made db-cluster developer-runnable"
 * supported by docs/phase-10-closeout.md, README.md, CHANGELOG.md.
 *
 * Lifecycle: propose → validate → approve → commit → inspect → receipts → trace
 *
 * Usage: npx tsx scripts/dogfood-update.ts
 */

import { createDogfoodCluster } from './dogfood-ingest.js';
import { rmSync } from 'node:fs';

async function main() {
    const cluster = await createDogfoodCluster();
    const { kernel, dataDir, artifacts } = cluster;

    console.log('\n=== Dogfood Mutation Workflow ===\n');

    // 1. Propose mutation: create a new finding entity
    console.log('1. Propose mutation...');
    const proposal = await kernel.proposeMutation({
        verb: 'create_entity',
        targetStore: 'canonical',
        payload: {
            kind: 'finding',
            name: 'Phase 10 made db-cluster developer-runnable',
            attributes: {
                observed_in: 'docs/phase-10-closeout.md',
                supported_by: ['docs/phase-10-closeout.md', 'README.md', 'CHANGELOG.md'],
            },
        },
        proposedBy: 'ai-agent',
    });
    console.log(`   Command ID: ${proposal.id}`);
    console.log(`   Status: ${proposal.status}`);
    console.log(`   (No truth written yet)`);

    // 2. Validate
    console.log('\n2. Validate mutation...');
    const validated = await kernel.validateMutation(proposal.id);
    console.log(`   Status: ${validated.status}`);

    // 3. Approve
    console.log('\n3. Approve mutation...');
    const approved = await kernel.approveMutation(
        proposal.id,
        'operator',
        'Finding observed during Phase 10 closeout review',
    );
    console.log(`   Status: ${approved.status}`);
    console.log(`   Approved by: operator`);

    // 4. Commit
    console.log('\n4. Commit mutation...');
    const { command, receipt } = await kernel.commitMutation(proposal.id, 'operator');
    console.log(`   Command status: ${command.status}`);
    console.log(`   Receipt ID: ${receipt.id}`);
    console.log(`   Receipt summary: ${receipt.resultSummary}`);

    // 5. Inspect command
    console.log('\n5. Inspect command...');
    const inspected = await kernel.inspectCommand(proposal.id);
    console.log(`   Verb: ${inspected.verb}`);
    console.log(`   Target: ${inspected.targetStore}`);
    console.log(`   Status: ${inspected.status}`);
    console.log(`   Proposed by: ${inspected.proposedBy}`);

    // 6. List receipts
    console.log('\n6. List receipts...');
    const receipts = await kernel.listReceipts();
    console.log(`   Total receipts: ${receipts.length}`);
    const lastReceipt = receipts[receipts.length - 1];
    console.log(`   Last receipt: ${lastReceipt.resultSummary}`);

    // 7. Trace the new finding
    console.log('\n7. Trace new finding...');
    // Find the entity that was created by the committed command
    const result = await kernel.findSources({ query: 'developer-runnable' });
    if (result.resolvedEntities.length > 0) {
        const newFinding = result.resolvedEntities[0];
        const uri = `cluster://canonical/${newFinding.id}`;
        const why = await kernel.why(uri);
        console.log(`   Entity: ${newFinding.kind}/${newFinding.name}`);
        console.log(`   Why: ${why}`);
    }

    console.log('\n=== Mutation workflow complete ===');
    rmSync(dataDir, { recursive: true, force: true });
}

main().catch(console.error);
