/**
 * SDK Example: Policy enforcement and redaction.
 *
 * Demonstrates: SDK with policies, trust zones, redaction, policy explain.
 *
 * When `policies` is set on the SDK constructor, the SDK wraps its kernel in
 * a PolicyEnforcedKernel so reads/writes are filtered + redacted at runtime
 * according to the configured principal.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClusterSDK } from 'db-cluster/sdk';
import {
    DEFAULT_POLICIES,
    DEFAULT_TRUST_ZONES,
    DEFAULT_VISIBILITY_RULES,
    INTERNAL_TRUSTED_PRINCIPAL,
} from 'db-cluster/policy';
import type { Principal } from 'db-cluster/policy';

async function main() {
    const dataDir = mkdtempSync(join(tmpdir(), 'db-cluster-policy-'));

    // Seed entities through an admin SDK (INTERNAL_TRUSTED_PRINCIPAL) so the
    // command lifecycle still runs but policy admits all writes.
    const adminSdk = new ClusterSDK({
        clusterDir: dataDir,
        policies: DEFAULT_POLICIES,
        trustZones: DEFAULT_TRUST_ZONES,
        visibilityRules: DEFAULT_VISIBILITY_RULES,
        principal: INTERNAL_TRUSTED_PRINCIPAL,
    });

    async function createRecord(name: string, attrs: Record<string, unknown>) {
        const cmd = await adminSdk.proposeMutation({
            verb: 'create_entity',
            targetStore: 'canonical',
            payload: { kind: 'record', name, attributes: attrs },
            proposedBy: 'admin-seed',
        });
        await adminSdk.validateMutation(cmd.id);
        await adminSdk.approveMutation(cmd.id, 'admin-approver', 'auto-approved in admin seed');
        await adminSdk.commitMutation(cmd.id, 'admin-seed');
    }

    await createRecord('Public project overview', {
        visibility: 'public',
        content: 'This project uses db-cluster.',
    });
    await createRecord('Internal credentials store', {
        visibility: 'restricted',
        apiToken: 'example-token-not-a-real-secret',
        dbPassword: 'example-password',
    });

    // Internal principal — full access
    const internal: Principal = {
        id: 'admin',
        name: 'Admin',
        roles: ['admin'],
        trustZone: 'internal',
    };

    // External principal — restricted
    const external: Principal = {
        id: 'public-api',
        name: 'Public API',
        roles: ['external-reader'],
        trustZone: 'external',
    };

    // SDK with full-access principal
    const internalSdk = new ClusterSDK({
        clusterDir: dataDir,
        policies: DEFAULT_POLICIES,
        trustZones: DEFAULT_TRUST_ZONES,
        visibilityRules: DEFAULT_VISIBILITY_RULES,
        principal: internal,
    });

    // SDK with restricted principal
    const externalSdk = new ClusterSDK({
        clusterDir: dataDir,
        policies: DEFAULT_POLICIES,
        trustZones: DEFAULT_TRUST_ZONES,
        visibilityRules: DEFAULT_VISIBILITY_RULES,
        principal: external,
    });

    console.log('=== Internal principal (full access) ===');
    const internalResults = await internalSdk.findSources('credentials');
    console.log('Found:', internalResults.resolvedEntities.length, 'entities');

    console.log('\n=== External principal (restricted) ===');
    const externalResults = await externalSdk.findSources('credentials');
    console.log('Found:', externalResults.resolvedEntities.length, 'entities');
    console.log('(Restricted entities may be invisible or redacted)');

    // Policy explain — dry-run check, never returns restricted data.
    console.log('\n=== Policy explanation ===');
    const decision = externalSdk.policyExplain({
        principal: external,
        capability: 'read_owner_truth',
        resourceUri: 'cluster://canonical/*',
        ownerStore: 'canonical',
    });
    console.log('External read canonical:', decision.decision, '→', decision.reason);

    // Cleanup
    rmSync(dataDir, { recursive: true, force: true });
    console.log('\nDone.');
}

main().catch(console.error);
