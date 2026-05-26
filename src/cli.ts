#!/usr/bin/env node
import { Command } from 'commander';
import { resolve } from 'node:path';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createLocalCluster } from './adapters/local/index.js';
import { ClusterKernel } from './kernel/cluster-kernel.js';
import { ClusterResolver } from './resolver/index.js';
import { formatClusterUri, parseClusterUri, isClusterUri } from './uri/index.js';

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

// --- index ---
const index = program.command('index').description('Manage the cluster index');

index
    .command('rebuild')
    .description('Clear and rebuild the index from owner stores')
    .action(async () => {
        const kernel = getKernel();
        const result = await kernel.rebuildIndex('cli-user');
        console.log(`Index rebuilt: ${result.rebuilt} record(s) from owner stores.`);
        console.log(`  provenance: ${result.provenance.id}`);
        console.log(`  receipt:    ${result.receipt.id}`);
    });

index
    .command('status')
    .description('Show index status and staleness estimate')
    .action(async () => {
        const kernel = getKernel();
        const status = await kernel.indexStatus();
        console.log(`Index status:`);
        console.log(`  total records: ${status.total}`);
        console.log(`  expected:      ${status.expectedTotal}`);
        console.log(`  stale:         ${status.possiblyStale ? 'POSSIBLY STALE' : 'ok'}`);
        console.log(`  by store:`);
        for (const [store, count] of Object.entries(status.byStore)) {
            console.log(`    ${store}: ${count}`);
        }
    });

index
    .command('explain <record-id>')
    .description('Explain why an index record exists and whether it is stale')
    .action(async (recordId: string) => {
        const kernel = getKernel();
        try {
            const explanation = await kernel.explainIndex(recordId);
            console.log(`Index record: ${explanation.indexRecordId}`);
            console.log(`  source:       ${explanation.sourceStore}/${explanation.sourceId}`);
            console.log(`  text:         ${explanation.text}`);
            console.log(`  indexedAt:    ${explanation.indexedAt}`);
            console.log(`  sourceExists: ${explanation.sourceExists}`);
            console.log(`  stale:        ${explanation.stale}`);
            if (explanation.staleCause) {
                console.log(`  staleCause:   ${explanation.staleCause}`);
            }
        } catch (err: any) {
            console.error(err.message);
            process.exit(1);
        }
    });

index
    .command('stale')
    .description('List index records that do not match source truth')
    .action(async () => {
        const kernel = getKernel();
        const stale = await kernel.listStaleRecords();
        if (stale.length === 0) {
            console.log('No stale index records.');
            return;
        }
        console.log(`Stale records (${stale.length}):`);
        for (const s of stale) {
            console.log(`  ${s.indexRecordId}`);
            console.log(`    source: ${s.sourceStore}/${s.sourceId}`);
            console.log(`    cause:  ${s.cause}`);
        }
    });

// --- resolve ---
program
    .command('resolve <uri>')
    .description('Resolve a cluster URI to its owner-store object')
    .action(async (uri: string) => {
        if (!existsSync(CLUSTER_DIR)) {
            console.error('No cluster found. Run `db-cluster init` first.');
            process.exit(1);
        }
        const stores = createLocalCluster(CLUSTER_DIR);
        const resolver = new ClusterResolver(stores);

        try {
            const resolved = await resolver.resolve(uri);
            console.log(`Resolved: ${resolved.uri}`);
            console.log(`  kind:  ${resolved.kind}`);
            console.log(`  store: ${resolved.store}`);
            console.log(`  object: ${JSON.stringify(resolved.object, null, 2)}`);
        } catch (err: any) {
            console.error(`Resolve failed: ${err.message}`);
            process.exit(1);
        }
    });

// --- retrieve ---
program
    .command('retrieve <query>')
    .description('Retrieve an evidence bundle (structured cluster retrieval)')
    .option('--limit <n>', 'Max index candidates', '20')
    .action(async (query: string, opts: { limit: string }) => {
        const kernel = getKernel();
        const bundle = await kernel.retrieveBundle(query, { limit: parseInt(opts.limit) });

        console.log(`Evidence Bundle: ${bundle.id}`);
        console.log(`  query:     "${bundle.query}"`);
        console.log(`  assembled: ${bundle.assembledAt}`);
        console.log(`  entities:  ${bundle.resolvedEntities.length}`);
        console.log(`  artifacts: ${bundle.resolvedArtifacts.length}`);
        console.log(`  index:     ${bundle.indexRecords.length} candidates`);
        console.log(`  provenance: ${bundle.provenanceEvents.length} events`);
        console.log(`  fresh:     ${bundle.freshness.allFresh ? 'YES' : 'NO'}`);

        if (bundle.resolvedEntities.length > 0) {
            console.log(`\nResolved entities:`);
            for (const e of bundle.resolvedEntities) {
                const staleTag = e.indexStale ? ' [STALE]' : '';
                console.log(`  ${e.uri} — ${e.object.kind}/${e.object.name}${staleTag}`);
            }
        }
        if (bundle.resolvedArtifacts.length > 0) {
            console.log(`\nResolved artifacts:`);
            for (const a of bundle.resolvedArtifacts) {
                console.log(`  ${a.uri} — ${a.object.filename} v${a.object.version}`);
            }
        }
        if (bundle.missingContext.length > 0) {
            console.log(`\nMissing context:`);
            for (const gap of bundle.missingContext) {
                console.log(`  [${gap.impact}] ${gap.description}`);
            }
        }
        if (bundle.confidenceBoundaries.length > 0) {
            console.log(`\nConfidence boundaries:`);
            for (const b of bundle.confidenceBoundaries) {
                console.log(`  [${b.level}] ${b.claim}`);
            }
        }
    });

// --- explain-retrieval ---
program
    .command('explain-retrieval <query>')
    .description('Retrieve and explain — shows what was found, missing, and confidence')
    .option('--limit <n>', 'Max index candidates', '20')
    .action(async (query: string, opts: { limit: string }) => {
        const kernel = getKernel();
        const bundle = await kernel.retrieveBundle(query, { limit: parseInt(opts.limit) });
        const explanation = await kernel.explainRetrieval(bundle);

        console.log(explanation.summary);
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
