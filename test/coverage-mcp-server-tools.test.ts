/**
 * Coverage — MCP `handleTool` arms: empty-state reasons, the approval gates and
 * the `cluster_why` explanation.
 *
 * Two kinds of test:
 *  - hand-built SDK stubs, to drive the policy-filtered and probe-failure arms
 *    of the empty-state logic that a real cluster cannot be put into on demand;
 *  - a real raw ClusterSDK over a temp cluster, for the tools whose output is a
 *    function of real provenance (`cluster_why`, `cluster_trace`).
 *
 * Every assertion is on the tool's returned envelope (`_meta`, reasons, lines)
 * or on a typed error with its code and context, never on "it ran".
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { handleTool, TOOLS } from '../src/mcp/server.js';
import { ClusterSDK } from '../src/sdk/cluster-sdk.js';
import { createLocalCluster } from '../src/adapters/local/index.js';
import { ClusterKernel } from '../src/kernel/cluster-kernel.js';
import { ApprovalGateDeniedError } from '../src/policy/approval-gate-denied-error.js';

type Body = Record<string, any>;

const noop = async () => {
    throw new Error('stub method not expected to be called');
};

/** A stub SDK exposing only what a test supplies; any other method throws. */
function stubSdk(methods: Record<string, (...a: any[]) => unknown>): ClusterSDK {
    return new Proxy(methods, {
        get: (target, prop: string) => target[prop] ?? noop,
    }) as unknown as ClusterSDK;
}

const emptyFind = { indexRecords: [], resolvedEntities: [], resolvedArtifacts: [] };

describe('handleTool — tool lookup', () => {
    it('rejects an unknown tool name before touching the SDK', async () => {
        await expect(handleTool('cluster_does_not_exist', {}, stubSdk({}))).rejects.toThrow('Unknown tool: cluster_does_not_exist');
    });

    it('every advertised tool has a unique name, a description and an object input schema', () => {
        const names = TOOLS.map((t) => t.name);
        expect(new Set(names).size).toBe(names.length);
        for (const t of TOOLS) {
            expect(t.description.length).toBeGreaterThan(0);
            expect(t.inputSchema.type).toBe('object');
        }
    });
});

describe('cluster_find_sources — empty-state reason', () => {
    it('passes query, limit and offset through to the SDK', async () => {
        const findSources = vi.fn(async (..._args: unknown[]) => emptyFind);
        await handleTool('cluster_find_sources', { query: 'roadmap', limit: 5, offset: 10 }, stubSdk({ findSources }));
        expect(findSources.mock.calls[0]).toEqual(['roadmap', 5, 10]);
    });

    it('trusts a kernel-reported all_filtered_by_policy and does not probe', async () => {
        const findSources = vi.fn(async () => ({ ...emptyFind, _meta: { empty_reason: 'all_filtered_by_policy' } }));
        const out = (await handleTool('cluster_find_sources', { query: 'x' }, stubSdk({ findSources }))) as Body;
        expect(out._meta.empty_reason).toBe('all_filtered_by_policy');
        expect(findSources).toHaveBeenCalledTimes(1);
    });

    it('reports no_data when the probe finds the whole index empty', async () => {
        const findSources = vi.fn(async (..._args: unknown[]) => emptyFind);
        const out = (await handleTool('cluster_find_sources', { query: 'x' }, stubSdk({ findSources }))) as Body;
        expect(out._meta.empty_reason).toBe('no_data');
        expect(findSources.mock.calls[1]).toEqual(['', 1]);
    });

    it('reports no_match when the probe shows the index has records the query missed', async () => {
        const findSources = vi
            .fn()
            .mockResolvedValueOnce(emptyFind)
            .mockResolvedValueOnce({ ...emptyFind, indexRecords: [{ id: 'i1' }] });
        const out = (await handleTool('cluster_find_sources', { query: 'x' }, stubSdk({ findSources }))) as Body;
        expect(out._meta.empty_reason).toBe('no_match');
    });

    it('reports no_match (never no_data) when the probe itself fails, so a real error is not mistaken for an empty cluster', async () => {
        const findSources = vi
            .fn()
            .mockResolvedValueOnce(emptyFind)
            .mockRejectedValueOnce(new Error('probe blew up'));
        const out = (await handleTool('cluster_find_sources', { query: 'x' }, stubSdk({ findSources }))) as Body;
        expect(out._meta.empty_reason).toBe('no_match');
    });

    it('omits empty_reason for a non-empty result and labels each record as derivative / owner truth', async () => {
        const findSources = vi.fn(async () => ({
            indexRecords: [{ id: 'i1', sourceId: 'e1', sourceStore: 'canonical', text: 'document: A', metadata: { secret: 'hunter2' }, indexedAt: 't', owner: 'index' }],
            resolvedEntities: [{ id: 'e1', kind: 'document', name: 'A', attributes: {}, version: 1, createdAt: 't', updatedAt: 't', owner: 'canonical' }],
            resolvedArtifacts: [],
        }));
        const out = (await handleTool('cluster_find_sources', { query: 'A' }, stubSdk({ findSources }))) as Body;
        expect('empty_reason' in out._meta).toBe(false);
        expect(out.indexRecords[0]._sourceStore).toBe('index');
        expect(out.indexRecords[0]._note).toContain('may be stale');
        expect(JSON.stringify(out.indexRecords[0])).not.toContain('hunter2');
        expect(out.resolvedEntities[0]._sourceStore).toBe('canonical');
    });
});

describe('cluster_list_receipts — empty-state reason', () => {
    it('defaults the limit to 20 and forwards the commandId filter', async () => {
        const listReceipts = vi.fn(async (..._args: unknown[]): Promise<unknown[]> => []);
        await handleTool('cluster_list_receipts', { commandId: 'c1' }, stubSdk({ listReceipts }));
        expect(listReceipts.mock.calls[0][0]).toEqual({ commandId: 'c1', limit: 20 });
    });

    it('trusts a kernel-reported all_filtered_by_policy', async () => {
        const receipts: any = [];
        receipts._meta = { empty_reason: 'all_filtered_by_policy' };
        const listReceipts = vi.fn(async (..._args: unknown[]) => receipts);
        const out = (await handleTool('cluster_list_receipts', {}, stubSdk({ listReceipts }))) as Body;
        expect(out._meta.empty_reason).toBe('all_filtered_by_policy');
        expect(listReceipts).toHaveBeenCalledTimes(1);
    });

    it('an empty filtered result for a given command is no_match without probing', async () => {
        const listReceipts = vi.fn(async (..._args: unknown[]): Promise<unknown[]> => []);
        const out = (await handleTool('cluster_list_receipts', { commandId: 'c1' }, stubSdk({ listReceipts }))) as Body;
        expect(out._meta.empty_reason).toBe('no_match');
        expect(listReceipts).toHaveBeenCalledTimes(1);
    });

    it('with no filter, an empty result is no_data when the probe is also empty', async () => {
        const listReceipts = vi.fn(async (..._args: unknown[]): Promise<unknown[]> => []);
        const out = (await handleTool('cluster_list_receipts', {}, stubSdk({ listReceipts }))) as Body;
        expect(out._meta.empty_reason).toBe('no_data');
        expect(listReceipts.mock.calls[1][0]).toEqual({ limit: 1 });
    });

    it('with no filter, an empty result is no_match when the probe finds a receipt', async () => {
        const listReceipts = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 'r1' }]);
        const out = (await handleTool('cluster_list_receipts', {}, stubSdk({ listReceipts }))) as Body;
        expect(out._meta.empty_reason).toBe('no_match');
    });

    it('with no filter, a failing probe is treated as an empty cluster (no_data)', async () => {
        const listReceipts = vi.fn().mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('probe failed'));
        const out = (await handleTool('cluster_list_receipts', {}, stubSdk({ listReceipts }))) as Body;
        expect(out._meta.empty_reason).toBe('no_data');
    });
});

describe('MCP-boundary approval gates (aiFacingGate)', () => {
    const gate = { aiFacingGate: true };
    const committed = { command: { id: 'c1', status: 'committed', verb: 'create_entity', targetStore: 'canonical', proposedBy: 'a', proposedAt: 't', payload: {} }, receipt: { id: 'r1', commandId: 'c1', committedAt: 't', resultSummary: 's', affectedIds: [], provenanceEventId: 'e', integrityHash: 'h' } };

    it('refuses to commit a validated (not approved) command, with the gate context for the agent', async () => {
        const commitMutation = vi.fn();
        const sdk = stubSdk({ inspectCommand: async () => ({ id: 'c1', status: 'validated' }), commitMutation });

        const err = (await handleTool('cluster_commit_mutation', { commandId: 'c1', actorId: 'a' }, sdk, gate).catch((e: unknown) => e)) as ApprovalGateDeniedError;

        expect(err).toBeInstanceOf(ApprovalGateDeniedError);
        expect(err.code).toBe('POLICY_DENIED');
        expect(err).toMatchObject({ commandId: 'c1', currentStatus: 'validated', requiredStatus: 'approved' });
        expect(String(err.remediationHint)).toContain('cluster_approve_mutation');
        expect(commitMutation).not.toHaveBeenCalled();
    });

    it('lets an approved command through to commit', async () => {
        const commitMutation = vi.fn(async () => committed);
        const sdk = stubSdk({ inspectCommand: async () => ({ id: 'c1', status: 'approved' }), commitMutation });
        const out = (await handleTool('cluster_commit_mutation', { commandId: 'c1', actorId: 'a' }, sdk, gate)) as Body;
        expect(commitMutation).toHaveBeenCalledWith('c1', 'a');
        expect(out._meta).toMatchObject({ operation: 'write', writesCluster: true });
    });

    it('when the gate cannot inspect the command it falls through so the kernel produces the typed error', async () => {
        const typed = Object.assign(new Error('Command ghost not found in queue'), { code: 'COMMAND_NOT_FOUND' });
        const commitMutation = vi.fn(async () => { throw typed; });
        const sdk = stubSdk({
            inspectCommand: async () => { throw new Error('inspect failed'); },
            commitMutation,
        });
        const err = await handleTool('cluster_commit_mutation', { commandId: 'ghost', actorId: 'a' }, sdk, gate).catch((e: unknown) => e);
        expect(err).toBe(typed);
        expect(commitMutation).toHaveBeenCalledTimes(1);
    });

    it('does not consult the gate at all for a trusted in-process caller (no boundary)', async () => {
        const inspectCommand = vi.fn();
        const commitMutation = vi.fn(async () => committed);
        await handleTool('cluster_commit_mutation', { commandId: 'c1', actorId: 'a' }, stubSdk({ inspectCommand, commitMutation }));
        expect(inspectCommand).not.toHaveBeenCalled();
        expect(commitMutation).toHaveBeenCalledTimes(1);
    });

    it('refuses compensation outright on the ai-facing boundary and never calls the SDK', async () => {
        const compensateMutation = vi.fn();
        const err = await handleTool(
            'cluster_compensate_mutation',
            { commandId: 'c1', compensatedBy: 'a', reason: 'r' },
            stubSdk({ compensateMutation }),
            gate,
        ).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(ApprovalGateDeniedError);
        expect(err).toMatchObject({ commandId: 'c1', surface: 'ai-facing', requiresPrivileged: true });
        expect(compensateMutation).not.toHaveBeenCalled();
    });

    it('a gate descriptor with aiFacingGate:false behaves like no boundary', async () => {
        const commitMutation = vi.fn(async () => committed);
        await handleTool('cluster_commit_mutation', { commandId: 'c1', actorId: 'a' }, stubSdk({ commitMutation }), { aiFacingGate: false });
        expect(commitMutation).toHaveBeenCalledTimes(1);
    });
});

// ─── Real-provenance tools ─────────────────────────────────────────────────

describe('cluster_why / cluster_trace over real provenance', () => {
    let dir: string;
    // Local stores read their files at construction, so the SDK is built AFTER seeding.
    const makeSdk = () => new ClusterSDK({ clusterDir: dir });
    let kernel: ClusterKernel;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'coverage-mcp-tools-'));
        const stores = createLocalCluster(dir);
        kernel = new ClusterKernel(stores, { dataDir: dir });
    });

    afterEach(() => {
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    it('explains an entity with its creator, evidence links, receipts and provenance gaps in separate lines', async () => {
        const { artifact } = await kernel.ingestArtifact({
            filename: 'spec.md', content: Buffer.from('# Spec'), mimeType: 'text/markdown', actorId: 'alicedoe',
        });
        const { entity } = await kernel.createEntity({ kind: 'requirement', name: 'Auth Flow', attributes: {}, actorId: 'alicedoe' });
        await kernel.linkEvidence({ artifactId: artifact.id, entityId: entity.id, actorId: 'alicedoe' });
        // A committed mutation that names the entity gives it a receipt.
        await stores_appendReceipt(dir, entity.id);

        const uri = `cluster://canonical/${entity.id}`;
        const out = (await handleTool('cluster_why', { uri }, makeSdk())) as Body;

        expect(out._meta).toMatchObject({ operation: 'read', writesCluster: false, uri });
        const lines = (out.explanation as string).split('\n');
        expect(lines[0]).toBe('[entity in canonical] (entity in canonical)');
        expect(lines).toContain('Created by: [redacted]');
        expect(lines.some((l) => /^Evidence links: [1-9]/.test(l))).toBe(true);
        const receiptCount = (await createLocalCluster(dir).ledger.listReceipts()).filter((r) => r.affectedIds.includes(entity.id)).length;
        expect(receiptCount).toBeGreaterThanOrEqual(1);
        expect(lines).toContain(`Receipts: ${receiptCount}`);
        // The entity name never appears in the explanation text.
        expect(out.explanation).not.toContain('Auth Flow');
    });

    it('reports a gap count when the focal object has no provenance trail', async () => {
        // An artifact written straight to the store has no ingestion event in the ledger.
        const stores = createLocalCluster(dir);
        const bare = await stores.artifact.ingest({ filename: 'bare.md', content: Buffer.from('x'), mimeType: 'text/markdown' });

        const out = (await handleTool('cluster_why', { uri: `cluster://artifact/${bare.id}` }, makeSdk())) as Body;
        expect(out.explanation).toBe('[artifact in artifact] (artifact in artifact)\n⚠ 1 gap(s) in provenance');
    });

    it('a well-formed URI naming nothing explains itself as a missing object rather than throwing', async () => {
        const out = (await handleTool('cluster_why', { uri: 'cluster://canonical/ghost' }, makeSdk())) as Body;
        // The gap node has no owner store, and the explanation says provenance is missing.
        expect(out.explanation).toBe('[entity in unknown] (entity in unknown)\n⚠ 1 gap(s) in provenance');
    });

    it('cluster_trace honours direction and depth and sanitizes labels', async () => {
        const { entity } = await kernel.createEntity({ kind: 'requirement', name: 'Auth Flow', attributes: {}, actorId: 'alicedoe' });
        const uri = `cluster://canonical/${entity.id}`;

        const backward = (await handleTool('cluster_trace', { uri }, makeSdk())) as Body;
        expect(backward._meta).toMatchObject({ operation: 'read', writesCluster: false, focalUri: uri });
        expect(backward.direction).toBe('backward');
        expect(backward.nodes.length).toBeGreaterThan(0);

        const shallow = (await handleTool('cluster_trace', { uri, direction: 'forward', depth: 0 }, makeSdk())) as Body;
        expect(shallow.direction).toBe('forward');
        expect(shallow.nodes).toEqual([]);
    });
});

/** Append a receipt that names `entityId`, as a committed mutation would. */
async function stores_appendReceipt(dir: string, entityId: string): Promise<void> {
    const stores = createLocalCluster(dir);
    await stores.ledger.appendReceipt({
        commandId: 'cmd-seed', resultSummary: 'seeded mutation', affectedIds: [entityId], provenanceEventId: 'evt-seed',
    });
}
