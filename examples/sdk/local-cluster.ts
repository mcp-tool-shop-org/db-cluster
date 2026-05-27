/**
 * SDK Example: Local cluster setup and basic operations.
 *
 * Demonstrates: create cluster via SDK, propose+commit lifecycle for writes,
 * retrieve evidence bundle, trace provenance.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClusterSDK } from 'db-cluster/sdk';

async function main() {
    // Create a temporary cluster — SDK owns store wiring.
    const dataDir = mkdtempSync(join(tmpdir(), 'db-cluster-example-'));
    const sdk = new ClusterSDK({ clusterDir: dataDir });

    console.log('Cluster initialized at:', dataDir);

    // Ingest an artifact via the command lifecycle.
    const artifactCmd = await sdk.proposeMutation({
        verb: 'ingest_artifact',
        targetStore: 'artifact',
        payload: {
            filename: 'research-notes.md',
            content: Buffer.from('# Research: AI database safety patterns'),
            mimeType: 'text/markdown',
        },
        proposedBy: 'example',
    });
    await sdk.validateMutation(artifactCmd.id);
    const { receipt: artifactReceipt } = await sdk.commitMutation(artifactCmd.id, 'example');
    const artifactId = artifactReceipt.affectedIds[0];
    console.log('Artifact ingested:', artifactId);

    // Create an entity via the command lifecycle.
    const entityCmd = await sdk.proposeMutation({
        verb: 'create_entity',
        targetStore: 'canonical',
        payload: {
            kind: 'claim',
            name: 'Command-gated mutation prevents unauthorized writes',
            attributes: { confidence: 'high', domain: 'safety' },
        },
        proposedBy: 'example',
    });
    await sdk.validateMutation(entityCmd.id);
    const { receipt: entityReceipt } = await sdk.commitMutation(entityCmd.id, 'example');
    const entityId = entityReceipt.affectedIds[0];
    console.log('Entity created:', entityId);

    // Retrieve an evidence bundle.
    const bundle = await sdk.retrieveBundle('safety mutation');
    console.log('Retrieved:', bundle.resolvedEntities.length, 'entities,', bundle.resolvedArtifacts.length, 'artifacts');
    console.log('All fresh:', bundle.freshness.allFresh);

    // Trace provenance.
    const graph = await sdk.traceObject(`cluster://canonical/${entityId}`);
    console.log('Provenance nodes:', graph.nodes.length);
    for (const node of graph.nodes) {
        console.log(' ', node.uri, node.label);
    }

    // Cleanup.
    rmSync(dataDir, { recursive: true, force: true });
    console.log('Done.');
}

main().catch(console.error);
