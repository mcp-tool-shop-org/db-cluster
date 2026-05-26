/**
 * Example: Agent-Safe App Database
 *
 * An application where an AI agent proposes mutations and an operator validates/commits.
 * The cluster proves: MCP proposes mutation, operator validates/commits,
 * trace/why explains change, denied principal cannot read restricted record.
 *
 * Uses: artifact store (uploaded records), canonical store (app records),
 *       index store (discovery), ledger store (provenance + receipts).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalCluster } from '../../src/adapters/local/index.js';
import { ClusterKernel } from '../../src/kernel/cluster-kernel.js';
import { PolicyEnforcedKernel } from '../../src/kernel/policy-enforced-kernel.js';
import { DEFAULT_POLICIES, DEFAULT_TRUST_ZONES, DEFAULT_VISIBILITY_RULES } from '../../src/policy/default-policies.js';
import type { Principal } from '../../src/types/policy.js';

async function main() {
    const dataDir = mkdtempSync(join(tmpdir(), 'agent-safe-db-'));
    const stores = createLocalCluster(dataDir);
    const kernel = new ClusterKernel(stores, { dataDir });

    console.log('=== Agent-Safe App Database ===\n');

    // Ingest uploaded records
    await kernel.ingestArtifact({
        filename: 'user-upload.csv',
        content: Buffer.from('name,email,role\nAlice,alice@example.com,admin\nBob,bob@example.com,user'),
        mimeType: 'text/csv',
    });

    // Create app records
    const userRecord = await kernel.createEntity({
        kind: 'user',
        name: 'Alice',
        attributes: { email: 'alice@example.com', role: 'admin', apiKey: 'sk-admin-secret' },
    });

    const publicRecord = await kernel.createEntity({
        kind: 'setting',
        name: 'App theme',
        attributes: { value: 'dark', updatedBy: 'system' },
    });

    console.log('Records created:', userRecord.name, publicRecord.name);

    // Simulate: AI agent proposes a mutation (would come via MCP in production)
    console.log('\n--- AI Agent proposes mutation ---');
    const agentProposal = await kernel.proposeMutation({
        verb: 'update_entity',
        targetStore: 'canonical',
        payload: { entityId: publicRecord.id, patch: { attributes: { value: 'light' } } },
        proposedBy: 'ai-agent',
    });
    console.log('Agent proposed:', agentProposal.id, '→', agentProposal.status);
    console.log('(No store writes yet — command is staged)');

    // Operator validates and commits
    console.log('\n--- Operator validates and commits ---');
    await kernel.validateCommand(agentProposal.id);
    const { command, receipt } = await kernel.commitMutation(agentProposal.id, 'operator');
    console.log('Operator committed:', command.status);
    console.log('Receipt:', receipt.id);

    // Trace explains the change
    console.log('\n--- Trace explains change ---');
    const explanation = await kernel.why(`cluster://canonical/${publicRecord.id}`);
    console.log('Why:', explanation);

    // Policy enforcement: restricted principal cannot read sensitive records
    console.log('\n--- Policy enforcement ---');
    const policyKernel = new PolicyEnforcedKernel(kernel, {
        policies: DEFAULT_POLICIES,
        trustZones: DEFAULT_TRUST_ZONES,
        visibilityRules: DEFAULT_VISIBILITY_RULES,
    });

    const agent: Principal = { id: 'ai-agent', trustZone: 'agent', capabilities: ['read', 'propose'] };
    const operator: Principal = { id: 'operator', trustZone: 'internal', capabilities: ['read', 'write', 'approve', 'admin'] };

    const agentResults = await policyKernel.findSources('Alice admin', agent);
    const operatorResults = await policyKernel.findSources('Alice admin', operator);

    console.log('Agent sees:', agentResults.resolvedEntities.length, 'entities');
    console.log('Operator sees:', operatorResults.resolvedEntities.length, 'entities');

    // Cleanup
    rmSync(dataDir, { recursive: true, force: true });
    console.log('\nDone.');
}

main().catch(console.error);
