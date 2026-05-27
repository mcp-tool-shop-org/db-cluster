import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLocalCluster } from '../src/adapters/local/index.js';
import { ClusterKernel } from '../src/kernel/cluster-kernel.js';
import { ProvenanceMissingError, CommandNotValidatedError, CommandNotFoundError } from '../src/kernel/errors.js';
import type { ClusterStores } from '../src/contracts/index.js';

describe('Wave 3 — Kernel Spine', () => {
    let cluster: ClusterStores;
    let kernel: ClusterKernel;
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), 'db-cluster-kernel-'));
        cluster = createLocalCluster(tmpDir);
        kernel = new ClusterKernel(cluster);
    });

    afterEach(() => {
        try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    });

    it('1. ingestArtifact writes artifact, index record, provenance event, and receipt', async () => {
        const result = await kernel.ingestArtifact({
            filename: 'evidence.md',
            content: Buffer.from('# Source document'),
            mimeType: 'text/markdown',
            actorId: 'user-1',
        });

        expect(result.artifact.owner).toBe('artifact');
        expect(result.artifact.filename).toBe('evidence.md');
        expect(result.indexRecord.owner).toBe('index');
        expect(result.indexRecord.sourceId).toBe(result.artifact.id);
        expect(result.provenance.owner).toBe('ledger');
        expect(result.provenance.action).toBe('artifact_ingested');
        expect(result.receipt.commandId).toBeTruthy();
        expect(result.receipt.affectedIds).toContain(result.artifact.id);
    });

    it('2. createEntity writes canonical entity, index record, provenance event, and receipt', async () => {
        const result = await kernel.createEntity({
            kind: 'person',
            name: 'Alice',
            attributes: { role: 'engineer' },
            actorId: 'user-1',
        });

        expect(result.entity.owner).toBe('canonical');
        expect(result.entity.kind).toBe('person');
        expect(result.entity.name).toBe('Alice');
        expect(result.indexRecord.sourceStore).toBe('canonical');
        expect(result.indexRecord.sourceId).toBe(result.entity.id);
        expect(result.provenance.action).toBe('entity_created');
        expect(result.receipt.affectedIds).toContain(result.entity.id);
    });

    it('3. linkEvidence creates a provenance edge between artifact and entity', async () => {
        const { artifact } = await kernel.ingestArtifact({
            filename: 'proof.pdf',
            content: Buffer.from('proof content'),
            mimeType: 'application/pdf',
            actorId: 'user-1',
        });
        const { entity } = await kernel.createEntity({
            kind: 'claim',
            name: 'AI needs federated stores',
            attributes: {},
            actorId: 'user-1',
        });

        const result = await kernel.linkEvidence({
            artifactId: artifact.id,
            entityId: entity.id,
            actorId: 'user-1',
        });

        expect(result.provenance.action).toBe('evidence_linked');
        expect(result.provenance.detail).toMatchObject({
            artifactId: artifact.id,
            entityId: entity.id,
        });
        expect(result.receipt.affectedIds).toContain(artifact.id);
        expect(result.receipt.affectedIds).toContain(entity.id);
    });

    it('4. findSources reads through index but resolves owner-store records', async () => {
        await kernel.ingestArtifact({
            filename: 'federalist.md',
            content: Buffer.from('Federalist paper content'),
            mimeType: 'text/markdown',
            actorId: 'user-1',
        });
        await kernel.createEntity({
            kind: 'concept',
            name: 'Federalism',
            attributes: {},
            actorId: 'user-1',
        });

        const result = await kernel.findSources({ query: 'federalist' });

        // Should find both via index text search
        expect(result.indexRecords.length).toBeGreaterThanOrEqual(1);
        // Resolved from owner stores, not just index projections
        expect(
            result.resolvedArtifacts.length + result.resolvedEntities.length,
        ).toBeGreaterThanOrEqual(1);

        // Verify resolved items come from their owner stores
        for (const a of result.resolvedArtifacts) {
            expect(a.owner).toBe('artifact');
        }
        for (const e of result.resolvedEntities) {
            expect(e.owner).toBe('canonical');
        }
    });

    it('5. inspectEntity returns canonical truth, not index projection', async () => {
        const { entity } = await kernel.createEntity({
            kind: 'person',
            name: 'Bob',
            attributes: { title: 'Architect' },
            actorId: 'user-1',
        });

        const inspected = await kernel.inspectEntity(entity.id);

        // Comes from canonical store directly
        expect(inspected.owner).toBe('canonical');
        expect(inspected.id).toBe(entity.id);
        expect(inspected.attributes).toEqual({ title: 'Architect' });
    });

    it('6. traceProvenance walks ledger lineage', async () => {
        const { artifact } = await kernel.ingestArtifact({
            filename: 'trace-test.md',
            content: Buffer.from('trace content'),
            mimeType: 'text/markdown',
            actorId: 'user-1',
        });

        const trace = await kernel.traceProvenance(artifact.id);

        expect(trace.length).toBeGreaterThanOrEqual(1);
        expect(trace[0].subjectId).toBe(artifact.id);
        expect(trace[0].action).toBe('artifact_ingested');
    });

    it('7. proposeMutation does not mutate stores', async () => {
        const entitiesBefore = await cluster.canonical.list();
        const eventsBefore = await cluster.ledger.listEvents();

        const command = await kernel.proposeMutation({
            verb: 'create_entity',
            targetStore: 'canonical',
            payload: { kind: 'test', name: 'Ghost', attributes: {} },
            proposedBy: 'user-1',
        });

        expect(command.status).toBe('proposed');

        // Nothing changed in stores
        const entitiesAfter = await cluster.canonical.list();
        const eventsAfter = await cluster.ledger.listEvents();
        expect(entitiesAfter).toEqual(entitiesBefore);
        expect(eventsAfter).toEqual(eventsBefore);
    });

    it('8. commitMutation mutates only through typed command execution', async () => {
        const command = await kernel.proposeMutation({
            verb: 'create_entity',
            targetStore: 'canonical',
            payload: { kind: 'concept', name: 'Typed Mutation', attributes: {} },
            proposedBy: 'user-1',
        });

        // KERNEL-006: commit requires validated/approved status.
        await kernel.validateMutation(command.id);
        const result = await kernel.commitMutation(command.id, 'user-1');

        expect(result.command.status).toBe('committed');
        expect(result.receipt.resultSummary).toContain('Created entity');

        // Verify the entity actually exists now
        const entities = await cluster.canonical.list({ nameContains: 'Typed Mutation' });
        expect(entities).toHaveLength(1);
    });

    it('9. every committed command emits a receipt', async () => {
        await kernel.ingestArtifact({
            filename: 'r1.txt',
            content: Buffer.from('one'),
            mimeType: 'text/plain',
            actorId: 'user-1',
        });
        await kernel.createEntity({
            kind: 'test',
            name: 'Two',
            attributes: {},
            actorId: 'user-1',
        });

        const command = await kernel.proposeMutation({
            verb: 'create_entity',
            targetStore: 'canonical',
            payload: { kind: 'test', name: 'Three', attributes: {} },
            proposedBy: 'user-1',
        });
        await kernel.validateMutation(command.id);
        await kernel.commitMutation(command.id, 'user-1');

        const receipts = await kernel.listReceipts();
        // ingestArtifact (1) + createEntity (1) + commitMutation (1) = 3
        expect(receipts.length).toBeGreaterThanOrEqual(3);
    });

    it('10. missing provenance fails honestly', async () => {
        await expect(
            kernel.traceProvenance('nonexistent-id-12345'),
        ).rejects.toThrow(ProvenanceMissingError);
    });

    it('commitMutation rejects unknown command IDs', async () => {
        // KERNEL-C-005 (Wave C1-Amend): distinct typed error for the
        // not-found case. Pre-fix collapsed to CommandNotValidatedError;
        // the AI consumer can now branch on COMMAND_NOT_FOUND vs
        // COMMAND_NOT_VALIDATED.
        await expect(
            kernel.commitMutation('bogus-command-id', 'user-1'),
        ).rejects.toThrow(CommandNotFoundError);
    });
});
