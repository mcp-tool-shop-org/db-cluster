/**
 * Dashboard snapshot — generates a static JSON file from a live cluster.
 *
 * Usage: npx tsx scripts/dashboard-snapshot.ts [cluster-dir] [output-path]
 *
 * Defaults:
 *   cluster-dir: examples/dogfood-project-memory/.db-cluster
 *   output-path: dashboard/data/dogfood-snapshot.json
 */

import { resolve } from 'node:path';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createLocalCluster } from '../src/adapters/local/index.js';
import { ClusterKernel } from '../src/kernel/cluster-kernel.js';
import { inspectEntity, inspectIndexRecord, inspectCommandObject } from '../src/dashboard/inspector-data.js';
import { doctor } from '../src/ops/doctor.js';
import type { DashboardObject } from '../src/dashboard/dashboard-model.js';

export interface DashboardSnapshot {
    generatedAt: string;
    clusterDir: string;
    objects: DashboardObject[];
    operations: {
        doctorStatus: any;
        indexStatus: any;
    };
}

export async function generateSnapshot(clusterDir: string): Promise<DashboardSnapshot> {
    const stores = createLocalCluster(clusterDir);
    const kernel = new ClusterKernel(stores, { dataDir: clusterDir });

    const objects: DashboardObject[] = [];

    // Inspect entities (up to 20)
    const entities = await stores.canonical.list({ limit: 20 });
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
            // Skip records that can't be inspected
        }
    }

    // Inspect commands (up to 5) via CommandQueue
    const { CommandQueue } = await import('../src/kernel/command-queue.js');
    const queue = new CommandQueue(clusterDir);
    const commands = queue.list();
    for (const cmd of commands.slice(0, 5)) {
        try {
            const obj = await inspectCommandObject(kernel, cmd.id);
            objects.push(obj);
        } catch {
            // Skip
        }
    }

    // Operations data
    const doctorStatus = await doctor(stores);
    const indexStatus = await kernel.indexStatus();

    return {
        generatedAt: new Date().toISOString(),
        clusterDir,
        objects,
        operations: {
            doctorStatus,
            indexStatus,
        },
    };
}

// CLI execution — only runs when invoked directly
const isDirectRun = process.argv[1]?.includes('dashboard-snapshot');
if (isDirectRun) {
    const ROOT = resolve(import.meta.dirname, '..');
    const clusterDir = process.argv[2] || resolve(ROOT, 'examples/dogfood-project-memory/.db-cluster');
    const outputPath = process.argv[3] || resolve(ROOT, 'dashboard/data/dogfood-snapshot.json');

    if (!existsSync(clusterDir)) {
        console.error(`Cluster directory not found: ${clusterDir}`);
        console.error('Run the dogfood ingest script first: npx tsx scripts/dogfood-ingest.ts');
        process.exit(1);
    }

    const outputDir = resolve(outputPath, '..');
    if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });

    const snapshot = await generateSnapshot(clusterDir);
    writeFileSync(outputPath, JSON.stringify(snapshot, null, 2));
    console.log(`Dashboard snapshot written to ${outputPath}`);
    console.log(`  Objects: ${snapshot.objects.length}`);
    console.log(`  Generated: ${snapshot.generatedAt}`);
}
