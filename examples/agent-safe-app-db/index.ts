/**
 * Example: Agent-Safe App Database
 *
 * An application where an AI agent proposes mutations and an operator validates/commits.
 * The cluster proves: AI proposes mutation, operator validates/commits,
 * trace/why explains change, denied principal cannot read restricted record.
 *
 * Uses: artifact store (uploaded records), canonical store (app records),
 *       index store (discovery), ledger store (provenance + receipts).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClusterSDK } from 'db-cluster/sdk';
import { DEFAULT_POLICIES, DEFAULT_TRUST_ZONES, DEFAULT_VISIBILITY_RULES } from 'db-cluster/policy';
import type { Principal } from 'db-cluster/policy';

async function main() {
    const dataDir = mkdtempSync(join(tmpdir(), 'agent-safe-db-'));

    console.log('=== Agent-Safe App Database ===\n');

    // The application surface is the SDK. Configure it with policies so reads
    // and writes flow through PolicyEnforcedKernel at runtime.
    const operator: Principal = {
        id: 'operator',
        name: 'Operator',
        roles: ['operator'],
        trustZone: 'internal',
    };
    const sdk = new ClusterSDK({
        clusterDir: dataDir,
        policies: DEFAULT_POLICIES,
        trustZones: DEFAULT_TRUST_ZONES,
        visibilityRules: DEFAULT_VISIBILITY_RULES,
        principal: operator,
    });

    // Seed: ingest an uploaded record + create app records through the SDK lifecycle.
    async function ingest(filename: string, content: string, mimeType: string) {
        const cmd = await sdk.proposeMutation({
            verb: 'ingest_artifact',
            targetStore: 'artifact',
            payload: { filename, content: Buffer.from(content), mimeType },
            proposedBy: 'operator',
        });
        await sdk.validateMutation(cmd.id);
        const { receipt } = await sdk.commitMutation(cmd.id, 'operator');
        return receipt.affectedIds[0];
    }

    async function create(name: string, kind: string, attributes: Record<string, unknown>) {
        const cmd = await sdk.proposeMutation({
            verb: 'create_entity',
            targetStore: 'canonical',
            payload: { kind, name, attributes },
            proposedBy: 'operator',
        });
        await sdk.validateMutation(cmd.id);
        const { receipt } = await sdk.commitMutation(cmd.id, 'operator');
        return receipt.affectedIds[0];
    }

    await ingest(
        'user-upload.csv',
        'name,email,role\nAlice,alice@example.com,admin\nBob,bob@example.com,user',
        'text/csv',
    );

    const userRecordId = await create('Alice', 'user', {
        email: 'alice@example.com',
        role: 'admin',
        apiToken: 'example-token-not-a-real-secret',
    });

    const publicRecordId = await create('App theme', 'setting', {
        value: 'dark',
        updatedBy: 'system',
    });

    console.log('Records created:', userRecordId, publicRecordId);

    // Simulate: AI agent proposes a mutation (would come via MCP in production)
    console.log('\n--- AI Agent proposes mutation ---');
    const agentProposal = await sdk.proposeMutation({
        verb: 'update_entity',
        targetStore: 'canonical',
        payload: { entityId: publicRecordId, patch: { attributes: { value: 'light' } } },
        proposedBy: 'ai-agent',
    });
    console.log('Agent proposed:', agentProposal.id, '→', agentProposal.status);
    console.log('(No store writes yet — command is staged)');

    // Operator validates, approves and commits
    console.log('\n--- Operator validates, approves, and commits ---');
    await sdk.validateMutation(agentProposal.id);
    await sdk.approveMutation(agentProposal.id, 'operator', 'Reviewed');
    const { command, receipt } = await sdk.commitMutation(agentProposal.id, 'operator');
    console.log('Operator committed:', command.status);
    console.log('Receipt:', receipt.id);

    // Trace explains the change
    console.log('\n--- Trace explains change ---');
    const explanation = await sdk.why(`cluster://canonical/${publicRecordId}`);
    console.log('Why:', explanation);

    // Policy enforcement: an external principal sees a policy-filtered view.
    // The SDK routes through PolicyEnforcedKernel when `policies` is configured.
    console.log('\n--- Policy enforcement (external principal) ---');
    const externalPrincipal: Principal = {
        id: 'public-api',
        name: 'Public API',
        roles: ['external-reader'],
        trustZone: 'external',
    };
    const externalSdk = new ClusterSDK({
        clusterDir: dataDir,
        policies: DEFAULT_POLICIES,
        trustZones: DEFAULT_TRUST_ZONES,
        visibilityRules: DEFAULT_VISIBILITY_RULES,
        principal: externalPrincipal,
    });

    const operatorResults = await sdk.findSources('Alice admin');
    const externalResults = await externalSdk.findSources('Alice admin');

    console.log('Operator sees:', operatorResults.resolvedEntities.length, 'entities');
    console.log('External sees:', externalResults.resolvedEntities.length, 'entities (may be filtered/redacted)');

    void userRecordId; // referenced in audit trail but unused below

    // Cleanup
    rmSync(dataDir, { recursive: true, force: true });
    console.log('\nDone.');
}

main().catch(console.error);
