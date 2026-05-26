#!/usr/bin/env node
import { Command } from 'commander';
import { resolve } from 'node:path';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createLocalCluster } from './adapters/local/index.js';
import { ClusterKernel } from './kernel/cluster-kernel.js';
import { ClusterResolver } from './resolver/index.js';
import { formatClusterUri, parseClusterUri, isClusterUri } from './uri/index.js';
import { evaluatePolicy, explainPolicyDecision, checkVisibility } from './policy/policy-engine.js';
import { DEFAULT_POLICIES, DEFAULT_TRUST_ZONES, DEFAULT_VISIBILITY_RULES } from './policy/default-policies.js';
import type { Principal, Capability } from './types/policy.js';

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

// --- validate ---
program
    .command('validate <command-id>')
    .description('Validate a proposed command without committing')
    .action(async (commandId: string) => {
        const kernel = getKernel();
        try {
            const cmd = await kernel.validateMutation(commandId);
            console.log(`Validated: ${cmd.id}`);
            console.log(`  verb:   ${cmd.verb}`);
            console.log(`  status: ${cmd.status}`);
            if (cmd.validation) {
                console.log(`  checks:`);
                for (const check of cmd.validation.checks) {
                    console.log(`    ${check.passed ? '✓' : '✗'} ${check.name}${check.message ? ': ' + check.message : ''}`);
                }
            }
        } catch (err: any) {
            console.error(`Validation failed: ${err.message}`);
            process.exit(1);
        }
    });

// --- approve ---
program
    .command('approve <command-id>')
    .description('Approve a validated command (operator/policy gate)')
    .option('--note <text>', 'Approval note')
    .action(async (commandId: string, opts: { note?: string }) => {
        const kernel = getKernel();
        try {
            const cmd = await kernel.approveMutation(commandId, 'cli-user', opts.note);
            console.log(`Approved: ${cmd.id}`);
            console.log(`  verb:       ${cmd.verb}`);
            console.log(`  status:     ${cmd.status}`);
            console.log(`  approvedBy: ${cmd.approvedBy}`);
            if (cmd.approvalNote) {
                console.log(`  note:       ${cmd.approvalNote}`);
            }
        } catch (err: any) {
            console.error(`Approval failed: ${err.message}`);
            process.exit(1);
        }
    });

// --- reject ---
program
    .command('reject <command-id>')
    .description('Reject a proposed or validated command')
    .requiredOption('--reason <text>', 'Rejection reason')
    .action(async (commandId: string, opts: { reason: string }) => {
        const kernel = getKernel();
        try {
            const cmd = await kernel.rejectMutation(commandId, 'cli-user', opts.reason);
            console.log(`Rejected: ${cmd.id}`);
            console.log(`  verb:     ${cmd.verb}`);
            console.log(`  status:   ${cmd.status}`);
            console.log(`  reason:   ${cmd.rejectionReason}`);
        } catch (err: any) {
            console.error(`Rejection failed: ${err.message}`);
            process.exit(1);
        }
    });

// --- compensate ---
program
    .command('compensate <command-id>')
    .description('Compensate a committed command (correct without erasing)')
    .requiredOption('--reason <text>', 'Compensation reason')
    .action(async (commandId: string, opts: { reason: string }) => {
        const kernel = getKernel();
        try {
            const result = await kernel.compensateMutation(commandId, 'cli-user', opts.reason);
            console.log(`Compensated: ${result.originalCommand.id}`);
            console.log(`  original status: ${result.originalCommand.status}`);
            console.log(`  compensating:    ${result.compensatingCommand.id}`);
            console.log(`  receipt:         ${result.receipt.id}`);
            console.log(`  reason:          ${opts.reason}`);
        } catch (err: any) {
            console.error(`Compensation failed: ${err.message}`);
            process.exit(1);
        }
    });

// --- inspect-command ---
program
    .command('inspect-command <command-id>')
    .description('Inspect a command — full lifecycle state')
    .action(async (commandId: string) => {
        const kernel = getKernel();
        try {
            const cmd = await kernel.inspectCommand(commandId);
            console.log(JSON.stringify(cmd, null, 2));
        } catch (err: any) {
            console.error(`Not found: ${err.message}`);
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

// --- trace ---
program
    .command('trace <uri>')
    .description('Trace provenance for any cluster URI — navigable graph')
    .option('--direction <dir>', 'backward | forward | bidirectional', 'backward')
    .option('--depth <n>', 'Max traversal depth', '10')
    .option('--graph', 'Output full graph JSON', false)
    .action(async (uri: string, opts: { direction: string; depth: string; graph: boolean }) => {
        const kernel = getKernel();
        const graph = await kernel.traceObject(uri, {
            direction: opts.direction as 'backward' | 'forward' | 'bidirectional',
            depth: parseInt(opts.depth),
        });

        if (opts.graph) {
            console.log(JSON.stringify(graph, null, 2));
        } else {
            console.log(kernel.explainTrace(graph));
        }
    });

// --- why ---
program
    .command('why <uri>')
    .description('Why does this object exist? Compact provenance explanation.')
    .action(async (uri: string) => {
        const kernel = getKernel();
        const explanation = await kernel.why(uri);
        console.log(explanation);
    });

// --- lineage ---
program
    .command('lineage <uri>')
    .description('Full lineage — bidirectional trace with all edges')
    .option('--depth <n>', 'Max traversal depth', '10')
    .action(async (uri: string, opts: { depth: string }) => {
        const kernel = getKernel();
        const graph = await kernel.traceObject(uri, {
            direction: 'bidirectional',
            depth: parseInt(opts.depth),
            includeIndex: true,
            includeReceipts: true,
            includeGaps: true,
        });
        console.log(kernel.explainTrace(graph));
    });

// --- trace-bundle ---
program
    .command('trace-bundle <query>')
    .description('Retrieve a bundle and trace its full provenance graph')
    .option('--limit <n>', 'Max index candidates', '20')
    .option('--direction <dir>', 'backward | forward | bidirectional', 'backward')
    .option('--graph', 'Output full graph JSON', false)
    .action(async (query: string, opts: { limit: string; direction: string; graph: boolean }) => {
        const kernel = getKernel();
        const bundle = await kernel.retrieveBundle(query, { limit: parseInt(opts.limit) });
        const graph = await kernel.traceBundle(bundle, {
            direction: opts.direction as 'backward' | 'forward' | 'bidirectional',
        });

        if (opts.graph) {
            console.log(JSON.stringify(graph, null, 2));
        } else {
            console.log(kernel.explainTrace(graph));
        }
    });

// --- policy ---
const policy = program.command('policy').description('Policy explain and test surface');

policy
    .command('explain')
    .description('Explain what the policy engine would decide for a given action (dry-run)')
    .requiredOption('--principal <id>', 'Principal ID')
    .requiredOption('--capability <cap>', 'Capability to check')
    .option('--roles <roles>', 'Comma-separated roles', '')
    .option('--trust-zone <zone>', 'Trust zone', 'internal')
    .option('--uri <uri>', 'Resource URI')
    .option('--store <store>', 'Owner store')
    .option('--kind <kind>', 'Entity kind')
    .option('--verb <verb>', 'Command verb')
    .action((opts) => {
        const principal: Principal = {
            id: opts.principal,
            name: opts.principal,
            roles: opts.roles ? opts.roles.split(',') : [],
            trustZone: opts.trustZone,
        };

        const decision = evaluatePolicy({
            principal,
            capability: opts.capability as Capability,
            resourceUri: opts.uri,
            ownerStore: opts.store,
            entityKind: opts.kind,
            commandVerb: opts.verb,
            trustZone: opts.trustZone,
        }, { policies: DEFAULT_POLICIES, trustZones: DEFAULT_TRUST_ZONES });

        const explanation = explainPolicyDecision(decision);
        console.log(explanation);

        if (decision.decision === 'deny' && opts.uri) {
            const vis = checkVisibility(opts.uri, opts.store, DEFAULT_VISIBILITY_RULES);
            console.log(`\nVisibility: existence ${vis.existenceVisible ? 'VISIBLE' : 'HIDDEN'}${vis.emitPlaceholder ? ' (placeholder emitted)' : ''}`);
        }
    });

policy
    .command('test')
    .description('Test a policy scenario — evaluate multiple capabilities for a principal')
    .requiredOption('--principal <id>', 'Principal ID')
    .requiredOption('--capabilities <caps>', 'Comma-separated capabilities to test')
    .option('--roles <roles>', 'Comma-separated roles', '')
    .option('--trust-zone <zone>', 'Trust zone', 'internal')
    .option('--store <store>', 'Owner store')
    .option('--uri <uri>', 'Resource URI')
    .action((opts) => {
        const principal: Principal = {
            id: opts.principal,
            name: opts.principal,
            roles: opts.roles ? opts.roles.split(',') : [],
            trustZone: opts.trustZone,
        };

        const capabilities = opts.capabilities.split(',') as Capability[];
        const results = capabilities.map((capability) => {
            const decision = evaluatePolicy({
                principal,
                capability,
                resourceUri: opts.uri,
                ownerStore: opts.store,
                trustZone: opts.trustZone,
            }, { policies: DEFAULT_POLICIES, trustZones: DEFAULT_TRUST_ZONES });
            return { capability, decision: decision.decision, reason: decision.reason, policyId: decision.matchedPolicyId };
        });

        const allowed = results.filter((r) => r.decision === 'allow').length;
        const denied = results.filter((r) => r.decision === 'deny').length;

        console.log(`Policy test for ${principal.id} [${principal.roles.join(', ')}] in zone ${opts.trustZone}:`);
        console.log('');
        for (const r of results) {
            const icon = r.decision === 'allow' ? '✓' : '✗';
            console.log(`  ${icon} ${r.capability}: ${r.decision.toUpperCase()} — ${r.reason} (${r.policyId})`);
        }
        console.log('');
        console.log(`Summary: ${allowed} allowed, ${denied} denied out of ${results.length} actions.`);
    });

// --- stores ---
const stores = program.command('stores').description('Manage store backends');

stores
    .command('verify')
    .description('Verify store backend configuration and connectivity')
    .action(async () => {
        const canonicalBackend = process.env.DB_CLUSTER_CANONICAL_BACKEND ?? 'local';
        const postgresUrl = process.env.DB_CLUSTER_POSTGRES_URL;

        console.log('Store Backend Configuration');
        console.log('═══════════════════════════════════════');
        console.log(`  canonical: ${canonicalBackend}`);
        console.log(`  artifact:  local`);
        console.log(`  index:     local`);
        console.log(`  ledger:    local`);
        console.log('');

        // Canonical backend check
        if (canonicalBackend === 'postgres') {
            if (!postgresUrl) {
                console.error('✗ DB_CLUSTER_POSTGRES_URL not set');
                process.exit(1);
            }
            try {
                const { Pool } = await import('pg');
                const pool = new Pool({ connectionString: postgresUrl });
                const result = await pool.query('SELECT 1 AS ok');
                if (result.rows[0].ok === 1) {
                    console.log('  ✓ Postgres connection: OK');
                }
                // Check migrations
                const tableCheck = await pool.query(
                    `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'canonical_entities') AS exists`,
                );
                if (tableCheck.rows[0].exists) {
                    console.log('  ✓ Migrations: canonical_entities table exists');
                } else {
                    console.log('  ✗ Migrations: canonical_entities table NOT found');
                    console.log('    Run: db-cluster stores migrate');
                }
                await pool.end();
            } catch (err: any) {
                console.error(`  ✗ Postgres connection failed: ${err.message}`);
                process.exit(1);
            }
        } else {
            const clusterExists = existsSync(CLUSTER_DIR);
            if (clusterExists) {
                console.log('  ✓ Local cluster directory exists');
            } else {
                console.log('  ✗ No cluster initialized. Run: db-cluster init');
            }
        }

        console.log('');
        console.log('Contract compatibility: all backends implement CanonicalStore interface');
    });

stores
    .command('migrate')
    .description('Run pending store migrations')
    .action(async () => {
        const canonicalBackend = process.env.DB_CLUSTER_CANONICAL_BACKEND ?? 'local';
        const postgresUrl = process.env.DB_CLUSTER_POSTGRES_URL;

        if (canonicalBackend !== 'postgres') {
            console.log('No migrations needed for local backend.');
            return;
        }

        if (!postgresUrl) {
            console.error('DB_CLUSTER_POSTGRES_URL not set.');
            process.exit(1);
        }

        try {
            const { Pool } = await import('pg');
            const { PostgresCanonicalStore } = await import('./adapters/postgres/postgres-canonical-store.js');
            const pool = new Pool({ connectionString: postgresUrl });
            const store = new PostgresCanonicalStore(pool);
            await store.migrate();
            console.log('✓ Migrations applied: canonical_entities table ready');
            await pool.end();
        } catch (err: any) {
            console.error(`✗ Migration failed: ${err.message}`);
            process.exit(1);
        }
    });

stores
    .command('list')
    .description('List configured store backends')
    .action(() => {
        const canonicalBackend = process.env.DB_CLUSTER_CANONICAL_BACKEND ?? 'local';
        console.log('Backend     Store');
        console.log('─────────── ──────────');
        console.log(`${canonicalBackend.padEnd(12)}canonical`);
        console.log(`local       artifact`);
        console.log(`local       index`);
        console.log(`local       ledger`);
    });

// --- Operations commands ---

program
    .command('doctor')
    .description('Run full cluster health assessment')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
        const stores = createLocalCluster(CLUSTER_DIR);
        const { doctor } = await import('./ops/doctor.js');
        const health = await doctor(stores);
        if (opts.json) {
            console.log(JSON.stringify(health, null, 2));
        } else {
            console.log(`Cluster: ${health.status}`);
            console.log(`Checks: ${health.summary.total} total, ${health.summary.healthy} healthy, ${health.summary.errors} errors, ${health.summary.warnings} warnings`);
            for (const check of health.checks) {
                const icon = check.status === 'healthy' ? '✓' : check.severity === 'error' ? '✗' : '!';
                console.log(`  ${icon} [${check.store}] ${check.name}: ${check.message}`);
                if (check.suggestedCommand) {
                    console.log(`    → fix: ${check.suggestedCommand}`);
                }
            }
        }
    });

program
    .command('verify')
    .description('Verify cluster invariants (data consistency)')
    .option('--json', 'Output as JSON')
    .option('--sample <n>', 'Max records to sample per store', '100')
    .action(async (opts) => {
        const stores = createLocalCluster(CLUSTER_DIR);
        const { verify } = await import('./ops/verify.js');
        const health = await verify(stores, { sampleLimit: parseInt(opts.sample, 10) });
        if (opts.json) {
            console.log(JSON.stringify(health, null, 2));
        } else {
            console.log(`Verification: ${health.status}`);
            for (const check of health.checks) {
                const icon = check.status === 'healthy' ? '✓' : check.severity === 'error' ? '✗' : '!';
                console.log(`  ${icon} ${check.name}: ${check.message}`);
            }
        }
    });

const rebuild = program
    .command('rebuild')
    .description('Rebuild derivative state from owner truth');

rebuild
    .command('index')
    .description('Rebuild the index from canonical + artifact stores')
    .option('--dry-run', 'Show what would be rebuilt without mutating')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
        const stores = createLocalCluster(CLUSTER_DIR);
        const { rebuildIndex } = await import('./ops/rebuild.js');
        const result = await rebuildIndex(stores, { dryRun: opts.dryRun });
        if (opts.json) {
            console.log(JSON.stringify(result, null, 2));
        } else {
            console.log(`Rebuilt: ${result.rebuilt} records${result.dryRun ? ' (dry run)' : ''}`);
            if (result.errors.length > 0) {
                console.log(`Errors: ${result.errors.length}`);
                for (const e of result.errors) console.log(`  ${e}`);
            }
        }
    });

rebuild
    .command('check')
    .description('Check for stale or orphan index records')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
        const stores = createLocalCluster(CLUSTER_DIR);
        const { checkStale } = await import('./ops/rebuild.js');
        const stale = await checkStale(stores);
        if (opts.json) {
            console.log(JSON.stringify(stale, null, 2));
        } else {
            if (stale.length === 0) {
                console.log('No stale records found.');
            } else {
                console.log(`Found ${stale.length} stale record(s):`);
                for (const s of stale) {
                    console.log(`  [${s.type}] ${s.sourceStore}/${s.sourceId}: ${s.message}`);
                }
            }
        }
    });

program
    .command('backup')
    .description('Export cluster state to JSON backup')
    .option('-o, --output <file>', 'Output file path')
    .option('--json', 'Write to stdout as JSON')
    .action(async (opts) => {
        const stores = createLocalCluster(CLUSTER_DIR);
        const { backup } = await import('./ops/backup.js');
        const data = await backup(stores);
        const json = JSON.stringify(data, null, 2);
        if (opts.output) {
            const { writeFileSync } = await import('node:fs');
            writeFileSync(resolve(opts.output), json, 'utf-8');
            console.log(`Backup written to ${opts.output}`);
        } else {
            console.log(json);
        }
    });

program
    .command('restore <file>')
    .description('Restore cluster state from a backup file')
    .option('--json', 'Output as JSON')
    .action(async (file, opts) => {
        const stores = createLocalCluster(CLUSTER_DIR);
        const { restore } = await import('./ops/backup.js');
        const raw = readFileSync(resolve(file), 'utf-8');
        const data = JSON.parse(raw);
        const result = await restore(stores, data);
        if (opts.json) {
            console.log(JSON.stringify(result, null, 2));
        } else {
            console.log(`Entities: ${result.entities.created} created, ${result.entities.skipped} skipped`);
            console.log(`Events: ${result.events.created} created, ${result.events.skipped} skipped`);
            console.log(`Receipts: ${result.receipts.created} created, ${result.receipts.skipped} skipped`);
        }
    });

program
    .command('migration-status')
    .description('Check Postgres schema migration state')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
        const url = process.env.DB_CLUSTER_POSTGRES_URL;
        if (!url) {
            console.error('DB_CLUSTER_POSTGRES_URL not set.');
            process.exit(1);
        }
        const pg = await import('pg');
        const pool = new pg.default.Pool({ connectionString: url });
        try {
            const { checkMigrationStatus } = await import('./ops/migrations.js');
            const status = await checkMigrationStatus(pool);
            if (opts.json) {
                console.log(JSON.stringify(status, null, 2));
            } else {
                console.log(`Backend: ${status.backend}`);
                console.log(`Migrated: ${status.migrated}`);
                console.log(`Tables: ${status.tables.join(', ') || '(none)'}`);
                console.log(status.message);
            }
        } finally {
            await pool.end();
        }
    });

program
    .command('verify-schema')
    .description('Validate physical backend schema structure')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
        const url = process.env.DB_CLUSTER_POSTGRES_URL;
        if (!url) {
            console.error('DB_CLUSTER_POSTGRES_URL not set.');
            process.exit(1);
        }
        const pg = await import('pg');
        const pool = new pg.default.Pool({ connectionString: url });
        try {
            const { verifySchema } = await import('./ops/migrations.js');
            const result = await verifySchema(pool);
            if (opts.json) {
                console.log(JSON.stringify(result, null, 2));
            } else {
                console.log(`Schema valid: ${result.valid}`);
                if (result.issues.length > 0) {
                    for (const issue of result.issues) console.log(`  ✗ ${issue}`);
                }
            }
        } finally {
            await pool.end();
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
