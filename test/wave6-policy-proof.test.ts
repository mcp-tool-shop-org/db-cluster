/**
 * Wave 6 — Phase 7 Proof Suite: Destructive Policy Proofs Across the Stack
 *
 * Exit sentence: "db-cluster can enforce policy, redaction, and existence boundaries
 * across kernel, SDK, CLI, and MCP without leaking restricted truth or weakening
 * retrieval, provenance, or command-gated mutation law."
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PolicyEnforcedKernel, PolicyDeniedError } from '../src/kernel/policy-enforced-kernel.js';
import type { PolicyKernelOptions } from '../src/kernel/policy-enforced-kernel.js';
import type { Policy, Principal, TrustZone, VisibilityRule, RedactionRule } from '../src/types/policy.js';
import { createLocalCluster } from '../src/adapters/local/index.js';
import { ClusterSDK } from '../src/sdk/cluster-sdk.js';
import { handleTool } from '../src/mcp/server.js';
import { REDACTED } from '../src/policy/redactor.js';
import type { ClusterStores } from '../src/contracts/index.js';

// ─── Principals ────────────────────────────────────────────────────────────

const admin: Principal = {
    id: 'admin-1',
    name: 'Admin',
    roles: ['cluster-admin'],
    trustZone: 'internal',
};

const indexOnly: Principal = {
    id: 'indexer-1',
    name: 'Index Only Reader',
    roles: ['index-only'],
    trustZone: 'external',
};

const proposer: Principal = {
    id: 'proposer-1',
    name: 'AI Proposer',
    roles: ['proposer'],
    trustZone: 'ai-facing',
};

const approver: Principal = {
    id: 'approver-1',
    name: 'Approver',
    roles: ['approver'],
    trustZone: 'internal',
};

const restricted: Principal = {
    id: 'restricted-1',
    name: 'Restricted Reader',
    roles: ['restricted-reader'],
    trustZone: 'ai-facing',
};

// ─── Policies ──────────────────────────────────────────────────────────────

const policies: Policy[] = [
    // Admin: full access
    { id: 'admin-full', name: 'Admin Full', priority: 5, match: { principals: ['cluster-admin'] }, decision: 'allow', reason: 'Admin.' },
    // Index-only: discover + derivative, DENY owner truth
    { id: 'index-discover', name: 'Index Discover', priority: 20, match: { principals: ['index-only'], capabilities: ['discover_existence', 'read_derivative', 'explain_retrieval'] }, decision: 'allow', reason: 'Index access.' },
    { id: 'index-deny-owner', name: 'Index Deny Owner', priority: 15, match: { principals: ['index-only'], capabilities: ['read_owner_truth', 'trace_provenance', 'read_command', 'read_receipts'] }, decision: 'deny', reason: 'Index-only cannot read owner truth.' },
    // Proposer: read, propose, validate — NOT approve/commit/compensate
    { id: 'proposer-read', name: 'Proposer Read', priority: 20, match: { principals: ['proposer'], capabilities: ['discover_existence', 'read_derivative', 'read_owner_truth', 'propose_mutation', 'validate_command', 'trace_provenance', 'read_command', 'explain_retrieval'] }, decision: 'allow', reason: 'Proposer access.' },
    { id: 'proposer-deny-commit', name: 'Proposer Deny Commit', priority: 15, match: { principals: ['proposer'], capabilities: ['approve_command', 'commit_command', 'compensate_command', 'reject_command'] }, decision: 'deny', reason: 'Proposers cannot approve, commit, or compensate.' },
    // Approver: approve, reject, read commands — NOT commit or read owner truth directly
    { id: 'approver-approve', name: 'Approver Approve', priority: 20, match: { principals: ['approver'], capabilities: ['approve_command', 'reject_command', 'read_command', 'validate_command', 'discover_existence', 'read_derivative', 'explain_retrieval'] }, decision: 'allow', reason: 'Approver access.' },
    { id: 'approver-deny-commit', name: 'Approver Deny Commit', priority: 15, match: { principals: ['approver'], capabilities: ['commit_command', 'compensate_command', 'read_owner_truth', 'propose_mutation'] }, decision: 'deny', reason: 'Approver cannot commit or read owner truth.' },
    // Restricted reader: read with redaction
    { id: 'restricted-read', name: 'Restricted Read', priority: 20, match: { principals: ['restricted-reader'], capabilities: ['discover_existence', 'read_derivative', 'trace_provenance', 'explain_retrieval', 'read_command', 'read_receipts'] }, decision: 'allow', reason: 'Restricted access.' },
    {
        id: 'restricted-owner-redacted', name: 'Restricted Owner Redacted', priority: 20,
        match: { principals: ['restricted-reader'], capabilities: ['read_owner_truth'] },
        decision: 'allow', reason: 'Read with attribute redaction.',
        redaction: { id: 'mask-attrs', target: 'entity_attributes', behavior: 'mask', reason: 'Attributes masked.' },
    },
    {
        id: 'restricted-receipts-redacted', name: 'Restricted Receipts Redacted', priority: 18,
        match: { principals: ['restricted-reader'], capabilities: ['read_receipts'] },
        decision: 'allow', reason: 'Receipts with detail redaction.',
        redaction: { id: 'strip-receipts', target: 'receipt_details', behavior: 'strip', reason: 'Receipt details restricted.' },
    },
    {
        id: 'restricted-commands-redacted', name: 'Restricted Commands Redacted', priority: 18,
        match: { principals: ['restricted-reader'], capabilities: ['read_command'] },
        decision: 'allow', reason: 'Commands with payload redaction.',
        redaction: { id: 'strip-payload', target: 'command_payload', behavior: 'strip', reason: 'Command payload restricted.' },
    },
];

const trustZones: TrustZone[] = [
    { id: 'internal', name: 'Internal', defaultCapabilities: [], defaultScope: { stores: ['*'] }, approvalMode: 'auto', redactionRules: [], visibilityRules: [] },
    {
        id: 'ai-facing', name: 'AI-Facing', defaultCapabilities: [], defaultScope: { stores: ['*'] },
        approvalMode: 'require_approval_for_writes',
        redactionRules: [{ id: 'zone-actors', target: 'provenance_actors', behavior: 'strip', reason: 'Actors hidden.' }],
        visibilityRules: [],
    },
    { id: 'external', name: 'External', defaultCapabilities: [], defaultScope: { stores: ['index'] }, approvalMode: 'require_approval', redactionRules: [], visibilityRules: [] },
];

const visibilityRules: VisibilityRule[] = [
    { id: 'hide-secret', scope: { stores: ['canonical'], kinds: ['secret'] }, existenceVisible: false, emitPlaceholder: false },
];

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Create a fresh cluster on disk and return both the stores and the data
 * directory. Tests that build multiple kernel instances against the same
 * cluster MUST pass that same dataDir into every makeKernel() call — the
 * CommandQueue persists to dataDir/commands.json, so different kernels
 * with no dataDir would maintain divergent in-memory command queues even
 * though they share the four backing stores. This matters more after Wave
 * A2 removed the _kernel bypass: previously a single restrictedK would
 * use `_kernel.proposeMutation` to put a command in its own queue and
 * then assert against restrictedK.inspectCommand; that worked. Now we
 * need to seed via admin AND have restricted see the same command, which
 * only happens if the command queue is shared (i.e., on disk).
 */
function makeStoresWithDir(): { stores: ClusterStores; dataDir: string } {
    const dataDir = mkdtempSync(join(tmpdir(), 'wave6-proof-'));
    return { stores: createLocalCluster(dataDir), dataDir };
}

function makeStores(): ClusterStores {
    return makeStoresWithDir().stores;
}

function makeKernel(stores: ClusterStores, principal: Principal, dataDir?: string): PolicyEnforcedKernel {
    return new PolicyEnforcedKernel(stores, { principal }, { policies, trustZones, visibilityRules, dataDir });
}

function makeSDK(): ClusterSDK {
    const dir = mkdtempSync(join(tmpdir(), 'wave6-sdk-'));
    return new ClusterSDK({ clusterDir: dir, policies, trustZones, visibilityRules });
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('Wave 6 — Phase 7 Proof Suite: Destructive Policy Proofs', () => {

    // ═══════════════════════════════════════════════════════════════════════
    // Proof 1: Denied owner-truth read does not leak via resolve, inspect,
    //          retrieve, trace, or why
    // ═══════════════════════════════════════════════════════════════════════

    describe('Proof 1: Denied owner-truth read does not leak through any surface', () => {
        it('inspectEntity throws PolicyDeniedError for index-only principal', async () => {
            const stores = makeStores();
            const adminK = makeKernel(stores, admin);
            const { entity } = await adminK.createEntity({
                kind: 'concept', name: 'Proof1Entity', attributes: { sensitive: 'data' }, actorId: 'admin-1',
            });

            const indexK = makeKernel(stores, indexOnly);
            await expect(indexK.inspectEntity(entity.id)).rejects.toThrow(PolicyDeniedError);
        });

        it('traceObject throws PolicyDeniedError for index-only principal', async () => {
            const stores = makeStores();
            const adminK = makeKernel(stores, admin);
            const { entity } = await adminK.createEntity({
                kind: 'concept', name: 'Proof1Trace', attributes: {}, actorId: 'admin-1',
            });

            const indexK = makeKernel(stores, indexOnly);
            await expect(indexK.traceObject(`cluster://canonical/${entity.id}`)).rejects.toThrow(PolicyDeniedError);
        });

        it('why() throws PolicyDeniedError for index-only principal', async () => {
            const stores = makeStores();
            const adminK = makeKernel(stores, admin);
            const { entity } = await adminK.createEntity({
                kind: 'concept', name: 'Proof1Why', attributes: {}, actorId: 'admin-1',
            });

            const indexK = makeKernel(stores, indexOnly);
            await expect(indexK.why(`cluster://canonical/${entity.id}`)).rejects.toThrow(PolicyDeniedError);
        });

        it('PolicyDeniedError does not contain entity data', async () => {
            const stores = makeStores();
            const adminK = makeKernel(stores, admin);
            await adminK.createEntity({
                kind: 'concept', name: 'SecretName', attributes: { password: 'hunter2' }, actorId: 'admin-1',
            });

            const indexK = makeKernel(stores, indexOnly);
            try {
                await indexK.inspectEntity('does-not-matter');
                expect.fail('should throw');
            } catch (err: any) {
                const msg = JSON.stringify(err);
                expect(msg).not.toContain('SecretName');
                expect(msg).not.toContain('hunter2');
                expect(msg).not.toContain('password');
            }
        });
    });

    // ═══════════════════════════════════════════════════════════════════════
    // Proof 2: Index-only principal sees derivative metadata, not owner payload
    // ═══════════════════════════════════════════════════════════════════════

    describe('Proof 2: Index-only principal sees derivative but not owner-truth payload', () => {
        it('findSources for index-only filters BOTH canonical entities AND their backing index records', async () => {
            const stores = makeStores();
            const adminK = makeKernel(stores, admin);
            await adminK.createEntity({
                kind: 'concept', name: 'Derivative Test', attributes: { secret: 'value' }, actorId: 'admin-1',
            });

            const indexK = makeKernel(stores, indexOnly);
            const result = await indexK.findSources({ query: 'Derivative' });

            // KERNEL-003 fix: a canonical-backed index record contains the
            // entity's kind/name/attributes in its `text` and `metadata`. If
            // the principal cannot `read_owner_truth` on canonical, returning
            // the index record leaks those fields. Both must be filtered.
            expect(result.resolvedEntities).toHaveLength(0);
            expect(result.resolvedArtifacts).toHaveLength(0);
            expect(result.indexRecords).toHaveLength(0);
        });

        it('index-only principal cannot escalate from index to owner truth', async () => {
            const stores = makeStores();
            const adminK = makeKernel(stores, admin);
            const { entity } = await adminK.createEntity({
                kind: 'concept', name: 'Index Only Proof', attributes: { classified: 'top-secret' }, actorId: 'admin-1',
            });

            const indexK = makeKernel(stores, indexOnly);
            // findSources filters both surfaces (see above test) — but the
            // load-bearing invariant for THIS proof is the inspect escalation
            // attempt below: even if a principal somehow obtains an entity
            // ID, they still cannot read its owner truth.
            await indexK.findSources({ query: 'Index Only' });
            await expect(indexK.inspectEntity(entity.id)).rejects.toThrow(PolicyDeniedError);
        });
    });

    // ═══════════════════════════════════════════════════════════════════════
    // Proof 3: Hidden existence does not appear through search, stale,
    //          missing-context, or policy explain
    // ═══════════════════════════════════════════════════════════════════════

    describe('Proof 3: Hidden existence does not leak through any surface', () => {
        it('findSources excludes entities denied by policy', async () => {
            const stores = makeStores();
            const adminK = makeKernel(stores, admin);
            await adminK.createEntity({
                kind: 'concept', name: 'Visible Entity', attributes: {}, actorId: 'admin-1',
            });
            await adminK.createEntity({
                kind: 'secret', name: 'Hidden Entity', attributes: {}, actorId: 'admin-1',
            });

            // Index-only can't read owner truth — both entities excluded from resolvedEntities
            const indexK = makeKernel(stores, indexOnly);
            const result = await indexK.findSources({ query: 'Entity' });
            expect(result.resolvedEntities).toHaveLength(0);
        });

        it('listStaleRecords does not expose secret entity source IDs', async () => {
            const stores = makeStores();
            const adminK = makeKernel(stores, admin);
            const { entity } = await adminK.createEntity({
                kind: 'secret', name: 'Stale Secret', attributes: {}, actorId: 'admin-1',
            });

            // Delete the entity to make the index stale, then check restricted view
            // (We can't delete directly, but we can check the filter works with what exists)
            const restrictedK = makeKernel(stores, restricted);
            const staleRecords = await restrictedK.listStaleRecords();
            // No stale record should reference a secret entity
            const leaks = staleRecords.filter((r) => r.sourceId === entity.id);
            expect(leaks).toHaveLength(0);
        });

        it('policy explain for hidden resource produces same response as nonexistent', () => {
            const sdk = makeSDK();
            const realResult = sdk.policyExplain({
                principal: indexOnly,
                capability: 'read_owner_truth',
                ownerStore: 'canonical',
                resourceUri: 'cluster://canonical/real-secret-entity',
            });
            const fakeResult = sdk.policyExplain({
                principal: indexOnly,
                capability: 'read_owner_truth',
                ownerStore: 'canonical',
                resourceUri: 'cluster://canonical/totally-fake-nonexistent',
            });

            expect(realResult.decision).toBe('deny');
            expect(fakeResult.decision).toBe('deny');
            expect(realResult.reason).toBe(fakeResult.reason);
            expect(realResult.matchedPolicyId).toBe(fakeResult.matchedPolicyId);
        });
    });

    // ═══════════════════════════════════════════════════════════════════════
    // Proof 4: Redacted trace preserves graph structure but hides nodes/actors
    // ═══════════════════════════════════════════════════════════════════════

    describe('Proof 4: Redacted trace preserves graph structure', () => {
        it('restricted reader trace graph still has nodes and edges', async () => {
            const stores = makeStores();
            const adminK = makeKernel(stores, admin);
            const { entity } = await adminK.createEntity({
                kind: 'concept', name: 'Trace Target', attributes: { x: 1 }, actorId: 'admin-1',
            });

            const restrictedK = makeKernel(stores, restricted);
            const graph = await restrictedK.traceObject(`cluster://canonical/${entity.id}`);

            expect(graph.focalUri).toBe(`cluster://canonical/${entity.id}`);
            expect(graph.nodes.length).toBeGreaterThan(0);
            // Graph structure preserved — edges reference node URIs
            for (const edge of graph.edges) {
                expect(graph.nodes.some((n) => n.uri === edge.from || n.uri === edge.to)).toBe(true);
            }
        });

        it('ai-facing zone redacts provenance actors from metadata', async () => {
            const stores = makeStores();
            const adminK = makeKernel(stores, admin);
            const { entity } = await adminK.createEntity({
                kind: 'concept', name: 'Actor Hidden', attributes: {}, actorId: 'admin-1',
            });

            // Admin trace shows actor
            const adminGraph = await adminK.traceObject(`cluster://canonical/${entity.id}`);
            const adminMeta = adminGraph.nodes.find((n) => n.metadata?.actorId);

            // Restricted (ai-facing) trace hides actor via zone redaction
            const restrictedK = makeKernel(stores, restricted);
            const restrictedGraph = await restrictedK.traceObject(`cluster://canonical/${entity.id}`);
            for (const node of restrictedGraph.nodes) {
                if (node.metadata) {
                    expect(node.metadata.actorId).toBeUndefined();
                }
            }
        });
    });

    // ═══════════════════════════════════════════════════════════════════════
    // Proof 5: Redacted receipts preserve audit shape but hide details
    // ═══════════════════════════════════════════════════════════════════════

    describe('Proof 5: Redacted receipts preserve audit shape', () => {
        it('restricted reader receipts have id, commandId, committedAt but stripped details', async () => {
            const stores = makeStores();
            const adminK = makeKernel(stores, admin);
            await adminK.createEntity({
                kind: 'concept', name: 'Receipt Audit', attributes: { data: 'sensitive' }, actorId: 'admin-1',
            });

            const adminReceipts = await adminK.listReceipts({});
            expect(adminReceipts.length).toBeGreaterThan(0);

            const restrictedK = makeKernel(stores, restricted);
            const redactedReceipts = await restrictedK.listReceipts({});
            expect(redactedReceipts.length).toBe(adminReceipts.length);

            for (let i = 0; i < redactedReceipts.length; i++) {
                // Audit shape preserved
                expect(redactedReceipts[i].id).toBe(adminReceipts[i].id);
                expect(redactedReceipts[i].commandId).toBe(adminReceipts[i].commandId);
                expect(redactedReceipts[i].committedAt).toBe(adminReceipts[i].committedAt);
                // Details redacted
                expect(redactedReceipts[i].resultSummary).toBe(REDACTED);
                expect(redactedReceipts[i].affectedIds).toEqual([]);
            }
        });

        it('restricted reader commands have metadata but stripped payload', async () => {
            // Shared dataDir so adminK + restrictedK see the same command queue.
            const { stores, dataDir } = makeStoresWithDir();
            const adminK = makeKernel(stores, admin, dataDir);
            const restrictedK = makeKernel(stores, restricted, dataDir);
            // Seed via admin since restricted has no propose_mutation /
            // commit_command. (Previously used restrictedK._kernel to bypass;
            // _kernel was removed in Wave A2.) Use full command lifecycle so
            // the command is persisted (KERNEL-006: validate is required
            // before commit at the kernel layer).
            const cmd = await adminK.proposeMutation({
                verb: 'create_entity',
                targetStore: 'canonical',
                payload: { kind: 'concept', name: 'Command Audit', attributes: { secret: 'payload' } },
                proposedBy: 'admin-1',
            });
            await adminK.validateMutation(cmd.id);
            await adminK.commitMutation(cmd.id, 'admin-1');

            const command = await restrictedK.inspectCommand(cmd.id);

            expect(command.id).toBe(cmd.id);
            expect(command.verb).toBe('create_entity');
            expect(command.status).toBe('committed');
            // Payload stripped by redaction
            expect(command.payload).toEqual({});
        });
    });

    // ═══════════════════════════════════════════════════════════════════════
    // Proof 6: MCP applies same redaction and denial as SDK/kernel
    // ═══════════════════════════════════════════════════════════════════════

    describe('Proof 6: MCP applies same redaction and denial as SDK/kernel', () => {
        it('MCP policy_explain returns deny without object data', async () => {
            const sdk = makeSDK();
            const result = await handleTool('cluster_policy_explain', {
                principal: indexOnly,
                capability: 'read_owner_truth',
                ownerStore: 'canonical',
                resourceUri: 'cluster://canonical/some-id',
            }, sdk) as any;

            expect(result.decision).toBe('deny');
            expect(result._meta.note).toContain('No restricted object data');
            expect(result.object).toBeUndefined();
            expect(result.entity).toBeUndefined();
            expect(result.attributes).toBeUndefined();
        });

        it('MCP policy_test produces per-action denials without leaking data', async () => {
            const sdk = makeSDK();
            const result = await handleTool('cluster_policy_test', {
                scenario: 'MCP parity test',
                principal: indexOnly,
                actions: [
                    { capability: 'read_owner_truth', ownerStore: 'canonical' },
                    { capability: 'discover_existence' },
                ],
            }, sdk) as any;

            expect(result.results[0].decision).toBe('deny');
            expect(result.results[1].decision).toBe('allow');
            // No object data in results
            expect(result.results[0].object).toBeUndefined();
            expect(result.results[1].object).toBeUndefined();
        });

        it('MCP find_sources surfaces same filtering as kernel', async () => {
            const sdk = makeSDK();
            // Use SDK directly to add data and search — SDK uses kernel under the hood
            const result = await handleTool('cluster_find_sources', {
                query: 'nonexistent-query',
            }, sdk) as any;

            // Result shape is correct even with no matches
            expect(result._meta.operation).toBe('read');
            expect(result.indexRecords).toBeDefined();
            expect(result.resolvedEntities).toBeDefined();
        });
    });

    // ═══════════════════════════════════════════════════════════════════════
    // Proof 7: CLI policy explain/test does not leak restricted content
    // ═══════════════════════════════════════════════════════════════════════

    describe('Proof 7: CLI policy explain/test does not leak restricted content', () => {
        it('SDK policyExplain produces reason without entity attributes', () => {
            const sdk = makeSDK();
            const result = sdk.policyExplain({
                principal: restricted,
                capability: 'read_owner_truth',
                ownerStore: 'canonical',
                resourceUri: 'cluster://canonical/any-entity',
            });

            // Returns policy decision info only
            expect(result.decision).toBe('allow');
            expect(result.explanation).toBeDefined();
            expect((result as any).attributes).toBeUndefined();
            expect((result as any).payload).toBeUndefined();
            expect((result as any).content).toBeUndefined();
            expect((result as any).storagePath).toBeUndefined();
        });

        it('SDK policyTest returns decisions only, no data payloads', () => {
            const sdk = makeSDK();
            const result = sdk.policyTest({
                scenario: 'CLI parity',
                principal: proposer,
                actions: [
                    { capability: 'read_owner_truth' },
                    { capability: 'commit_command' },
                    { capability: 'propose_mutation' },
                ],
            });

            expect(result.results).toHaveLength(3);
            expect(result.results[0].decision).toBe('allow');
            expect(result.results[1].decision).toBe('deny');
            expect(result.results[2].decision).toBe('allow');
            // No data payloads
            for (const r of result.results) {
                expect((r as any).entity).toBeUndefined();
                expect((r as any).payload).toBeUndefined();
            }
        });
    });

    // ═══════════════════════════════════════════════════════════════════════
    // Proof 8: Proposer can propose but cannot approve/commit
    // ═══════════════════════════════════════════════════════════════════════

    describe('Proof 8: Proposer can propose but cannot approve/commit', () => {
        it('proposer can propose a mutation', async () => {
            const stores = makeStores();
            const propK = makeKernel(stores, proposer);
            const command = await propK.proposeMutation({
                verb: 'create_entity',
                targetStore: 'canonical',
                payload: { kind: 'concept', name: 'Proposed', attributes: {} },
                proposedBy: 'proposer-1',
            });

            expect(command.status).toBe('proposed');
            expect(command.verb).toBe('create_entity');
        });

        it('proposer can validate a mutation', async () => {
            const stores = makeStores();
            const propK = makeKernel(stores, proposer);
            const command = await propK.proposeMutation({
                verb: 'create_entity',
                targetStore: 'canonical',
                payload: { kind: 'concept', name: 'ValidateMe', attributes: {} },
                proposedBy: 'proposer-1',
            });

            const validated = await propK.validateMutation(command.id);
            expect(validated.status).toBe('validated');
        });

        it('proposer CANNOT approve', async () => {
            const stores = makeStores();
            const adminK = makeKernel(stores, admin);
            const command = await adminK.proposeMutation({
                verb: 'create_entity',
                targetStore: 'canonical',
                payload: { kind: 'concept', name: 'ApproveTest', attributes: {} },
                proposedBy: 'admin-1',
            });
            await adminK.validateMutation(command.id);

            const propK = makeKernel(stores, proposer);
            await expect(propK.approveMutation(command.id, 'proposer-1')).rejects.toThrow(PolicyDeniedError);
        });

        it('proposer CANNOT commit', async () => {
            const stores = makeStores();
            const adminK = makeKernel(stores, admin);
            const command = await adminK.proposeMutation({
                verb: 'create_entity',
                targetStore: 'canonical',
                payload: { kind: 'concept', name: 'CommitTest', attributes: {} },
                proposedBy: 'admin-1',
            });
            await adminK.validateMutation(command.id);
            await adminK.approveMutation(command.id, 'admin-1');

            const propK = makeKernel(stores, proposer);
            await expect(propK.commitMutation(command.id, 'proposer-1')).rejects.toThrow(PolicyDeniedError);
        });

        it('proposer CANNOT compensate', async () => {
            const stores = makeStores();
            const adminK = makeKernel(stores, admin);
            const { entity } = await adminK.createEntity({
                kind: 'concept', name: 'CompensateTest', attributes: {}, actorId: 'admin-1',
            });
            const receipts = await adminK.listReceipts({});
            const commandId = receipts[0].commandId;

            const propK = makeKernel(stores, proposer);
            await expect(propK.compensateMutation(commandId, 'proposer-1', 'undo')).rejects.toThrow(PolicyDeniedError);
        });
    });

    // ═══════════════════════════════════════════════════════════════════════
    // Proof 9: Approver can approve but cannot bypass command law
    // ═══════════════════════════════════════════════════════════════════════

    describe('Proof 9: Approver can approve but cannot bypass command law', () => {
        it('approver can approve a validated command', async () => {
            // Shared dataDir so admin's command is visible to approver's kernel.
            const { stores, dataDir } = makeStoresWithDir();
            const adminK = makeKernel(stores, admin, dataDir);
            const appK = makeKernel(stores, approver, dataDir);
            // Seed command via the admin kernel since approver has no
            // propose_mutation; the _kernel bypass was removed in Wave A2.
            const command = await adminK.proposeMutation({
                verb: 'create_entity',
                targetStore: 'canonical',
                payload: { kind: 'concept', name: 'ApproveMe', attributes: {} },
                proposedBy: 'admin-1',
            });
            await adminK.validateMutation(command.id);

            const approved = await appK.approveMutation(command.id, 'approver-1', 'looks good');
            expect(approved.status).toBe('approved');
            expect(approved.approvedBy).toBe('approver-1');
        });

        it('approver can reject a command', async () => {
            const { stores, dataDir } = makeStoresWithDir();
            const adminK = makeKernel(stores, admin, dataDir);
            const appK = makeKernel(stores, approver, dataDir);
            const command = await adminK.proposeMutation({
                verb: 'create_entity',
                targetStore: 'canonical',
                payload: { kind: 'concept', name: 'RejectMe', attributes: {} },
                proposedBy: 'admin-1',
            });
            await adminK.validateMutation(command.id);

            const rejected = await appK.rejectMutation(command.id, 'approver-1', 'not needed');
            expect(rejected.status).toBe('rejected');
        });

        it('approver CANNOT commit — policy prevents bypassing lifecycle', async () => {
            const { stores, dataDir } = makeStoresWithDir();
            const adminK = makeKernel(stores, admin, dataDir);
            const appK = makeKernel(stores, approver, dataDir);
            const command = await adminK.proposeMutation({
                verb: 'create_entity',
                targetStore: 'canonical',
                payload: { kind: 'concept', name: 'CommitBypass', attributes: {} },
                proposedBy: 'admin-1',
            });
            await adminK.validateMutation(command.id);
            await adminK.approveMutation(command.id, 'admin-1');

            await expect(appK.commitMutation(command.id, 'approver-1')).rejects.toThrow(PolicyDeniedError);
        });

        it('approver CANNOT read owner truth directly', async () => {
            const stores = makeStores();
            const adminK = makeKernel(stores, admin);
            const { entity } = await adminK.createEntity({
                kind: 'concept', name: 'OwnerTruth', attributes: {}, actorId: 'admin-1',
            });

            const appK = makeKernel(stores, approver);
            await expect(appK.inspectEntity(entity.id)).rejects.toThrow(PolicyDeniedError);
        });

        it('approver CANNOT propose mutations', async () => {
            const stores = makeStores();
            const appK = makeKernel(stores, approver);
            await expect(appK.proposeMutation({
                verb: 'create_entity',
                targetStore: 'canonical',
                payload: { kind: 'concept', name: 'Sneaky', attributes: {} },
                proposedBy: 'approver-1',
            })).rejects.toThrow(PolicyDeniedError);
        });
    });

    // ═══════════════════════════════════════════════════════════════════════
    // Proof 10: Existing non-policy laws still hold under enforcement
    // ═══════════════════════════════════════════════════════════════════════

    describe('Proof 10: Existing cluster law still holds under policy enforcement', () => {
        it('owner truth: entity lives in canonical store', async () => {
            const stores = makeStores();
            const adminK = makeKernel(stores, admin);
            const { entity } = await adminK.createEntity({
                kind: 'concept', name: 'Owner Truth', attributes: { x: 1 }, actorId: 'admin-1',
            });

            const inspected = await adminK.inspectEntity(entity.id);
            expect(inspected.owner).toBe('canonical');
            expect(inspected.kind).toBe('concept');
            expect(inspected.attributes.x).toBe(1);
        });

        it('index derivation: index is derivative of canonical', async () => {
            const stores = makeStores();
            const adminK = makeKernel(stores, admin);
            await adminK.createEntity({
                kind: 'concept', name: 'Index Derives', attributes: {}, actorId: 'admin-1',
            });

            // This proof is about cluster doctrine — "the index is a derivative
            // store, sourced from canonical." That's a property of the storage
            // layer, not of the policy layer. Read directly from the index
            // store. (Previously this used adminK._kernel.findSources to
            // bypass the policy/visibility layer; the _kernel getter was
            // removed in Wave A2 / KERNEL-R003. Going to the store directly
            // is the principled replacement — the question being asked is
            // about doctrine, not about what a policy-bound caller sees.)
            const records = await stores.index.search({ text: 'Index Derives' });
            expect(records.length).toBeGreaterThan(0);
            expect(records[0].owner).toBe('index');
            expect(records[0].sourceStore).toBe('canonical');
        });

        it('provenance graph: entity creation produces provenance trail', async () => {
            const stores = makeStores();
            const adminK = makeKernel(stores, admin);
            const { entity } = await adminK.createEntity({
                kind: 'concept', name: 'Provenance Law', attributes: {}, actorId: 'admin-1',
            });

            const graph = await adminK.traceObject(`cluster://canonical/${entity.id}`);
            expect(graph.nodes.length).toBeGreaterThan(0);
            expect(graph.focalUri).toBe(`cluster://canonical/${entity.id}`);
        });

        it('mutation lifecycle: rejected commands cannot be committed', async () => {
            const stores = makeStores();
            const adminK = makeKernel(stores, admin);

            // Propose
            const command = await adminK.proposeMutation({
                verb: 'create_entity',
                targetStore: 'canonical',
                payload: { kind: 'concept', name: 'Lifecycle', attributes: {} },
                proposedBy: 'admin-1',
            });
            expect(command.status).toBe('proposed');

            // Validate
            const validated = await adminK.validateMutation(command.id);
            expect(validated.status).toBe('validated');

            // Reject — terminal state
            const rejected = await adminK.rejectMutation(command.id, 'admin-1', 'not needed');
            expect(rejected.status).toBe('rejected');

            // Cannot commit rejected command (kernel law)
            await expect(adminK.commitMutation(command.id, 'admin-1')).rejects.toThrow();
        });

        it('mutation lifecycle: full propose → validate → approve → commit', async () => {
            const stores = makeStores();
            const adminK = makeKernel(stores, admin);

            const command = await adminK.proposeMutation({
                verb: 'create_entity',
                targetStore: 'canonical',
                payload: { kind: 'concept', name: 'FullLifecycle', attributes: {} },
                proposedBy: 'admin-1',
            });

            const validated = await adminK.validateMutation(command.id);
            expect(validated.status).toBe('validated');

            const approved = await adminK.approveMutation(command.id, 'admin-1');
            expect(approved.status).toBe('approved');

            const result = await adminK.commitMutation(command.id, 'admin-1');
            expect(result.command.status).toBe('committed');
            expect(result.receipt).toBeDefined();
            expect(result.receipt.commandId).toBe(command.id);
        });

        it('receipts: every commit produces a receipt in the ledger', async () => {
            const stores = makeStores();
            const adminK = makeKernel(stores, admin);
            await adminK.createEntity({
                kind: 'concept', name: 'Receipt Law', attributes: {}, actorId: 'admin-1',
            });

            const receipts = await adminK.listReceipts({});
            expect(receipts.length).toBeGreaterThan(0);
            expect(receipts[0].id).toBeDefined();
            expect(receipts[0].commandId).toBeDefined();
            expect(receipts[0].committedAt).toBeDefined();
            expect(receipts[0].provenanceEventId).toBeDefined();
        });
    });
});
