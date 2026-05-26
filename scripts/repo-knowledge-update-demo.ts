#!/usr/bin/env node
/**
 * Demo: repo-knowledge fact update workflow through db-cluster.
 *
 * Shows how an agent proposes an update, an operator approves,
 * and the receipt/provenance trace is preserved — all without
 * touching the original repo-knowledge files.
 *
 * Usage: npx tsx scripts/repo-knowledge-update-demo.ts
 */

import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createLocalCluster } from '../src/adapters/local/index.js';
import { ClusterKernel } from '../src/kernel/cluster-kernel.js';
import { ingestRepoKnowledge, type IngestSource } from '../src/integrations/repo-knowledge/ingest.js';
import { proposeFactUpdate, executeFactUpdate, generateWritebackPayload } from '../src/integrations/repo-knowledge/update-workflow.js';

const DEMO_DIR = join(import.meta.dirname, '..', '.demo-rk-update');
const SOURCES_DIR = join(DEMO_DIR, 'sources');
const CLUSTER_DIR = join(DEMO_DIR, 'cluster');

async function main() {
    console.log('=== Repo-Knowledge Update Workflow Demo ===\n');

    // Setup
    rmSync(DEMO_DIR, { recursive: true, force: true });
    mkdirSync(SOURCES_DIR, { recursive: true });

    const sourcePath = join(SOURCES_DIR, 'project-status.md');
    writeFileSync(sourcePath, '# Project Status\n\nPhase 13 complete.\nNext: Phase 14 integration gate.\n');

    const cluster = createLocalCluster(CLUSTER_DIR);
    const kernel = new ClusterKernel(cluster, { dataDir: CLUSTER_DIR });

    // 1. Ingest
    console.log('1. Ingesting repo-knowledge source...');
    const sources: IngestSource[] = [{ path: sourcePath, entityKind: 'fact' }];
    const ingestResult = await ingestRepoKnowledge(kernel, sources, {
        repoName: 'db-cluster',
        actorId: 'demo-agent',
    });
    console.log(`   Entities: ${ingestResult.entityIds.length}, Artifacts: ${ingestResult.artifactIds.length}\n`);

    const factId = ingestResult.entityIds.find((id) => id !== ingestResult.repoEntityId)!;
    const artifactId = ingestResult.artifactIds[0];

    // 2. Propose update
    console.log('2. Agent proposes fact update...');
    const cmd = await proposeFactUpdate(kernel, {
        factEntityId: factId,
        patch: { phase: 14, status: 'in-progress' },
        supportingArtifacts: [artifactId],
        proposedBy: 'agent:claude',
        reason: 'Phase 14 started — integration gate active',
    });
    console.log(`   Command: ${cmd.id} (status: ${cmd.status})\n`);

    // 3. Execute full workflow (operator approves)
    console.log('3. Operator approves and commits...');
    const result = await executeFactUpdate(
        kernel,
        {
            factEntityId: factId,
            patch: { phase: 14, status: 'in-progress' },
            supportingArtifacts: [artifactId],
            proposedBy: 'agent:claude',
            reason: 'Phase 14 started',
        },
        'operator:mikey',
    );
    console.log(`   Committed: ${result.committed}, Receipt: ${result.receiptId}\n`);

    // 4. Generate writeback payload (NOT applied)
    console.log('4. Writeback payload (generated, NOT applied):');
    const wb = generateWritebackPayload(factId, { phase: 14 }, result.command.id);
    console.log(`   Applied: ${wb.applied}`);
    console.log(`   Payload:`, JSON.stringify(wb.payload, null, 2).split('\n').map(l => '   ' + l).join('\n'));

    // 5. Provenance trace
    console.log('\n5. Provenance trace for fact entity:');
    const events = await kernel.traceProvenance(factId);
    for (const ev of events) {
        console.log(`   [${ev.verb}] ${ev.subjectId} → ${ev.objectId ?? '(none)'} at ${ev.occurredAt}`);
    }

    console.log('\n=== Demo complete. Source files untouched. ===');

    // Cleanup
    rmSync(DEMO_DIR, { recursive: true, force: true });
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
