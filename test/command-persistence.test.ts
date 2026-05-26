import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalCluster } from '../src/adapters/local/index.js';
import { ClusterKernel } from '../src/kernel/cluster-kernel.js';
import { CommandQueue } from '../src/kernel/command-queue.js';
import { backup, restore } from '../src/ops/backup.js';

describe('Wave 3: Command persistence across kernel instances', () => {
    let dataDir: string;

    beforeAll(() => {
        dataDir = mkdtempSync(join(tmpdir(), 'cmd-persist-'));
    });

    afterAll(() => {
        rmSync(dataDir, { recursive: true, force: true });
    });

    it('propose in kernel A, validate in kernel B', async () => {
        const stores = createLocalCluster(dataDir);
        const kernelA = new ClusterKernel(stores, { dataDir });

        const proposal = await kernelA.proposeMutation({
            verb: 'create_entity',
            targetStore: 'canonical',
            payload: { kind: 'finding', name: 'cross-kernel-test', attributes: {} },
            proposedBy: 'agent',
        });

        // Kernel B reads the same dataDir
        const kernelB = new ClusterKernel(stores, { dataDir });
        const validated = await kernelB.validateMutation(proposal.id);
        expect(validated.status).toBe('validated');
    });

    it('approve as operator principal in kernel C', async () => {
        const stores = createLocalCluster(dataDir);
        const kernelA = new ClusterKernel(stores, { dataDir });

        const proposal = await kernelA.proposeMutation({
            verb: 'create_entity',
            targetStore: 'canonical',
            payload: { kind: 'decision', name: 'approve-test', attributes: {} },
            proposedBy: 'agent',
        });
        await kernelA.validateMutation(proposal.id);

        // New kernel instance approves
        const kernelC = new ClusterKernel(stores, { dataDir });
        const approved = await kernelC.approveMutation(proposal.id, 'operator', 'approved by test');
        expect(approved.status).toBe('approved');
    });

    it('commit in kernel D', async () => {
        const stores = createLocalCluster(dataDir);
        const kernelA = new ClusterKernel(stores, { dataDir });

        const proposal = await kernelA.proposeMutation({
            verb: 'create_entity',
            targetStore: 'canonical',
            payload: { kind: 'milestone', name: 'commit-test', attributes: {} },
            proposedBy: 'agent',
        });
        await kernelA.validateMutation(proposal.id);
        await kernelA.approveMutation(proposal.id, 'operator');

        // New kernel commits
        const kernelD = new ClusterKernel(stores, { dataDir });
        const { command, receipt } = await kernelD.commitMutation(proposal.id, 'operator');
        expect(command.status).toBe('committed');
        expect(receipt).toBeDefined();
    });

    it('inspect lifecycle from kernel E', async () => {
        const stores = createLocalCluster(dataDir);
        const kernelA = new ClusterKernel(stores, { dataDir });

        const proposal = await kernelA.proposeMutation({
            verb: 'create_entity',
            targetStore: 'canonical',
            payload: { kind: 'finding', name: 'inspect-test', attributes: {} },
            proposedBy: 'agent',
        });
        await kernelA.validateMutation(proposal.id);

        // New kernel can inspect
        const kernelE = new ClusterKernel(stores, { dataDir });
        const inspected = await kernelE.inspectCommand(proposal.id);
        expect(inspected).toBeDefined();
        expect(inspected!.status).toBe('validated');
        expect(inspected!.proposedBy).toBe('agent');
    });

    it('rejected command remains rejected after restart', async () => {
        const stores = createLocalCluster(dataDir);
        const kernelA = new ClusterKernel(stores, { dataDir });

        const proposal = await kernelA.proposeMutation({
            verb: 'create_entity',
            targetStore: 'canonical',
            payload: { kind: 'finding', name: 'reject-test', attributes: {} },
            proposedBy: 'agent',
        });
        await kernelA.rejectMutation(proposal.id, 'operator', 'not approved');

        // New kernel sees rejected state
        const kernelB = new ClusterKernel(stores, { dataDir });
        const inspected = await kernelB.inspectCommand(proposal.id);
        expect(inspected!.status).toBe('rejected');
    });

    it('compensated command preserves original history after restart', async () => {
        const stores = createLocalCluster(dataDir);
        const kernelA = new ClusterKernel(stores, { dataDir });

        const proposal = await kernelA.proposeMutation({
            verb: 'create_entity',
            targetStore: 'canonical',
            payload: { kind: 'finding', name: 'compensate-test', attributes: {} },
            proposedBy: 'agent',
        });
        await kernelA.validateMutation(proposal.id);
        await kernelA.approveMutation(proposal.id, 'operator');
        const { command: committed } = await kernelA.commitMutation(proposal.id, 'operator');

        // Compensate
        const { compensatingCommand } = await kernelA.compensateMutation(
            committed.id, 'operator', 'mistake',
        );

        // New kernel sees full history
        const kernelB = new ClusterKernel(stores, { dataDir });
        const original = await kernelB.inspectCommand(committed.id);
        expect(original!.status).toBe('compensated');
        expect(original!.compensatingCommandId).toBe(compensatingCommand.id);

        const comp = await kernelB.inspectCommand(compensatingCommand.id);
        expect(comp!.status).toBe('committed');
    });

    it('backup/restore preserves command lifecycle state', async () => {
        const freshDir = mkdtempSync(join(tmpdir(), 'cmd-backup-'));
        const stores = createLocalCluster(freshDir);
        const queue = new CommandQueue(freshDir);
        const kernel = new ClusterKernel(stores, { dataDir: freshDir });

        const proposal = await kernel.proposeMutation({
            verb: 'create_entity',
            targetStore: 'canonical',
            payload: { kind: 'phase', name: 'backup-cmd-test', attributes: {} },
            proposedBy: 'agent',
        });
        await kernel.validateMutation(proposal.id);

        // Backup with command queue
        const data = await backup(stores, { commandQueue: queue });
        expect(data.commands).toBeDefined();
        expect(data.commands!.length).toBeGreaterThan(0);

        // Restore to fresh location
        const restoreDir = mkdtempSync(join(tmpdir(), 'cmd-restore-'));
        const restoreStores = createLocalCluster(restoreDir);
        const restoreQueue = new CommandQueue(restoreDir);
        const result = await restore(restoreStores, data, { commandQueue: restoreQueue });
        expect(result.commands!.restored).toBeGreaterThan(0);

        // Verify command accessible from new kernel
        const restoreKernel = new ClusterKernel(restoreStores, { dataDir: restoreDir });
        const restored = await restoreKernel.inspectCommand(proposal.id);
        expect(restored).toBeDefined();
        expect(restored!.status).toBe('validated');

        rmSync(freshDir, { recursive: true, force: true });
        rmSync(restoreDir, { recursive: true, force: true });
    });
});
