/**
 * SDK Example: Retrieval bundle with freshness and gap detection.
 *
 * Demonstrates: structured retrieval, freshness reporting, and explainRetrieval.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClusterSDK } from 'db-cluster/sdk';

async function main() {
    const dataDir = mkdtempSync(join(tmpdir(), 'db-cluster-bundle-'));
    const sdk = new ClusterSDK({ clusterDir: dataDir });

    async function createEntity(name: string, attributes: Record<string, unknown>) {
        const cmd = await sdk.proposeMutation({
            verb: 'create_entity',
            targetStore: 'canonical',
            payload: { kind: 'claim', name, attributes },
            proposedBy: 'example',
        });
        await sdk.validateMutation(cmd.id);
        await sdk.commitMutation(cmd.id, 'example');
    }

    async function ingestArtifact(filename: string, content: string, mimeType: string) {
        const cmd = await sdk.proposeMutation({
            verb: 'ingest_artifact',
            targetStore: 'artifact',
            payload: { filename, content: Buffer.from(content), mimeType },
            proposedBy: 'example',
        });
        await sdk.validateMutation(cmd.id);
        await sdk.commitMutation(cmd.id, 'example');
    }

    // Create multiple entities and artifacts
    await createEntity('Indexes are derivative', { law: 'architecture' });
    await createEntity('Retrieval resolves to owner truth', { law: 'retrieval' });
    await ingestArtifact('architecture-spec.md', '# Architecture: four stores, four owners', 'text/markdown');

    // Retrieve a bundle
    const bundle = await sdk.retrieveBundle('architecture');
    console.log('=== Evidence Bundle ===');
    console.log('Query:', bundle.query);
    console.log('Entities:', bundle.resolvedEntities.length);
    console.log('Artifacts:', bundle.resolvedArtifacts.length);
    console.log('All fresh:', bundle.freshness.allFresh);
    console.log('Stale count:', bundle.freshness.staleCount);
    console.log('Missing context items:', bundle.missingContext.length);

    for (const entity of bundle.resolvedEntities) {
        console.log(`  Entity: ${entity.object.name} (indexStale: ${entity.indexStale})`);
    }

    // Explain the retrieval
    console.log('\n=== Retrieval explanation ===');
    const explanation = await sdk.explainRetrieval(bundle);
    console.log(explanation.summary);
    console.log('Resolved:', explanation.resolvedCount, 'Missing:', explanation.missingCount, 'All fresh:', explanation.allFresh);

    // Cleanup
    rmSync(dataDir, { recursive: true, force: true });
    console.log('\nDone.');
}

main().catch(console.error);
