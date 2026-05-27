/**
 * Wave A3 — Surface domain regression tests (re-audit-2 findings).
 *
 * These tests probe FULL invariants — each test must FAIL against the pre-fix
 * code on HEAD and PASS after the corresponding Wave A3 Surface fix lands.
 *
 * Findings covered:
 * - SURFACE-R2-001 — CLI `resolve` bypasses policy entirely
 * - SURFACE-R2-002 — `DB_CLUSTER_POLICIES_FILE` path sandbox blocks dotdot but not symlinks
 * - SURFACE-R2-003 — SDK.resolve sanitizes only 2 of 5 store types
 * - SURFACE-R2-004 — `INTERNAL_TRUSTED_PRINCIPAL` silent fallback
 * - SURFACE-R2-006 — CLI `--self-approve` auto-walks `validate → approve → commit`
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import fc from 'fast-check';
import { execSync, spawnSync } from 'node:child_process';
import {
    mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, readFileSync, rmSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { ClusterSDK } from '../src/sdk/cluster-sdk.js';
import { createLocalCluster } from '../src/adapters/local/index.js';
import { ClusterKernel } from '../src/kernel/cluster-kernel.js';
import type { Policy, Principal } from '../src/types/policy.js';

const ROOT = resolve(import.meta.dirname, '..');
const CLI = `node ${join(ROOT, 'dist', 'cli.js')}`;
const MCP_SERVER = join(ROOT, 'dist', 'mcp', 'server.js');

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Seed a cluster directory with an admin-created entity and artifact. */
async function seedCluster(): Promise<{
    clusterDir: string;
    dir: string;
    entityId: string;
    artifactId: string;
    receiptId: string;
}> {
    const dir = mkdtempSync(join(tmpdir(), 'wave-a3-surface-'));
    execSync(`${CLI} init`, { cwd: dir, encoding: 'utf-8' });
    const clusterDir = join(dir, '.db-cluster');

    // Use a raw kernel to seed (no policies path here, just admin trust).
    const stores = createLocalCluster(clusterDir);
    const kernel = new ClusterKernel(stores, { dataDir: clusterDir });

    // Create an entity.
    const entityResult = await kernel.createEntity({
        kind: 'document',
        name: 'WaveA3SecretEntity',
        attributes: { secret: 'top-secret-attribute-value' },
        actorId: 'admin-seed',
    });

    // Ingest an artifact.
    const artifactResult = await kernel.ingestArtifact({
        filename: 'wave-a3-artifact.txt',
        content: Buffer.from('Some confidential artifact bytes.'),
        mimeType: 'text/plain',
        actorId: 'admin-seed',
    });

    return {
        clusterDir,
        dir,
        entityId: entityResult.entity.id,
        artifactId: artifactResult.artifact.id,
        receiptId: artifactResult.receipt.id,
    };
}

// ─── SURFACE-R2-001 — CLI resolve bypasses policy ──────────────────────────

describe('SURFACE-R2-001 — CLI resolve routes through policy/SDK', () => {
    it('CLI resolve does NOT emit storagePath for artifact URIs even without policies', async () => {
        // Full invariant: the CLI resolve subcommand must never print
        // raw owner-truth filesystem paths to stdout. Today the command
        // constructs a raw ClusterResolver and JSON-stringifies the object,
        // which includes `storagePath`. The fix routes through SDK or the
        // policy-enforced kernel wrapper which sanitizes artifacts.
        const { dir, artifactId } = await seedCluster();

        const out = execSync(`${CLI} resolve cluster://artifact/${artifactId}`, {
            cwd: dir, encoding: 'utf-8',
        });

        expect(out).not.toContain('storagePath');
    });

    it('CLI resolve does NOT emit storagePath for artifact URIs when policies are configured', async () => {
        const { dir, clusterDir, artifactId } = await seedCluster();

        // Write a permissive policy file — admin can read everything.
        const policiesFile = join(clusterDir, 'policies.json');
        writeFileSync(policiesFile, JSON.stringify({
            policies: [
                {
                    id: 'admin-full',
                    name: 'Admin Full Access',
                    priority: 10,
                    match: { principals: ['cluster-admin'] },
                    decision: 'allow',
                    reason: 'Admin.',
                },
            ],
        }), 'utf-8');

        const out = execSync(`${CLI} resolve cluster://artifact/${artifactId}`, {
            cwd: dir, encoding: 'utf-8',
        });

        // Even with policies configured + admin access, the storagePath
        // must not leak through the CLI surface.
        expect(out).not.toContain('storagePath');
    });
});

// ─── SURFACE-R2-002 — Symlink sandbox bypass ────────────────────────────────

describe('SURFACE-R2-002 — DB_CLUSTER_POLICIES_FILE path sandbox rejects symlinks', () => {
    it('symlink-via-DB_CLUSTER_POLICIES_FILE pointing outside cwd is rejected by buildSDKOptions', async () => {
        // Full invariant: the MCP server's buildSDKOptions must reject any
        // DB_CLUSTER_POLICIES_FILE that, after realpath resolution, points
        // outside the working directory. Symlinks that pass the lexical
        // check but resolve outside must be refused.
        const sandbox = mkdtempSync(join(tmpdir(), 'a3-sandbox-'));
        const outside = mkdtempSync(join(tmpdir(), 'a3-outside-'));

        // Write a real policies file outside the sandbox containing a marker.
        const outsideFile = join(outside, 'evil-policies.json');
        const evilPolicies = {
            policies: [
                {
                    id: 'evil',
                    name: 'EvilLeakMarker',
                    priority: 99,
                    match: { principals: ['anyone'] },
                    decision: 'allow',
                    reason: 'EvilLeakMarker',
                },
            ],
        };
        writeFileSync(outsideFile, JSON.stringify(evilPolicies), 'utf-8');

        // Create a symlink inside the sandbox pointing to the outside file.
        const linkInside = join(sandbox, 'policies.json');
        try {
            symlinkSync(outsideFile, linkInside);
        } catch (err: any) {
            // Windows often needs admin/privilege for symlinks — skip if so.
            if (err.code === 'EPERM' || err.code === 'ENOTSUP') {
                console.warn(`Skipping symlink test: ${err.code} (Windows needs admin / Developer Mode)`);
                return;
            }
            throw err;
        }

        // Initialize a cluster in the sandbox so the MCP server has a cluster.
        execSync(`${CLI} init`, { cwd: sandbox, encoding: 'utf-8' });

        // Import buildSDKOptions dynamically with env scoped to this test.
        const prevCwd = process.cwd();
        const prevEnv = process.env.DB_CLUSTER_POLICIES_FILE;
        const prevDir = process.env.DB_CLUSTER_DIR;
        try {
            process.chdir(sandbox);
            process.env.DB_CLUSTER_POLICIES_FILE = 'policies.json';
            process.env.DB_CLUSTER_DIR = sandbox;

            // Re-import so the module sees the new cwd.
            const mod = await import('../src/mcp/server.js?wave-a3-symlink-' + Date.now());
            const buildSDKOptions = (mod as any).buildSDKOptions;
            expect(typeof buildSDKOptions).toBe('function');

            let threw = false;
            let leaked = false;
            let opts: any = null;
            try {
                opts = buildSDKOptions();
            } catch (err: any) {
                threw = true;
                // The thrown error must NOT contain the leaked content marker.
                expect(String(err.message)).not.toContain('EvilLeakMarker');
            }

            if (!threw) {
                // If no throw, the policy file must NOT contain the outside policy.
                const policiesStr = JSON.stringify(opts?.policies ?? []);
                leaked = policiesStr.includes('EvilLeakMarker');
            }

            // Either it threw (good) OR it didn't follow the symlink (good).
            expect(leaked).toBe(false);
            expect(threw).toBe(true);
        } finally {
            process.chdir(prevCwd);
            if (prevEnv === undefined) delete process.env.DB_CLUSTER_POLICIES_FILE;
            else process.env.DB_CLUSTER_POLICIES_FILE = prevEnv;
            if (prevDir === undefined) delete process.env.DB_CLUSTER_DIR;
            else process.env.DB_CLUSTER_DIR = prevDir;
        }
    });
});

// ─── SURFACE-R2-003 — All 5 store types sanitized ───────────────────────────

describe('SURFACE-R2-003 — SDK.resolve sanitizes all 5 store types', () => {
    /**
     * Property-based: for each of the 5 store types resolvable through the
     * cluster resolver, the SDK.resolve output (when policy-enforced) must
     * be sanitized — no internal fields exposed.
     *
     * Fields per store type that must be redacted/sanitized:
     * - artifact:   `storagePath`
     * - canonical:  raw `attributes` (or marker indicating sanitization)
     * - ledger:     `actorId` + `detail`
     * - index:      `metadata`
     * - receipt:    `resultSummary`
     */
    it('all 5 store types — output is sanitized when policy-enforced', async () => {
        const { clusterDir, entityId, artifactId, receiptId } = await seedCluster();

        // Permissive policy: admin can read everything BUT redaction rules
        // strip the most sensitive fields. This proves the sanitization is
        // applied regardless of allow vs. redact path.
        const policies: Policy[] = [
            {
                id: 'admin-full',
                name: 'Admin Full',
                priority: 10,
                match: { principals: ['cluster-admin'] },
                decision: 'allow',
                reason: 'Admin.',
            },
        ];

        const admin: Principal = {
            id: 'admin-1',
            name: 'Admin',
            roles: ['cluster-admin'],
            trustZone: 'internal',
        };

        const sdk = new ClusterSDK({ clusterDir, policies, principal: admin });
        expect(sdk.policyEnforced).toBe(true);

        // 1. artifact resolution — no storagePath
        const artifactResolved = await sdk.resolve(`cluster://artifact/${artifactId}`);
        expect(artifactResolved.object).not.toHaveProperty('storagePath');

        // 2. canonical resolution — sanitized marker present, attributes not raw
        //    (the existing sanitizeEntityForOutput attaches _sourceType).
        const entityResolved = await sdk.resolve(`cluster://canonical/${entityId}`);
        expect((entityResolved.object as any)._sourceType).toBe('owner-truth');

        // 3. receipt resolution — sanitized (no raw resultSummary leak path)
        const receiptResolved = await sdk.resolve(`cluster://receipt/${receiptId}`);
        // After fix, receipt object carries _sourceType: 'audit-record'.
        expect((receiptResolved.object as any)._sourceType).toBe('audit-record');

        // 4. ledger event — read kernel/provenance to find one event ID.
        const stores = createLocalCluster(clusterDir);
        const events = await stores.ledger.listEvents({ limit: 5 });
        expect(events.length).toBeGreaterThan(0);
        const ledgerResolved = await sdk.resolve(`cluster://ledger/${events[0].id}`);
        // AGG-002 fix-up: replace the prior disjunction with a conjunction.
        // Production sanitizeProvenanceEventForOutput always emits ALL THREE
        // markers simultaneously (_sourceType, actorId=REDACTED, detail={}).
        // A regression that emits only ONE marker must fail this assertion.
        const ledgerObj = ledgerResolved.object as any;
        expect(ledgerObj._sourceType).toBe('audit-record');
        expect(ledgerObj.actorId).toBe('[REDACTED]');
        expect(ledgerObj.detail).toEqual({});

        // 5. index record — locate one via the index store.
        const indexList = await stores.index.search({ text: '', limit: 5 });
        expect(indexList.length).toBeGreaterThan(0);
        const idxResolved = await sdk.resolve(`cluster://index/${indexList[0].id}`);
        // AGG-002 fix-up: conjunctive form. Production
        // sanitizeIndexRecordForOutput always emits ALL THREE markers:
        // _sourceType='derivative', metadata=undefined (destructured out),
        // and _metadataPolicy notice string.
        const idxObj = idxResolved.object as any;
        expect(idxObj._sourceType).toBe('derivative');
        expect(idxObj.metadata).toBeUndefined();
        expect(typeof idxObj._metadataPolicy).toBe('string');
        expect(idxObj._metadataPolicy.length).toBeGreaterThan(0);
    });

    // AGG-002 fix-up — the unconditional-sanitization invariant.
    //
    // Pre-fix: SDK.resolve sanitization was inside `if (this.policyEnforced)`.
    // When the SDK was constructed WITHOUT policies (the ~614 baseline-tests
    // path), resolved.object was returned RAW for all 5 store types —
    // ledger leaked actorId+detail, index leaked metadata, receipt leaked
    // resultSummary, artifact leaked storagePath, canonical leaked attributes
    // (no `_sourceType` marker so callers couldn't tell). The fix-up moves
    // the 5-arm switch OUT of the policyEnforced guard so it runs UNCONDITIONALLY.
    //
    // This test runs every assertion through a NO-POLICY SDK and asserts the
    // sanitization markers are present anyway.
    it('SDK.resolve sanitizes ALL 5 store types EVEN WITHOUT policies configured', async () => {
        const { clusterDir, entityId, artifactId, receiptId } = await seedCluster();

        // No policies. No principal. The bare SDK path that the ~614
        // baseline tests use.
        const sdk = new ClusterSDK({ clusterDir });
        expect(sdk.policyEnforced).toBe(false);

        // 1. artifact — _sourceType marker AND no storagePath.
        const artifactResolved = await sdk.resolve(`cluster://artifact/${artifactId}`);
        expect((artifactResolved.object as any).storagePath).toBeUndefined();
        expect((artifactResolved.object as any)._sourceType).toBe('owner-truth');

        // 2. canonical — _sourceType marker.
        const entityResolved = await sdk.resolve(`cluster://canonical/${entityId}`);
        expect((entityResolved.object as any)._sourceType).toBe('owner-truth');

        // 3. receipt — _sourceType: 'audit-record'.
        const receiptResolved = await sdk.resolve(`cluster://receipt/${receiptId}`);
        expect((receiptResolved.object as any)._sourceType).toBe('audit-record');

        // 4. ledger — actorId=REDACTED + detail={} + _sourceType.
        const stores = createLocalCluster(clusterDir);
        const events = await stores.ledger.listEvents({ limit: 5 });
        expect(events.length).toBeGreaterThan(0);
        const ledgerResolved = await sdk.resolve(`cluster://ledger/${events[0].id}`);
        const ledgerObj = ledgerResolved.object as any;
        expect(ledgerObj._sourceType).toBe('audit-record');
        expect(ledgerObj.actorId).toBe('[REDACTED]');
        expect(ledgerObj.detail).toEqual({});

        // 5. index — _sourceType: 'derivative' + metadata removed + policy notice.
        const indexList = await stores.index.search({ text: '', limit: 5 });
        expect(indexList.length).toBeGreaterThan(0);
        const idxResolved = await sdk.resolve(`cluster://index/${indexList[0].id}`);
        const idxObj = idxResolved.object as any;
        expect(idxObj._sourceType).toBe('derivative');
        expect(idxObj.metadata).toBeUndefined();
        expect(typeof idxObj._metadataPolicy).toBe('string');
    });
});

// ─── SURFACE-R2-004 — INTERNAL_TRUSTED_PRINCIPAL silent fallback warning ────

describe('SURFACE-R2-004 — SDK warns when policies set without principal', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('warns when policies provided without principal', () => {
        // Full invariant: when policies is non-empty but principal is unset,
        // the SDK silently falls back to INTERNAL_TRUSTED_PRINCIPAL (cluster
        // admin). Today no warning fires. After the fix, console.warn must
        // be called with a message naming INTERNAL_TRUSTED_PRINCIPAL.
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const tmpDir = mkdtempSync(join(tmpdir(), 'a3-warn-'));
        execSync(`${CLI} init`, { cwd: tmpDir, encoding: 'utf-8' });

        new ClusterSDK({
            clusterDir: join(tmpDir, '.db-cluster'),
            policies: [
                {
                    id: 'p1', name: 'P1', priority: 10,
                    match: { principals: ['cluster-admin'] },
                    decision: 'allow', reason: 'admin',
                },
            ],
            // principal: OMITTED → silent fallback to INTERNAL_TRUSTED_PRINCIPAL.
        });

        const allCalls = warnSpy.mock.calls.flat().join(' ');
        expect(allCalls).toContain('INTERNAL_TRUSTED_PRINCIPAL');
    });

    it('does NOT warn when principal is explicitly set to INTERNAL_TRUSTED_PRINCIPAL', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const tmpDir = mkdtempSync(join(tmpdir(), 'a3-warn-explicit-'));
        execSync(`${CLI} init`, { cwd: tmpDir, encoding: 'utf-8' });

        new ClusterSDK({
            clusterDir: join(tmpDir, '.db-cluster'),
            policies: [
                {
                    id: 'p1', name: 'P1', priority: 10,
                    match: { principals: ['cluster-admin'] },
                    decision: 'allow', reason: 'admin',
                },
            ],
            principal: ClusterSDK.INTERNAL_TRUSTED_PRINCIPAL,
        });

        const allCalls = warnSpy.mock.calls.flat().join(' ');
        expect(allCalls).not.toContain('INTERNAL_TRUSTED_PRINCIPAL');
    });

    it('does NOT warn when principal is a custom (non-internal) value', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const tmpDir = mkdtempSync(join(tmpdir(), 'a3-warn-custom-'));
        execSync(`${CLI} init`, { cwd: tmpDir, encoding: 'utf-8' });

        new ClusterSDK({
            clusterDir: join(tmpDir, '.db-cluster'),
            policies: [
                {
                    id: 'p1', name: 'P1', priority: 10,
                    match: { principals: ['someone'] },
                    decision: 'allow', reason: 'something',
                },
            ],
            principal: {
                id: 'custom-1',
                name: 'Custom',
                roles: ['someone'],
                trustZone: 'ai-facing',
            },
        });

        const allCalls = warnSpy.mock.calls.flat().join(' ');
        expect(allCalls).not.toContain('INTERNAL_TRUSTED_PRINCIPAL');
    });
});

// ─── SURFACE-R2-006 — --self-approve requires explicit acknowledgment ──────

describe('SURFACE-R2-006 — CLI --self-approve auto-walk requires explicit ack', () => {
    it('--self-approve without --accept-soft-duty-bypass refuses and prints the bypass message', async () => {
        // Full invariant: when policies are NOT configured, the CLI
        // commit --self-approve subcommand auto-walks validate→approve→commit.
        // Per the fix, calling commit --self-approve alone must refuse
        // (nonzero exit) with a message referencing the soft-duty-bypass and
        // pointing to --accept-soft-duty-bypass to opt in.
        const { dir } = await seedCluster();

        // Propose a command to commit. Use spawnSync to avoid shell quoting on Windows.
        const proposePayload = JSON.stringify({
            verb: 'create_entity',
            targetStore: 'canonical',
            payload: { kind: 'note', name: 'Note', attributes: {} },
        });
        const propose = spawnSync('node', [
            join(ROOT, 'dist', 'cli.js'),
            '--actor', 'same-actor',
            'propose', proposePayload,
        ], { cwd: dir, encoding: 'utf-8' });
        expect(propose.status).toBe(0);
        const match = (propose.stdout ?? '').match(/Proposed command: ([a-zA-Z0-9_-]+)/);
        expect(match).toBeTruthy();
        const cmdId = match![1];

        // Call commit --self-approve WITHOUT --accept-soft-duty-bypass.
        // Same actor proposed and tries to commit → soft bypass.
        const result = spawnSync('node', [
            join(ROOT, 'dist', 'cli.js'),
            '--actor', 'same-actor',
            'commit', cmdId, '--self-approve',
        ], { cwd: dir, encoding: 'utf-8' });

        // Today the command succeeds. After the fix, it should fail with
        // an error message naming the soft-duty-bypass.
        const combined = (result.stderr ?? '') + (result.stdout ?? '');
        const refused = result.status !== 0 && /accept-soft-duty-bypass/i.test(combined);
        expect(refused).toBe(true);
    });

    it('--self-approve with --accept-soft-duty-bypass proceeds and emits the warning', async () => {
        const { dir } = await seedCluster();

        // Propose via spawnSync — avoids shell quoting on Windows.
        const proposePayload = JSON.stringify({
            verb: 'create_entity',
            targetStore: 'canonical',
            payload: { kind: 'note', name: 'Note2', attributes: {} },
        });
        const propose = spawnSync('node', [
            join(ROOT, 'dist', 'cli.js'),
            '--actor', 'proposer-x',
            'propose', proposePayload,
        ], { cwd: dir, encoding: 'utf-8' });
        expect(propose.status).toBe(0);
        const match = (propose.stdout ?? '').match(/Proposed command: ([a-zA-Z0-9_-]+)/);
        expect(match).toBeTruthy();
        const cmdId = match![1];

        const result = spawnSync('node', [
            join(ROOT, 'dist', 'cli.js'),
            '--actor', 'proposer-x',
            'commit', cmdId, '--self-approve', '--accept-soft-duty-bypass',
        ], { cwd: dir, encoding: 'utf-8' });

        // Must succeed.
        expect(result.status).toBe(0);
        // Must warn loudly about separation of duties.
        const combined = (result.stderr ?? '') + (result.stdout ?? '');
        expect(/separation of duties/i.test(combined) || /soft-duty-bypass/i.test(combined)).toBe(true);
    });
});
