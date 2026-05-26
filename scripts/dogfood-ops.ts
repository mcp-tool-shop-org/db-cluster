/**
 * Dogfood operations script — destroy, diagnose, repair, backup, restore.
 *
 * Usage: npx tsx scripts/dogfood-ops.ts
 */

import { createDogfoodCluster } from './dogfood-ingest.js';
import { doctor } from '../src/ops/doctor.js';
import { verify } from '../src/ops/verify.js';
import { rebuildIndex } from '../src/ops/rebuild.js';
import { backup, restore } from '../src/ops/backup.js';
import { createLocalCluster } from '../src/adapters/local/index.js';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function main() {
    const cluster = await createDogfoodCluster();
    const { dataDir } = cluster;
    const stores = createLocalCluster(dataDir);

    console.log('\n=== Dogfood Operations & Recovery ===\n');

    // 1. Doctor: healthy state
    console.log('1. Doctor (healthy state)...');
    const health1 = await doctor(stores);
    console.log(`   Status: ${health1.status}`);
    console.log(`   Checks: ${health1.checks.length}`);
    console.log('');

    // 2. Verify retrieval works
    console.log('2. Verify retrieval before damage...');
    const beforeResults = await cluster.kernel.findSources({ query: 'Phase' });
    console.log(`   Found: ${beforeResults.resolvedEntities.length} entities`);
    console.log('');

    // 3. Delete index (simulate corruption)
    console.log('3. Deleting index...');
    await stores.index.clear();
    const afterClear = await cluster.kernel.findSources({ query: 'Phase' });
    console.log(`   After clear: ${afterClear.resolvedEntities.length} entities (should be 0)`);
    console.log('');

    // 4. Doctor detects degraded state
    console.log('4. Doctor (degraded state)...');
    const health2 = await doctor(stores);
    console.log(`   Status: ${health2.status}`);
    console.log('');

    // 5. Rebuild index
    console.log('5. Rebuilding index...');
    const rebuildResult = await rebuildIndex(stores);
    console.log(`   Indexed: ${rebuildResult.indexedCount} records`);
    console.log('');

    // 6. Verify retrieval restored
    console.log('6. Verify retrieval after rebuild...');
    const afterRebuild = await cluster.kernel.findSources({ query: 'Phase' });
    console.log(`   Found: ${afterRebuild.resolvedEntities.length} entities`);
    console.log('');

    // 7. Backup
    console.log('7. Backup...');
    const backupData = await backup(stores);
    console.log(`   Entities: ${backupData.entities.length}`);
    console.log(`   Artifacts: ${backupData.artifacts.length}`);
    console.log(`   Events: ${backupData.events.length}`);
    console.log(`   Receipts: ${backupData.receipts.length}`);
    console.log('');

    // 8. Restore to fresh location
    console.log('8. Restore to fresh location...');
    const freshDir = mkdtempSync(join(tmpdir(), 'dogfood-restore-'));
    const freshStores = createLocalCluster(freshDir);
    const restoreResult = await restore(freshStores, backupData);
    console.log(`   Restored entities: ${restoreResult.entitiesRestored}`);
    console.log(`   Restored artifacts: ${restoreResult.artifactsRestored}`);
    console.log(`   Restored events: ${restoreResult.eventsRestored}`);
    console.log('');

    // 9. Verify restored cluster
    console.log('9. Verify restored cluster...');
    const restoredHealth = await doctor(freshStores);
    console.log(`   Status: ${restoredHealth.status}`);
    const restoredResults = await freshStores.index.search({ text: 'Phase' });
    console.log(`   Index records: ${restoredResults.length}`);
    console.log('');

    rmSync(dataDir, { recursive: true, force: true });
    rmSync(freshDir, { recursive: true, force: true });
    console.log('=== Operations complete ===');
}

main().catch(console.error);
