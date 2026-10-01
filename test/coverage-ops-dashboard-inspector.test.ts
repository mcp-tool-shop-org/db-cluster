/**
 * Coverage — dashboard inspector data: how kernel results map to
 * DashboardObjects for entities, artifacts, index records and commands,
 * including stale/missing index warnings and tolerant fallbacks.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLocalCluster } from '../src/adapters/local/index.js';
import { ClusterKernel } from '../src/kernel/cluster-kernel.js';
import {
    inspectEntity,
    inspectArtifact,
    inspectIndexRecord,
    inspectCommandObject,
} from '../src/dashboard/inspector-data.js';
import type { ClusterStores } from '../src/contracts/index.js';

const ACTOR = 'operator';

describe('inspector-data', () => {
    let dir: string;
    let stores: ClusterStores;
    let kernel: ClusterKernel;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'cov-inspector-'));
        stores = createLocalCluster(dir);
        kernel = new ClusterKernel(stores, { dataDir: dir });
    });
    afterEach(() => {
        vi.restoreAllMocks();
        rmSync(dir, { recursive: true, force: true });
    });

    describe('inspectEntity', () => {
        it('maps an entity with its provenance graph, receipts and fresh status', async () => {
            const { entity } = await kernel.createEntity({ kind: 'note', name: 'inspectable', attributes: { k: 'v' }, actorId: ACTOR });
            const obj = await inspectEntity(kernel, entity.id);
            expect(obj).toMatchObject({
                uri: `cluster://canonical/entity/${entity.id}`,
                id: entity.id,
                type: 'entity',
                name: 'inspectable',
                ownerStore: 'canonical',
                sourceType: 'owner-truth',
                freshness: 'fresh',
            });
            expect(obj.object).toEqual({
                id: entity.id, kind: 'note', name: 'inspectable', attributes: { k: 'v' },
                createdAt: entity.createdAt, updatedAt: entity.updatedAt,
            });
            expect(obj.receipts).toHaveLength(1);
            expect(obj.receipts[0].id).toBeTruthy();
            expect(obj.warnings).toEqual([]);
        });

        it('links related entities and evidence artifacts discovered through retrieval', async () => {
            const { entity } = await kernel.createEntity({ kind: 'note', name: 'zephyrword', attributes: {}, actorId: ACTOR });
            const { entity: sibling } = await kernel.createEntity({ kind: 'note', name: 'zephyrword sibling', attributes: {}, actorId: ACTOR });
            const { artifact } = await kernel.ingestArtifact({
                filename: 'zephyrword.txt', content: Buffer.from('zephyrword evidence'), mimeType: 'text/plain', actorId: ACTOR,
            });
            const obj = await inspectEntity(kernel, entity.id);
            const uris = obj.relationships.map((r) => `${r.edge}:${r.uri}`);
            expect(uris).toContain(`related:cluster://canonical/entity/${sibling.id}`);
            expect(uris).toContain(`evidence:cluster://artifact/source/${artifact.id}`);
            expect(obj.relationships.every((r) => r.uri !== `cluster://canonical/entity/${entity.id}`)).toBe(true);
        });

        it('reports a stale freshness and a stale_index warning when the index text has drifted', async () => {
            const { entity } = await kernel.createEntity({ kind: 'note', name: 'drifty', attributes: {}, actorId: ACTOR });
            // Change owner truth behind the index's back.
            await stores.canonical.update(entity.id, { name: 'drifty renamed' });
            const obj = await inspectEntity(kernel, entity.id);
            expect(obj.freshness).toBe('stale');
            expect(obj.warnings).toHaveLength(1);
            expect(obj.warnings[0]).toMatchObject({
                type: 'stale_index',
                severity: 'warn',
                message: 'Index text does not match current entity state',
                repairSuggestion: 'Run `db-cluster reindex`',
            });
            expect(obj.warnings[0].subjectUri).toMatch(/^cluster:\/\/index\/record\//);
        });

        it('degrades to unknown freshness and no warnings when staleness cannot be computed', async () => {
            const { entity } = await kernel.createEntity({ kind: 'note', name: 'tolerant', attributes: {}, actorId: ACTOR });
            vi.spyOn(kernel, 'listStaleRecords').mockRejectedValue(new Error('index unreadable'));
            const obj = await inspectEntity(kernel, entity.id);
            expect(obj.freshness).toBe('unknown');
            expect(obj.warnings).toEqual([]);
        });

        it('degrades to no relationships when retrieval fails', async () => {
            const { entity } = await kernel.createEntity({ kind: 'note', name: 'lonely', attributes: {}, actorId: ACTOR });
            vi.spyOn(kernel, 'retrieveBundle').mockRejectedValue(new Error('search unavailable'));
            const obj = await inspectEntity(kernel, entity.id);
            expect(obj.relationships).toEqual([]);
        });

        it('propagates the typed not-found error for an unknown entity', async () => {
            await expect(inspectEntity(kernel, 'no-such-entity')).rejects.toMatchObject({ code: 'NOT_FOUND' });
        });
    });

    describe('inspectArtifact', () => {
        it('maps a resolvable artifact and its receipts', async () => {
            const { artifact } = await kernel.ingestArtifact({
                filename: 'report.txt', content: Buffer.from('report body'), mimeType: 'text/plain', actorId: ACTOR,
            });
            vi.spyOn(kernel, 'findSources').mockResolvedValue({
                resolvedArtifacts: [artifact],
            } as unknown as Awaited<ReturnType<ClusterKernel['findSources']>>);
            const obj = await inspectArtifact(kernel, artifact.id);
            expect(obj).toMatchObject({
                uri: `cluster://artifact/source/${artifact.id}`,
                type: 'artifact',
                name: 'report.txt',
                ownerStore: 'artifact',
                sourceType: 'source-truth',
                freshness: 'fresh',
                relationships: [],
                warnings: [],
            });
            expect(obj.object).toEqual({
                id: artifact.id, filename: 'report.txt', contentHash: artifact.contentHash, mimeType: 'text/plain',
                sizeBytes: artifact.sizeBytes, version: artifact.version, ingestedAt: artifact.ingestedAt,
            });
            expect(obj.receipts).toHaveLength(1);
        });

        it('falls back to the bare id when the artifact is not among the resolved sources', async () => {
            const obj = await inspectArtifact(kernel, 'unresolved-artifact');
            expect(obj.name).toBe('unresolved-artifact');
            expect(obj.object).toEqual({ id: 'unresolved-artifact' });
            expect(obj.receipts).toEqual([]);
            // The trace of a missing artifact still reports the gap node.
            // The trace of an artifact that exists nowhere is a single MISSING gap node.
            expect(obj.provenanceGraph.nodes).toHaveLength(1);
            expect(obj.provenanceGraph.nodes[0].label).toContain('[MISSING]');
            expect(obj.provenanceGraph.edges).toEqual([]);
        });
    });

    describe('inspectIndexRecord', () => {
        it('maps a fresh index record to a projection relationship with no warnings', async () => {
            const { entity, indexRecord } = await kernel.createEntity({ kind: 'note', name: 'projected', attributes: {}, actorId: ACTOR });
            const obj = await inspectIndexRecord(kernel, indexRecord.id);
            expect(obj).toMatchObject({
                uri: `cluster://index/record/${indexRecord.id}`,
                type: 'index_record',
                name: `index/${indexRecord.id.slice(0, 8)}`,
                ownerStore: 'index',
                sourceType: 'derivative',
                freshness: 'fresh',
                warnings: [],
                receipts: [],
            });
            expect(obj.object).toMatchObject({ sourceStore: 'canonical', sourceId: entity.id, stale: false, sourceExists: true });
            expect(obj.relationships).toEqual([{
                uri: `cluster://canonical/entity/${entity.id}`,
                edge: 'projects',
                targetStore: 'canonical',
                targetType: 'entity',
            }]);
        });

        it('marks a drifted record stale with its cause and a repair suggestion', async () => {
            const { entity, indexRecord } = await kernel.createEntity({ kind: 'note', name: 'before', attributes: {}, actorId: ACTOR });
            await stores.canonical.update(entity.id, { name: 'after' });
            const obj = await inspectIndexRecord(kernel, indexRecord.id);
            expect(obj.freshness).toBe('stale');
            expect(obj.warnings).toHaveLength(1);
            expect(obj.warnings[0]).toMatchObject({
                type: 'stale_index',
                severity: 'warn',
                subjectUri: `cluster://index/record/${indexRecord.id}`,
            });
            expect(obj.warnings[0].message).toContain('does not match current entity');
            expect(obj.warnings[0].repairSuggestion).toContain('reindex');
        });

        it('marks a record whose source is gone as missing, with both stale and missing warnings', async () => {
            const orphan = await stores.index.index({
                sourceId: 'vanished-entity', sourceStore: 'canonical', text: 'note: vanished', metadata: {},
            });
            const obj = await inspectIndexRecord(kernel, orphan.id);
            expect(obj.freshness).toBe('missing');
            expect(obj.warnings.map((w) => w.type)).toEqual(['stale_index', 'missing_source']);
            expect(obj.warnings[0].message).toBe('Source entity vanished-entity no longer exists');
            expect(obj.warnings[1]).toMatchObject({ severity: 'error' });
            expect(obj.object).toMatchObject({ sourceExists: false, stale: true });
        });

        it('propagates the typed not-found error for an unknown record', async () => {
            await expect(inspectIndexRecord(kernel, 'no-such-record')).rejects.toMatchObject({ code: 'NOT_FOUND' });
        });
    });

    describe('inspectCommandObject', () => {
        it('maps a committed command with its receipts and lifecycle state', async () => {
            const cmd = await kernel.proposeMutation({
                verb: 'create_entity', targetStore: 'canonical',
                payload: { kind: 'note', name: 'via-command', attributes: {} }, proposedBy: 'agent',
            });
            await kernel.validateMutation(cmd.id);
            await kernel.commitMutation(cmd.id, ACTOR);
            const obj = await inspectCommandObject(kernel, cmd.id);
            expect(obj).toMatchObject({
                uri: `cluster://ledger/command/${cmd.id}`,
                type: 'command',
                name: 'create_entity (committed)',
                ownerStore: 'ledger',
                sourceType: 'append-only',
                warnings: [],
            });
            expect(obj.provenanceGraph).toEqual({ nodes: [], edges: [], warnings: [] });
            expect(obj.receipts).toHaveLength(1);
            expect(obj.receipts[0].commandId).toBe(cmd.id);
            expect(obj.commandState).toMatchObject({
                id: cmd.id, verb: 'create_entity', status: 'committed', proposedBy: 'agent',
            });
            expect(obj.commandState?.validatedAt).toBeTruthy();
            expect(obj.commandState?.committedAt).toBeTruthy();
        });

        it('adds a rejected_command warning carrying the rejection reason', async () => {
            const cmd = await kernel.proposeMutation({
                verb: 'create_entity', targetStore: 'canonical',
                payload: { kind: 'note', name: 'doomed', attributes: {} }, proposedBy: 'agent',
            });
            await kernel.validateMutation(cmd.id);
            await kernel.rejectMutation(cmd.id, 'reviewer', 'duplicate of an existing note');
            const obj = await inspectCommandObject(kernel, cmd.id);
            expect(obj.name).toBe('create_entity (rejected)');
            expect(obj.warnings).toEqual([{
                type: 'rejected_command',
                severity: 'warn',
                message: 'duplicate of an existing note',
            }]);
            expect(obj.commandState).toMatchObject({ status: 'rejected', rejectedBy: 'reviewer', rejectionReason: 'duplicate of an existing note' });
        });

        it('uses a generic message when a rejected command carries no reason', async () => {
            vi.spyOn(kernel, 'inspectCommand').mockResolvedValue({
                id: 'cmd-x', verb: 'create_entity', targetStore: 'canonical', payload: {},
                proposedAt: new Date().toISOString(), proposedBy: 'agent', status: 'rejected',
            });
            const obj = await inspectCommandObject(kernel, 'cmd-x');
            expect(obj.warnings[0].message).toBe('Command was rejected');
        });

        it('propagates the typed not-found error for an unknown command', async () => {
            await expect(inspectCommandObject(kernel, 'no-such-command')).rejects.toMatchObject({ code: 'NOT_FOUND' });
        });
    });
});
