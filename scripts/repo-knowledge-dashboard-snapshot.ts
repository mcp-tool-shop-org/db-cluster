/**
 * Repo-knowledge dashboard snapshot — generates a static snapshot
 * of imported repo-knowledge memory for the truth inspector.
 *
 * Uses Phase 13 dashboard infrastructure.
 */

import { resolve } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { createLocalCluster } from '../src/adapters/local/index.js';
import { ClusterKernel } from '../src/kernel/cluster-kernel.js';
import { inspectEntity, inspectIndexRecord, inspectCommandObject } from '../src/dashboard/inspector-data.js';
import { buildOpsModel } from '../src/dashboard/ops-model.js';
import type { DashboardObject } from '../src/dashboard/dashboard-model.js';

export interface RepoKnowledgeSnapshot {
    generatedAt: string;
    clusterDir: string;
    repoName: string;
    objects: DashboardObject[];
    operations: Awaited<ReturnType<typeof buildOpsModel>>;
}

export async function generateRepoKnowledgeSnapshot(
    clusterDir: string,
    repoName: string,
): Promise<RepoKnowledgeSnapshot> {
    const stores = createLocalCluster(clusterDir);
    const kernel = new ClusterKernel(stores, { dataDir: clusterDir });

    const objects: DashboardObject[] = [];

    // Inspect entities (up to 30)
    const entities = await stores.canonical.list({ limit: 30 });
    for (const entity of entities) {
        try {
            const obj = await inspectEntity(kernel, entity.id);
            objects.push(obj);
        } catch {
            // Skip entities that can't be inspected
        }
    }

    // Inspect index records (up to 10)
    const indexRecords = await stores.index.search({ text: '', metadata: {} });
    for (const record of indexRecords.slice(0, 10)) {
        try {
            const obj = await inspectIndexRecord(kernel, record.id);
            objects.push(obj);
        } catch {
            // Skip
        }
    }

    // Operations model
    const operations = await buildOpsModel(stores, kernel);

    return {
        generatedAt: new Date().toISOString(),
        clusterDir,
        repoName,
        objects,
        operations,
    };
}

// CLI entry point
const isDirectRun = import.meta.url === `file:///${resolve(process.argv[1] ?? '').replace(/\\/g, '/')}`;

if (isDirectRun) {
    const clusterDir = process.argv[2] ?? 'examples/dogfood-project-memory/.db-cluster';
    const repoName = process.argv[3] ?? 'db-cluster';
    const outputPath = process.argv[4] ?? 'dashboard/data/repo-knowledge-snapshot.json';

    const resolvedCluster = resolve(clusterDir);
    const resolvedOutput = resolve(outputPath);

    console.log(`Generating repo-knowledge snapshot from: ${resolvedCluster}`);

    generateRepoKnowledgeSnapshot(resolvedCluster, repoName).then((snapshot) => {
        mkdirSync(resolve(outputPath, '..'), { recursive: true });
        writeFileSync(resolvedOutput, JSON.stringify(snapshot, null, 2));
        console.log(`Snapshot written: ${resolvedOutput}`);
        console.log(`  Objects: ${snapshot.objects.length}`);
        console.log(`  Health: ${snapshot.operations.overall}`);
    }).catch((err) => {
        console.error('Snapshot generation failed:', err);
        process.exit(1);
    });
}
