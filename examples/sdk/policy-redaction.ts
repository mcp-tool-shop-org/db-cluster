/**
 * SDK Example: Policy enforcement and redaction.
 *
 * Demonstrates: PolicyEnforcedKernel, trust zones, redaction, denied access.
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
    const dataDir = mkdtempSync(join(tmpdir(), 'db-cluster-policy-'));
    const stores = createLocalCluster(dataDir);
    const kernel = new ClusterKernel(stores, { dataDir });

    // Create entities with different sensitivity
    await kernel.createEntity({
        kind: 'record',
        name: 'Public project overview',
        attributes: { visibility: 'public', content: 'This project uses db-cluster.' },
    });
    await kernel.createEntity({
        kind: 'record',
        name: 'Internal credentials store',
        attributes: { visibility: 'restricted', apiKey: 'sk-secret-12345', dbPassword: 'hunter2' },
    });

    // Create policy-enforced kernel
    const policyKernel = new PolicyEnforcedKernel(kernel, {
        policies: DEFAULT_POLICIES,
        trustZones: DEFAULT_TRUST_ZONES,
        visibilityRules: DEFAULT_VISIBILITY_RULES,
    });

    // Internal principal — full access
    const internal: Principal = { id: 'admin', trustZone: 'internal', capabilities: ['read', 'write', 'admin'] };

    // External principal — restricted
    const external: Principal = { id: 'public-api', trustZone: 'external', capabilities: ['read'] };

    console.log('=== Internal principal (full access) ===');
    const internalResults = await policyKernel.findSources('credentials', internal);
    console.log('Found:', internalResults.resolvedEntities.length, 'entities');

    console.log('\n=== External principal (restricted) ===');
    const externalResults = await policyKernel.findSources('credentials', external);
    console.log('Found:', externalResults.resolvedEntities.length, 'entities');
    console.log('(Restricted entities may be invisible or redacted)');

    // Policy explain
    console.log('\n=== Policy explanation ===');
    const { evaluatePolicy } = await import('../../src/policy/policy-engine.js');
    const decision = evaluatePolicy(external, 'read', 'cluster://canonical/*', DEFAULT_POLICIES);
    console.log('External read canonical:', decision.decision, '→', decision.reason);

    // Cleanup
    rmSync(dataDir, { recursive: true, force: true });
    console.log('\nDone.');
}

main().catch(console.error);
