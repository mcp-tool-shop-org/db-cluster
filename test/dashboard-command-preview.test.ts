import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLocalCluster } from '../src/adapters/local/index.js';
import { ClusterKernel } from '../src/kernel/cluster-kernel.js';
import { inspectCommandObject } from '../src/dashboard/inspector-data.js';

describe('Dashboard command preview', () => {
    let kernel: ClusterKernel;
    let TEST_DIR: string;

    beforeEach(() => {
        TEST_DIR = mkdtempSync(join(tmpdir(), 'db-cluster-dashboard-cmd-preview-'));
        const cluster = createLocalCluster(TEST_DIR);
        kernel = new ClusterKernel(cluster, { dataDir: TEST_DIR });
    });

    afterEach(() => {
        try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
    });

    it('proposed command shows proposed status', async () => {
        const { entity } = await kernel.createEntity({ kind: 'test', name: 'A', attributes: {}, actorId: 'u' });
        const cmd = await kernel.proposeMutation({
            verb: 'update_entity',
            targetStore: 'canonical',
            payload: { entityId: entity.id, patch: { name: 'B' } },
            proposedBy: 'agent',
        });

        const obj = await inspectCommandObject(kernel, cmd.id);
        expect(obj.commandState!.status).toBe('proposed');
        expect(obj.commandState!.proposedBy).toBe('agent');
    });

    it('validated command shows validated status', async () => {
        const { entity } = await kernel.createEntity({ kind: 'test', name: 'A', attributes: {}, actorId: 'u' });
        const cmd = await kernel.proposeMutation({
            verb: 'update_entity',
            targetStore: 'canonical',
            payload: { entityId: entity.id, patch: { name: 'B' } },
            proposedBy: 'agent',
        });
        await kernel.validateMutation(cmd.id);

        const obj = await inspectCommandObject(kernel, cmd.id);
        expect(obj.commandState!.status).toBe('validated');
        expect(obj.commandState!.validatedAt).toBeDefined();
    });

    it('rejected command shows rejected status with reason', async () => {
        const { entity } = await kernel.createEntity({ kind: 'test', name: 'A', attributes: {}, actorId: 'u' });
        const cmd = await kernel.proposeMutation({
            verb: 'update_entity',
            targetStore: 'canonical',
            payload: { entityId: entity.id, patch: { name: 'B' } },
            proposedBy: 'agent',
        });
        await kernel.validateMutation(cmd.id);
        await kernel.rejectMutation(cmd.id, 'operator', 'Not now');

        const obj = await inspectCommandObject(kernel, cmd.id);
        expect(obj.commandState!.status).toBe('rejected');
        expect(obj.commandState!.rejectedBy).toBe('operator');
        expect(obj.commandState!.rejectionReason).toBe('Not now');
    });

    it('committed command shows committed status with receipt', async () => {
        const { entity } = await kernel.createEntity({ kind: 'test', name: 'A', attributes: {}, actorId: 'u' });
        const cmd = await kernel.proposeMutation({
            verb: 'update_entity',
            targetStore: 'canonical',
            payload: { entityId: entity.id, patch: { name: 'B' } },
            proposedBy: 'agent',
        });
        await kernel.validateMutation(cmd.id);
        await kernel.approveMutation(cmd.id, 'operator');
        await kernel.commitMutation(cmd.id, 'operator');

        const obj = await inspectCommandObject(kernel, cmd.id);
        expect(obj.commandState!.status).toBe('committed');
        expect(obj.commandState!.committedAt).toBeDefined();
        expect(obj.receipts.length).toBeGreaterThan(0);
    });

    it('compensated command shows compensated status', async () => {
        const { entity } = await kernel.createEntity({ kind: 'test', name: 'A', attributes: {}, actorId: 'u' });
        const cmd = await kernel.proposeMutation({
            verb: 'update_entity',
            targetStore: 'canonical',
            payload: { entityId: entity.id, patch: { name: 'B' } },
            proposedBy: 'agent',
        });
        await kernel.validateMutation(cmd.id);
        await kernel.approveMutation(cmd.id, 'operator');
        await kernel.commitMutation(cmd.id, 'operator');
        await kernel.compensateMutation(cmd.id, 'operator', 'rollback');

        const obj = await inspectCommandObject(kernel, cmd.id);
        expect(obj.commandState!.status).toBe('compensated');
        expect(obj.commandState!.compensatedAt).toBeDefined();
    });

    it('command preview never implies direct editing', async () => {
        const { entity } = await kernel.createEntity({ kind: 'test', name: 'A', attributes: {}, actorId: 'u' });
        const cmd = await kernel.proposeMutation({
            verb: 'update_entity',
            targetStore: 'canonical',
            payload: { entityId: entity.id, patch: { name: 'B' } },
            proposedBy: 'agent',
        });

        const obj = await inspectCommandObject(kernel, cmd.id);

        // The dashboard object for a command should NOT have an edit action
        // It shows state, not a form
        expect(obj.type).toBe('command');
        expect(obj.ownerStore).toBe('ledger');
        expect(obj.sourceType).toBe('append-only');
        // Commands live in the ledger — they are audit trail, not editable records
    });
});
