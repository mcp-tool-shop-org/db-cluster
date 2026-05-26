#!/usr/bin/env node
/**
 * Repo-knowledge ops script — exercises doctor, verify, backup, restore,
 * rebuild index, and provenance trace on imported repo-knowledge memory.
 *
 * Usage: npx tsx scripts/repo-knowledge-ops.ts
 */

import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createLocalCluster } from '../src/adapters/local/index.js';
import { ClusterKernel } from '../src/kernel/cluster-kernel.js';
import { CommandQueue } from '../src/kernel/command-queue.js';
import { ingestRepoKnowledge, type IngestSource } from '../src/integrations/repo-knowledge/ingest.js';
import { doctor } from '../src/ops/doctor.js';
import { verify } from '../src/ops/verify.js';
import { backup, restore } from '../src/ops/backup.js';

const OPS_DIR = join(import.meta.dirname, '..', '.demo-rk-ops');
const SOURCES_DIR = join(OPS_DIR, 'sources');
const CLUSTER_DIR = join(OPS_DIR, 'cluster');
const RESTORE_DIR = join(OPS_DIR, 'restore');

async function main() {
    console.log('=== Repo-Knowledge Ops Demo ===\n');

    rmSync(OPS_DIR, { recursive: true, force: true });
    mkdirSync(SOURCES_DIR, { recursive: true });

    // Create source files
    writeFileSync(join(SOURCES_DIR, 'status.md'), '# Status\n\nPhase 14 active.\n');
    writeFileSync(join(SOURCES_DIR, 'conventions.md'), '# Conventions\n\nESM only. Strict TS.\n');

    // Setup cluster + ingest
    const stores = createLocalCluster(CLUSTER_DIR);
    const kernel = new ClusterKernel(stores, { dataDir: CLUSTER_DIR });

    const sources: IngestSource[] = [
        { path: join(SOURCES_DIR, 'status.md'), entityKind: 'fact' },
        { path: join(SOURCES_DIR, 'conventions.md'), entityKind: 'convention' },
    ];

    console.log('1. Ingesting...');
    const result = await ingestRepoKnowledge(kernel, sources, {
        repoName: 'db-cluster',
        actorId: 'ops-demo',
    });
    console.log(`   ${result.entityIds.length} entities, ${result.artifactIds.length} artifacts\n`);

    // Doctor
    console.log('2. Running doctor...');
    const health = await doctor(stores);
    console.log(`   Status: ${health.status}, Checks: ${health.checks.length}\n`);

    // Verify
    console.log('3. Running verify...');
    const vResult = await verify(stores);
    console.log(`   Status: ${vResult.status}, Checks: ${vResult.checks.length}\n`);

    // Backup
    console.log('4. Creating backup...');
    const queue = new CommandQueue(CLUSTER_DIR);
    const bkp = await backup(stores, { commandQueue: queue });
    console.log(`   Entities: ${bkp.entities.length}, Artifacts: ${bkp.artifacts.length}, Events: ${bkp.events.length}\n`);

    // Restore to fresh location
    console.log('5. Restoring to fresh cluster...');
    const restoreStores = createLocalCluster(RESTORE_DIR);
    const restoreQueue = new CommandQueue(RESTORE_DIR);
    const rResult = await restore(restoreStores, bkp, { commandQueue: restoreQueue });
    console.log(`   Entities: ${rResult.entities.created}, Artifacts: ${rResult.artifacts.created}\n`);

    // Verify restored cluster
    console.log('6. Verifying restored cluster...');
    const restoredHealth = await verify(restoreStores);
    console.log(`   Status: ${restoredHealth.status}\n`);

    // Rebuild index on original
    console.log('7. Rebuilding index...');
    const rebuildResult = await kernel.rebuildIndex('ops-demo');
    console.log(`   Rebuilt: ${rebuildResult.rebuilt} records\n`);

    // Trace provenance
    console.log('8. Provenance trace:');
    const entityId = result.entityIds[0];
    const events = await kernel.traceProvenance(entityId);
    for (const ev of events.slice(0, 3)) {
        console.log(`   [${ev.verb}] ${ev.subjectId.slice(0, 8)}... at ${ev.occurredAt}`);
    }

    console.log('\n=== Ops demo complete. ===');
    rmSync(OPS_DIR, { recursive: true, force: true });
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
