import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ClusterSDK } from '../src/sdk/cluster-sdk.js';
import { handleTool, TOOLS } from '../src/mcp/server.js';
import { DEFAULT_POLICIES, DEFAULT_TRUST_ZONES, DEFAULT_VISIBILITY_RULES } from '../src/policy/default-policies.js';
import { PolicyDeniedError } from '../src/kernel/policy-enforced-kernel.js';
import type { Principal, Capability, Policy } from '../src/types/policy.js';

// ─── Fixtures ──────────────────────────────────────────────────────────────

const CLI = `node ${join(process.cwd(), 'dist', 'cli.js')}`;
const TEST_DIR = mkdtempSync(join(tmpdir(), 'policy-surface-'));

const admin: Principal = { id: 'admin-1', name: 'Admin', roles: ['cluster-admin'], trustZone: 'internal' };
const observer: Principal = { id: 'obs-1', name: 'Observer', roles: ['observer'], trustZone: 'ai-facing' };
const proposer: Principal = { id: 'agent-1', name: 'Agent', roles: ['proposer'], trustZone: 'ai-facing' };
const nobody: Principal = { id: 'nobody-1', name: 'Nobody', roles: [], trustZone: 'external' };

function makeSDK(): ClusterSDK {
    const dir = mkdtempSync(join(tmpdir(), 'policy-sdk-'));
    // Initialize cluster directory
    execSync(`${CLI} init`, { cwd: dir, encoding: 'utf-8' });
    return new ClusterSDK({
        clusterDir: join(dir, '.db-cluster'),
        policies: DEFAULT_POLICIES,
        trustZones: DEFAULT_TRUST_ZONES,
        visibilityRules: DEFAULT_VISIBILITY_RULES,
    });
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('Wave 4 — Policy Surface (CLI/SDK/MCP)', () => {

    // ─── Proof 1: CLI policy explain returns allow/deny reason ────────

    describe('Proof 1: CLI policy explain returns allow/deny reason', () => {
        it('CLI explain shows ALLOW for admin', () => {
            const out = execSync(
                `${CLI} policy explain --principal admin-1 --roles cluster-admin --capability read_owner_truth --trust-zone internal`,
                { cwd: TEST_DIR, encoding: 'utf-8' },
            );
            expect(out).toContain('ALLOW');
            expect(out).toContain('Cluster admin');
        });

        it('CLI explain shows DENY for unknown principal', () => {
            const out = execSync(
                `${CLI} policy explain --principal nobody --capability commit_command --trust-zone external`,
                { cwd: TEST_DIR, encoding: 'utf-8' },
            );
            expect(out).toContain('DENY');
            expect(out).toContain('No matching policy');
        });

        it('CLI explain shows deny reason for proposer commit', () => {
            const out = execSync(
                `${CLI} policy explain --principal agent-1 --roles proposer --capability commit_command --trust-zone ai-facing`,
                { cwd: TEST_DIR, encoding: 'utf-8' },
            );
            expect(out).toContain('DENY');
            expect(out).toContain('cannot');
        });
    });

    // ─── Proof 2: SDK policy explain matches policy engine decision ──

    describe('Proof 2: SDK policy explain matches policy engine decision', () => {
        it('SDK explain for admin returns allow', () => {
            const sdk = makeSDK();
            const result = sdk.policyExplain({
                principal: admin,
                capability: 'read_owner_truth',
            });
            expect(result.decision).toBe('allow');
            expect(result.matchedPolicyId).toBe('admin-full-access');
            expect(result.reason).toContain('unrestricted');
        });

        it('SDK explain for proposer commit returns deny', () => {
            const sdk = makeSDK();
            const result = sdk.policyExplain({
                principal: proposer,
                capability: 'commit_command',
            });
            expect(result.decision).toBe('deny');
            expect(result.matchedPolicyId).toBe('proposer-deny-commit');
        });

        it('SDK explain for observer read returns allow', () => {
            const sdk = makeSDK();
            const result = sdk.policyExplain({
                principal: observer,
                capability: 'read_owner_truth',
            });
            expect(result.decision).toBe('allow');
            expect(result.matchedPolicyId).toBe('observer-read');
        });
    });

    // ─── Proof 3: MCP policy explain includes structured denial, no object data

    describe('Proof 3: MCP policy explain includes structured denial but no restricted object data', () => {
        it('MCP explain returns decision structure without object data', async () => {
            const sdk = makeSDK();
            const result = await handleTool('cluster_policy_explain', {
                principal: nobody,
                capability: 'read_owner_truth',
                resourceUri: 'cluster://canonical/secret-entity-123',
                ownerStore: 'canonical',
            }, sdk);

            const r = result as any;
            expect(r.decision).toBe('deny');
            expect(r.reason).toBeTruthy();
            expect(r.matchedPolicyId).toBeTruthy();
            expect(r._meta.note).toContain('no action was executed');
            // Must not contain any object content
            expect(r).not.toHaveProperty('object');
            expect(r).not.toHaveProperty('entity');
            expect(r).not.toHaveProperty('content');
            expect(r).not.toHaveProperty('attributes');
        });

        it('MCP explain surfaces visibility when denied', async () => {
            const sdk = makeSDK();
            const result = await handleTool('cluster_policy_explain', {
                principal: nobody,
                capability: 'read_owner_truth',
                resourceUri: 'cluster://artifact/restricted-1',
                ownerStore: 'artifact',
            }, sdk) as any;

            expect(result.decision).toBe('deny');
            expect(result.visibility).toBeTruthy();
            // Visibility tells whether to say "not found" or "denied"
            expect(typeof result.visibility.existenceVisible).toBe('boolean');
            expect(typeof result.visibility.emitPlaceholder).toBe('boolean');
        });
    });

    // ─── Proof 4: policy test evaluates scenario without executing ────

    describe('Proof 4: policy test can evaluate a scenario without executing the action', () => {
        it('SDK policyTest returns per-action decisions', () => {
            const sdk = makeSDK();
            const result = sdk.policyTest({
                scenario: 'AI agent full access probe',
                principal: proposer,
                actions: [
                    { capability: 'read_owner_truth' },
                    { capability: 'propose_mutation' },
                    { capability: 'commit_command' },
                    { capability: 'approve_command' },
                    { capability: 'read_receipts' },
                ],
            });

            expect(result.scenario).toBe('AI agent full access probe');
            expect(result.principalId).toBe('agent-1');
            expect(result.results).toHaveLength(5);
            expect(result.results[0].decision).toBe('allow'); // read
            expect(result.results[1].decision).toBe('allow'); // propose
            expect(result.results[2].decision).toBe('deny');  // commit
            expect(result.results[3].decision).toBe('deny');  // approve
            expect(result.summary).toContain('allowed');
            expect(result.summary).toContain('denied');
        });

        it('MCP policy_test returns structured results', async () => {
            const sdk = makeSDK();
            const result = await handleTool('cluster_policy_test', {
                scenario: 'Observer audit check',
                principal: observer,
                actions: [
                    { capability: 'discover_existence' },
                    { capability: 'read_owner_truth' },
                    { capability: 'commit_command' },
                ],
            }, sdk) as any;

            expect(result.scenario).toBe('Observer audit check');
            expect(result.results).toHaveLength(3);
            expect(result._meta.note).toContain('no actions were executed');
        });

        it('CLI policy test shows per-capability results', () => {
            const out = execSync(
                `${CLI} policy test --principal agent-1 --roles proposer --capabilities read_owner_truth,propose_mutation,commit_command --trust-zone ai-facing`,
                { cwd: TEST_DIR, encoding: 'utf-8' },
            );
            expect(out).toContain('read_owner_truth');
            expect(out).toContain('propose_mutation');
            expect(out).toContain('commit_command');
            expect(out).toContain('ALLOW');
            expect(out).toContain('DENY');
            expect(out).toContain('Summary:');
        });
    });

    // ─── Proof 5: denied responses surface policy reason safely ──────

    describe('Proof 5: denied retrieve/trace/why responses surface policy reason safely', () => {
        it('SDK explain for denied trace shows reason without graph data', () => {
            const sdk = makeSDK();
            const result = sdk.policyExplain({
                principal: nobody,
                capability: 'trace_provenance',
                resourceUri: 'cluster://canonical/entity-1',
            });
            expect(result.decision).toBe('deny');
            expect(result.reason).toBeTruthy();
            expect(result.explanation).toContain('DENY');
            expect(result.explanation).toContain('trace_provenance');
            // No graph/node/edge data leaked
            expect(result).not.toHaveProperty('nodes');
            expect(result).not.toHaveProperty('edges');
        });

        it('SDK explain for denied retrieve shows reason without bundle data', () => {
            const sdk = makeSDK();
            const result = sdk.policyExplain({
                principal: nobody,
                capability: 'read_derivative',
                ownerStore: 'index',
            });
            expect(result.decision).toBe('deny');
            expect(result.explanation).toContain('DENY');
            // No bundle data
            expect(result).not.toHaveProperty('resolvedEntities');
            expect(result).not.toHaveProperty('indexRecords');
        });
    });

    // ─── Proof 6: visibility rule controls denial message ────────────

    describe('Proof 6: visibility rule controls whether denial says "not found" or "denied"', () => {
        it('restricted artifact: existence hidden, placeholder emitted', () => {
            const sdk = makeSDK();
            const result = sdk.policyExplain({
                principal: nobody,
                capability: 'read_owner_truth',
                resourceUri: 'cluster://artifact/restricted-doc',
                ownerStore: 'artifact',
            });
            expect(result.decision).toBe('deny');
            expect(result.visibility).toBeTruthy();
            // DEFAULT_VISIBILITY_RULES hides restricted artifacts with placeholder
            expect(result.visibility!.existenceVisible).toBe(false);
            expect(result.visibility!.emitPlaceholder).toBe(true);
        });

        it('non-restricted resource: no special visibility info', () => {
            const sdk = makeSDK();
            const result = sdk.policyExplain({
                principal: nobody,
                capability: 'read_owner_truth',
                resourceUri: 'cluster://ledger/event-1',
                ownerStore: 'ledger',
            });
            expect(result.decision).toBe('deny');
            // visibility is present because resourceUri is set and denied
            expect(result.visibility).toBeTruthy();
            // Ledger not explicitly in visibility rules — defaults to hidden, no placeholder
            expect(result.visibility!.existenceVisible).toBe(false);
            expect(result.visibility!.emitPlaceholder).toBe(false);
        });
    });

    // ─── Proof 7: policy surface does not expose raw policies without admin ─

    describe('Proof 7: policy surface does not expose raw policies if caller lacks admin-level access', () => {
        it('MCP explain does not include raw policy objects', async () => {
            const sdk = makeSDK();
            const result = await handleTool('cluster_policy_explain', {
                principal: nobody,
                capability: 'read_owner_truth',
            }, sdk) as any;

            // Must not expose raw policy array or full policy objects
            expect(result).not.toHaveProperty('policies');
            expect(result).not.toHaveProperty('allPolicies');
            expect(result).not.toHaveProperty('policySet');
            // Only the matched policy ID and name — not the full match conditions
            expect(result.matchedPolicyId).toBeTruthy();
            expect(result.matchedPolicyName).toBeTruthy();
            expect(result).not.toHaveProperty('matchConditions');
            expect(result).not.toHaveProperty('match');
        });

        it('MCP test does not include raw policy objects', async () => {
            const sdk = makeSDK();
            const result = await handleTool('cluster_policy_test', {
                scenario: 'probe',
                principal: nobody,
                actions: [{ capability: 'read_owner_truth' }],
            }, sdk) as any;

            expect(result).not.toHaveProperty('policies');
            // Each result only shows decision + reason + policy ID, not full policy
            for (const r of result.results) {
                expect(r).not.toHaveProperty('match');
                expect(r).not.toHaveProperty('policy');
            }
        });

        it('TOOLS definitions for policy tools are read-only', () => {
            const explain = TOOLS.find((t) => t.name === 'cluster_policy_explain');
            const test = TOOLS.find((t) => t.name === 'cluster_policy_test');
            expect(explain).toBeTruthy();
            expect(test).toBeTruthy();
            expect(explain!.annotations.readOnly).toBe(true);
            expect(explain!.annotations.writesCluster).toBe(false);
            expect(test!.annotations.readOnly).toBe(true);
            expect(test!.annotations.writesCluster).toBe(false);
        });
    });

    // ─── Proof 8: SURFACE-002 SDK end-to-end policy wiring ──────────
    //
    // TESTS-R002: re-audit found that the SURFACE-002 SDK opt-in policy wrap
    // had ZERO end-to-end coverage. The pre-existing proofs only exercise
    // sdk.policyExplain() / sdk.policyTest() (dry-run surfaces). If the SDK
    // regressed to ignoring `policies` and silently falling back to the raw
    // ClusterKernel, no test caught it. These tests construct the SDK with
    // policies, then exercise actual read/write surfaces and assert the policy
    // engine fires (filters, denies, or allows as expected).

    describe('Proof 8: SDK end-to-end policy wiring (SURFACE-002)', () => {
        // Restrictive policies for these tests — explicit per-test to avoid
        // depending on DEFAULT_POLICIES drift. The restricted principal can
        // discover_existence + read_derivative (so findSources fires at all)
        // but is denied read_owner_truth (so per-entity policy filtering
        // strips the actual entity payload out of the result).
        const restrictedReaderPolicies: Policy[] = [
            {
                id: 'allow-discover',
                name: 'Allow discovery',
                priority: 20,
                match: { principals: ['restricted-reader'], capabilities: ['discover_existence', 'read_derivative'] },
                decision: 'allow',
                reason: 'Restricted reader can discover.',
            },
            {
                id: 'deny-owner-truth',
                name: 'Deny owner-truth',
                priority: 10,
                match: { principals: ['restricted-reader'], capabilities: ['read_owner_truth'] },
                decision: 'deny',
                reason: 'Restricted reader cannot read owner truth.',
            },
        ];

        const restricted: Principal = {
            id: 'restricted-1',
            name: 'Restricted',
            roles: ['restricted-reader'],
            trustZone: 'ai-facing',
        };

        const proposerOnly: Principal = {
            id: 'proposer-only-1',
            name: 'Proposer Only',
            roles: ['proposer'],
            trustZone: 'ai-facing',
        };

        it('restricted-principal SDK filters reads (findSources returns empty resolvedEntities)', async () => {
            // SETUP: build a cluster with admin-trusted principal so we can
            // seed entities, then connect a RESTRICTED SDK to the same dir.
            const dir = mkdtempSync(join(tmpdir(), 'policy-sdk-e2e-1-'));
            execSync(`${CLI} init`, { cwd: dir, encoding: 'utf-8' });
            const clusterDir = join(dir, '.db-cluster');

            // Admin SDK seeds an entity (no policies, so it's the raw kernel path).
            const adminSdk = new ClusterSDK({ clusterDir });
            const proposal = await adminSdk.proposeMutation({
                verb: 'create_entity',
                targetStore: 'canonical',
                payload: { kind: 'document', name: 'Restricted Doc', attributes: { secret: 'top-secret' } },
                proposedBy: 'setup',
            });
            await adminSdk.validateMutation(proposal.id);
            await adminSdk.approveMutation(proposal.id, 'approver');
            await adminSdk.commitMutation(proposal.id, 'committer');

            // Restricted SDK with discover-but-no-owner-truth policy.
            const restrictedSdk = new ClusterSDK({
                clusterDir,
                policies: restrictedReaderPolicies,
                trustZones: DEFAULT_TRUST_ZONES,
                principal: restricted,
            });
            expect(restrictedSdk.policyEnforced).toBe(true);

            // findSources MUST go through the policy layer. The entity exists
            // in canonical, but read_owner_truth is denied, so resolvedEntities
            // and indexRecords (canonical-backed) MUST be filtered out.
            const result = await restrictedSdk.findSources('Restricted');
            expect(result.resolvedEntities).toHaveLength(0);
            // Index records backed by canonical sources also filtered (KERNEL-003).
            for (const record of result.indexRecords) {
                expect(record.sourceStore).not.toBe('canonical');
            }
        });

        it('proposer-only principal SDK can propose but cannot commit (throws PolicyDeniedError)', async () => {
            const dir = mkdtempSync(join(tmpdir(), 'policy-sdk-e2e-2-'));
            execSync(`${CLI} init`, { cwd: dir, encoding: 'utf-8' });
            const clusterDir = join(dir, '.db-cluster');

            // Proposer-only policies: can propose + validate, NOT approve + commit.
            const proposerOnlyPolicies: Policy[] = [
                {
                    id: 'proposer-read-write',
                    name: 'Proposer Read+Propose',
                    priority: 20,
                    match: {
                        principals: ['proposer'],
                        capabilities: ['discover_existence', 'read_owner_truth', 'read_derivative', 'propose_mutation', 'validate_command', 'read_command'],
                    },
                    decision: 'allow',
                    reason: 'Proposer.',
                },
                {
                    id: 'proposer-deny-commit',
                    name: 'Proposer Deny Commit',
                    priority: 15,
                    match: {
                        principals: ['proposer'],
                        capabilities: ['commit_command', 'approve_command'],
                    },
                    decision: 'deny',
                    reason: 'Proposers cannot commit or approve.',
                },
            ];

            const proposerSdk = new ClusterSDK({
                clusterDir,
                policies: proposerOnlyPolicies,
                trustZones: DEFAULT_TRUST_ZONES,
                principal: proposerOnly,
            });
            expect(proposerSdk.policyEnforced).toBe(true);

            // Propose succeeds (proposer allowed).
            const cmd = await proposerSdk.proposeMutation({
                verb: 'create_entity',
                targetStore: 'canonical',
                payload: { kind: 'document', name: 'ProposerDoc', attributes: {} },
                proposedBy: 'proposer-only-1',
            });
            expect(cmd.status).toBe('proposed');

            // Validate succeeds (proposer allowed).
            await proposerSdk.validateMutation(cmd.id);

            // Approve MUST throw — proposer is denied approve_command.
            await expect(proposerSdk.approveMutation(cmd.id, 'proposer-only-1')).rejects.toThrow(PolicyDeniedError);

            // Commit also throws — proposer is denied commit_command. Note the
            // SDK no longer auto-walks (KERNEL-R002 fix), so even calling
            // commitMutation without an explicit approve hits the policy check
            // for commit_command and rejects there.
            await expect(proposerSdk.commitMutation(cmd.id, 'proposer-only-1')).rejects.toThrow(PolicyDeniedError);
        });

        it('SDK without policies uses raw kernel (commitMutation succeeds with no policy gating)', async () => {
            const dir = mkdtempSync(join(tmpdir(), 'policy-sdk-e2e-3-'));
            execSync(`${CLI} init`, { cwd: dir, encoding: 'utf-8' });
            const clusterDir = join(dir, '.db-cluster');

            // No policies, no trustZones, no visibilityRules → raw kernel path.
            const rawSdk = new ClusterSDK({ clusterDir });
            expect(rawSdk.policyEnforced).toBe(false);

            // Propose + validate + approve + commit succeeds end-to-end with
            // no policy enforcement. (Validates that the no-policy path is
            // genuinely raw, not silently wrapping.)
            const cmd = await rawSdk.proposeMutation({
                verb: 'create_entity',
                targetStore: 'canonical',
                payload: { kind: 'document', name: 'RawDoc', attributes: {} },
                proposedBy: 'raw-user',
            });
            await rawSdk.validateMutation(cmd.id);
            await rawSdk.approveMutation(cmd.id, 'raw-approver');
            const result = await rawSdk.commitMutation(cmd.id, 'raw-committer');
            expect(result.command.status).toBe('committed');
            expect(result.receipt.commandId).toBe(cmd.id);
        });
    });
});
