/**
 * Wave V4 — A4 — MCP gate-refusal-as-error (AI-006) + tool-annotation spec keys (AI-007).
 *
 * Two findings, one authoritative file, driven through the REAL production MCP
 * surface (the registered `CallToolRequestSchema` / `ListToolsRequestSchema`
 * handlers over an in-memory transport — NOT a hand-passed boundary descriptor):
 *
 *  - AI-006 — the AI-facing approval gates (`cluster_commit_mutation` of a
 *    not-`approved` command; `cluster_compensate_mutation` of any committed
 *    command) NO LONGER return a refusal object on the success path. They throw
 *    ApprovalGateDeniedError, the catch arm redacts it into the CANONICAL error
 *    envelope, and the wire result carries `isError: true`. This is the whole
 *    point of the fix: a destructive-tool refusal must read as an ERROR to an
 *    MCP host, not as a successful tool result. The adversarial assertions below
 *    pin the EXACT pre-fix bug (`res.isError` falsy on a refusal).
 *
 *  - AI-007 — `ListToolsRequestSchema` emits, per tool, PURE MCP-spec annotation
 *    hint keys (`readOnlyHint`, `destructiveHint`, `idempotentHint`) and keeps
 *    the internal 5-field classification under a namespaced `_meta` key —
 *    NEVER co-mingled into `annotations` (a strict host validates annotations
 *    against the spec shape). `destructiveHint:true` ONLY on the two
 *    writesCluster tools (commit + compensate).
 *
 * CANONICAL wire shape (the contract this file pins):
 *   { content: [{ type:'text', text: JSON.stringify(body) }], isError: true }
 *   body = { error:<human msg>, code:<ClusterErrorCode>, retryable, remediation_hint,
 *            context, _meta:{operation:'error'}, next_valid_actions? }
 *   NOTE: the human message is under `body.error`, NOT `body.message`.
 *
 * Throwaway temp dirs only — NEVER the repo `.db-cluster/`. The production
 * server reads `DB_CLUSTER_DIR` at import time, so each scenario sets it to a
 * fresh tmp parent and `vi.resetModules()` + dynamic-imports a fresh server.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { ClusterSDK } from '../src/sdk/cluster-sdk.js';

// ─── Temp-dir bookkeeping ───────────────────────────────────────────────────

const tmpDirs: string[] = [];

function freshParentDir(label: string): string {
    const dir = mkdtempSync(join(tmpdir(), `wave-v4-gate-${label}-`));
    tmpDirs.push(dir);
    return dir;
}

afterEach(() => {
    while (tmpDirs.length) {
        const d = tmpDirs.pop();
        if (d) {
            try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
        }
    }
    delete process.env.DB_CLUSTER_DIR;
    delete process.env.DB_CLUSTER_MCP_ALLOW_PRIVILEGED;
    delete process.env.DB_CLUSTER_PRINCIPAL;
    delete process.env.DB_CLUSTER_MCP_TRUST_ZONE;
    vi.restoreAllMocks();
});

/**
 * Propose → validate → approve → commit a `create_entity` command on a raw SDK
 * bound to `clusterDir`. Returns the COMMITTED command id (what compensate
 * operates on).
 */
async function seedCommittedEntity(clusterDir: string, marker: string): Promise<string> {
    const sdk = new ClusterSDK({ clusterDir });
    const cmd = await sdk.proposeMutation({
        verb: 'create_entity',
        targetStore: 'canonical',
        payload: { kind: 'document', name: `seed-${marker}`, attributes: {} },
        proposedBy: 'seed',
    });
    await sdk.validateMutation(cmd.id);
    await sdk.approveMutation(cmd.id, 'seed-approver');
    const committed = await sdk.commitMutation(cmd.id, 'seed');
    expect(committed.command.status).toBe('committed');
    return cmd.id;
}

/** Stage a command to `validated` (NOT approved); return its id. */
async function seedValidatedEntity(clusterDir: string, marker: string): Promise<string> {
    const sdk = new ClusterSDK({ clusterDir });
    const cmd = await sdk.proposeMutation({
        verb: 'create_entity',
        targetStore: 'canonical',
        payload: { kind: 'document', name: `validated-${marker}`, attributes: {} },
        proposedBy: 'seed',
    });
    await sdk.validateMutation(cmd.id);
    return cmd.id;
}

/** Spin up the REAL exported MCP `server` over an in-memory transport. */
async function connectFreshServer(): Promise<{ client: Client; server: { close: () => Promise<void> } }> {
    vi.resetModules();
    const mod = await import('../src/mcp/server.js');
    const server = mod.server as unknown as {
        connect: (t: unknown) => Promise<void>;
        close: () => Promise<void>;
    };
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'wave-v4-gate-test', version: '0.0.0' }, { capabilities: {} });
    await client.connect(clientTransport);
    return { client, server };
}

/** Parse the single text content block + the top-level isError from a tool result. */
function parseToolResult(res: unknown): { body: Record<string, unknown>; isError: boolean } {
    const r = res as { content: Array<{ type: string; text: string }>; isError?: boolean };
    const text = r.content.find((c) => c.type === 'text')?.text ?? '{}';
    return { body: JSON.parse(text) as Record<string, unknown>, isError: r.isError === true };
}

// ════════════════════════════════════════════════════════════════════════════
// AI-006 — both AI-facing gate refusals read as ERRORS (isError:true), not
//          success-path objects, through the PRODUCTION CallTool handler.
// ════════════════════════════════════════════════════════════════════════════

describe('AI-006 — MCP gate refusals set isError on the production CallTool surface', () => {
    it('commit gate: a validated-but-not-approved commit is REFUSED as an ERROR (isError true)', async () => {
        const parent = freshParentDir('commit');
        mkdirSync(join(parent, '.db-cluster'), { recursive: true });
        process.env.DB_CLUSTER_DIR = parent;
        // No opt-in → ai-facing default → mcpCommitGateActive() === true.

        const commandId = await seedValidatedEntity(join(parent, '.db-cluster'), 'commit');

        const { client, server } = await connectFreshServer();
        try {
            const res = await client.callTool({
                name: 'cluster_commit_mutation',
                arguments: { commandId, actorId: 'ai' },
            });
            // ADVERSARIAL: the exact pre-fix bug was a refusal returned WITHOUT
            // isError. Assert directly on the raw result that isError is true.
            expect((res as { isError?: boolean }).isError).toBe(true);

            const { body, isError } = parseToolResult(res);
            expect(isError).toBe(true);
            expect(body.code).toBe('POLICY_DENIED');
            // Human message under `body.error` (NOT body.message — undefined on wire).
            expect(typeof body.error).toBe('string');
            expect((body.error as string).length).toBeGreaterThan(0);
            expect((body.error as string)).toMatch(/approve|approved/i);
            expect(body.message).toBeUndefined();
            expect((body._meta as Record<string, unknown>).operation).toBe('error');
            // Commit-gate context + lifecycle next action.
            expect((body.context as Record<string, unknown>).requiredStatus).toBe('approved');
            expect(body.next_valid_actions).toContain('cluster_approve_mutation');
            // No write occurred.
            expect(body.receipt).toBeUndefined();
        } finally {
            await client.close();
            await server.close();
        }
    });

    it('compensate gate: compensating a committed command is REFUSED as an ERROR (isError true)', async () => {
        const parent = freshParentDir('compensate');
        mkdirSync(join(parent, '.db-cluster'), { recursive: true });
        process.env.DB_CLUSTER_DIR = parent;
        // No opt-in → ai-facing default → compensate gate active.

        const commandId = await seedCommittedEntity(join(parent, '.db-cluster'), 'compensate');

        const { client, server } = await connectFreshServer();
        try {
            const res = await client.callTool({
                name: 'cluster_compensate_mutation',
                arguments: { commandId, compensatedBy: 'ai', reason: 'ai-side reversal attempt' },
            });
            // ADVERSARIAL: the destructive sibling must ALSO read as an error.
            expect((res as { isError?: boolean }).isError).toBe(true);

            const { body, isError } = parseToolResult(res);
            expect(isError).toBe(true);
            expect(body.code).toBe('POLICY_DENIED');
            expect(typeof body.error).toBe('string');
            expect((body.error as string)).toMatch(/operator|ai-facing|not available|privileged/i);
            expect(body.message).toBeUndefined();
            expect((body._meta as Record<string, unknown>).operation).toBe('error');
            // Compensate-gate context fields.
            expect((body.context as Record<string, unknown>).surface).toBe('ai-facing');
            expect((body.context as Record<string, unknown>).requiresPrivileged).toBe(true);
            // No compensating write occurred.
            expect(body.compensatingCommand).toBeUndefined();
            expect(body.receipt).toBeUndefined();
        } finally {
            await client.close();
            await server.close();
        }
    });

    it('NEITHER gate refusal ever comes back with isError falsy/undefined (the pre-fix bug)', async () => {
        const parent = freshParentDir('adversarial');
        mkdirSync(join(parent, '.db-cluster'), { recursive: true });
        process.env.DB_CLUSTER_DIR = parent;

        const committedId = await seedCommittedEntity(join(parent, '.db-cluster'), 'adv-committed');
        const validatedId = await seedValidatedEntity(join(parent, '.db-cluster'), 'adv-validated');

        const { client, server } = await connectFreshServer();
        try {
            const commitRes = await client.callTool({
                name: 'cluster_commit_mutation',
                arguments: { commandId: validatedId, actorId: 'ai' },
            }) as { isError?: boolean };
            const compRes = await client.callTool({
                name: 'cluster_compensate_mutation',
                arguments: { commandId: committedId, compensatedBy: 'ai', reason: 'x' },
            }) as { isError?: boolean };

            // The pre-fix bug: a refusal returned on the success path → isError
            // falsy. Both must now be strictly true.
            expect(commitRes.isError).toBe(true);
            expect(compRes.isError).toBe(true);
            expect(commitRes.isError).not.toBeFalsy();
            expect(compRes.isError).not.toBeFalsy();
        } finally {
            await client.close();
            await server.close();
        }
    });
});

// ════════════════════════════════════════════════════════════════════════════
// AI-007 — ListTools emits PURE spec annotation keys + namespaced classification
// ════════════════════════════════════════════════════════════════════════════

interface ListedTool {
    name: string;
    annotations?: Record<string, unknown>;
    _meta?: Record<string, unknown>;
}

describe('AI-007 — MCP tool annotations carry pure spec hint keys via listTools()', () => {
    /** Connect a fresh server against an (empty) throwaway cluster for listTools. */
    async function connectForList(): Promise<{ client: Client; server: { close: () => Promise<void> } }> {
        const parent = freshParentDir('listtools');
        mkdirSync(join(parent, '.db-cluster'), { recursive: true });
        process.env.DB_CLUSTER_DIR = parent;
        return connectFreshServer();
    }

    it('cluster_find_sources: readOnlyHint=true, destructiveHint=false, idempotentHint=true', async () => {
        const { client, server } = await connectForList();
        try {
            const { tools } = await client.listTools() as unknown as { tools: ListedTool[] };
            const t = tools.find((x) => x.name === 'cluster_find_sources');
            expect(t).toBeDefined();
            expect(t!.annotations).toBeDefined();
            expect(t!.annotations!.readOnlyHint).toBe(true);
            expect(t!.annotations!.destructiveHint).toBe(false);
            expect(t!.annotations!.idempotentHint).toBe(true);
        } finally {
            await client.close();
            await server.close();
        }
    });

    it('commit + compensate: destructiveHint=true, readOnlyHint=false', async () => {
        const { client, server } = await connectForList();
        try {
            const { tools } = await client.listTools() as unknown as { tools: ListedTool[] };
            for (const name of ['cluster_commit_mutation', 'cluster_compensate_mutation']) {
                const t = tools.find((x) => x.name === name);
                expect(t, name).toBeDefined();
                expect(t!.annotations!.destructiveHint, name).toBe(true);
                expect(t!.annotations!.readOnlyHint, name).toBe(false);
            }
        } finally {
            await client.close();
            await server.close();
        }
    });

    it('annotations carry the 3 spec hint keys and NO co-mingled internal flags (strict-host guard)', async () => {
        // The internal 5-field classification keys must NEVER appear in
        // `annotations` — a strict host validates annotations against the spec
        // shape and could choke on non-spec keys. (The MCP SDK may add its OWN
        // spec-legal keys such as `title`; we only forbid the INTERNAL flags
        // and require the 3 hint keys.)
        const INTERNAL_FLAGS = ['writesCluster', 'approvalSensitive', 'stagedOnly', 'requiresExistingCommand'];
        const SPEC_HINT_KEYS = ['readOnlyHint', 'destructiveHint', 'idempotentHint'];
        const { client, server } = await connectForList();
        try {
            const { tools } = await client.listTools() as unknown as { tools: ListedTool[] };
            expect(tools.length).toBeGreaterThan(0);
            for (const t of tools) {
                expect(t.annotations, t.name).toBeDefined();
                const keys = Object.keys(t.annotations!);
                // All 3 spec hint keys present.
                for (const k of SPEC_HINT_KEYS) {
                    expect(keys, `${t.name} missing ${k}`).toContain(k);
                }
                // NONE of the internal classification flags leaked in.
                for (const flag of INTERNAL_FLAGS) {
                    expect(keys, `${t.name} leaked internal flag ${flag} into annotations`).not.toContain(flag);
                }
                // `readOnly` (the internal flag name) must not appear either —
                // only the `readOnlyHint` spec key. Guard against the easy
                // co-mingle of spreading the 5-field object into annotations.
                expect(keys, `${t.name} leaked internal flag readOnly into annotations`).not.toContain('readOnly');
            }
        } finally {
            await client.close();
            await server.close();
        }
    });

    it('the internal 5-field classification is present under _meta[io.dbcluster/classification]', async () => {
        const { client, server } = await connectForList();
        try {
            const { tools } = await client.listTools() as unknown as { tools: ListedTool[] };
            const t = tools.find((x) => x.name === 'cluster_commit_mutation');
            expect(t).toBeDefined();
            const classification = t!._meta?.['io.dbcluster/classification'] as Record<string, unknown> | undefined;
            expect(classification).toBeDefined();
            for (const key of ['readOnly', 'writesCluster', 'approvalSensitive', 'stagedOnly', 'requiresExistingCommand']) {
                expect(classification, key).toHaveProperty(key);
            }
            // Sanity: commit is a writesCluster + approvalSensitive tool.
            expect(classification!.writesCluster).toBe(true);
            expect(classification!.approvalSensitive).toBe(true);
            expect(classification!.readOnly).toBe(false);
        } finally {
            await client.close();
            await server.close();
        }
    });

    it('EXACTLY the two writesCluster tools have destructiveHint=true (iterate all tools)', async () => {
        const { client, server } = await connectForList();
        try {
            const { tools } = await client.listTools() as unknown as { tools: ListedTool[] };
            const destructive = tools
                .filter((t) => t.annotations!.destructiveHint === true)
                .map((t) => t.name)
                .sort();
            expect(destructive).toEqual(['cluster_commit_mutation', 'cluster_compensate_mutation']);

            // Cross-check against the namespaced classification: destructiveHint
            // === writesCluster for every tool (no drift between the spec hint
            // and the internal flag).
            for (const t of tools) {
                const classification = t._meta?.['io.dbcluster/classification'] as Record<string, unknown> | undefined;
                expect(classification, t.name).toBeDefined();
                expect(t.annotations!.destructiveHint, t.name).toBe(classification!.writesCluster);
                expect(t.annotations!.readOnlyHint, t.name).toBe(classification!.readOnly);
                expect(t.annotations!.idempotentHint, t.name).toBe(classification!.readOnly);
            }
        } finally {
            await client.close();
            await server.close();
        }
    });
});
