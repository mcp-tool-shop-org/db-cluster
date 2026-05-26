/**
 * SDK Example: Postgres canonical backend.
 *
 * Demonstrates: Postgres-backed canonical store with local artifact/index/ledger.
 * Requires: DB_CLUSTER_POSTGRES_URL environment variable.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCluster } from '../../src/adapters/factory.js';
import { ClusterKernel } from '../../src/kernel/cluster-kernel.js';

async function main() {
    const postgresUrl = process.env.DB_CLUSTER_POSTGRES_URL;
    if (!postgresUrl) {
        console.log('Skipping: DB_CLUSTER_POSTGRES_URL not set.');
        console.log('Set it to run this example: export DB_CLUSTER_POSTGRES_URL=postgresql://user:pass@localhost:5432/db');
        return;
    }

    const dataDir = mkdtempSync(join(tmpdir(), 'db-cluster-pg-example-'));

    // Create cluster with Postgres canonical + local artifact/index/ledger
    const { stores } = createCluster({
        rootDir: dataDir,
        backends: { canonical: 'postgres' },
        postgresUrl,
    });

    const kernel = new ClusterKernel(stores, { dataDir });
    console.log('Cluster with Postgres canonical initialized.');

    // Create entity — goes to Postgres
    const entity = await kernel.createEntity({
        kind: 'record',
        name: 'Postgres-backed entity',
        attributes: { backend: 'postgres', tier: 'production' },
    });
    console.log('Entity created in Postgres:', entity.id);

    // Ingest artifact — stays local
    const artifact = await kernel.ingestArtifact({
        filename: 'config.json',
        content: Buffer.from('{"setting": "value"}'),
        mimeType: 'application/json',
    });
    console.log('Artifact stored locally:', artifact.id);

    // Retrieve — crosses both stores
    const bundle = await kernel.retrieveBundle('postgres config');
    console.log('Bundle spans stores:', bundle.resolvedEntities.length, 'entities,', bundle.resolvedArtifacts.length, 'artifacts');

    // Cleanup
    rmSync(dataDir, { recursive: true, force: true });
    console.log('Done. (Postgres entities persist in the database.)');
}

main().catch(console.error);
