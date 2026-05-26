import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalCluster } from '../src/adapters/local/index.js';
import { ClusterKernel } from '../src/kernel/cluster-kernel.js';

describe('Wave 4: Command-created entities auto-index', () => {
    let dataDir: string;

    beforeAll(() => {
        dataDir = mkdtempSync(join(tmpdir(), 'auto-idx-'));
    });

    afterAll(() => {
        rmSync(dataDir, { recursive: true, force: true });
    });

    it('createEntity() and command-created entity both become searchable', async () => {
        const stores = createLocalCluster(dataDir);
        const kernel = new ClusterKernel(stores, { dataDir });

        // Direct createEntity
        const { entity: direct } = await kernel.createEntity({
            kind: 'phase',
            name: 'Direct Phase',
            attributes: {},
            actorId: 'operator',
        });

        // Command-created entity
        const proposal = await kernel.proposeMutation({
            verb: 'create_entity',
            targetStore: 'canonical',
            payload: { kind: 'phase', name: 'Command Phase', attributes: {} },
            proposedBy: 'operator',
        });
        const { command } = await kernel.commitMutation(proposal.id, 'operator');

        // Both should be searchable
        const directResults = await stores.index.search({ text: 'Direct Phase' });
        expect(directResults.length).toBeGreaterThan(0);

        const cmdResults = await stores.index.search({ text: 'Command Phase' });
        expect(cmdResults.length).toBeGreaterThan(0);
    });

    it('command-created entity resolves owner truth', async () => {
        const stores = createLocalCluster(dataDir);
        const kernel = new ClusterKernel(stores, { dataDir });

        const proposal = await kernel.proposeMutation({
            verb: 'create_entity',
            targetStore: 'canonical',
            payload: { kind: 'decision', name: 'Owner Truth Test', attributes: { rationale: 'test' } },
            proposedBy: 'agent',
        });
        const { receipt } = await kernel.commitMutation(proposal.id, 'operator');
        const entityId = receipt.affectedIds[0];

        // Resolve from canonical (owner truth)
        const entity = await kernel.inspectEntity(entityId);
        expect(entity.kind).toBe('decision');
        expect(entity.name).toBe('Owner Truth Test');
    });

    it('command-created entity appears in retrieval bundle', async () => {
        const stores = createLocalCluster(dataDir);
        const kernel = new ClusterKernel(stores, { dataDir });

        const proposal = await kernel.proposeMutation({
            verb: 'create_entity',
            targetStore: 'canonical',
            payload: { kind: 'finding', name: 'Bundle Retrieval Test', attributes: {} },
            proposedBy: 'agent',
        });
        await kernel.commitMutation(proposal.id, 'operator');

        // Should appear in retrieval
        const bundle = await kernel.retrieveBundle('Bundle Retrieval');
        expect(bundle.resolvedEntities.length).toBeGreaterThan(0);
        const found = bundle.resolvedEntities.find((re) => re.object.name === 'Bundle Retrieval Test');
        expect(found).toBeDefined();
    });

    it('command-created entity trace includes command/provenance/receipt', async () => {
        const stores = createLocalCluster(dataDir);
        const kernel = new ClusterKernel(stores, { dataDir });

        const proposal = await kernel.proposeMutation({
            verb: 'create_entity',
            targetStore: 'canonical',
            payload: { kind: 'milestone', name: 'Trace Test Milestone', attributes: {} },
            proposedBy: 'agent',
        });
        const { receipt } = await kernel.commitMutation(proposal.id, 'operator');
        const entityId = receipt.affectedIds[0];

        // Trace provenance
        const events = await kernel.traceProvenance(entityId);
        expect(events.length).toBeGreaterThan(0);
        const mutationEvent = events.find((e) => e.action === 'mutation_committed');
        expect(mutationEvent).toBeDefined();

        // Receipt references the entity
        expect(receipt.affectedIds).toContain(entityId);
    });

    it('no duplicate index records after repeated rebuild', async () => {
        const stores = createLocalCluster(dataDir);
        const kernel = new ClusterKernel(stores, { dataDir });

        const proposal = await kernel.proposeMutation({
            verb: 'create_entity',
            targetStore: 'canonical',
            payload: { kind: 'finding', name: 'NoDupe Test', attributes: {} },
            proposedBy: 'agent',
        });
        await kernel.commitMutation(proposal.id, 'operator');

        // Rebuild index
        const { rebuildIndex } = await import('../src/ops/rebuild.js');
        await rebuildIndex(stores);

        // Search should find exactly one record for this entity
        const results = await stores.index.search({ text: 'NoDupe Test' });
        const matches = results.filter((r) => r.text.includes('NoDupe Test'));
        expect(matches.length).toBe(1);
    });

    it('update_entity refreshes index deterministically', async () => {
        const stores = createLocalCluster(dataDir);
        const kernel = new ClusterKernel(stores, { dataDir });

        // Create entity first
        const { entity } = await kernel.createEntity({
            kind: 'decision',
            name: 'Original Name',
            attributes: { v: 1 },
            actorId: 'operator',
        });

        // Update via command
        const proposal = await kernel.proposeMutation({
            verb: 'update_entity',
            targetStore: 'canonical',
            payload: { entityId: entity.id, patch: { name: 'Updated Name', attributes: { v: 2 } } },
            proposedBy: 'operator',
        });
        await kernel.commitMutation(proposal.id, 'operator');

        // Old name should not be in index
        const oldResults = await stores.index.search({ text: 'Original Name' });
        const oldMatches = oldResults.filter((r) => r.sourceId === entity.id);
        expect(oldMatches.length).toBe(0);

        // New name should be in index
        const newResults = await stores.index.search({ text: 'Updated Name' });
        const newMatches = newResults.filter((r) => r.sourceId === entity.id);
        expect(newMatches.length).toBe(1);
    });
});
