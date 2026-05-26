/**
 * Dogfood retrieval script — query project memory through the cluster.
 *
 * Demonstrates that retrieval returns evidence bundles with:
 * - resolved entities (from canonical store)
 * - supporting artifacts (from artifact store)
 * - index records used (derivative)
 * - provenance events
 * - freshness assessment
 * - missing context / confidence boundaries
 *
 * Usage: npx tsx scripts/dogfood-query.ts
 */

import { createDogfoodCluster } from './dogfood-ingest.js';
import { rmSync } from 'node:fs';

async function main() {
    const cluster = await createDogfoodCluster();
    const { kernel, dataDir } = cluster;

    console.log('\n=== Dogfood Retrieval Tasks ===\n');

    const queries = [
        'MCP',
        'Mutation Law',
        'Phase 8',
        'derivative',
        'Policy',
        'tests across',
        'rebuildable',
        'closeout',
        'decision',
    ];

    for (const query of queries) {
        console.log(`─── Query: "${query}" ───`);
        const bundle = await kernel.retrieveBundle(query);
        const explanation = await kernel.explainRetrieval(bundle);

        console.log(`  Index candidates: ${bundle.indexRecords.length}`);
        console.log(`  Resolved entities: ${bundle.resolvedEntities.length}`);
        console.log(`  Resolved artifacts: ${bundle.resolvedArtifacts.length}`);
        console.log(`  Provenance events: ${bundle.provenanceEvents.length}`);
        console.log(`  Freshness: ${bundle.freshness.allFresh ? 'ALL FRESH' : `${bundle.freshness.staleCount} stale`}`);
        console.log(`  Missing context: ${bundle.missingContext.length}`);
        console.log(`  Confidence boundaries: ${bundle.confidenceBoundaries.length}`);

        if (bundle.resolvedEntities.length > 0) {
            console.log(`  First entity: ${bundle.resolvedEntities[0].object.kind}/${bundle.resolvedEntities[0].object.name}`);
        }
        if (bundle.resolvedArtifacts.length > 0) {
            console.log(`  First artifact: ${bundle.resolvedArtifacts[0].object.filename}`);
        }
        console.log('');
    }

    rmSync(dataDir, { recursive: true, force: true });
}

main().catch(console.error);
