#!/usr/bin/env node
import { Command } from 'commander';
import { resolve } from 'node:path';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createLocalCluster } from './adapters/local/index.js';
import { ClusterKernel } from './kernel/cluster-kernel.js';

const CLUSTER_DIR = resolve(process.cwd(), '.db-cluster');

function getKernel(): ClusterKernel {
    if (!existsSync(CLUSTER_DIR)) {
        console.error('No cluster found. Run `db-cluster init` first.');
        process.exit(1);
    }
    const stores = createLocalCluster(CLUSTER_DIR);
    return new ClusterKernel(stores, { dataDir: CLUSTER_DIR });
}

const program = new Command();

program
    .name('db-cluster')
    .description('AI-native federated database cluster')
    .version('0.1.0');

// --- init ---
program
    .command('init')
    .description('Initialize a new cluster in the current directory')
    .action(() => {
        if (existsSync(CLUSTER_DIR)) {
            console.log('Cluster already initialized at .db-cluster/');
            return;
        }
        mkdirSync(CLUSTER_DIR, { recursive: true });
        createLocalCluster(CLUSTER_DIR);
        console.log('Cluster initialized at .db-cluster/');
        console.log('  canonical/  — entities, state');
        console.log('  artifact/   — raw files, evidence');
        console.log('  index/      — discoverability');
        console.log('  ledger/     — provenance, receipts');
    });

// --- ingest ---
program
    .command('ingest <file>')
    .description('Ingest a source artifact into the cluster')
    .action(async (file: string) => {
        const kernel = getKernel();
        const filePath = resolve(file);
        if (!existsSync(filePath)) {
            console.error(`File not found: ${filePath}`);
            process.exit(1);
        }
        const content = readFileSync(filePath);
        const filename = file.split(/[/\\]/).pop()!;
        const mimeType = guessMime(filename);

        const result = await kernel.ingestArtifact({
            filename,
            content,
            mimeType,
            actorId: 'cli-user',
        });

        console.log(`Ingested: ${filename}`);
        console.log(`  artifact: ${result.artifact.id}`);
        console.log(`  version:  ${result.artifact.version}`);
        console.log(`  hash:     ${result.artifact.contentHash.slice(0, 12)}...`);
        console.log(`  indexed:  ${result.indexRecord.id}`);
        console.log(`  receipt:  ${result.receipt.id}`);
    });

// --- entity create ---
const entity = program.command('entity').description('Manage canonical entities');

entity
    .command('create')
    .description('Create a canonical entity')
    .requiredOption('--kind <kind>', 'Entity kind/type')
    .requiredOption('--name <name>', 'Entity name')
    .option('--attr <json>', 'Attributes as JSON', '{}')
    .action(async (opts: { kind: string; name: string; attr: string }) => {
        const kernel = getKernel();
        const attributes = JSON.parse(opts.attr);

        const result = await kernel.createEntity({
            kind: opts.kind,
            name: opts.name,
            attributes,
            actorId: 'cli-user',
        });

        console.log(`Created entity: ${opts.kind}/${opts.name}`);
        console.log(`  id:      ${result.entity.id}`);
        console.log(`  indexed: ${result.indexRecord.id}`);
        console.log(`  receipt: ${result.receipt.id}`);
    });

// --- link ---
program
    .command('link')
    .description('Link an artifact as evidence for an entity')
    .requiredOption('--artifact <id>', 'Artifact ID')
    .requiredOption('--entity <id>', 'Entity ID')
    .action(async (opts: { artifact: string; entity: string }) => {
        const kernel = getKernel();

        const result = await kernel.linkEvidence({
            artifactId: opts.artifact,
            entityId: opts.entity,
            actorId: 'cli-user',
        });

        console.log(`Linked: artifact ${opts.artifact} → entity ${opts.entity}`);
        console.log(`  provenance: ${result.provenance.id}`);
        console.log(`  receipt:    ${result.receipt.id}`);
    });

// --- find ---
program
    .command('find <query>')
    .description('Find sources through the cluster index')
    .option('--limit <n>', 'Max results', '10')
    .action(async (query: string, opts: { limit: string }) => {
        const kernel = getKernel();

        const result = await kernel.findSources({ query, limit: parseInt(opts.limit) });

        console.log(`Found ${result.indexRecords.length} index record(s) for "${query}":`);
        for (const r of result.indexRecords) {
            console.log(`  [${r.sourceStore}] ${r.sourceId} — ${r.text}`);
        }
        if (result.resolvedEntities.length) {
            console.log(`\nResolved entities:`);
            for (const e of result.resolvedEntities) {
                console.log(`  ${e.kind}/${e.name} (${e.id})`);
            }
        }
        if (result.resolvedArtifacts.length) {
            console.log(`\nResolved artifacts:`);
            for (const a of result.resolvedArtifacts) {
                console.log(`  ${a.filename} v${a.version} (${a.id})`);
            }
        }
    });

// --- inspect ---
program
    .command('inspect <entity-id>')
    .description('Inspect a canonical entity (returns truth, not index projection)')
    .action(async (entityId: string) => {
        const kernel = getKernel();

        try {
            const entity = await kernel.inspectEntity(entityId);
            console.log(`Entity: ${entity.kind}/${entity.name}`);
            console.log(`  id:         ${entity.id}`);
            console.log(`  owner:      ${entity.owner}`);
            console.log(`  created:    ${entity.createdAt}`);
            console.log(`  updated:    ${entity.updatedAt}`);
            console.log(`  attributes: ${JSON.stringify(entity.attributes)}`);
        } catch (err: any) {
            console.error(err.message);
            process.exit(1);
        }
    });

// --- trace ---
program
    .command('trace <id>')
    .description('Trace provenance for a subject')
    .action(async (id: string) => {
        const kernel = getKernel();

        try {
            const events = await kernel.traceProvenance(id);
            console.log(`Provenance trace for ${id} (${events.length} event(s)):`);
            for (const e of events) {
                console.log(`  [${e.timestamp}] ${e.action} by ${e.actorId}`);
                console.log(`    subject: ${e.subjectStore}/${e.subjectId}`);
                if (e.parentEventId) console.log(`    parent:  ${e.parentEventId}`);
            }
        } catch (err: any) {
            console.error(err.message);
            process.exit(1);
        }
    });

// --- propose ---
program
    .command('propose <command-json>')
    .description('Propose a mutation (does NOT write to stores)')
    .action(async (commandJson: string) => {
        const kernel = getKernel();
        const { verb, targetStore, payload } = JSON.parse(commandJson);

        const command = await kernel.proposeMutation({
            verb,
            targetStore,
            payload,
            proposedBy: 'cli-user',
        });

        console.log(`Proposed command: ${command.id}`);
        console.log(`  verb:   ${command.verb}`);
        console.log(`  target: ${command.targetStore}`);
        console.log(`  status: ${command.status}`);
        console.log(`\nTo commit: db-cluster commit ${command.id}`);
    });

// --- commit ---
program
    .command('commit <command-id>')
    .description('Commit a proposed mutation through command runtime')
    .action(async (commandId: string) => {
        const kernel = getKernel();

        try {
            const result = await kernel.commitMutation(commandId, 'cli-user');
            console.log(`Committed: ${result.command.id}`);
            console.log(`  verb:    ${result.command.verb}`);
            console.log(`  status:  ${result.command.status}`);
            console.log(`  result:  ${result.receipt.resultSummary}`);
            console.log(`  receipt: ${result.receipt.id}`);
        } catch (err: any) {
            console.error(`Commit failed: ${err.message}`);
            process.exit(1);
        }
    });

// --- receipts ---
program
    .command('receipts')
    .description('List all mutation receipts')
    .option('--limit <n>', 'Max results', '20')
    .action(async (opts: { limit: string }) => {
        const kernel = getKernel();

        const receipts = await kernel.listReceipts({ limit: parseInt(opts.limit) });

        if (receipts.length === 0) {
            console.log('No receipts found.');
            return;
        }
        console.log(`Receipts (${receipts.length}):`);
        for (const r of receipts) {
            console.log(`  [${r.committedAt}] ${r.resultSummary}`);
            console.log(`    id:      ${r.id}`);
            console.log(`    command: ${r.commandId}`);
        }
    });

program.parse();

function guessMime(filename: string): string {
    const ext = filename.split('.').pop()?.toLowerCase();
    switch (ext) {
        case 'md': return 'text/markdown';
        case 'txt': return 'text/plain';
        case 'json': return 'application/json';
        case 'pdf': return 'application/pdf';
        case 'html': return 'text/html';
        case 'ts': case 'js': return 'text/javascript';
        default: return 'application/octet-stream';
    }
}
