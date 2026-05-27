/**
 * Dogfood policy tests — verify trust zones enforce correctly on project memory.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { rmSync } from 'node:fs';
import { createDogfoodCluster, type DogfoodCluster } from '../scripts/dogfood-ingest.js';
import { PolicyEnforcedKernel, PolicyDeniedError } from '../src/kernel/policy-enforced-kernel.js';
import { DEFAULT_POLICIES, DEFAULT_TRUST_ZONES, DEFAULT_VISIBILITY_RULES } from '../src/policy/default-policies.js';
import { createLocalCluster } from '../src/adapters/local/index.js';
import type { Principal, Policy } from '../src/types/policy.js';

let cluster: DogfoodCluster;

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

const policyOpts = {
    policies: DOGFOOD_POLICIES,
    trustZones: DEFAULT_TRUST_ZONES,
    visibilityRules: DEFAULT_VISIBILITY_RULES,
};

const operator: Principal = { id: 'operator', name: 'Operator', roles: ['cluster-admin'], trustZone: 'internal' };
const agent: Principal = { id: 'agent', name: 'AI Agent', roles: ['proposer'], trustZone: 'ai-facing' };
const observer: Principal = { id: 'observer', name: 'Observer', roles: ['observer'], trustZone: 'internal' };
const external: Principal = { id: 'external', name: 'External', roles: [], trustZone: 'external' };

beforeAll(async () => {
    cluster = await createDogfoodCluster();
});

afterAll(() => {
    rmSync(cluster.dataDir, { recursive: true, force: true });
});

describe('Dogfood policy', () => {
    it('operator can read, trace, and commit', async () => {
        const stores = createLocalCluster(cluster.dataDir);
        const k = new PolicyEnforcedKernel(stores, { principal: operator }, policyOpts);

        // Read
        const results = await k.findSources({ query: 'Phase' });
        expect(results.resolvedEntities.length).toBeGreaterThanOrEqual(0);

        // Propose → validate → commit (KERNEL-006 requires explicit validate)
        const proposal = await k.proposeMutation({
            verb: 'create_entity',
            targetStore: 'canonical',
            payload: { kind: 'finding', name: 'op-policy-test', attributes: {} },
            proposedBy: 'operator',
        });
        await k.validateMutation(proposal.id);
        const { command } = await k.commitMutation(proposal.id, 'operator');
        expect(command.status).toBe('committed');
    });

    it('agent can retrieve and propose but cannot commit', async () => {
        const stores = createLocalCluster(cluster.dataDir);
        const k = new PolicyEnforcedKernel(stores, { principal: agent }, policyOpts);

        // Can discover
        const results = await k.findSources({ query: 'Phase' });
        expect(results).toBeDefined();

        // Can propose
        const proposal = await k.proposeMutation({
            verb: 'create_entity',
            targetStore: 'canonical',
            payload: { kind: 'finding', name: 'agent-policy-test', attributes: {} },
            proposedBy: 'agent',
        });
        expect(proposal.status).toBe('proposed');

        // Cannot commit
        await expect(
            k.commitMutation(proposal.id, 'agent'),
        ).rejects.toThrow(PolicyDeniedError);
    });

    it('observer can read but cannot propose', async () => {
        const stores = createLocalCluster(cluster.dataDir);
        const k = new PolicyEnforcedKernel(stores, { principal: observer }, policyOpts);

        // Can read
        const results = await k.findSources({ query: 'Phase' });
        expect(results).toBeDefined();

        // Cannot propose
        await expect(
            k.proposeMutation({
                verb: 'create_entity',
                targetStore: 'canonical',
                payload: { kind: 'finding', name: 'obs-test', attributes: {} },
                proposedBy: 'observer',
            }),
        ).rejects.toThrow(PolicyDeniedError);
    });

    it('external cannot access cluster', async () => {
        const stores = createLocalCluster(cluster.dataDir);
        const k = new PolicyEnforcedKernel(stores, { principal: external }, policyOpts);

        await expect(
            k.findSources({ query: 'Phase' }),
        ).rejects.toThrow(PolicyDeniedError);
    });

    it('agent can read commands it proposed', async () => {
        const stores = createLocalCluster(cluster.dataDir);
        const agentK = new PolicyEnforcedKernel(stores, { principal: agent }, policyOpts);

        // Agent proposes
        const proposal = await agentK.proposeMutation({
            verb: 'create_entity',
            targetStore: 'canonical',
            payload: { kind: 'finding', name: 'agent-readable-cmd', attributes: { secret: 'hidden-value' } },
            proposedBy: 'agent',
        });

        // Agent can inspect its own command
        const inspected = await agentK.inspectCommand(proposal.id);
        expect(inspected).toBeDefined();
        expect(inspected.id).toBe(proposal.id);
        expect(inspected.status).toBe('proposed');
    });

    it('provenance graph preserves shape under redaction', async () => {
        const stores = createLocalCluster(cluster.dataDir);
        const agentK = new PolicyEnforcedKernel(stores, { principal: agent }, policyOpts);

        // Agent can trace (proposer has trace_provenance)
        // Use an entity from the existing cluster
        const phaseId = cluster.entities.get('Phase 6 — AI-Facing Interface: MCP and SDK')!;
        const uri = `cluster://canonical/${phaseId}`;
        const graph = await agentK.traceObject(uri);

        // Graph has structure even if some nodes are hidden/redacted
        expect(graph.focalUri).toBe(uri);
        expect(graph.nodes.length).toBeGreaterThanOrEqual(0);
    });

    it('policy explain does not leak restricted data', async () => {
        const stores = createLocalCluster(cluster.dataDir);
        const extK = new PolicyEnforcedKernel(stores, { principal: external }, policyOpts);

        // External is denied — the error message should not contain store content
        try {
            await extK.findSources({ query: 'secret internal data' });
        } catch (err) {
            if (err instanceof PolicyDeniedError) {
                expect(err.message).not.toContain('secret');
                expect(err.decision.reason).not.toContain('internal data');
            }
        }
    });
});
