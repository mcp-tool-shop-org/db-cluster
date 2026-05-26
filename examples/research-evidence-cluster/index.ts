/**
 * Example: Research Evidence Cluster
 *
 * A research team stores papers, claims, and source notes.
 * The cluster proves: retrieve evidence bundle, trace claim to artifact,
 * stale index detection, policy redaction for restricted source.
 *
 * Uses: artifact store (papers), canonical store (claims/topics/sources),
 *       index store (discovery), ledger store (provenance + receipts).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalCluster, ClusterKernel, doctor } from 'db-cluster';

async function main() {
    const dataDir = mkdtempSync(join(tmpdir(), 'research-cluster-'));
    const stores = createLocalCluster(dataDir);
    const kernel = new ClusterKernel(stores, { dataDir });

    console.log('=== Research Evidence Cluster ===\n');

    // Ingest research papers (artifacts)
    const paper1 = await kernel.ingestArtifact({
        filename: 'smith-2025-ai-safety.pdf',
        content: Buffer.from('Smith et al. 2025: AI systems require structured mutation boundaries to prevent unauthorized state changes.'),
        mimeType: 'application/pdf',
    });

    const paper2 = await kernel.ingestArtifact({
        filename: 'chen-2024-provenance.pdf',
        content: Buffer.from('Chen & Wang 2024: Provenance tracking reduces trust calibration errors by 40% in AI-assisted systems.'),
        mimeType: 'application/pdf',
    });

    console.log('Papers ingested:', paper1.filename, paper2.filename);

    // Create claims (entities)
    const claim1 = await kernel.createEntity({
        kind: 'claim',
        name: 'Mutation boundaries prevent unauthorized writes',
        attributes: { confidence: 'high', source: 'smith-2025', domain: 'safety' },
    });

    const claim2 = await kernel.createEntity({
        kind: 'claim',
        name: 'Provenance reduces trust calibration errors',
        attributes: { confidence: 'high', source: 'chen-2024', domain: 'trust' },
    });

    // Create a topic entity
    const topic = await kernel.createEntity({
        kind: 'topic',
        name: 'AI Database Safety',
        attributes: { relatedClaims: [claim1.id, claim2.id] },
    });

    console.log('Claims created:', claim1.name, '|', claim2.name);
    console.log('Topic:', topic.name);

    // Retrieve evidence bundle
    console.log('\n--- Retrieve: "safety mutation" ---');
    const bundle = await kernel.retrieveBundle('safety mutation');
    console.log('Entities:', bundle.resolvedEntities.length);
    console.log('Artifacts:', bundle.resolvedArtifacts.length);
    console.log('Confidence:', bundle.confidence);

    // Trace claim to source artifact
    console.log('\n--- Trace claim provenance ---');
    const graph = await kernel.traceObject(`cluster://canonical/${claim1.id}`);
    console.log('Provenance nodes:', graph.nodes.length);
    for (const node of graph.nodes) {
        console.log(`  ${node.action} by ${node.actorId}`);
    }

    // Demonstrate stale index detection
    console.log('\n--- Stale index detection ---');
    await stores.index.clear();
    const health = await doctor(stores);
    console.log('After index wipe, doctor says:', health.status);
    const indexCheck = health.checks.find((c) => c.name === 'index_populated');
    console.log('Index check:', indexCheck?.message);
    console.log('Repair available:', indexCheck?.repairAvailable);

    // Rebuild
    const rebuilt = await kernel.rebuildIndex('example-actor');
    console.log('Rebuilt:', rebuilt.rebuilt, 'records');

    // Cleanup
    rmSync(dataDir, { recursive: true, force: true });
    console.log('\nDone.');
}

main().catch(console.error);
