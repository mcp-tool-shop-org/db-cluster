import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLocalCluster } from '../src/adapters/local/index.js';
import { ClusterKernel } from '../src/kernel/cluster-kernel.js';
import type { ClusterStores } from '../src/contracts/index.js';

describe('Phase 5 — Mutation Law and Command Runtime', () => {
    let cluster: ClusterStores;
    let kernel: ClusterKernel;
    let TEST_DIR: string;

    beforeEach(() => {
        TEST_DIR = mkdtempSync(join(tmpdir(), 'db-cluster-phase5-proof-'));
        cluster = createLocalCluster(TEST_DIR);
        kernel = new ClusterKernel(cluster, { dataDir: TEST_DIR });
    });

    afterEach(() => {
        try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
    });

    // ─── Proof 1: No commit without validation ───────────────────────

    describe('Proof 1: No commit without validation', () => {
        it('proposed command with invalid payload rejects on validation', async () => {
            const cmd = await kernel.proposeMutation({
                verb: 'create_entity',
                targetStore: 'canonical',
                payload: { badField: 'no kind or name' }, // missing kind/name
                proposedBy: 'ai-agent',
            });

            // KERNEL-006: validation is now an explicit step. The validation
            // failure surfaces from validateMutation, not from commit (which
            // refuses to run on a proposed/unvalidated command).
            await expect(kernel.validateMutation(cmd.id))
                .rejects.toThrow(/Validation failed|create_entity requires/);

            // Command is now rejected
            const inspected = await kernel.inspectCommand(cmd.id);
            expect(inspected.status).toBe('rejected');
        });

        it('committing an unvalidated proposed command throws CommandNotValidatedError', async () => {
            // Belt-and-braces for KERNEL-006: skipping validate is no longer
            // possible at the kernel layer.
            const cmd = await kernel.proposeMutation({
                verb: 'create_entity',
                targetStore: 'canonical',
                payload: { kind: 'task', name: 'Skipped', attributes: {} },
                proposedBy: 'ai-agent',
            });

            await expect(kernel.commitMutation(cmd.id, 'ai-agent'))
                .rejects.toThrow(/has not been validated/);
        });

        it('valid command commits successfully (after explicit validate)', async () => {
            const cmd = await kernel.proposeMutation({
                verb: 'create_entity',
                targetStore: 'canonical',
                payload: { kind: 'task', name: 'Build', attributes: {} },
                proposedBy: 'ai-agent',
            });

            await kernel.validateMutation(cmd.id);
            const result = await kernel.commitMutation(cmd.id, 'ai-agent');
            expect(result.command.status).toBe('committed');
            expect(result.receipt).toBeTruthy();
        });
    });

    // ─── Proof 2: Rejected commands cannot commit ────────────────────

    describe('Proof 2: Rejected commands cannot commit', () => {
        it('explicitly rejected command throws on commit attempt', async () => {
            const cmd = await kernel.proposeMutation({
                verb: 'create_entity',
                targetStore: 'canonical',
                payload: { kind: 'thing', name: 'X', attributes: {} },
                proposedBy: 'ai',
            });

            await kernel.rejectMutation(cmd.id, 'operator', 'Not approved by policy');

            await expect(kernel.commitMutation(cmd.id, 'ai'))
                .rejects.toThrow(/rejected|Previously rejected/);
        });

        it('rejected command carries reason and actor', async () => {
            const cmd = await kernel.proposeMutation({
                verb: 'update_entity',
                targetStore: 'canonical',
                payload: { entityId: 'e1', patch: { name: 'Y' } },
                proposedBy: 'ai',
            });

            const rejected = await kernel.rejectMutation(cmd.id, 'security-bot', 'Unauthorized field mutation');

            expect(rejected.status).toBe('rejected');
            expect(rejected.rejectedBy).toBe('security-bot');
            expect(rejected.rejectionReason).toBe('Unauthorized field mutation');
            expect(rejected.rejectedAt).toBeTruthy();
        });
    });

    // ─── Proof 3: Approval lifecycle ────────────────────────────────

    describe('Proof 3: Full approval lifecycle', () => {
        it('proposed → validated → approved → committed', async () => {
            const cmd = await kernel.proposeMutation({
                verb: 'create_entity',
                targetStore: 'canonical',
                payload: { kind: 'module', name: 'Auth', attributes: {} },
                proposedBy: 'ai',
            });
            expect(cmd.status).toBe('proposed');

            // Validate
            const validated = await kernel.validateMutation(cmd.id);
            expect(validated.status).toBe('validated');
            expect(validated.validation).toBeTruthy();
            expect(validated.validation!.valid).toBe(true);
            expect(validated.validation!.checks.length).toBeGreaterThan(0);

            // Approve
            const approved = await kernel.approveMutation(cmd.id, 'admin', 'Looks good');
            expect(approved.status).toBe('approved');
            expect(approved.approvedBy).toBe('admin');
            expect(approved.approvalNote).toBe('Looks good');

            // Commit
            const result = await kernel.commitMutation(cmd.id, 'system');
            expect(result.command.status).toBe('committed');
            expect(result.command.committedBy).toBe('system');
            expect(result.receipt.resultSummary).toContain('Auth');
        });

        it('cannot approve a proposed (unvalidated) command', async () => {
            const cmd = await kernel.proposeMutation({
                verb: 'create_entity',
                targetStore: 'canonical',
                payload: { kind: 'x', name: 'y', attributes: {} },
                proposedBy: 'ai',
            });

            // SHA-KERNEL-C-001 (Wave C1-Amend): typed
            // InvalidStateTransitionError replaces bare new Error(...).
            // Message reads "Cannot transition command X from status 'proposed' to 'approved'".
            await expect(kernel.approveMutation(cmd.id, 'admin'))
                .rejects.toThrow(/'proposed'.*'approved'/);
        });
    });

    // ─── Proof 4: Compensated commands preserve original receipt ─────

    describe('Proof 4: Compensation preserves history', () => {
        it('compensated command retains original receipt, gains compensating receipt', async () => {
            // Create and commit something
            const { entity, receipt: originalReceipt } = await kernel.createEntity({
                kind: 'feature',
                name: 'DarkMode',
                attributes: { enabled: true },
                actorId: 'dev',
            });

            // Propose → validate → commit
            const cmd = await kernel.proposeMutation({
                verb: 'update_entity',
                targetStore: 'canonical',
                payload: { entityId: entity.id, patch: { name: 'LightMode' } },
                proposedBy: 'dev',
            });
            await kernel.validateMutation(cmd.id);
            const result = await kernel.commitMutation(cmd.id, 'dev');
            const updateReceipt = result.receipt;

            // Compensate the update
            const comp = await kernel.compensateMutation(
                cmd.id,
                'ops',
                'Reverted: wrong feature renamed',
            );

            // Original command is now compensated
            expect(comp.originalCommand.status).toBe('compensated');
            expect(comp.originalCommand.compensatingCommandId).toBe(comp.compensatingCommand.id);
            expect(comp.originalCommand.compensatedBy).toBe('ops');

            // Original receipt still exists in ledger
            const receipts = await kernel.listReceipts();
            const originalExists = receipts.some((r) => r.id === updateReceipt.id);
            expect(originalExists).toBe(true);

            // Compensating receipt also exists
            const compReceiptExists = receipts.some((r) => r.id === comp.receipt.id);
            expect(compReceiptExists).toBe(true);
            expect(comp.receipt.resultSummary).toContain('Compensated');
        });

        it('cannot compensate a non-committed command', async () => {
            const cmd = await kernel.proposeMutation({
                verb: 'create_entity',
                targetStore: 'canonical',
                payload: { kind: 'z', name: 'w', attributes: {} },
                proposedBy: 'ai',
            });

            // SHA-KERNEL-C-001 (Wave C1-Amend): typed
            // InvalidStateTransitionError. Message: "Cannot transition command X from status 'proposed' to 'compensated'".
            await expect(kernel.compensateMutation(cmd.id, 'ops', 'mistake'))
                .rejects.toThrow(/'proposed'.*'compensated'/);
        });
    });

    // ─── Proof 5: Failed commands emit audit trail ──────────────────

    describe('Proof 5: Failed commands produce audit trail', () => {
        it('rejected command produces provenance event in ledger', async () => {
            const cmd = await kernel.proposeMutation({
                verb: 'create_entity',
                targetStore: 'canonical',
                payload: { kind: 'thing', name: 'audit-test', attributes: {} },
                proposedBy: 'ai',
            });

            // Validate first (required before reject from validated)
            await kernel.validateMutation(cmd.id);
            await kernel.rejectMutation(cmd.id, 'policy-engine', 'Blocked by rate limit');

            // Check ledger for rejection event
            const events = await cluster.ledger.listEvents({ subjectId: cmd.id });
            const rejectionEvent = events.find((e) => e.action === 'command_rejected');
            expect(rejectionEvent).toBeTruthy();
            expect(rejectionEvent!.actorId).toBe('policy-engine');
            expect(rejectionEvent!.detail.reason).toBe('Blocked by rate limit');
        });

        it('approved command produces provenance event in ledger', async () => {
            const cmd = await kernel.proposeMutation({
                verb: 'create_entity',
                targetStore: 'canonical',
                payload: { kind: 'item', name: 'approved-test', attributes: {} },
                proposedBy: 'ai',
            });

            await kernel.validateMutation(cmd.id);
            await kernel.approveMutation(cmd.id, 'supervisor', 'LGTM');

            const events = await cluster.ledger.listEvents({ subjectId: cmd.id });
            const approvalEvent = events.find((e) => e.action === 'command_approved');
            expect(approvalEvent).toBeTruthy();
            expect(approvalEvent!.actorId).toBe('supervisor');
            expect(approvalEvent!.detail.note).toBe('LGTM');
        });

        it('compensation produces provenance event in ledger', async () => {
            const { entity } = await kernel.createEntity({
                kind: 'record',
                name: 'CompTest',
                attributes: {},
                actorId: 'u',
            });
            const cmd = await kernel.proposeMutation({
                verb: 'update_entity',
                targetStore: 'canonical',
                payload: { entityId: entity.id, patch: { name: 'CompChanged' } },
                proposedBy: 'u',
            });
            await kernel.validateMutation(cmd.id);
            await kernel.commitMutation(cmd.id, 'u');
            await kernel.compensateMutation(cmd.id, 'auditor', 'Data correction');

            const events = await cluster.ledger.listEvents({ subjectId: cmd.id });
            const compEvent = events.find((e) => e.action === 'command_compensated');
            expect(compEvent).toBeTruthy();
            expect(compEvent!.actorId).toBe('auditor');
            expect(compEvent!.detail.reason).toBe('Data correction');
        });
    });

    // ─── Proof 6: Cross-process command lifecycle ───────────────────

    describe('Proof 6: Command lifecycle survives restart', () => {
        it('command proposed in one kernel instance can be committed in another', async () => {
            // First instance: propose + validate (KERNEL-006: validate is required)
            const cmd = await kernel.proposeMutation({
                verb: 'create_entity',
                targetStore: 'canonical',
                payload: { kind: 'project', name: 'CrossProcess', attributes: {} },
                proposedBy: 'process-1',
            });
            await kernel.validateMutation(cmd.id);

            // Second instance: commit
            const kernel2 = new ClusterKernel(createLocalCluster(TEST_DIR), { dataDir: TEST_DIR });
            const result = await kernel2.commitMutation(cmd.id, 'process-2');

            expect(result.command.status).toBe('committed');
            expect(result.command.committedBy).toBe('process-2');
            expect(result.receipt.resultSummary).toContain('CrossProcess');
        });

        it('validated command in one kernel can be approved and committed in another', async () => {
            const cmd = await kernel.proposeMutation({
                verb: 'create_entity',
                targetStore: 'canonical',
                payload: { kind: 'service', name: 'PersistTest', attributes: {} },
                proposedBy: 'p1',
            });
            await kernel.validateMutation(cmd.id);

            // Second instance
            const kernel2 = new ClusterKernel(createLocalCluster(TEST_DIR), { dataDir: TEST_DIR });
            const approved = await kernel2.approveMutation(cmd.id, 'admin');
            expect(approved.status).toBe('approved');

            const result = await kernel2.commitMutation(cmd.id, 'system');
            expect(result.command.status).toBe('committed');
        });
    });

    // ─── Proof 7: Validation checks are detailed ────────────────────

    describe('Proof 7: Validation produces detailed check results', () => {
        it('validation result contains named checks with pass/fail', async () => {
            const cmd = await kernel.proposeMutation({
                verb: 'create_entity',
                targetStore: 'canonical',
                payload: { kind: 'widget', name: 'Valid', attributes: {} },
                proposedBy: 'ai',
            });

            const validated = await kernel.validateMutation(cmd.id);

            expect(validated.validation).toBeTruthy();
            expect(validated.validation!.checks.length).toBeGreaterThanOrEqual(4);
            expect(validated.validation!.checks.every((c) => c.passed)).toBe(true);
            expect(validated.validation!.validatedAt).toBeTruthy();

            // Check names are meaningful
            const names = validated.validation!.checks.map((c) => c.name);
            expect(names).toContain('verb_present');
            expect(names).toContain('target_store_valid');
            expect(names).toContain('payload_present');
            expect(names).toContain('payload_shape');
            expect(names).toContain('status_is_proposed');
        });
    });

    // ─── Proof 8: Command status transitions are enforced ───────────

    describe('Proof 8: Invalid status transitions are rejected', () => {
        it('cannot validate a committed command', async () => {
            const cmd = await kernel.proposeMutation({
                verb: 'create_entity',
                targetStore: 'canonical',
                payload: { kind: 'item', name: 'StatusTest', attributes: {} },
                proposedBy: 'ai',
            });
            await kernel.validateMutation(cmd.id);
            await kernel.commitMutation(cmd.id, 'ai');

            await expect(kernel.validateMutation(cmd.id))
                .rejects.toThrow();
        });

        it('cannot reject a committed command', async () => {
            const cmd = await kernel.proposeMutation({
                verb: 'create_entity',
                targetStore: 'canonical',
                payload: { kind: 'item', name: 'RejectTest', attributes: {} },
                proposedBy: 'ai',
            });
            await kernel.validateMutation(cmd.id);
            await kernel.commitMutation(cmd.id, 'ai');

            // SHA-KERNEL-C-001 (Wave C1-Amend): typed InvalidStateTransitionError.
            await expect(kernel.rejectMutation(cmd.id, 'admin', 'too late'))
                .rejects.toThrow(/'committed'.*'rejected'/);
        });

        it('cannot approve a rejected command', async () => {
            const cmd = await kernel.proposeMutation({
                verb: 'create_entity',
                targetStore: 'canonical',
                payload: { kind: 'item', name: 'ApproveTest', attributes: {} },
                proposedBy: 'ai',
            });
            await kernel.validateMutation(cmd.id);
            await kernel.rejectMutation(cmd.id, 'admin', 'nope');

            // SHA-KERNEL-C-001 (Wave C1-Amend): typed InvalidStateTransitionError.
            await expect(kernel.approveMutation(cmd.id, 'admin'))
                .rejects.toThrow(/'rejected'.*'approved'/);
        });
    });
});
