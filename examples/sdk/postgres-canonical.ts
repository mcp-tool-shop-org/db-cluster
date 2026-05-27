/**
 * SDK Example: Postgres canonical backend.
 *
 * Demonstrates: cluster directory wired against a Postgres canonical store
 * (the local artifact/index/ledger stores stay on disk).
 * Requires: DB_CLUSTER_POSTGRES_URL environment variable.
 *
 * Configure the backend through DB_CLUSTER_CANONICAL_BACKEND / DB_CLUSTER_POSTGRES_URL
 * before constructing the SDK — see docs/store-contracts.md for the env
 * variable contract.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClusterSDK } from 'db-cluster/sdk';

async function main() {
    const postgresUrl = process.env.DB_CLUSTER_POSTGRES_URL;
    if (!postgresUrl) {
        console.log('Skipping: DB_CLUSTER_POSTGRES_URL not set.');
        console.log('Set it to run this example: export DB_CLUSTER_POSTGRES_URL=postgresql://user:pass@localhost:5432/db');
        return;
    }

    const dataDir = mkdtempSync(join(tmpdir(), 'db-cluster-pg-example-'));

    // Postgres backend is selected via env vars; the SDK reads the resulting cluster.
    const previousBackend = process.env.DB_CLUSTER_CANONICAL_BACKEND;
    process.env.DB_CLUSTER_CANONICAL_BACKEND = 'postgres';
    try {
        const sdk = new ClusterSDK({ clusterDir: dataDir });
        console.log('Cluster with Postgres canonical initialized.');

        // Create entity — goes to Postgres
        const entityCmd = await sdk.proposeMutation({
            verb: 'create_entity',
            targetStore: 'canonical',
            payload: {
                kind: 'record',
                name: 'Postgres-backed entity',
                attributes: { backend: 'postgres', tier: 'production' },
            },
            proposedBy: 'example',
        });
        await sdk.validateMutation(entityCmd.id);
        const { receipt: entityReceipt } = await sdk.commitMutation(entityCmd.id, 'example');
        console.log('Entity created in Postgres:', entityReceipt.affectedIds[0]);

        // Ingest artifact — stays local
        const artifactCmd = await sdk.proposeMutation({
            verb: 'ingest_artifact',
            targetStore: 'artifact',
            payload: {
                filename: 'config.json',
                content: Buffer.from('{"setting": "value"}'),
                mimeType: 'application/json',
            },
            proposedBy: 'example',
        });
        await sdk.validateMutation(artifactCmd.id);
        const { receipt: artifactReceipt } = await sdk.commitMutation(artifactCmd.id, 'example');
        console.log('Artifact stored locally:', artifactReceipt.affectedIds[0]);

        // Retrieve — crosses both stores
        const bundle = await sdk.retrieveBundle('postgres config');
        console.log('Bundle spans stores:', bundle.resolvedEntities.length, 'entities,', bundle.resolvedArtifacts.length, 'artifacts');
    } finally {
        if (previousBackend === undefined) {
            delete process.env.DB_CLUSTER_CANONICAL_BACKEND;
        } else {
            process.env.DB_CLUSTER_CANONICAL_BACKEND = previousBackend;
        }
    }

    // Cleanup
    rmSync(dataDir, { recursive: true, force: true });
    console.log('Done. (Postgres entities persist in the database.)');
}

main().catch(console.error);
