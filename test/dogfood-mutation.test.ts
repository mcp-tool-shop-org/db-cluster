/**
 * Dogfood mutation tests — verify command lifecycle works on project memory.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { rmSync } from 'node:fs';
import { createDogfoodCluster, type DogfoodCluster } from '../scripts/dogfood-ingest.js';

let cluster: DogfoodCluster;

beforeAll(async () => {
    cluster = await createDogfoodCluster();
});

afterAll(() => {
    rmSync(cluster.dataDir, { recursive: true, force: true });
});

describe('Dogfood mutation', () => {
    it('propose writes no truth', async () => {
        const before = await cluster.kernel.findSources({ query: 'developer-runnable-test' });
        expect(before.resolvedEntities.length).toBe(0);

        const proposal = await cluster.kernel.proposeMutation({
            verb: 'create_entity',
            targetStore: 'canonical',
            payload: {
                kind: 'finding',
                name: 'developer-runnable-test unique marker',
                attributes: { test: true },
            },
            proposedBy: 'ai-agent',
        });
        expect(proposal.status).toBe('proposed');

        // Still not in canonical store
        const after = await cluster.kernel.findSources({ query: 'developer-runnable-test' });
        expect(after.resolvedEntities.length).toBe(0);
    });

    it('validate checks payload without writing', async () => {
        const proposal = await cluster.kernel.proposeMutation({
            verb: 'create_entity',
            targetStore: 'canonical',
            payload: {
                kind: 'finding',
                name: 'validate-check-test',
                attributes: {},
            },
            proposedBy: 'ai-agent',
        });

        const validated = await cluster.kernel.validateMutation(proposal.id);
        expect(validated.status).toBe('validated');

        // Still not in canonical store
        const results = await cluster.kernel.findSources({ query: 'validate-check-test' });
        expect(results.resolvedEntities.length).toBe(0);
    });

    it('approve records gate', async () => {
        const proposal = await cluster.kernel.proposeMutation({
            verb: 'create_entity',
            targetStore: 'canonical',
            payload: {
                kind: 'finding',
                name: 'approve-gate-test',
                attributes: {},
            },
            proposedBy: 'ai-agent',
        });

        await cluster.kernel.validateMutation(proposal.id);
        const approved = await cluster.kernel.approveMutation(
            proposal.id,
            'operator',
            'Approved for testing',
        );
        expect(approved.status).toBe('approved');
    });

    it('commit updates canonical memory and produces receipt', async () => {
        const proposal = await cluster.kernel.proposeMutation({
            verb: 'create_entity',
            targetStore: 'canonical',
            payload: {
                kind: 'finding',
                name: 'commit-test-finding',
                attributes: { proven: true },
            },
            proposedBy: 'ai-agent',
        });

        const { command, receipt } = await cluster.kernel.commitMutation(proposal.id, 'operator');
        expect(command.status).toBe('committed');
        expect(receipt).toBeDefined();
        expect(receipt.resultSummary).toContain('commit-test-finding');
    });

    it('receipt connects command to change', async () => {
        const proposal = await cluster.kernel.proposeMutation({
            verb: 'create_entity',
            targetStore: 'canonical',
            payload: {
                kind: 'decision',
                name: 'receipt-connection-test',
                attributes: {},
            },
            proposedBy: 'ai-agent',
        });

        const { command, receipt } = await cluster.kernel.commitMutation(proposal.id, 'operator');
        expect(receipt.commandId).toBe(command.id);
        expect(receipt.affectedIds.length).toBeGreaterThan(0);
    });

    it('trace shows mutation provenance after commit', async () => {
        // Create entity via commit
        const proposal = await cluster.kernel.proposeMutation({
            verb: 'create_entity',
            targetStore: 'canonical',
            payload: {
                kind: 'finding',
                name: 'traceable-finding',
                attributes: { source: 'docs/phase-10-closeout.md' },
            },
            proposedBy: 'ai-agent',
        });

        const { command, receipt } = await cluster.kernel.commitMutation(proposal.id, 'operator');

        // The command should be committed
        const inspected = await cluster.kernel.inspectCommand(proposal.id);
        expect(inspected.status).toBe('committed');

        // Receipt proves the mutation happened
        expect(receipt.commandId).toBe(command.id);
        expect(receipt.affectedIds.length).toBeGreaterThan(0);

        // The affected entity has provenance (mutation_committed is recorded against first affectedId)
        const entityId = receipt.affectedIds[0];
        const events = await cluster.kernel.traceProvenance(entityId);
        expect(events.length).toBeGreaterThan(0);
        expect(events.some((e) => e.action === 'mutation_committed')).toBe(true);
    });

    it('full lifecycle: propose → validate → approve → commit', async () => {
        const proposal = await cluster.kernel.proposeMutation({
            verb: 'create_entity',
            targetStore: 'canonical',
            payload: {
                kind: 'milestone',
                name: 'full-lifecycle-test',
                attributes: { phase: 11 },
            },
            proposedBy: 'ai-agent',
        });
        expect(proposal.status).toBe('proposed');

        const validated = await cluster.kernel.validateMutation(proposal.id);
        expect(validated.status).toBe('validated');

        const approved = await cluster.kernel.approveMutation(proposal.id, 'operator', 'LGTM');
        expect(approved.status).toBe('approved');

        const { command, receipt } = await cluster.kernel.commitMutation(proposal.id, 'operator');
        expect(command.status).toBe('committed');
        expect(receipt.resultSummary).toContain('full-lifecycle-test');
    });
});
