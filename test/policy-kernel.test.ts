import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PolicyEnforcedKernel, PolicyDeniedError } from '../src/kernel/policy-enforced-kernel.js';
import type { PolicyContext, PolicyKernelOptions } from '../src/kernel/policy-enforced-kernel.js';
import type { Policy, Principal, TrustZone, VisibilityRule } from '../src/types/policy.js';
import { createLocalCluster } from '../src/adapters/local/index.js';

// ─── Test principals ───────────────────────────────────────────────────────

const admin: Principal = {
    id: 'admin-1',
    name: 'Cluster Admin',
    roles: ['cluster-admin'],
    trustZone: 'internal',
};

const indexOnlyReader: Principal = {
    id: 'indexer-1',
    name: 'Index Reader',
    roles: ['index-reader'],
    trustZone: 'ai-facing',
};

const proposer: Principal = {
    id: 'agent-1',
    name: 'AI Agent',
    roles: ['proposer'],
    trustZone: 'ai-facing',
};

const approver: Principal = {
    id: 'approver-1',
    name: 'Approver',
    roles: ['approver'],
    trustZone: 'internal',
};

const receiptReader: Principal = {
    id: 'auditor-1',
    name: 'Auditor',
    roles: ['receipt-reader'],
    trustZone: 'internal',
};

const explainer: Principal = {
    id: 'explain-1',
    name: 'Explain Agent',
    roles: ['explainer'],
    trustZone: 'ai-facing',
};

const deniedPrincipal: Principal = {
    id: 'nobody-1',
    name: 'Nobody',
    roles: [],
    trustZone: 'external',
};

// ─── Test policies ─────────────────────────────────────────────────────────

const policies: Policy[] = [
    // Admin full access
    {
        id: 'admin-full',
        name: 'Admin Full',
        priority: 5,
        match: { principals: ['cluster-admin'] },
        decision: 'allow',
        reason: 'Admin gets everything.',
    },
    // Index reader: can discover existence + read derivative, but NOT read owner truth
    {
        id: 'index-reader-discover',
        name: 'Index Reader Discover',
        priority: 20,
        match: {
            principals: ['index-reader'],
            capabilities: ['discover_existence', 'read_derivative'],
        },
        decision: 'allow',
        reason: 'Index reader can discover and read derivatives.',
    },
    // Proposer: can propose + validate + discover + read derivative, but NOT commit/approve
    {
        id: 'proposer-read',
        name: 'Proposer Read',
        priority: 20,
        match: {
            principals: ['proposer'],
            capabilities: ['discover_existence', 'read_derivative', 'read_owner_truth', 'propose_mutation', 'validate_command', 'read_command', 'trace_provenance'],
        },
        decision: 'allow',
        reason: 'Proposer can read and propose.',
    },
    {
        id: 'proposer-deny-commit',
        name: 'Proposer Cannot Commit',
        priority: 15,
        match: {
            principals: ['proposer'],
            capabilities: ['commit_command', 'approve_command', 'compensate_command'],
        },
        decision: 'deny',
        reason: 'Proposers cannot commit, approve, or compensate.',
    },
    // Approver: can approve, reject, read commands, but NOT commit or mutate truth directly
    {
        id: 'approver-approve',
        name: 'Approver Approve',
        priority: 20,
        match: {
            principals: ['approver'],
            capabilities: ['approve_command', 'reject_command', 'read_command', 'validate_command', 'discover_existence', 'read_derivative'],
        },
        decision: 'allow',
        reason: 'Approver can approve/reject commands.',
    },
    {
        id: 'approver-deny-commit',
        name: 'Approver Cannot Commit',
        priority: 15,
        match: {
            principals: ['approver'],
            capabilities: ['commit_command', 'compensate_command', 'read_owner_truth'],
        },
        decision: 'deny',
        reason: 'Approver cannot commit or read owner truth directly.',
    },
    // Receipt reader: can read receipts and commands, nothing else
    {
        id: 'receipt-reader',
        name: 'Receipt Reader',
        priority: 20,
        match: {
            principals: ['receipt-reader'],
            capabilities: ['read_receipts', 'read_command'],
        },
        decision: 'allow',
        reason: 'Auditor can read receipts.',
    },
    // Explainer: can explain retrieval
    {
        id: 'explainer-explain',
        name: 'Explainer',
        priority: 20,
        match: {
            principals: ['explainer'],
            capabilities: ['explain_retrieval', 'discover_existence', 'read_derivative'],
        },
        decision: 'allow',
        reason: 'Can explain retrieval.',
    },
    // Visibility-scoped: redacted artifact content
    {
        id: 'redacted-artifact',
        name: 'Redacted Artifact Read',
        priority: 30,
        match: {
            principals: ['index-reader'],
            capabilities: ['read_owner_truth'],
            stores: ['artifact'],
        },
        decision: 'allow',
        reason: 'Can read artifact metadata but content should be redacted.',
        redaction: {
            id: 'strip-artifact-content',
            target: 'artifact_content',
            behavior: 'strip',
            reason: 'Artifact content not authorized.',
        },
    },
];

const trustZones: TrustZone[] = [
    {
        id: 'internal',
        name: 'Internal',
        defaultCapabilities: [],
        defaultScope: { stores: ['*'] },
        approvalMode: 'auto',
        redactionRules: [],
        visibilityRules: [],
    },
    {
        id: 'ai-facing',
        name: 'AI-Facing',
        defaultCapabilities: [],
        defaultScope: { stores: ['*'] },
        approvalMode: 'require_approval_for_writes',
        redactionRules: [],
        visibilityRules: [],
    },
    {
        id: 'external',
        name: 'External',
        defaultCapabilities: [],
        defaultScope: { stores: ['index'] },
        approvalMode: 'require_approval',
        redactionRules: [],
        visibilityRules: [],
    },
];

const visibilityRules: VisibilityRule[] = [
    {
        id: 'hide-canonical-from-external',
        scope: { stores: ['canonical'] },
        existenceVisible: false,
        emitPlaceholder: true,
    },
];

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Builds a PolicyEnforcedKernel for the given principal and ALSO returns an
 * admin-wrapped kernel against the SAME stores so tests can seed data with
 * full privileges and then exercise the restricted kernel for assertions.
 *
 * The previous helper returned only the restricted kernel; tests reached
 * into `restricted._kernel` to bypass policy when seeding. That getter was
 * removed in Wave A2 (KERNEL-R003 / SURFACE-R001), so the bypass primitive
 * is gone. The seeding path now goes through admin's wrapped kernel —
 * functionally equivalent because admin has full access.
 *
 * Both kernels share the SAME dataDir so they see the same persistent
 * CommandQueue. Without this the in-memory queues diverge and a command
 * proposed via admin would be invisible to the restricted kernel that
 * tries to inspectCommand / commitMutation against it.
 *
 * TESTS-B-004 (Wave A4): previously this helper returned only the
 * restricted kernel and attached the admin kernel as a hidden `__admin`
 * property via double-cast. That bypassed TypeScript's structural checks
 * entirely and was invisible to verb-parity allowlist enforcement. The
 * helper now returns a typed tuple so call sites destructure both kernels
 * by name. Eliminates the cast; makes the test reader's job obvious.
 */
interface PolicyKernelPair {
    restricted: PolicyEnforcedKernel;
    admin: PolicyEnforcedKernel;
}

function makePolicyKernel(principal: Principal): PolicyKernelPair {
    const dir = mkdtempSync(join(tmpdir(), 'policy-kernel-'));
    const stores = createLocalCluster(dir);
    const restricted = new PolicyEnforcedKernel(
        stores,
        { principal },
        { policies, trustZones, visibilityRules, dataDir: dir },
    );
    const adminKernel = new PolicyEnforcedKernel(
        stores,
        { principal: admin },
        { policies, trustZones, visibilityRules, dataDir: dir },
    );
    return { restricted, admin: adminKernel };
}

async function seedEntity(adminKernel: PolicyEnforcedKernel): Promise<string> {
    const result = await adminKernel.createEntity({
        kind: 'concept',
        name: 'Test Entity',
        attributes: { domain: 'test' },
        actorId: 'admin-1',
    });
    return result.entity.id;
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('Wave 3 — Kernel Policy Enforcement', () => {

    // ─── Proof 1: denied principal cannot inspect owner truth ─────────

    describe('Proof 1: denied principal cannot inspect owner truth', () => {
        it('denied principal gets PolicyDeniedError on inspectEntity', async () => {
            const { restricted: pk, admin: adminK } = makePolicyKernel(deniedPrincipal);
            const entityId = await seedEntity(adminK);

            await expect(pk.inspectEntity(entityId)).rejects.toThrow(PolicyDeniedError);
        });

        it('denied principal error includes decision details', async () => {
            const { restricted: pk, admin: adminK } = makePolicyKernel(deniedPrincipal);
            const entityId = await seedEntity(adminK);

            try {
                await pk.inspectEntity(entityId);
                expect.fail('should have thrown');
            } catch (err) {
                expect(err).toBeInstanceOf(PolicyDeniedError);
                const pde = err as PolicyDeniedError;
                expect(pde.decision.decision).toBe('deny');
                expect(pde.decision.capability).toBe('read_owner_truth');
                expect(pde.decision.principalId).toBe('nobody-1');
            }
        });
    });

    // ─── Proof 2: index-only can discover but not resolve owner truth ─

    describe('Proof 2: index-only principal can discover derivative but not resolve owner truth', () => {
        it('index reader can findSources (discover_existence) — but cannot see canonical-backed records', async () => {
            const { restricted: pk, admin: adminK } = makePolicyKernel(indexOnlyReader);
            // Seed via the admin-bound helper kernel (indexOnlyReader has no commit_command).
            await adminK.createEntity({
                kind: 'concept',
                name: 'Discoverable',
                attributes: {},
                actorId: 'admin-1',
            });

            const result = await pk.findSources({ query: 'Discoverable' });
            // KERNEL-003 fix: index records that mirror canonical truth are
            // filtered by the SAME policy that gates the underlying canonical
            // object. indexOnlyReader has `read_derivative` but is denied
            // `read_owner_truth` on canonical AND the canonical store is
            // hidden by visibility — so the canonical-backed index record is
            // also dropped. Previously the record leaked kind/name/attributes
            // through `text` and `metadata`.
            expect(result.resolvedEntities).toHaveLength(0);
            expect(result.indexRecords).toHaveLength(0);
        });

        it('index reader cannot inspectEntity', async () => {
            const { restricted: pk, admin: adminK } = makePolicyKernel(indexOnlyReader);
            const entityId = await seedEntity(adminK);
            await expect(pk.inspectEntity(entityId)).rejects.toThrow(PolicyDeniedError);
        });

        it('index reader can retrieveBundle (read_derivative)', async () => {
            const { restricted: pk, admin: adminK } = makePolicyKernel(indexOnlyReader);
            await adminK.createEntity({
                kind: 'concept',
                name: 'BundleTest',
                attributes: {},
                actorId: 'admin-1',
            });

            const bundle = await pk.retrieveBundle('BundleTest');
            expect(bundle).toBeTruthy();
        });
    });

    // ─── Proof 3: trace requires trace_provenance ────────────────────

    describe('Proof 3: trace requires trace_provenance', () => {
        it('principal without trace_provenance cannot traceObject', async () => {
            const { restricted: pk, admin: adminK } = makePolicyKernel(indexOnlyReader);
            const entityId = await seedEntity(adminK);

            await expect(pk.traceObject(`cluster://canonical/${entityId}`)).rejects.toThrow(PolicyDeniedError);
        });

        it('principal without trace_provenance cannot call why', async () => {
            const { restricted: pk, admin: adminK } = makePolicyKernel(indexOnlyReader);
            const entityId = await seedEntity(adminK);

            await expect(pk.why(`cluster://canonical/${entityId}`)).rejects.toThrow(PolicyDeniedError);
        });

        it('proposer (with trace_provenance) can trace', async () => {
            const { restricted: pk, admin: adminK } = makePolicyKernel(proposer);
            const entityId = await seedEntity(adminK);

            const graph = await pk.traceObject(`cluster://canonical/${entityId}`);
            expect(graph.nodes.length).toBeGreaterThan(0);
        });
    });

    // ─── Proof 4: proposer can propose but cannot commit ─────────────

    describe('Proof 4: proposer can propose but cannot commit', () => {
        it('proposer can propose a mutation', async () => {
            const { restricted: pk, admin: adminK } = makePolicyKernel(proposer);
            const cmd = await pk.proposeMutation({
                verb: 'create_entity',
                targetStore: 'canonical',
                payload: { kind: 'concept', name: 'Proposed', attributes: {} },
                proposedBy: 'agent-1',
            });
            expect(cmd.status).toBe('proposed');
        });

        it('proposer cannot commit', async () => {
            const { restricted: pk, admin: adminK } = makePolicyKernel(proposer);
            const cmd = await pk.proposeMutation({
                verb: 'create_entity',
                targetStore: 'canonical',
                payload: { kind: 'concept', name: 'Proposed', attributes: {} },
                proposedBy: 'agent-1',
            });

            await expect(pk.commitMutation(cmd.id, 'agent-1')).rejects.toThrow(PolicyDeniedError);
        });

        it('proposer cannot approve', async () => {
            const { restricted: pk, admin: adminK } = makePolicyKernel(proposer);
            const cmd = await pk.proposeMutation({
                verb: 'create_entity',
                targetStore: 'canonical',
                payload: { kind: 'concept', name: 'Proposed', attributes: {} },
                proposedBy: 'agent-1',
            });

            await expect(pk.approveMutation(cmd.id, 'agent-1')).rejects.toThrow(PolicyDeniedError);
        });
    });

    // ─── Proof 5: approver can approve but cannot mutate truth ───────

    describe('Proof 5: approver can approve but cannot mutate owner truth directly', () => {
        it('approver cannot commit', async () => {
            const { restricted: pk, admin: adminK } = makePolicyKernel(approver);
            // Seed a command via the admin-bound helper kernel since
            // approver has no propose_mutation. The _kernel bypass was
            // removed in Wave A2 (KERNEL-R003).
            const cmd = await adminK.proposeMutation({
                verb: 'create_entity',
                targetStore: 'canonical',
                payload: { kind: 'concept', name: 'ApproverTest', attributes: {} },
                proposedBy: 'someone',
            });

            await expect(pk.commitMutation(cmd.id, 'approver-1')).rejects.toThrow(PolicyDeniedError);
        });

        it('approver can approve a validated command', async () => {
            const { restricted: pk, admin: adminK } = makePolicyKernel(approver);
            const cmd = await adminK.proposeMutation({
                verb: 'create_entity',
                targetStore: 'canonical',
                payload: { kind: 'concept', name: 'Approvable', attributes: {} },
                proposedBy: 'someone',
            });
            await adminK.validateMutation(cmd.id);

            const approved = await pk.approveMutation(cmd.id, 'approver-1', 'looks good');
            expect(approved.status).toBe('approved');
        });

        it('approver cannot read owner truth directly', async () => {
            const { restricted: pk, admin: adminK } = makePolicyKernel(approver);
            const entityId = await seedEntity(adminK);

            await expect(pk.inspectEntity(entityId)).rejects.toThrow(PolicyDeniedError);
        });
    });

    // ─── Proof 6: commit requires commit_command ─────────────────────

    describe('Proof 6: commit requires commit_command', () => {
        it('receipt-reader cannot commit', async () => {
            const { restricted: pk, admin: adminK } = makePolicyKernel(receiptReader);
            await expect(pk.commitMutation('any-id', 'auditor-1')).rejects.toThrow(PolicyDeniedError);
        });

        it('admin (with commit_command) can commit', async () => {
            const { restricted: pk, admin: adminK } = makePolicyKernel(admin);
            const cmd = await pk.proposeMutation({
                verb: 'create_entity',
                targetStore: 'canonical',
                payload: { kind: 'concept', name: 'Committable', attributes: {} },
                proposedBy: 'admin-1',
            });

            await pk.validateMutation(cmd.id);
            const result = await pk.commitMutation(cmd.id, 'admin-1');
            expect(result.command.status).toBe('committed');
            expect(result.receipt).toBeTruthy();
        });
    });

    // ─── Proof 7: receipt reads require read_receipts ────────────────

    describe('Proof 7: receipt reads require read_receipts', () => {
        it('proposer cannot list receipts', async () => {
            const { restricted: pk, admin: adminK } = makePolicyKernel(proposer);
            await expect(pk.listReceipts()).rejects.toThrow(PolicyDeniedError);
        });

        it('receipt-reader can list receipts', async () => {
            const { restricted: pk, admin: adminK } = makePolicyKernel(receiptReader);
            const receipts = await pk.listReceipts();
            expect(Array.isArray(receipts)).toBe(true);
        });

        it('denied principal cannot list receipts', async () => {
            const { restricted: pk, admin: adminK } = makePolicyKernel(deniedPrincipal);
            await expect(pk.listReceipts()).rejects.toThrow(PolicyDeniedError);
        });
    });

    // ─── Proof 8: explain retrieval requires explain_retrieval ───────

    describe('Proof 8: explain retrieval requires explain_retrieval', () => {
        it('principal without explain_retrieval cannot explain', async () => {
            const { restricted: pk, admin: adminK } = makePolicyKernel(proposer);
            const bundle = await pk.retrieveBundle('anything');
            // proposer doesn't have explain_retrieval
            await expect(pk.explainRetrieval(bundle)).rejects.toThrow(PolicyDeniedError);
        });

        it('explainer can explain retrieval', async () => {
            const { restricted: pk, admin: adminK } = makePolicyKernel(explainer);
            const bundle = await pk.retrieveBundle('anything');
            const explanation = await pk.explainRetrieval(bundle);
            expect(explanation.summary).toBeTruthy();
        });
    });

    // ─── Proof 9: denied resolution hides according to visibility rule

    describe('Proof 9: denied resolution hides or redacts according to visibility rule', () => {
        it('visibility check reports canonical as hidden for external', () => {
            const { restricted: pk, admin: adminK } = makePolicyKernel(deniedPrincipal);
            const vis = pk.checkVisibility('cluster://canonical/entity-1', 'canonical');
            expect(vis.existenceVisible).toBe(false);
            expect(vis.emitPlaceholder).toBe(true);
        });

        it('findSources filters resolved entities when principal lacks read_owner_truth', async () => {
            const { restricted: pk, admin: adminK } = makePolicyKernel(indexOnlyReader);
            await adminK.createEntity({
                kind: 'concept',
                name: 'Filtered Entity',
                attributes: {},
                actorId: 'admin-1',
            });

            const result = await pk.findSources({ query: 'Filtered' });
            // KERNEL-003 fix: index records that mirror canonical/artifact truth
            // are filtered by the SAME policy that gates the underlying object.
            // indexOnlyReader has `read_derivative` but NOT `read_owner_truth`
            // on canonical (and the canonical store is hidden by visibility for
            // their trust zone). Previously the index record leaked the entity
            // kind/name/attributes through `text` and `metadata`. Now both the
            // entity AND its index record are filtered, which is the stronger
            // and correct enforcement.
            expect(result.resolvedEntities).toHaveLength(0);
            expect(result.indexRecords).toHaveLength(0);
        });
    });

    // ─── Proof 10: policy denial does not bypass command validation ──

    describe('Proof 10: policy denial does not bypass existing command validation', () => {
        it('admin still subject to command lifecycle rules', async () => {
            const { restricted: pk, admin: adminK } = makePolicyKernel(admin);

            // Propose with invalid payload (no filename for ingest_artifact)
            const cmd = await pk.proposeMutation({
                verb: 'ingest_artifact',
                targetStore: 'artifact',
                payload: {}, // missing required fields
                proposedBy: 'admin-1',
            });

            // Policy allows admin to commit, but kernel validation rejects invalid payload
            await expect(pk.commitMutation(cmd.id, 'admin-1')).rejects.toThrow();
        });

        it('admin cannot commit a rejected command', async () => {
            const { restricted: pk, admin: adminK } = makePolicyKernel(admin);
            const cmd = await pk.proposeMutation({
                verb: 'create_entity',
                targetStore: 'canonical',
                payload: { kind: 'concept', name: 'ToReject', attributes: {} },
                proposedBy: 'admin-1',
            });

            // Reject it first
            await pk.rejectMutation(cmd.id, 'admin-1', 'bad idea');

            // Policy allows admin, but kernel blocks commit on rejected command
            await expect(pk.commitMutation(cmd.id, 'admin-1')).rejects.toThrow();
        });

        it('policy allow does not skip verb validation', async () => {
            const { restricted: pk, admin: adminK } = makePolicyKernel(admin);
            const cmd = await pk.proposeMutation({
                verb: 'nonexistent_verb' as any,
                targetStore: 'canonical',
                payload: {},
                proposedBy: 'admin-1',
            });

            // Policy allows, but kernel rejects unknown verb
            await expect(pk.commitMutation(cmd.id, 'admin-1')).rejects.toThrow();
        });
    });
});
