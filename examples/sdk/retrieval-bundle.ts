/**
 * SDK Example: Retrieval bundle with freshness and gap detection.
 *
 * Demonstrates: structured retrieval, stale detection, and rebuild.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalCluster } from '../../src/adapters/local/index.js';
import { ClusterKernel } from '../../src/kernel/cluster-kernel.js';
import { rebuildIndex } from '../../src/ops/rebuild.js';

async function main() {
    const dataDir = mkdtempSync(join(tmpdir(), 'db-cluster-bundle-'));
    const stores = createLocalCluster(dataDir);
    const kernel = new ClusterKernel(stores, { dataDir });

    // Create multiple entities and artifacts
    await kernel.createEntity({ kind: 'claim', name: 'Indexes are derivative', attributes: { law: 'architecture' } });
    await kernel.createEntity({ kind: 'claim', name: 'Retrieval resolves to owner truth', attributes: { law: 'retrieval' } });
    await kernel.ingestArtifact({
        filename: 'architecture-spec.md',
        content: Buffer.from('# Architecture: four stores, four owners'),
        mimeType: 'text/markdown',
    });

    // Retrieve a bundle
    const bundle = await kernel.retrieveBundle('architecture');
    console.log('=== Evidence Bundle ===');
    console.log('Query:', bundle.query);
    console.log('Entities:', bundle.resolvedEntities.length);
    console.log('Artifacts:', bundle.resolvedArtifacts.length);
    console.log('Confidence:', bundle.confidence);
    console.log('Gaps:', bundle.gaps.length);
    console.log('Stale:', bundle.staleRecords.length);

    for (const entity of bundle.resolvedEntities) {
        console.log(`  Entity: ${entity.object.name} (fresh: ${entity.fresh})`);
    }

    // Simulate staleness: wipe index, then retrieve
    console.log('\n=== After index wipe ===');
    await stores.index.clear();
    const emptyBundle = await kernel.retrieveBundle('architecture');
    console.log('Entities after wipe:', emptyBundle.resolvedEntities.length);
    console.log('(Index is empty — nothing to discover)');

    // Rebuild index from owner truth
    console.log('\n=== After rebuild ===');
    const result = await rebuildIndex(stores);
    console.log('Rebuilt:', result.rebuilt, 'records');

    const restoredBundle = await kernel.retrieveBundle('architecture');
    console.log('Entities after rebuild:', restoredBundle.resolvedEntities.length);

    // Cleanup
    rmSync(dataDir, { recursive: true, force: true });
    console.log('\nDone.');
}

main().catch(console.error);
