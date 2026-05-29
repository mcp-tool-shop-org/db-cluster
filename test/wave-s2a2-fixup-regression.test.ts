/**
 * Wave S2-A2 fix-up — targeted regression nets (Fixup Agent).
 *
 * Two independent verifier lenses found that the INJECT-001 MCP write-approval
 * gate was applied to `cluster_commit_mutation` but NOT its destructive sibling
 * `cluster_compensate_mutation`, and that the gate's PRODUCTION wiring (the
 * registered `CallToolRequestSchema` handler that feeds
 * `{ aiFacingGate: mcpCommitGateActive() }`) was untested — only the gate's
 * internal logic (`handleTool(..., { aiFacingGate: true })`) had coverage. This
 * file closes both gaps plus two LOW siblings.
 *
 * Test ids:
 *   - FIX 1 — `cluster_compensate_mutation` is REFUSED on the AI-facing default
 *     MCP surface (driven through the REAL registered CallTool handler over an
 *     in-memory transport, NOT a hand-passed boundary), and PROCEEDS once the
 *     operator opts into DB_CLUSTER_MCP_ALLOW_PRIVILEGED. FAILS at HEAD (the
 *     pre-fix compensate arm writes unconditionally).
 *   - [V3-001] — INJECT-001 PRODUCTION wiring: `mcpCommitGateActive()` is true
 *     with no env and false under the privileged opt-in, AND the production
 *     CallTool commit path refuses a `validated`-not-`approved` command. Pins
 *     the `{ aiFacingGate: mcpCommitGateActive() }` wiring so a refactor that
 *     drops it or flips the default is caught.
 *   - [V3-003] — REDACT-002 ledger pre-scrub end-to-end: a `cause.message`
 *     carrying a Windows-RELATIVE path is scrubbed to `<path>` in the PERSISTED
 *     ledger `mutation_orphaned.detail.error` (read back off disk), proving the
 *     A2 relative-path PATH_REGEX improvement reaches the immutable ledger.
 *   - FIX 3 — the CLI `PolicyConfigError` catch arm scrubs the absolute
 *     `POLICIES_FILE` path from its stderr output (sibling of REDACT-003).
 *     FAILS at HEAD (the arm printed raw `err.message`).
 *
 * Throwaway temp dirs only — NEVER the repo `.db-cluster/`. The MCP production
 * tests set `DB_CLUSTER_DIR` to a fresh tmp parent and `vi.resetModules()` +
 * dynamic-import the server so the module-level `CLUSTER_DIR` / memoized SDK
 * bind to the throwaway cluster, never the repo root.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { ClusterSDK } from '../src/sdk/cluster-sdk.js';
import { ClusterKernel } from '../src/kernel/cluster-kernel.js';
import { PolicyEnforcedKernel, PolicyDeniedError } from '../src/kernel/policy-enforced-kernel.js';
import { createLocalCluster } from '../src/adapters/local/index.js';
import { cliCommand } from '../src/cli.js';
import { PolicyConfigError } from '../src/mcp/config-validator.js';
import type { Principal, Policy, TrustZone } from '../src/types/policy.js';

// ─── Temp-dir bookkeeping ───────────────────────────────────────────────────

const tmpDirs: string[] = [];

/** A throwaway PARENT dir; `.db-cluster` is created beneath it. */
function freshParentDir(label: string): string {
    const dir = mkdtempSync(join(tmpdir(), `wave-s2a2-fixup-${label}-`));
    tmpDirs.push(dir);
    return dir;
}

/** A throwaway dir that already contains an (empty) `.db-cluster`. */
function freshClusterDir(label: string): string {
    const parent = freshParentDir(label);
    const clusterDir = join(parent, '.db-cluster');
    mkdirSync(clusterDir, { recursive: true });
    return clusterDir;
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
    delete process.env.DB_CLUSTER_POLICIES_FILE;
    delete process.env.DB_CLUSTER_MCP_TRUST_ZONE;
    vi.restoreAllMocks();
});

// ─── Shared lifecycle seed ──────────────────────────────────────────────────

/**
 * Propose → validate → approve → commit a `create_entity` command on a raw SDK
 * bound to `clusterDir`. Returns the COMMITTED command id (the thing
 * `compensate` operates on) so the production MCP path can later compensate it.
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

/**
 * Spin up the REAL exported MCP `server` over an in-memory transport and return
 * a connected MCP `Client`. The server's registered `CallToolRequestSchema`
 * handler is the production wiring under test — it computes
 * `{ aiFacingGate: mcpCommitGateActive() }` itself from the env.
 *
 * `DB_CLUSTER_DIR` MUST be set to a throwaway parent BEFORE this is called:
 * the server module reads it at import time to resolve `CLUSTER_DIR`, so we
 * `vi.resetModules()` + dynamic-import a fresh module instance per scenario.
 */
async function connectFreshServer(): Promise<{ client: Client; server: { close: () => Promise<void> } }> {
    vi.resetModules();
    const mod = await import('../src/mcp/server.js');
    const server = mod.server as unknown as {
        connect: (t: unknown) => Promise<void>;
        close: () => Promise<void>;
    };
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'fixup-test', version: '0.0.0' }, { capabilities: {} });
    await client.connect(clientTransport);
    return { client, server };
}

/** Parse the single text content block an MCP tool result carries. */
function parseToolResult(res: unknown): { body: Record<string, unknown>; isError: boolean } {
    const r = res as { content: Array<{ type: string; text: string }>; isError?: boolean };
    const text = r.content.find((c) => c.type === 'text')?.text ?? '{}';
    return { body: JSON.parse(text) as Record<string, unknown>, isError: r.isError === true };
}

// ════════════════════════════════════════════════════════════════════════════
// FIX 1 — cluster_compensate_mutation gated on the AI-facing surface
//          (driven through the REAL production CallTool handler)
// ════════════════════════════════════════════════════════════════════════════
//
// At HEAD the compensate arm (src/mcp/server.ts ~:1042) had NO gate and wrote
// directly. Post-fix, under the redacting ai-facing default (no
// DB_CLUSTER_MCP_ALLOW_PRIVILEGED), compensation is refused with an
// AiErrorEnvelope; with the operator opt-in it proceeds as before.

describe('FIX 1 — cluster_compensate_mutation refused on the AI-facing MCP surface', () => {
    it('PRODUCTION CallTool path: compensate of a committed command is REFUSED under the no-env ai-facing default', async () => {
        const parent = freshParentDir('fix1-refuse');
        mkdirSync(join(parent, '.db-cluster'), { recursive: true });
        process.env.DB_CLUSTER_DIR = parent;
        // No DB_CLUSTER_MCP_ALLOW_PRIVILEGED → ai-facing default → gate active.

        const commandId = await seedCommittedEntity(join(parent, '.db-cluster'), 'fix1refuse');

        const { client, server } = await connectFreshServer();
        try {
            const res = await client.callTool({
                name: 'cluster_compensate_mutation',
                arguments: { commandId, compensatedBy: 'ai', reason: 'attempted ai-side reversal' },
            });
            const { body } = parseToolResult(res);
            // Structured AiErrorEnvelope refusal — NOT a successful compensation.
            expect(body.code).toBe('POLICY_DENIED');
            expect(String(body.message)).toMatch(/operator|ai-facing|not available|privileged/i);
            expect(body.retryable).toBe(false);
            expect(String(body.remediation_hint)).toMatch(/DB_CLUSTER_MCP_ALLOW_PRIVILEGED|operator|CLI|SDK/i);
            // It did NOT write: no compensatingCommand / receipt in the body.
            expect(body.compensatingCommand).toBeUndefined();
            expect(body.receipt).toBeUndefined();
            expect((body._meta as Record<string, unknown>).operation).toBe('error');
        } finally {
            await client.close();
            await server.close();
        }
    });

    it('PRODUCTION CallTool path: compensate PROCEEDS once the operator opts into DB_CLUSTER_MCP_ALLOW_PRIVILEGED (with a privileged principal)', async () => {
        const parent = freshParentDir('fix1-privileged');
        mkdirSync(join(parent, '.db-cluster'), { recursive: true });
        process.env.DB_CLUSTER_DIR = parent;
        // Operator-controlled opt-in: relaxes BOTH the MCP commit/compensate
        // gate AND the privileged-trust-zone refusal, so a cluster-admin
        // principal (which the policy engine grants compensate_command) is
        // honored on this surface. Without the opt-in, enforceMcpTrustZone
        // would refuse this principal and the default observer cannot write.
        process.env.DB_CLUSTER_MCP_ALLOW_PRIVILEGED = '1';
        process.env.DB_CLUSTER_PRINCIPAL = JSON.stringify({
            id: 'ops-admin', name: 'Ops Admin', roles: ['cluster-admin'], trustZone: 'internal',
        });

        const commandId = await seedCommittedEntity(join(parent, '.db-cluster'), 'fix1priv');

        const { client, server } = await connectFreshServer();
        try {
            const res = await client.callTool({
                name: 'cluster_compensate_mutation',
                arguments: { commandId, compensatedBy: 'ops:lead', reason: 'authorized correction' },
            });
            const { body } = parseToolResult(res);
            // The gate is relaxed → the real compensation happened.
            expect(body.code).toBeUndefined();
            expect(body.compensatingCommand).toBeDefined();
            expect(body.originalCommand).toBeDefined();
            expect(body.receipt).toBeDefined();
            expect((body._meta as Record<string, unknown>).operation).toBe('compensate');
        } finally {
            await client.close();
            await server.close();
        }
    });
});

// ════════════════════════════════════════════════════════════════════════════
// [V3-001] — INJECT-001 PRODUCTION wiring (the gap: gate logic tested, its
//            production activation was not)
// ════════════════════════════════════════════════════════════════════════════

describe('[V3-001] INJECT-001 production wiring — mcpCommitGateActive() + CallTool commit refusal', () => {
    it('mcpCommitGateActive() returns true with no env and false under DB_CLUSTER_MCP_ALLOW_PRIVILEGED', async () => {
        delete process.env.DB_CLUSTER_MCP_ALLOW_PRIVILEGED;
        delete process.env.DB_CLUSTER_MCP_TRUST_ZONE;
        vi.resetModules();
        const mod1 = await import('../src/mcp/server.js');
        expect(mod1.mcpCommitGateActive()).toBe(true);

        process.env.DB_CLUSTER_MCP_ALLOW_PRIVILEGED = '1';
        expect(mod1.mcpCommitGateActive()).toBe(false);

        // A pinned privileged trust-zone also relaxes the gate.
        delete process.env.DB_CLUSTER_MCP_ALLOW_PRIVILEGED;
        process.env.DB_CLUSTER_MCP_TRUST_ZONE = 'internal';
        expect(mod1.mcpCommitGateActive()).toBe(false);
    });

    it('PRODUCTION CallTool commit path refuses a validated-but-not-approved command (the {aiFacingGate: mcpCommitGateActive()} wiring)', async () => {
        const parent = freshParentDir('v3001-commit');
        mkdirSync(join(parent, '.db-cluster'), { recursive: true });
        process.env.DB_CLUSTER_DIR = parent;
        // No opt-in → mcpCommitGateActive() === true → the handler must refuse.

        // Seed a command that is VALIDATED but NOT approved.
        const sdk = new ClusterSDK({ clusterDir: join(parent, '.db-cluster') });
        const cmd = await sdk.proposeMutation({
            verb: 'create_entity',
            targetStore: 'canonical',
            payload: { kind: 'document', name: 'v3001-validated', attributes: {} },
            proposedBy: 'seed',
        });
        await sdk.validateMutation(cmd.id);

        const { client, server } = await connectFreshServer();
        try {
            const res = await client.callTool({
                name: 'cluster_commit_mutation',
                arguments: { commandId: cmd.id, actorId: 'ai' },
            });
            const { body } = parseToolResult(res);
            // Refused at the production surface because the command is not yet approved.
            expect(body.code).toBe('POLICY_DENIED');
            expect(String(body.message)).toMatch(/approve|approved/i);
            expect(body.next_valid_actions).toContain('cluster_approve_mutation');
            // No receipt → no write occurred.
            expect(body.receipt).toBeUndefined();
        } finally {
            await client.close();
            await server.close();
        }
    });

    it('PRODUCTION CallTool commit path: an APPROVED command commits cleanly (positive control — the gate is specifically the approve step)', async () => {
        const parent = freshParentDir('v3001-approved');
        mkdirSync(join(parent, '.db-cluster'), { recursive: true });
        process.env.DB_CLUSTER_DIR = parent;
        // A privileged principal under the opt-in: proves the refusal above is
        // SPECIFICALLY the not-approved status, not a blanket commit denial.
        process.env.DB_CLUSTER_MCP_ALLOW_PRIVILEGED = '1';
        process.env.DB_CLUSTER_PRINCIPAL = JSON.stringify({
            id: 'ops-admin', name: 'Ops Admin', roles: ['cluster-admin'], trustZone: 'internal',
        });

        // Build an approved-but-not-committed command.
        const sdk = new ClusterSDK({ clusterDir: join(parent, '.db-cluster') });
        const cmd = await sdk.proposeMutation({
            verb: 'create_entity',
            targetStore: 'canonical',
            payload: { kind: 'document', name: 'v3001-approved', attributes: {} },
            proposedBy: 'seed',
        });
        await sdk.validateMutation(cmd.id);
        await sdk.approveMutation(cmd.id, 'seed-approver');

        const { client, server } = await connectFreshServer();
        try {
            const res = await client.callTool({
                name: 'cluster_commit_mutation',
                arguments: { commandId: cmd.id, actorId: 'ai' },
            });
            const { body } = parseToolResult(res);
            expect(body.code).toBeUndefined();
            expect(body.receipt).toBeDefined();
            expect((body._meta as Record<string, unknown>).operation).toBe('write');
        } finally {
            await client.close();
            await server.close();
        }
    });
});

// ════════════════════════════════════════════════════════════════════════════
// [V3-003] — REDACT-002 ledger pre-scrub: relative path scrubbed ON DISK
// ════════════════════════════════════════════════════════════════════════════
//
// recordOrphanMutation persists `redactErrorMessage(cause)` into the ledger's
// mutation_orphaned.detail.error. The A2 PATH_REGEX improvement added bare
// Windows-RELATIVE path matching (`Users\mikey\AppData\secret.dat`). This
// proves that improvement reaches the IMMUTABLE ledger end-to-end: force a
// receipt-write failure whose cause.message carries a relative path, then read
// the persisted event back off disk and assert it is scrubbed to `<path>`.

describe('[V3-003] REDACT-002 — relative-path scrub reaches the persisted ledger', () => {
    const RELATIVE_PATH = 'Users\\mikey\\AppData\\secret.dat';

    it('a relative path in a receipt-failure cause.message is scrubbed to <path> in the on-disk ledger', async () => {
        const parent = freshParentDir('v3003-ledger');
        const dir = join(parent, '.db-cluster');
        mkdirSync(dir, { recursive: true });
        const stores = createLocalCluster(dir);
        const kernel = new ClusterKernel(stores, { dataDir: dir });

        // Force the NEXT appendReceipt to throw with a relative-path-bearing
        // message — the orphan-recovery path persists redactErrorMessage(cause).
        const realAppendReceipt = stores.ledger.appendReceipt.bind(stores.ledger);
        let failedOnce = false;
        stores.ledger.appendReceipt = (async (receipt: unknown) => {
            if (!failedOnce) {
                failedOnce = true;
                throw new Error(`receipt write failed for ${RELATIVE_PATH}: disk full`);
            }
            return realAppendReceipt(receipt as never);
        }) as typeof stores.ledger.appendReceipt;

        await expect(
            kernel.createEntity({
                kind: 'document',
                name: 'OrphanSubject',
                attributes: {},
                actorId: 'admin-1',
            }),
        ).rejects.toThrow(); // ReceiptFailedError

        // Read the persisted ledger back OFF DISK (listEvents reads the store).
        const events = await stores.ledger.listEvents({});
        const orphaned = events.filter((e) => e.action === 'mutation_orphaned');
        expect(orphaned.length).toBeGreaterThanOrEqual(1);

        const persistedError = String((orphaned[0].detail as Record<string, unknown>).error ?? '');
        // The load-bearing assertion: the relative path is GONE from the
        // immutable ledger, replaced with the scrub marker.
        expect(persistedError).not.toContain(RELATIVE_PATH);
        expect(persistedError).not.toContain('mikey');
        expect(persistedError).toContain('<path>');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// FIX 3 — CLI PolicyConfigError arm scrubs the absolute POLICIES_FILE path
// ════════════════════════════════════════════════════════════════════════════
//
// At HEAD the PolicyConfigError catch arm in src/cli.ts printed raw
// `err.message`, which embeds the absolute POLICIES_FILE path (the error is
// constructed as `new PolicyConfigError(POLICIES_FILE, ...)`). Post-fix the arm
// routes through redactErrorForCli (same scrubber as the ClusterError /
// adapter-error siblings), so the path is replaced with `<path>` on stderr.

describe('FIX 3 — CLI PolicyConfigError arm scrubs the absolute policies-file path', () => {
    it('the cliCommand catch arm emits a <path>-scrubbed message for a PolicyConfigError carrying an absolute path', async () => {
        const ABS = process.platform === 'win32'
            ? 'C:\\Users\\mikey\\AppData\\secret\\.db-cluster\\policies.json'
            : '/home/mikey/secret/.db-cluster/policies.json';

        const stderrChunks: string[] = [];
        const stderrSpy = vi
            .spyOn(process.stderr, 'write')
            .mockImplementation(((chunk: string | Uint8Array): boolean => {
                stderrChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
                return true;
            }) as typeof process.stderr.write);
        // cliCommand calls process.exit on the error path — stub it to throw a
        // sentinel so the runner is not killed, then swallow that sentinel.
        const exitSpy = vi
            .spyOn(process, 'exit')
            .mockImplementation(((code?: number): never => {
                throw new Error(`__exit__:${code}`);
            }) as typeof process.exit);

        const wrapped = cliCommand(async () => {
            // POLICIES_FILE is passed as the `field` → it lands verbatim in
            // err.message ("Invalid policy config (<ABS>): ...").
            throw new PolicyConfigError(ABS, 'JSON.parse failed: Unexpected token');
        });

        await expect(wrapped()).rejects.toThrow(/__exit__/);

        const out = stderrChunks.join('');
        // Sanity: the arm actually ran and produced the policy-config headline.
        expect(out).toMatch(/Invalid policy config/i);
        // The load-bearing assertion: NO absolute path leaks; it is scrubbed.
        expect(out).not.toContain(ABS);
        expect(out).not.toContain('mikey');
        expect(out).toContain('<path>');

        stderrSpy.mockRestore();
        exitSpy.mockRestore();
    });
});

// ════════════════════════════════════════════════════════════════════════════
// FIX 2 — KERNEL-003 store/verb re-derivation extended to compensate
// ════════════════════════════════════════════════════════════════════════════
//
// At HEAD the policy-enforced compensateMutation gate was store/verb-blind:
// `enforce('compensate_command')` passed NO ownerStore, so a store-scoped
// compensate policy (allow ONLY when stores:['canonical']) could not match the
// underspecified request — the principal fell through to default-deny on EVERY
// compensate. That made a store-scoped compensate policy INEXPRESSIBLE. The fix
// re-derives the ORIGINAL command's targetStore (mirroring commitMutation) and
// passes { ownerStore, commandVerb: 'compensate' }, so the store-scoped allow
// matches and the legitimate canonical compensate PROCEEDS.

describe('FIX 2 — store-scoped compensate policy is now expressible', () => {
    // A principal whose compensate grant is SCOPED to the canonical store. The
    // default-deny tail (priority 1) denies anything the scoped allow doesn't
    // match — so pre-fix (store-blind gate) the canonical compensate is WRONGLY
    // denied; post-fix it is allowed.
    const STORE_SCOPED_COMPENSATOR: Principal = {
        id: 'canonical-compensator',
        name: 'Canonical-only Compensator',
        roles: ['canonical-compensator'],
        trustZone: 'internal',
    };
    const ADMIN: Principal = {
        id: 'admin-fix2', name: 'Admin', roles: ['cluster-admin'], trustZone: 'internal',
    };

    // Lower priority number = higher precedence (matches policy-kernel.test.ts).
    // No explicit default-deny tail is needed: the policy engine fails CLOSED
    // when no `allow` matches. An explicit `match:{}` deny would shadow even
    // the admin allow, so it is intentionally omitted.
    const policies: Policy[] = [
        // Admin allow-all (highest precedence) — used to seed the committed command.
        { id: 'admin-all', name: 'Admin', priority: 5, match: { principals: ['cluster-admin'] }, decision: 'allow', reason: 'admin' },
        // Store-scoped compensate allow. The store constraint is the whole
        // point: it only matches a request that carries ownerStore ===
        // 'canonical'. A store-blind enforce cannot satisfy it.
        {
            id: 'compensate-canonical-only',
            name: 'Compensate canonical only',
            priority: 20,
            match: { principals: ['canonical-compensator'], capabilities: ['compensate_command'], stores: ['canonical'] },
            decision: 'allow',
            reason: 'May compensate only in the canonical store.',
        },
        // The scoped compensator also needs the read verbs the gate / seed
        // read-back exercise.
        {
            id: 'compensator-reads',
            name: 'Compensator reads',
            priority: 20,
            match: { principals: ['canonical-compensator'], capabilities: ['read_command', 'discover_existence', 'read_owner_truth', 'read_derivative'] },
            decision: 'allow',
            reason: 'read access',
        },
    ];
    const trustZones: TrustZone[] = [
        { id: 'internal', name: 'Internal', defaultCapabilities: [], defaultScope: { stores: ['*'] }, approvalMode: 'auto', redactionRules: [], visibilityRules: [] },
    ];

    function makeKernels(dir: string): { restricted: PolicyEnforcedKernel; admin: PolicyEnforcedKernel } {
        const stores = createLocalCluster(dir);
        const restricted = new PolicyEnforcedKernel(stores, { principal: STORE_SCOPED_COMPENSATOR }, { policies, trustZones, dataDir: dir });
        const admin = new PolicyEnforcedKernel(stores, { principal: ADMIN }, { policies, trustZones, dataDir: dir });
        return { restricted, admin };
    }

    it('a canonical-store-scoped compensate grant ALLOWS compensating a canonical command (store-blind gate would deny it)', async () => {
        const parent = freshParentDir('fix2-scoped');
        const dir = join(parent, '.db-cluster');
        mkdirSync(dir, { recursive: true });
        const { restricted, admin } = makeKernels(dir);

        // Seed a committed create_entity (targetStore 'canonical') via admin.
        const created = await admin.createEntity({ kind: 'document', name: 'Fix2Subject', attributes: {}, actorId: 'admin' });
        // createEntity commits its own command; find that command id back via
        // the admin kernel's command list so we can compensate it.
        const cmd = await admin.proposeMutation({
            verb: 'create_entity', targetStore: 'canonical',
            payload: { kind: 'document', name: 'Fix2Compensable', attributes: {} }, proposedBy: 'admin',
        });
        await admin.validateMutation(cmd.id);
        await admin.approveMutation(cmd.id, 'admin');
        await admin.commitMutation(cmd.id, 'admin');
        void created;

        // Post-fix: the gate re-derives ownerStore='canonical', the scoped
        // allow matches → compensate PROCEEDS. Pre-fix the store-blind enforce
        // could not match the scoped allow → PolicyDeniedError.
        const result = await restricted.compensateMutation(cmd.id, 'canonical-compensator', 'scoped correction');
        expect(result.originalCommand.status).toBe('compensated');
        expect(result.compensatingCommand.status).toBe('committed');
    });

    it('preserves fail-closed: a principal with NO compensate grant is still denied (regression guard)', async () => {
        const parent = freshParentDir('fix2-failclosed');
        const dir = join(parent, '.db-cluster');
        mkdirSync(dir, { recursive: true });
        const stores = createLocalCluster(dir);
        // A principal with read access but NO compensate_command grant.
        const reader: Principal = { id: 'reader', name: 'Reader', roles: ['reader'], trustZone: 'internal' };
        const readerPolicies: Policy[] = [
            { id: 'admin-all', name: 'Admin', priority: 5, match: { principals: ['cluster-admin'] }, decision: 'allow', reason: 'admin' },
            { id: 'reader-reads', name: 'Reader reads', priority: 20, match: { principals: ['reader'], capabilities: ['read_command', 'discover_existence'] }, decision: 'allow', reason: 'read' },
            // No default-deny tail — the engine fails closed for the reader's
            // ungranted compensate_command (proven by the rejects assertion).
        ];
        const admin = new PolicyEnforcedKernel(stores, { principal: ADMIN }, { policies: readerPolicies, trustZones, dataDir: dir });
        const restricted = new PolicyEnforcedKernel(stores, { principal: reader }, { policies: readerPolicies, trustZones, dataDir: dir });

        const cmd = await admin.proposeMutation({
            verb: 'create_entity', targetStore: 'canonical',
            payload: { kind: 'document', name: 'Fix2FailClosed', attributes: {} }, proposedBy: 'admin',
        });
        await admin.validateMutation(cmd.id);
        await admin.approveMutation(cmd.id, 'admin');
        await admin.commitMutation(cmd.id, 'admin');

        // No compensate grant → PolicyDeniedError (the fix must NOT open a hole).
        await expect(
            restricted.compensateMutation(cmd.id, 'reader', 'unauthorized'),
        ).rejects.toThrow(PolicyDeniedError);
    });
});
