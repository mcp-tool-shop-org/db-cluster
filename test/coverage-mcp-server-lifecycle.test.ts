/**
 * Coverage — MCP server command lifecycle over the REAL production handler.
 *
 * A fresh `server` (the exported MCP Server, wired to the CallTool/ListTools
 * handlers) is connected to an in-memory client against a throwaway cluster
 * directory. Two postures are exercised:
 *
 *  - TRUSTED operator (DB_CLUSTER_MCP_ALLOW_PRIVILEGED + an internal principal):
 *    the full propose -> validate -> approve -> commit -> compensate lifecycle,
 *    the success envelopes of every lifecycle/read tool, and EVERY typed
 *    lifecycle error code with the `next_valid_actions` the boundary derives
 *    from it (the agent's recovery map).
 *  - default AI-facing observer: a write attempt is a real kernel policy
 *    denial, which has NO lifecycle remedy, so `next_valid_actions` must be
 *    omitted rather than invented.
 *
 * Wire contract pinned: errors are `{ isError: true }` with body
 * `{ error, code, retryable, remediation_hint, context, _meta:{operation:'error'} }`.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const ENV_KEYS = [
    'DB_CLUSTER_DIR',
    'DB_CLUSTER_PRINCIPAL',
    'DB_CLUSTER_POLICIES_FILE',
    'DB_CLUSTER_MCP_ALLOW_PRIVILEGED',
    'DB_CLUSTER_MCP_TRUST_ZONE',
] as const;

type Body = Record<string, any>;

interface Harness {
    client: Client;
    close: () => Promise<void>;
    parent: string;
    call: (name: string, args?: Record<string, unknown>) => Promise<{ body: Body; isError: boolean }>;
}

async function connectServer(env: Record<string, string>): Promise<Harness> {
    const parent = mkdtempSync(join(tmpdir(), 'coverage-mcp-lifecycle-'));
    mkdirSync(join(parent, '.db-cluster'), { recursive: true });
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.DB_CLUSTER_DIR = parent;
    for (const [k, v] of Object.entries(env)) process.env[k] = v;

    vi.resetModules();
    const mod = await import('../src/mcp/server.js');
    const server = mod.server as unknown as { connect: (t: unknown) => Promise<void>; close: () => Promise<void> };
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'coverage-mcp-lifecycle', version: '0.0.0' }, { capabilities: {} });
    await client.connect(clientTransport);

    const call = async (name: string, args: Record<string, unknown> = {}) => {
        const res = (await client.callTool({ name, arguments: args })) as {
            content: Array<{ type: string; text: string }>;
            isError?: boolean;
        };
        const text = res.content.find((c) => c.type === 'text')?.text ?? '{}';
        return { body: JSON.parse(text) as Body, isError: res.isError === true };
    };

    return {
        client,
        parent,
        call,
        close: async () => {
            await client.close();
            await server.close();
            try { rmSync(parent, { recursive: true, force: true }); } catch { /* best-effort */ }
        },
    };
}

const OPERATOR = JSON.stringify({ id: 'op-1', name: 'Operator', roles: ['cluster-admin'], trustZone: 'internal' });

// The gate and principal are read from the environment on each call, so the env is
// held for the whole describe block and cleared in afterAll (not per test).
// ════════════════════════════════════════════════════════════════════════════
// Trusted operator: lifecycle, success envelopes, typed errors
// ════════════════════════════════════════════════════════════════════════════

describe('MCP server — trusted operator lifecycle', () => {
    let h: Harness;

    beforeAll(async () => {
        h = await connectServer({ DB_CLUSTER_MCP_ALLOW_PRIVILEGED: '1', DB_CLUSTER_PRINCIPAL: OPERATOR });
    });
    afterAll(async () => {
        await h.close();
        for (const k of ENV_KEYS) delete process.env[k];
    });

    const propose = async (name: string, extra: Record<string, unknown> = {}) => {
        const r = await h.call('cluster_propose_mutation', {
            verb: 'create_entity',
            targetStore: 'canonical',
            payload: { kind: 'document', name, attributes: { tier: 'gold' }, ...extra },
            proposedBy: 'op-1',
        });
        expect(r.isError).toBe(false);
        return r.body.command.id as string;
    };
    const validated = async (name: string) => {
        const id = await propose(name);
        await h.call('cluster_validate_mutation', { commandId: id });
        return id;
    };
    const approved = async (name: string) => {
        const id = await validated(name);
        await h.call('cluster_approve_mutation', { commandId: id, approvedBy: 'approver-1', note: 'ok' });
        return id;
    };
    const committed = async (name: string) => {
        const id = await approved(name);
        await h.call('cluster_commit_mutation', { commandId: id, actorId: 'op-1' });
        return id;
    };

    // ── success envelopes ──────────────────────────────────────────────────

    it('propose stages a command and says nothing was written', async () => {
        const { body, isError } = await h.call('cluster_propose_mutation', {
            verb: 'create_entity',
            targetStore: 'canonical',
            payload: { kind: 'document', name: 'Alpha', attributes: {} },
            proposedBy: 'op-1',
        });
        expect(isError).toBe(false);
        expect(body._meta).toMatchObject({ operation: 'propose', writesCluster: false, stagedOnly: true });
        expect(body._meta.warning).toContain('PROPOSED only');
        expect(body.command).toMatchObject({ verb: 'create_entity', targetStore: 'canonical', status: 'proposed', proposedBy: 'op-1' });
        // lifecycle metadata keys only appear once they exist
        expect(body.command.approvedBy).toBeUndefined();
        expect(body.command.committedBy).toBeUndefined();
    });

    it('validate reports the proposed -> validated transition and attaches the validation result', async () => {
        const id = await propose('Beta');
        const { body } = await h.call('cluster_validate_mutation', { commandId: id });
        expect(body._meta).toMatchObject({ operation: 'validate', commandId: id, statusTransition: 'proposed → validated' });
        expect(body.command.status).toBe('validated');
        expect(body.command.validation.valid).toBe(true);
    });

    it('approve records the approver and note and flags the call approval-sensitive', async () => {
        const id = await validated('Gamma');
        const { body } = await h.call('cluster_approve_mutation', { commandId: id, approvedBy: 'approver-1', note: 'looks fine' });
        expect(body._meta).toMatchObject({ operation: 'approve', approvalSensitive: true, statusTransition: 'validated → approved' });
        expect(body.command).toMatchObject({ status: 'approved', approvedBy: 'approver-1', approvalNote: 'looks fine' });
    });

    it('reject is terminal and records who rejected it and why', async () => {
        const id = await propose('Delta');
        const { body } = await h.call('cluster_reject_mutation', { commandId: id, rejectedBy: 'op-1', reason: 'not needed' });
        expect(body._meta).toMatchObject({ operation: 'reject', statusTransition: '→ rejected (terminal)' });
        expect(body._meta.warning).toContain('CANNOT be committed');
        expect(body.command).toMatchObject({ status: 'rejected', rejectedBy: 'op-1', rejectionReason: 'not needed' });
    });

    it('commit writes cluster truth, returns a sanitized receipt, and the entity version tools see it', async () => {
        const id = await approved('Epsilon');
        const { body, isError } = await h.call('cluster_commit_mutation', { commandId: id, actorId: 'op-1' });
        expect(isError).toBe(false);
        expect(body._meta).toMatchObject({ operation: 'write', writesCluster: true, approvalSensitive: true, statusTransition: '→ committed' });
        expect(body.command).toMatchObject({ status: 'committed', committedBy: 'op-1' });
        expect(body.receipt.commandId).toBe(id);
        expect(body.receipt._sourceType).toBeDefined();

        const entityId = body.receipt.affectedIds[0] as string;
        const versions = await h.call('cluster_list_entity_versions', { id: entityId });
        expect(versions.body._meta).toMatchObject({ operation: 'read', storeAccessed: 'canonical' });
        expect(versions.body._meta.empty_reason).toBeUndefined();
        expect(versions.body.versions).toHaveLength(1);
        expect(versions.body.versions[0].name).toBe('Epsilon');

        const v1 = await h.call('cluster_get_entity_version', { id: entityId, version: 1 });
        expect(v1.body.version.name).toBe('Epsilon');
        const v9 = await h.call('cluster_get_entity_version', { id: entityId, version: 9 });
        expect(v9.body.version).toBeNull();
    });

    it('entity versions for an unknown id are empty with empty_reason no_data', async () => {
        const { body, isError } = await h.call('cluster_list_entity_versions', { id: 'no-such-entity' });
        expect(isError).toBe(false);
        expect(body.versions).toEqual([]);
        expect(body._meta.empty_reason).toBe('no_data');
    });

    it('compensate reverses a committed command and returns both commands plus the receipt', async () => {
        const id = await committed('Zeta');
        const { body, isError } = await h.call('cluster_compensate_mutation', { commandId: id, compensatedBy: 'op-1', reason: 'mistake' });
        expect(isError).toBe(false);
        expect(body._meta).toMatchObject({ operation: 'compensate', commandId: id, statusTransition: 'committed → compensated' });
        expect(body.originalCommand).toMatchObject({ id, status: 'compensated', compensatedBy: 'op-1' });
        expect(body.originalCommand.compensatingCommandId).toBe(body.compensatingCommand.id);
        expect(body.compensatingCommand.verb).toBe('compensate');
        expect(body.receipt).toBeDefined();
    });

    it('inspect_command returns the lifecycle view, and list_commands filters by status', async () => {
        const id = await validated('Eta');
        const inspected = await h.call('cluster_inspect_command', { commandId: id });
        expect(inspected.body._meta).toMatchObject({ operation: 'read', writesCluster: false, commandId: id });
        expect(inspected.body.command).toMatchObject({ id, status: 'validated' });

        const listed = await h.call('cluster_list_commands', { status: 'validated' });
        expect(listed.body._meta).toMatchObject({ operation: 'read', storeAccessed: 'ledger' });
        expect(listed.body._meta.empty_reason).toBeUndefined();
        expect(listed.body.commands.map((c: Body) => c.id)).toContain(id);
        expect(listed.body.commands.every((c: Body) => c.status === 'validated')).toBe(true);
    });

    it('list_receipts honours the commandId filter; an unknown command id is no_match', async () => {
        const id = await committed('Theta');
        const mine = await h.call('cluster_list_receipts', { commandId: id });
        expect(mine.body.receipts).toHaveLength(1);
        expect(mine.body.receipts[0].commandId).toBe(id);
        expect(mine.body._meta.empty_reason).toBeUndefined();

        const unknown = await h.call('cluster_list_receipts', { commandId: 'no-such-command' });
        expect(unknown.body.receipts).toEqual([]);
        expect(unknown.body._meta.empty_reason).toBe('no_match');

        const all = await h.call('cluster_list_receipts', { limit: 1 });
        expect(all.body.receipts).toHaveLength(1);
    });

    // ── typed lifecycle errors and their recovery map ──────────────────────

    async function expectError(name: string, args: Record<string, unknown>, code: string) {
        const { body, isError } = await h.call(name, args);
        expect(isError, `${name} ${code}`).toBe(true);
        expect(body.code).toBe(code);
        expect(typeof body.error).toBe('string');
        expect(body._meta).toEqual({ operation: 'error' });
        expect(body.message).toBeUndefined();
        expect(typeof body.retryable).toBe('boolean');
        expect(typeof body.remediation_hint).toBe('string');
        return body;
    }

    it('COMMAND_NOT_VALIDATED (commit a proposed command) -> validate or reject', async () => {
        const id = await propose('E1');
        const body = await expectError('cluster_commit_mutation', { commandId: id, actorId: 'op-1' }, 'COMMAND_NOT_VALIDATED');
        expect(body.next_valid_actions).toEqual(['cluster_validate_mutation', 'cluster_reject_mutation']);
        expect(body.context.commandId).toBe(id);
    });

    it('COMMAND_REJECTED (commit a rejected command) -> propose anew', async () => {
        const id = await propose('E2');
        await h.call('cluster_reject_mutation', { commandId: id, rejectedBy: 'op-1', reason: 'nope' });
        const body = await expectError('cluster_commit_mutation', { commandId: id, actorId: 'op-1' }, 'COMMAND_REJECTED');
        expect(body.next_valid_actions).toEqual(['cluster_propose_mutation']);
        expect(body.context.reason).toBe('nope');
    });

    it('COMMAND_NOT_FOUND (commit an unknown id) -> propose anew', async () => {
        const body = await expectError('cluster_commit_mutation', { commandId: 'ghost', actorId: 'op-1' }, 'COMMAND_NOT_FOUND');
        expect(body.next_valid_actions).toEqual(['cluster_propose_mutation']);
    });

    it.each([
        ['cluster_inspect_command', { commandId: 'ghost' }],
        ['cluster_approve_mutation', { commandId: 'ghost', approvedBy: 'a' }],
        ['cluster_validate_mutation', { commandId: 'ghost' }],
        ['cluster_reject_mutation', { commandId: 'ghost', rejectedBy: 'a', reason: 'r' }],
        ['cluster_compensate_mutation', { commandId: 'ghost', compensatedBy: 'a', reason: 'r' }],
    ])('NOT_FOUND from %s -> propose anew', async (name, args) => {
        const body = await expectError(name, args, 'NOT_FOUND');
        expect(body.next_valid_actions).toEqual(['cluster_propose_mutation']);
        expect(body.context.recordId).toBe('ghost');
    });

    it('COMMAND_ALREADY_TERMINAL on a committed command -> compensate', async () => {
        const id = await committed('E3');
        const body = await expectError('cluster_commit_mutation', { commandId: id, actorId: 'op-1' }, 'COMMAND_ALREADY_TERMINAL');
        expect(body.context.terminalStatus).toBe('committed');
        expect(body.next_valid_actions).toEqual(['cluster_compensate_mutation']);
    });

    it('COMMAND_ALREADY_TERMINAL on a compensated command -> propose anew', async () => {
        const id = await committed('E4');
        await h.call('cluster_compensate_mutation', { commandId: id, compensatedBy: 'op-1', reason: 'undo' });
        const body = await expectError('cluster_commit_mutation', { commandId: id, actorId: 'op-1' }, 'COMMAND_ALREADY_TERMINAL');
        expect(body.context.terminalStatus).toBe('compensated');
        expect(body.next_valid_actions).toEqual(['cluster_propose_mutation']);
    });

    it.each([
        ['proposed', ['cluster_validate_mutation', 'cluster_reject_mutation']],
        ['validated', ['cluster_approve_mutation', 'cluster_reject_mutation']],
        ['approved', ['cluster_commit_mutation', 'cluster_reject_mutation']],
        ['committed', ['cluster_compensate_mutation']],
        ['rejected', ['cluster_inspect_command']],
        ['compensated', ['cluster_inspect_command']],
    ])('INVALID_STATE_TRANSITION out of %s names the legal next verbs', async (from, expected) => {
        let id: string;
        let name: string;
        let args: Record<string, unknown>;
        switch (from) {
            case 'proposed':
                id = await propose('T-proposed');
                name = 'cluster_approve_mutation'; args = { commandId: id, approvedBy: 'a' };
                break;
            case 'validated':
                id = await validated('T-validated');
                name = 'cluster_compensate_mutation'; args = { commandId: id, compensatedBy: 'a', reason: 'r' };
                break;
            case 'approved':
                id = await approved('T-approved');
                name = 'cluster_approve_mutation'; args = { commandId: id, approvedBy: 'a2' };
                break;
            case 'committed':
                id = await committed('T-committed');
                name = 'cluster_reject_mutation'; args = { commandId: id, rejectedBy: 'a', reason: 'r' };
                break;
            case 'rejected':
                id = await propose('T-rejected');
                await h.call('cluster_reject_mutation', { commandId: id, rejectedBy: 'a', reason: 'r' });
                name = 'cluster_approve_mutation'; args = { commandId: id, approvedBy: 'a' };
                break;
            default:
                id = await committed('T-compensated');
                await h.call('cluster_compensate_mutation', { commandId: id, compensatedBy: 'a', reason: 'r' });
                name = 'cluster_compensate_mutation'; args = { commandId: id, compensatedBy: 'a', reason: 'r' };
        }
        const body = await expectError(name, args, 'INVALID_STATE_TRANSITION');
        expect(body.context.from).toBe(from);
        expect(body.next_valid_actions).toEqual(expected);
    });

    it('a lifecycle tool failing with a code that has no lifecycle remedy omits next_valid_actions', async () => {
        const body = await expectError(
            'cluster_propose_mutation',
            { verb: 'create_entity', targetStore: 'canonical', payload: {}, proposedBy: '' },
            'INVALID_ACTOR',
        );
        expect('next_valid_actions' in body).toBe(false);
    });

    it('a failing NON-lifecycle tool never gets next_valid_actions (that key belongs to the lifecycle toolset)', async () => {
        const missing = await h.call('cluster_resolve', { uri: 'cluster://canonical/ghost' });
        expect(missing.isError).toBe(true);
        expect(missing.body.code).toBe('RESOLVE_NOT_FOUND');
        expect('next_valid_actions' in missing.body).toBe(false);

        const unknown = await h.call('no_such_tool', {});
        expect(unknown.isError).toBe(true);
        expect(unknown.body.code).toBe('INTERNAL_ERROR');
        expect(unknown.body.error).toContain('Unknown tool');
        expect('next_valid_actions' in unknown.body).toBe(false);
    });

    it('propose/validate of a structurally invalid command surfaces COMMAND_REJECTED with the validation reason', async () => {
        const r = await h.call('cluster_propose_mutation', {
            verb: 'create_entity', targetStore: 'canonical', payload: { bogus: 1 }, proposedBy: 'op-1',
        });
        const id = r.body.command.id as string;
        const body = await expectError('cluster_validate_mutation', { commandId: id }, 'COMMAND_REJECTED');
        expect(body.context.reason).toContain('create_entity requires kind and name');
        expect(body.next_valid_actions).toEqual(['cluster_propose_mutation']);
    });

    it('ListTools publishes spec annotations and keeps the 5-field classification under _meta', async () => {
        const { tools } = await h.client.listTools();
        const commit = tools.find((t) => t.name === 'cluster_commit_mutation')!;
        expect(commit.annotations).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: false });
        const find = tools.find((t) => t.name === 'cluster_find_sources')!;
        expect(find.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });
        expect((find._meta as Body)['io.dbcluster/classification']).toMatchObject({ readOnly: true, writesCluster: false });
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Default AI-facing observer: policy denial has no lifecycle remedy
// ════════════════════════════════════════════════════════════════════════════

describe('MCP server — default AI-facing observer', () => {
    let h: Harness;

    beforeAll(async () => {
        h = await connectServer({});
    });
    afterAll(async () => {
        await h.close();
        for (const k of ENV_KEYS) delete process.env[k];
    });

    it('a write attempt is denied by the kernel (POLICY_DENIED) and offers no next_valid_actions', async () => {
        const { body, isError } = await h.call('cluster_propose_mutation', {
            verb: 'create_entity',
            targetStore: 'canonical',
            payload: { kind: 'document', name: 'Nope', attributes: {} },
            proposedBy: 'mcp-ai-facing',
        });
        expect(isError).toBe(true);
        expect(body.code).toBe('POLICY_DENIED');
        expect('next_valid_actions' in body).toBe(false);
        expect(body._meta).toEqual({ operation: 'error' });
    });

    it('list_commands on a cluster with no commands reports empty_reason no_data', async () => {
        const { body, isError } = await h.call('cluster_list_commands', {});
        expect(isError).toBe(false);
        expect(body.commands).toEqual([]);
        expect(body._meta.empty_reason).toBe('no_data');
    });

    it('reads still work and an empty cluster reports no_data', async () => {
        const { body, isError } = await h.call('cluster_find_sources', { query: 'anything' });
        expect(isError).toBe(false);
        expect(body._meta.empty_reason).toBe('no_data');
        expect(body.indexRecords).toEqual([]);
    });
});
