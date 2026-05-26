/**
 * Dogfood policy script — demonstrate trust zone enforcement on project memory.
 *
 * Principals:
 * - operator: full access (read/trace/commit)
 * - agent: can retrieve and propose, cannot commit
 * - observer: read-only (derivative/indexed summaries)
 * - external: discover existence only, no content
 *
 * Usage: npx tsx scripts/dogfood-policy.ts
 */

import { createDogfoodCluster } from './dogfood-ingest.js';
import { PolicyEnforcedKernel, PolicyDeniedError } from '../src/kernel/policy-enforced-kernel.js';
import { DEFAULT_POLICIES, DEFAULT_TRUST_ZONES, DEFAULT_VISIBILITY_RULES } from '../src/policy/default-policies.js';
import type { Principal } from '../src/types/policy.js';
import type { Policy } from '../src/types/policy.js';
import { rmSync } from 'node:fs';
import { createLocalCluster } from '../src/adapters/local/index.js';

// Extended policies for dogfood: add observer, external deny
const DOGFOOD_POLICIES: Policy[] = [
    ...DEFAULT_POLICIES,
    {
        id: 'external-deny-all',
        name: 'External Deny All',
        priority: 5,
        match: { trustZones: ['external'] },
        decision: 'deny',
        reason: 'External zone has no cluster access.',
    },
    {
        id: 'observer-deny-mutation',
        name: 'Observer Cannot Mutate',
        priority: 15,
        match: {
            principals: ['observer'],
            capabilities: ['propose_mutation', 'commit_command', 'approve_command'],
        },
        decision: 'deny',
        reason: 'Observer cannot mutate project memory.',
    },
];

async function main() {
    const cluster = await createDogfoodCluster();
    const { dataDir } = cluster;
    const stores = createLocalCluster(dataDir);

    console.log('\n=== Dogfood Policy & Redaction ===\n');

    // Define principals
    const operator: Principal = { id: 'operator', name: 'Operator', roles: ['cluster-admin'], trustZone: 'internal' };
    const agent: Principal = { id: 'agent', name: 'AI Agent', roles: ['proposer'], trustZone: 'ai-facing' };
    const observer: Principal = { id: 'observer', name: 'Observer', roles: ['observer'], trustZone: 'internal' };
    const external: Principal = { id: 'external', name: 'External', roles: [], trustZone: 'external' };

    const policyOpts = {
        policies: DOGFOOD_POLICIES,
        trustZones: DEFAULT_TRUST_ZONES,
        visibilityRules: DEFAULT_VISIBILITY_RULES,
    };

    // Operator: full access
    console.log('─── Operator ───');
    const opKernel = new PolicyEnforcedKernel(stores, { principal: operator }, policyOpts);
    const opResults = await opKernel.findSources({ query: 'Phase' });
    console.log(`  findSources: ${opResults.resolvedEntities.length} entities`);

    const opProposal = await opKernel.proposeMutation({
        verb: 'create_entity',
        targetStore: 'canonical',
        payload: { kind: 'finding', name: 'op-test', attributes: {} },
        proposedBy: 'operator',
    });
    const { command } = await opKernel.commitMutation(opProposal.id, 'operator');
    console.log(`  commit: ${command.status}`);
    console.log('');

    // Agent: can propose, cannot commit
    console.log('─── Agent ───');
    const agentKernel = new PolicyEnforcedKernel(stores, { principal: agent }, policyOpts);
    const agentResults = await agentKernel.findSources({ query: 'Phase' });
    console.log(`  findSources: ${agentResults.resolvedEntities.length} entities (may be filtered)`);

    const agentProposal = await agentKernel.proposeMutation({
        verb: 'create_entity',
        targetStore: 'canonical',
        payload: { kind: 'finding', name: 'agent-test', attributes: {} },
        proposedBy: 'agent',
    });
    console.log(`  propose: ${agentProposal.status}`);

    try {
        await agentKernel.commitMutation(agentProposal.id, 'agent');
        console.log('  commit: ALLOWED (unexpected)');
    } catch (err) {
        if (err instanceof PolicyDeniedError) {
            console.log(`  commit: DENIED — ${err.decision.reason}`);
        } else {
            console.log(`  commit: ERROR — ${(err as Error).message}`);
        }
    }
    console.log('');

    // Observer: read-only
    console.log('─── Observer ───');
    const obsKernel = new PolicyEnforcedKernel(stores, { principal: observer }, policyOpts);
    const obsResults = await obsKernel.findSources({ query: 'Phase' });
    console.log(`  findSources: ${obsResults.resolvedEntities.length} entities`);

    try {
        await obsKernel.proposeMutation({
            verb: 'create_entity',
            targetStore: 'canonical',
            payload: { kind: 'finding', name: 'obs-test', attributes: {} },
            proposedBy: 'observer',
        });
        console.log('  propose: ALLOWED (unexpected)');
    } catch (err) {
        if (err instanceof PolicyDeniedError) {
            console.log(`  propose: DENIED — ${err.decision.reason}`);
        }
    }
    console.log('');

    // External: denied everything
    console.log('─── External ───');
    const extKernel = new PolicyEnforcedKernel(stores, { principal: external }, policyOpts);
    try {
        await extKernel.findSources({ query: 'Phase' });
        console.log('  findSources: ALLOWED (unexpected)');
    } catch (err) {
        if (err instanceof PolicyDeniedError) {
            console.log(`  findSources: DENIED — ${err.decision.reason}`);
        }
    }
    console.log('');

    rmSync(dataDir, { recursive: true, force: true });
    console.log('=== Policy demonstration complete ===');
}

main().catch(console.error);
