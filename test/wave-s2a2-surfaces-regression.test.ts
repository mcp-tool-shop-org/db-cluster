/**
 * Wave S2-A2 — SDK & MCP surface confidentiality + gating regression tests.
 *
 * Protocol-v2 amend Wave S2-A2 (Fix Agent 1: SDK & MCP surfaces). Each test
 * below probes a FULL invariant — it must FAIL against pre-fix HEAD and PASS
 * after the corresponding source fix lands. Throwaway temp dirs only; never
 * the repo `.db-cluster/`.
 *
 * Findings covered:
 *  - REDACT-001 (HIGH)  — SDK `findSources` + `retrieveBundle().resolvedArtifacts`
 *                          leak `Artifact.storagePath` (absolute fs path) under
 *                          BOTH the no-policy raw kernel AND the default
 *                          `internal` empty-rules zone.
 *  - KERNEL-002 (MED)   — MCP boundary `buildSDKOptions()` defaults to a raw
 *                          (no-redaction) kernel. Post-fix it MUST default to
 *                          the `ai-facing` trust zone (redaction on) and MUST
 *                          refuse a self-asserted `internal`/`cluster-admin`
 *                          principal on the AI surface unless an explicit
 *                          operator opt-in is set.
 *  - INJECT-001 (MED)   — MCP commit tool not approval-gated. Post-fix, under
 *                          the ai-facing default boundary, a commit of a
 *                          `validated`-but-not-`approved` command is REFUSED
 *                          with an AiErrorEnvelope directing the caller to
 *                          `approve_mutation`; after approve, commit succeeds.
 *  - INJECT-002 (LOW)   — MCP policies-file not structurally validated. Post-fix
 *                          a malformed policies file is rejected and a
 *                          `__proto__` own-key does not pollute Object.prototype.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

import { ClusterSDK } from '../src/sdk/cluster-sdk.js';
import { buildSDKOptions, handleTool } from '../src/mcp/server.js';
import {
    DEFAULT_POLICIES,
    DEFAULT_TRUST_ZONES,
    DEFAULT_VISIBILITY_RULES,
} from '../src/policy/default-policies.js';
import type { Principal } from '../src/types/policy.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

const tmpDirs: string[] = [];

function freshClusterDir(label: string): string {
    const dir = mkdtempSync(join(tmpdir(), `wave-s2a2-${label}-`));
    tmpDirs.push(dir);
    const clusterDir = join(dir, '.db-cluster');
    mkdirSync(clusterDir, { recursive: true });
    return clusterDir;
}

/**
 * Seed an artifact through the full propose → validate → approve → commit
 * lifecycle on a (raw) SDK. Returns the artifact id and the SDK.
 */
async function seedArtifact(sdk: ClusterSDK, marker: string): Promise<string> {
    const buf = Buffer.from(`# secret evidence body — ${marker}`, 'utf-8');
    const cmd = await sdk.proposeMutation({
        verb: 'ingest_artifact',
        targetStore: 'artifact',
        payload: {
            filename: `${marker}.md`,
            content: buf,
            contentHash: createHash('sha256').update(buf).digest('hex'),
            mediaType: 'text/markdown',
        },
        proposedBy: 'seed',
    });
    await sdk.validateMutation(cmd.id);
    await sdk.approveMutation(cmd.id, 'seed-approver');
    const committed = await sdk.commitMutation(cmd.id, 'seed');
    expect(committed.command.status).toBe('committed');
    // Discover the artifact id back out via findSources.
    const found = await sdk.findSources(marker);
    expect(found.resolvedArtifacts.length).toBeGreaterThan(0);
    return found.resolvedArtifacts[0].id;
}

// The default internal zone admin principal (cluster-admin / internal).
const INTERNAL_ADMIN: Principal = {
    id: 'admin-s2a2',
    name: 'Admin',
    roles: ['cluster-admin'],
    trustZone: 'internal',
};

afterEach(() => {
    while (tmpDirs.length) {
        const d = tmpDirs.pop();
        if (d) {
            try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
        }
    }
    // Clean any env this suite set.
    delete process.env.DB_CLUSTER_PRINCIPAL;
    delete process.env.DB_CLUSTER_POLICIES_FILE;
    delete process.env.DB_CLUSTER_MCP_ALLOW_PRIVILEGED;
});

// ════════════════════════════════════════════════════════════════════════════
// REDACT-001 — SDK findSources + retrieveBundle.resolvedArtifacts strip storagePath
// ════════════════════════════════════════════════════════════════════════════

describe('REDACT-001 — SDK never leaks Artifact.storagePath', () => {
    // src/sdk/cluster-sdk.ts:293 (findSources raw pass-through) +
    // :318-332 (retrieveBundle sanitizes index+provenance but NOT
    // resolvedArtifacts). Both routed through sanitizeArtifactForOutput.

    it('findSources (no-policy raw SDK) returns artifacts WITHOUT storagePath but WITH content fields', async () => {
        const clusterDir = freshClusterDir('redact001-find-raw');
        const sdk = new ClusterSDK({ clusterDir }); // raw kernel, NO policies
        const artifactId = await seedArtifact(sdk, 'redact001findraw');

        const result = await sdk.findSources('redact001findraw');
        const art = result.resolvedArtifacts.find((a) => a.id === artifactId) as Record<string, unknown> | undefined;
        expect(art).toBeDefined();
        // storagePath (absolute fs path) MUST be absent.
        expect(art).not.toHaveProperty('storagePath');
        // Normal content fields MUST still be present.
        expect(art!.id).toBe(artifactId);
        expect(typeof art!.filename).toBe('string');
        expect(typeof art!.contentHash).toBe('string');
    });

    it('findSources (default internal empty-rules zone) returns artifacts WITHOUT storagePath but WITH content fields', async () => {
        const clusterDir = freshClusterDir('redact001-find-internal');
        // Policy-enforced SDK, default trust zones incl. `internal` (empty
        // redactionRules) under which the kernel returns the RAW artifact.
        const sdk = new ClusterSDK({
            clusterDir,
            policies: DEFAULT_POLICIES,
            trustZones: DEFAULT_TRUST_ZONES,
            visibilityRules: DEFAULT_VISIBILITY_RULES,
            principal: INTERNAL_ADMIN,
        });
        const artifactId = await seedArtifact(sdk, 'redact001findint');

        const result = await sdk.findSources('redact001findint');
        const art = result.resolvedArtifacts.find((a) => a.id === artifactId) as Record<string, unknown> | undefined;
        expect(art).toBeDefined();
        expect(art).not.toHaveProperty('storagePath');
        expect(art!.id).toBe(artifactId);
        expect(typeof art!.filename).toBe('string');
        expect(typeof art!.contentHash).toBe('string');
    });

    it('retrieveBundle().resolvedArtifacts (no-policy raw SDK) strips storagePath but keeps content fields', async () => {
        const clusterDir = freshClusterDir('redact001-bundle-raw');
        const sdk = new ClusterSDK({ clusterDir });
        const artifactId = await seedArtifact(sdk, 'redact001bundleraw');

        const bundle = await sdk.retrieveBundle('redact001bundleraw');
        const ra = bundle.resolvedArtifacts.find((r) => r.object.id === artifactId);
        expect(ra).toBeDefined();
        const obj = ra!.object as unknown as Record<string, unknown>;
        expect(obj).not.toHaveProperty('storagePath');
        expect(obj.id).toBe(artifactId);
        expect(typeof obj.filename).toBe('string');
        expect(typeof obj.contentHash).toBe('string');
    });

    it('retrieveBundle().resolvedArtifacts (default internal zone) strips storagePath but keeps content fields', async () => {
        const clusterDir = freshClusterDir('redact001-bundle-internal');
        const sdk = new ClusterSDK({
            clusterDir,
            policies: DEFAULT_POLICIES,
            trustZones: DEFAULT_TRUST_ZONES,
            visibilityRules: DEFAULT_VISIBILITY_RULES,
            principal: INTERNAL_ADMIN,
        });
        const artifactId = await seedArtifact(sdk, 'redact001bundleint');

        const bundle = await sdk.retrieveBundle('redact001bundleint');
        const ra = bundle.resolvedArtifacts.find((r) => r.object.id === artifactId);
        expect(ra).toBeDefined();
        const obj = ra!.object as unknown as Record<string, unknown>;
        expect(obj).not.toHaveProperty('storagePath');
        expect(obj.id).toBe(artifactId);
        expect(typeof obj.filename).toBe('string');
        expect(typeof obj.contentHash).toBe('string');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// KERNEL-002 — MCP boundary defaults to ai-facing redaction; refuses privileged
// ════════════════════════════════════════════════════════════════════════════

describe('KERNEL-002 — MCP boundary defaults to ai-facing (redaction on)', () => {
    // src/mcp/server.ts:81-176 buildSDKOptions.

    it('no env override → buildSDKOptions returns a policy-enforced ai-facing config', () => {
        delete process.env.DB_CLUSTER_PRINCIPAL;
        delete process.env.DB_CLUSTER_POLICIES_FILE;
        delete process.env.DB_CLUSTER_MCP_ALLOW_PRIVILEGED;

        const opts = buildSDKOptions();
        // Must carry default policies + trust zones (so the SDK builds a
        // PolicyEnforcedKernel rather than a raw kernel).
        expect(Array.isArray(opts.policies)).toBe(true);
        expect((opts.policies ?? []).length).toBeGreaterThan(0);
        expect(Array.isArray(opts.trustZones)).toBe(true);
        expect((opts.trustZones ?? []).some((z) => z.id === 'ai-facing')).toBe(true);
        // The acting principal must be in the ai-facing trust zone (NOT
        // internal/cluster-admin) so the kernel applies the ai-facing
        // redaction rules.
        expect(opts.principal).toBeDefined();
        expect(opts.principal!.trustZone).toBe('ai-facing');
    });

    it('no env override → find_sources MCP result strips artifact_content + storagePath', async () => {
        // Seed an artifact with a raw SDK, then read it back through the
        // ai-facing default boundary SDK to prove redaction fires with NO env.
        const clusterDir = freshClusterDir('kernel002-redact');
        const seedSdk = new ClusterSDK({ clusterDir });
        const artifactId = await seedArtifact(seedSdk, 'kernel002redact');

        // Build the ai-facing default boundary SDK against the SAME cluster.
        // Mirror the production default principal: read-only `observer` role
        // (DEFAULT_POLICIES grants reads) in the `ai-facing` zone (whose
        // redaction rules strip artifact_content).
        const aiFacing: Principal = {
            id: 'mcp-ai',
            name: 'MCP AI Surface',
            roles: ['observer'],
            trustZone: 'ai-facing',
        };
        const sdk = new ClusterSDK({
            clusterDir,
            policies: DEFAULT_POLICIES,
            trustZones: DEFAULT_TRUST_ZONES,
            visibilityRules: DEFAULT_VISIBILITY_RULES,
            principal: aiFacing,
        });

        const res = await handleTool('cluster_find_sources', { query: 'kernel002redact' }, sdk) as {
            resolvedArtifacts: Array<Record<string, unknown>>;
        };
        const art = res.resolvedArtifacts.find((a) => a.id === artifactId);
        // The ai-facing zone strips artifact_content → storagePath redacted by
        // the kernel, and the per-tool sanitizer removes the key entirely.
        expect(art).toBeDefined();
        expect(art).not.toHaveProperty('storagePath');
    });

    it('self-asserted internal principal env is REFUSED on the AI surface without opt-in', () => {
        process.env.DB_CLUSTER_PRINCIPAL = JSON.stringify(INTERNAL_ADMIN);
        delete process.env.DB_CLUSTER_MCP_ALLOW_PRIVILEGED;
        // Without the explicit operator opt-in, a principal claiming the
        // privileged `internal` zone must NOT be honored on the AI surface.
        expect(() => buildSDKOptions()).toThrow(/privileged|opt-in|ai-facing|DB_CLUSTER_MCP_ALLOW_PRIVILEGED/i);
    });

    it('self-asserted cluster-admin principal env is REFUSED on the AI surface without opt-in', () => {
        process.env.DB_CLUSTER_PRINCIPAL = JSON.stringify({
            id: 'sneaky',
            name: 'Sneaky',
            roles: ['cluster-admin'],
            trustZone: 'cluster-admin',
        });
        delete process.env.DB_CLUSTER_MCP_ALLOW_PRIVILEGED;
        expect(() => buildSDKOptions()).toThrow(/privileged|opt-in|ai-facing|DB_CLUSTER_MCP_ALLOW_PRIVILEGED/i);
    });

    it('explicit operator opt-in DOES honor a privileged internal principal', () => {
        process.env.DB_CLUSTER_PRINCIPAL = JSON.stringify(INTERNAL_ADMIN);
        process.env.DB_CLUSTER_MCP_ALLOW_PRIVILEGED = '1';
        const opts = buildSDKOptions();
        expect(opts.principal).toBeDefined();
        expect(opts.principal!.trustZone).toBe('internal');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// INJECT-001 — MCP commit approval-gated under the ai-facing default boundary
// ════════════════════════════════════════════════════════════════════════════

describe('INJECT-001 — MCP commit refuses non-approved command under ai-facing default', () => {
    // src/mcp/server.ts:792-833 commit/compensate handlers.

    it('commit of a validated-but-not-approved command under ai-facing default → AiErrorEnvelope refusal', async () => {
        const clusterDir = freshClusterDir('inject001-refuse');
        const sdk = new ClusterSDK({ clusterDir }); // trusted SDK seam for seeding

        // Stage a command to `validated` (NOT approved).
        const cmd = await sdk.proposeMutation({
            verb: 'create_entity',
            targetStore: 'canonical',
            payload: { kind: 'doc', name: 'inject001', attributes: {} },
            proposedBy: 'agent',
        });
        await sdk.validateMutation(cmd.id);

        // Commit through the MCP boundary WITH the ai-facing gate active.
        const refused = await handleTool(
            'cluster_commit_mutation',
            { commandId: cmd.id, actorId: 'agent' },
            sdk,
            { aiFacingGate: true },
        ) as Record<string, unknown>;

        // Must be a structured AiErrorEnvelope refusal (NOT a successful commit).
        expect((refused._meta as Record<string, unknown> | undefined)?.operation).toBe('error');
        expect(typeof refused.code).toBe('string');
        expect(typeof refused.remediation_hint).toBe('string');
        expect((refused.remediation_hint as string).toLowerCase()).toMatch(/approve/);
        expect(Array.isArray(refused.next_valid_actions)).toBe(true);
        expect(refused.next_valid_actions).toContain('cluster_approve_mutation');

        // The command must NOT have committed.
        const inspected = await sdk.inspectCommand(cmd.id);
        expect(inspected.status).toBe('validated');
    });

    it('after approve, commit through the ai-facing default boundary succeeds', async () => {
        const clusterDir = freshClusterDir('inject001-allow');
        const sdk = new ClusterSDK({ clusterDir });

        const cmd = await sdk.proposeMutation({
            verb: 'create_entity',
            targetStore: 'canonical',
            payload: { kind: 'doc', name: 'inject001ok', attributes: {} },
            proposedBy: 'agent',
        });
        await sdk.validateMutation(cmd.id);
        // Approve through the MCP boundary (approval is allowed; it is the gate).
        await handleTool(
            'cluster_approve_mutation',
            { commandId: cmd.id, approvedBy: 'operator' },
            sdk,
            { aiFacingGate: true },
        );

        const committed = await handleTool(
            'cluster_commit_mutation',
            { commandId: cmd.id, actorId: 'operator' },
            sdk,
            { aiFacingGate: true },
        ) as Record<string, unknown>;

        // Success envelope — writes cluster truth, returns a receipt.
        expect((committed._meta as Record<string, unknown>).writesCluster).toBe(true);
        expect(committed.receipt).toBeDefined();
        const inspected = await sdk.inspectCommand(cmd.id);
        expect(inspected.status).toBe('committed');
    });

    it('trusted SDK boundary (no ai-facing gate) still allows validated→commit', async () => {
        // Regression guard: the gate is MCP-surface-only. A trusted SDK caller
        // (no gate) retains the kernel's `validated`→commit path.
        const clusterDir = freshClusterDir('inject001-trusted');
        const sdk = new ClusterSDK({ clusterDir });
        const cmd = await sdk.proposeMutation({
            verb: 'create_entity',
            targetStore: 'canonical',
            payload: { kind: 'doc', name: 'inject001trust', attributes: {} },
            proposedBy: 'agent',
        });
        await sdk.validateMutation(cmd.id);
        const committed = await handleTool(
            'cluster_commit_mutation',
            { commandId: cmd.id, actorId: 'agent' },
            sdk,
        ) as Record<string, unknown>;
        expect((committed._meta as Record<string, unknown>).writesCluster).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// INJECT-002 — MCP policies-file structurally validated; __proto__ no pollution
// ════════════════════════════════════════════════════════════════════════════

describe('INJECT-002 — MCP policies-file structurally validated', () => {
    // src/mcp/server.ts:144 JSON.parse + destructure with no structural check.

    it('structurally-malformed policies file is rejected', () => {
        const clusterDir = freshClusterDir('inject002-malformed');
        const cwd = join(clusterDir, '..');
        // `policies` must be an array; here it is a string → must reject.
        const file = join(cwd, 'policies.json');
        writeFileSync(file, JSON.stringify({ policies: 'not-an-array' }), 'utf-8');

        const prevCwd = process.cwd();
        process.chdir(cwd);
        try {
            process.env.DB_CLUSTER_POLICIES_FILE = 'policies.json';
            expect(() => buildSDKOptions()).toThrow(/policy config|policies|expected an array|invalid/i);
        } finally {
            process.chdir(prevCwd);
        }
    });

    it('a __proto__ own-key in the policies file does not pollute Object.prototype', () => {
        const clusterDir = freshClusterDir('inject002-proto');
        const cwd = join(clusterDir, '..');
        const file = join(cwd, 'policies.json');
        // Raw JSON with a literal __proto__ key carrying a polluting payload.
        writeFileSync(file, '{"__proto__":{"polluted":"yes"},"policies":[]}', 'utf-8');

        const prevCwd = process.cwd();
        process.chdir(cwd);
        try {
            process.env.DB_CLUSTER_POLICIES_FILE = 'policies.json';
            // buildSDKOptions either rejects the file or ignores the proto key,
            // but in NO case may Object.prototype get polluted.
            try { buildSDKOptions(); } catch { /* rejection is acceptable */ }
            expect(({} as Record<string, unknown>).polluted).toBeUndefined();
            expect((Object.prototype as unknown as Record<string, unknown>).polluted).toBeUndefined();
        } finally {
            process.chdir(prevCwd);
        }
    });
});
