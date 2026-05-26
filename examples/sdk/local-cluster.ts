/**
 * SDK Example: Local cluster setup and basic operations.
 *
 * Demonstrates: create cluster, ingest artifact, create entity, retrieve, trace.
 */

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalCluster, ClusterKernel } from 'db-cluster';

async function main() {
    // Create a temporary cluster
    const dataDir = mkdtempSync(join(tmpdir(), 'db-cluster-example-'));
    const stores = createLocalCluster(dataDir);
    const kernel = new ClusterKernel(stores, { dataDir });

    console.log('Cluster initialized at:', dataDir);

    // Ingest an artifact (raw source document)
    const artifact = await kernel.ingestArtifact({
        filename: 'research-notes.md',
        content: Buffer.from('# Research: AI database safety patterns'),
        mimeType: 'text/markdown',
    });
    console.log('Artifact ingested:', artifact.id, artifact.filename);

    // Create an entity (structured claim)
    const entity = await kernel.createEntity({
        kind: 'claim',
        name: 'Command-gated mutation prevents unauthorized writes',
        attributes: { confidence: 'high', domain: 'safety' },
    });
    console.log('Entity created:', entity.id, entity.kind, entity.name);

    // Retrieve an evidence bundle
    const bundle = await kernel.retrieveBundle('safety mutation');
    console.log('Retrieved:', bundle.resolvedEntities.length, 'entities,', bundle.resolvedArtifacts.length, 'artifacts');
    console.log('Confidence:', bundle.confidence);

    // Trace provenance
    const graph = await kernel.traceObject(`cluster://canonical/${entity.id}`);
    console.log('Provenance nodes:', graph.nodes.length);
    for (const node of graph.nodes) {
        console.log(' ', node.uri, node.action);
    }

    // Cleanup
    rmSync(dataDir, { recursive: true, force: true });
    console.log('Done.');
}

main().catch(console.error);
