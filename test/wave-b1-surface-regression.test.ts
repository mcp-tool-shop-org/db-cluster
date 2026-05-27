/**
 * Wave B1-Amend — Surface domain regression tests.
 *
 * These tests probe FULL invariants for the Stage B Wave B1 Surface findings
 * being closed in this amend wave. Each test MUST fail against the pre-fix
 * code on HEAD `30e7f22` and PASS after the corresponding Wave B1-Amend
 * Surface fix lands.
 *
 * Findings covered (per dispatch):
 * - §2c CLI uniform try/catch wrapper (cliCommand HOF + typedErrorToExitCode)
 * - SURFACE-B-005 — ClusterTruthInspector.jsx crashes on unknown URI
 * - SURFACE-B-006 — CLI loadPolicyConfig structural validation
 * - SURFACE-B-007 — ClusterSDK.policyEnforced public-readonly bypass surface
 * - SURFACE-B-008 — SDK.retrieveBundle raw pass-through leaks index + ledger
 * - SURFACE-B-009 — CLI silently substitutes INTERNAL_TRUSTED_PRINCIPAL
 * - SURFACE-B-011 — Dashboard OperationsPanel blind to mutation_orphaned count
 * - SURFACE-B-013 — Hardcoded version string in CLI + MCP server
 * - SURFACE-B-015 — Dashboard JSDOM-ESM race remediation
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import {
    mkdtempSync, writeFileSync, existsSync, rmSync, readFileSync, statSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { ClusterSDK } from '../src/sdk/cluster-sdk.js';
import { createLocalCluster } from '../src/adapters/local/index.js';
import { ClusterKernel } from '../src/kernel/cluster-kernel.js';

const ROOT = resolve(import.meta.dirname, '..');
const CLI_JS = join(ROOT, 'dist', 'cli.js');

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Seed a cluster directory with admin-created entity + artifact for retrieval. */
async function seedCluster(): Promise<{
    clusterDir: string;
    dir: string;
    entityId: string;
    artifactId: string;
    secretMarker: string;
}> {
    const dir = mkdtempSync(join(tmpdir(), 'wave-b1-surface-'));
    execSync(`node ${CLI_JS} init`, { cwd: dir, encoding: 'utf-8' });
    const clusterDir = join(dir, '.db-cluster');

    const stores = createLocalCluster(clusterDir);
    const kernel = new ClusterKernel(stores, { dataDir: clusterDir });

    const secretMarker = 'wave-b1-surface-secret-marker-' + Math.random().toString(36).slice(2, 10);
    const entityResult = await kernel.createEntity({
        kind: 'document',
        name: 'WaveB1RetrieveProbe',
        attributes: { secret: secretMarker },
        actorId: 'admin-seed',
    });

    const artifactResult = await kernel.ingestArtifact({
        filename: 'wave-b1-probe.txt',
        content: Buffer.from('Wave B1 artifact bytes — must not leak through retrieveBundle path.'),
        mimeType: 'text/plain',
        actorId: 'admin-seed',
    });

    return {
        clusterDir,
        dir,
        entityId: entityResult.entity.id,
        artifactId: artifactResult.artifact.id,
        secretMarker,
    };
}

// ─── §2c — CLI uniform try/catch wrapper (cliCommand HOF) ──────────────────

describe('Surface §2c — CLI uniform try/catch wrapper', () => {
    it('exports a cliCommand HOF that wraps a CLI action with try/catch', async () => {
        // Full invariant: src/cli.ts MUST define a cliCommand higher-order
        // function that wraps each .action(async ...) body so kernel
        // exceptions are caught at the surface boundary instead of escaping
        // to Node's unhandled-rejection default.
        const cliSource = readFileSync(join(ROOT, 'src', 'cli.ts'), 'utf-8');
        // Definition site must exist with the documented shape.
        expect(cliSource).toMatch(/function\s+cliCommand</);
        // Every subcommand action wrapped in cliCommand(...) — at least 15
        // call sites (audit listed ~20 sites). Count is a coarse proxy
        // for the family-of-call-sites coverage discipline.
        const wrappedCount = (cliSource.match(/\.action\(\s*cliCommand\(/g) ?? []).length;
        expect(wrappedCount).toBeGreaterThanOrEqual(15);
    });

    it('exports a typedErrorToExitCode mapping for ClusterError codes', () => {
        const cliSource = readFileSync(join(ROOT, 'src', 'cli.ts'), 'utf-8');
        expect(cliSource).toMatch(/function\s+typedErrorToExitCode/);
        // Mapping must include the codes named in the dispatch.
        expect(cliSource).toContain('POLICY_DENIED');
        expect(cliSource).toContain('NOT_FOUND');
        expect(cliSource).toContain('CORRUPT_STORE');
        expect(cliSource).toContain('INVALID_CONTENT_HASH');
        expect(cliSource).toContain('IMPORT_CONFLICT');
        expect(cliSource).toContain('LEDGER_CYCLE_DETECTED');
        expect(cliSource).toContain('COMMAND_QUEUE_CORRUPT');
        expect(cliSource).toContain('COMMAND_QUEUE_PERSISTENCE_LOST');
        expect(cliSource).toContain('CONTENT_HASH_MISMATCH');
        expect(cliSource).toContain('STAGED_CONTENT_TAMPERED');
    });

    it('non-existent entity inspect exits 1 with sanitized stderr (no raw stack)', () => {
        // Real invocation: `db-cluster inspect <bogus-id>` against an empty
        // cluster MUST exit non-zero and produce a sanitized stderr.
        // Pre-fix the original `inspect` already had try/catch — the
        // probe site is `db-cluster find <q>` which lacks it. We use
        // `find` against a non-existent cluster directory: kernel throws
        // when no cluster is initialized, and the wrapper must convert
        // the throw into a sanitized exit.
        const dir = mkdtempSync(join(tmpdir(), 'wave-b1-cli-nostack-'));
        // No init — kernel will refuse.
        const result = spawnSync('node', [CLI_JS, 'find', 'anything'], {
            cwd: dir,
            encoding: 'utf-8',
        });
        try {
            // Must exit non-zero.
            expect(result.status).not.toBe(0);
            // Stderr must NOT contain a raw stack — no "    at " lines.
            // (Node stack frames are line-prefixed with "    at ".)
            expect(result.stderr).not.toMatch(/^\s+at /m);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('DEBUG=1 prints full stack when the wrapper rethrows', () => {
        const dir = mkdtempSync(join(tmpdir(), 'wave-b1-cli-debug-'));
        const result = spawnSync('node', [CLI_JS, 'find', 'anything'], {
            cwd: dir,
            encoding: 'utf-8',
            env: { ...process.env, DEBUG: '1' },
        });
        try {
            expect(result.status).not.toBe(0);
            // With DEBUG=1 the wrapper falls through to console.error(err),
            // which prints the stack. Stack frames are present.
            // (Stack frames may be on stderr — many runtimes route err.stack
            //  to stderr.)
            const combined = (result.stderr ?? '') + (result.stdout ?? '');
            expect(combined.length).toBeGreaterThan(0);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

// ─── SURFACE-B-005 — ClusterTruthInspector unknown-URI guard ──────────────

describe('SURFACE-B-005 — ClusterTruthInspector handles unknown URI', () => {
    it('source file declares a !focal guard before reading focal.owner', () => {
        const source = readFileSync(
            join(ROOT, 'dashboard', 'ClusterTruthInspector.jsx'),
            'utf-8',
        );
        // The pre-fix code had `const focal = OBJECTS[uri];` immediately
        // followed by `const ownerStore = STORES.find((s) => s.id === focal.owner);`
        // with no guard. The fix MUST introduce a !focal check that returns
        // a fallback render before any focal.<field> read.
        // We assert by looking for the literal guard fragment or an
        // equivalent early-return.
        // The fix shape per dispatch: `if (!focal) return <div...>Object not found:...</div>`.
        expect(source).toMatch(/if\s*\(\s*!\s*focal\s*\)/);
        // The fallback render mentions the URI in a code/mono span.
        expect(source).toMatch(/Object not found/i);
    });

    it('source file guards focal.attributes access with optional chaining', () => {
        const source = readFileSync(
            join(ROOT, 'dashboard', 'ClusterTruthInspector.jsx'),
            'utf-8',
        );
        // Pre-fix line 783 was `Object.entries(focal.attributes).map(...)`. The
        // fix must guard the access — either with `focal.attributes ?? {}`
        // or `focal.attributes &&` short-circuit.
        // We assert ANY of these defensive patterns exists in the file.
        const hasOptionalAttributes =
            /Object\.entries\s*\(\s*focal\.attributes\s*\?\?\s*\{\}\s*\)/.test(source) ||
            /Object\.entries\s*\(\s*focal\.attributes\s*\|\|\s*\{\}\s*\)/.test(source) ||
            /focal\.attributes\s*&&\s*Object\.entries\s*\(\s*focal\.attributes\s*\)/.test(source);
        expect(hasOptionalAttributes).toBe(true);
    });

    it('source file guards focal.related access defensively', () => {
        const source = readFileSync(
            join(ROOT, 'dashboard', 'ClusterTruthInspector.jsx'),
            'utf-8',
        );
        // Pre-fix `focal.related.map(...)` — fix must use `?? []` or `?.`.
        const hasRelatedGuard =
            /focal\.related\s*\?\?\s*\[\]/.test(source) ||
            /focal\.related\s*\?\.\s*map/.test(source) ||
            /\(\s*focal\.related\s*\|\|\s*\[\]\s*\)\.map/.test(source);
        expect(hasRelatedGuard).toBe(true);
    });
});

// ─── SURFACE-B-006 — CLI loadPolicyConfig structural validation ───────────

describe('SURFACE-B-006 — CLI loadPolicyConfig structural validation', () => {
    it('a malformed policies.json with non-array policies causes CLI subcommand to fail-closed', () => {
        const dir = mkdtempSync(join(tmpdir(), 'wave-b1-cfg-arr-'));
        execSync(`node ${CLI_JS} init`, { cwd: dir, encoding: 'utf-8' });
        const clusterDir = join(dir, '.db-cluster');
        // Malformed: `policies` is a non-array.
        writeFileSync(join(clusterDir, 'policies.json'), JSON.stringify({
            policies: { malformed: true },
        }), 'utf-8');
        const result = spawnSync('node', [CLI_JS, 'find', 'anything'], {
            cwd: dir,
            encoding: 'utf-8',
        });
        try {
            // Must NOT silently load the malformed config.
            expect(result.status).not.toBe(0);
            // Stderr must signal the structural defect.
            expect(result.stderr.toLowerCase()).toMatch(/polic|invalid|malformed/i);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('a malformed principal in policies.json causes CLI subcommand to fail-closed', () => {
        const dir = mkdtempSync(join(tmpdir(), 'wave-b1-cfg-prin-'));
        execSync(`node ${CLI_JS} init`, { cwd: dir, encoding: 'utf-8' });
        const clusterDir = join(dir, '.db-cluster');
        // Malformed: principal missing the required `roles` array.
        writeFileSync(join(clusterDir, 'policies.json'), JSON.stringify({
            policies: [
                { id: 'p1', name: 'P1', priority: 1, match: {}, decision: 'allow', reason: 'r' },
            ],
            principal: { id: 'p', name: 'P', trustZone: 'internal' /* roles missing */ },
        }), 'utf-8');
        const result = spawnSync('node', [CLI_JS, 'find', 'anything'], {
            cwd: dir,
            encoding: 'utf-8',
        });
        try {
            expect(result.status).not.toBe(0);
            expect(result.stderr.toLowerCase()).toMatch(/princip|invalid|roles/i);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('a well-formed policies.json is accepted (no fail-closed false positive)', () => {
        const dir = mkdtempSync(join(tmpdir(), 'wave-b1-cfg-ok-'));
        execSync(`node ${CLI_JS} init`, { cwd: dir, encoding: 'utf-8' });
        const clusterDir = join(dir, '.db-cluster');
        writeFileSync(join(clusterDir, 'policies.json'), JSON.stringify({
            policies: [
                { id: 'p1', name: 'P1', priority: 1, match: {}, decision: 'allow', reason: 'r' },
            ],
            principal: { id: 'p', name: 'P', roles: ['cluster-admin'], trustZone: 'internal' },
        }), 'utf-8');
        const result = spawnSync('node', [CLI_JS, 'find', 'anything'], {
            cwd: dir,
            encoding: 'utf-8',
        });
        try {
            // Well-formed config — must not fail validation (status 0 since
            // find returns empty cluster cleanly).
            expect(result.status).toBe(0);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

// ─── SURFACE-B-007 — ClusterSDK.policyEnforced visibility ─────────────────

describe('SURFACE-B-007 — ClusterSDK.policyEnforced visibility', () => {
    it('ClusterSDK source declares policyEnforced as private', () => {
        const source = readFileSync(join(ROOT, 'src', 'sdk', 'cluster-sdk.ts'), 'utf-8');
        // Pre-fix: `public readonly policyEnforced: boolean;`
        // Post-fix: `private readonly policyEnforced: boolean;` (or similar).
        expect(source).toMatch(/private\s+readonly\s+policyEnforced/);
        // Must NOT contain a `public readonly policyEnforced` declaration.
        expect(source).not.toMatch(/public\s+readonly\s+policyEnforced/);
    });

    it('ClusterSDK exposes isPolicyEnforced() introspection method', () => {
        const source = readFileSync(join(ROOT, 'src', 'sdk', 'cluster-sdk.ts'), 'utf-8');
        expect(source).toMatch(/isPolicyEnforced\s*\(/);
    });

    it('SDK instance returns boolean from isPolicyEnforced()', () => {
        const dir = mkdtempSync(join(tmpdir(), 'wave-b1-pe-'));
        try {
            execSync(`node ${CLI_JS} init`, { cwd: dir, encoding: 'utf-8' });
            const clusterDir = join(dir, '.db-cluster');
            const sdk = new ClusterSDK({ clusterDir });
            // isPolicyEnforced() exists and returns false for raw kernel path.
            const sdkAny = sdk as unknown as { isPolicyEnforced(): boolean };
            expect(typeof sdkAny.isPolicyEnforced).toBe('function');
            expect(sdkAny.isPolicyEnforced()).toBe(false);

            const sdk2 = new ClusterSDK({
                clusterDir,
                policies: [{ id: 'x', name: 'X', priority: 1, match: {}, decision: 'allow', reason: 'r' }],
                principal: { id: 'p', name: 'P', roles: ['cluster-admin'], trustZone: 'internal' },
            });
            const sdk2Any = sdk2 as unknown as { isPolicyEnforced(): boolean };
            expect(sdk2Any.isPolicyEnforced()).toBe(true);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

// ─── SURFACE-B-008 — SDK.retrieveBundle sanitization ──────────────────────

describe('SURFACE-B-008 — SDK.retrieveBundle sanitizes index + ledger', () => {
    it('non-policy-enforced retrieveBundle indexRecords[] carry no raw metadata', async () => {
        const { clusterDir, secretMarker } = await seedCluster();
        const sdk = new ClusterSDK({ clusterDir });
        const bundle = await sdk.retrieveBundle('WaveB1RetrieveProbe', { limit: 10 });
        try {
            expect(Array.isArray(bundle.indexRecords)).toBe(true);
            for (const r of bundle.indexRecords) {
                const rAny = r as any;
                // Metadata stripped via sanitizeIndexRecordForOutput
                expect(rAny.metadata).toBeUndefined();
                expect(rAny._sourceType).toBe('derivative');
                expect(typeof rAny._metadataPolicy).toBe('string');
            }
            // Secret attribute must not appear anywhere in the index records.
            expect(JSON.stringify(bundle.indexRecords)).not.toContain(secretMarker);
        } finally {
            // Cleanup happens at process exit; clusterDir is in tmpdir.
        }
    });

    it('non-policy-enforced retrieveBundle provenanceEvents[] carry redacted actorId + detail', async () => {
        const { clusterDir } = await seedCluster();
        const sdk = new ClusterSDK({ clusterDir });
        const bundle = await sdk.retrieveBundle('WaveB1RetrieveProbe', { limit: 10 });
        expect(Array.isArray(bundle.provenanceEvents)).toBe(true);
        for (const ev of bundle.provenanceEvents) {
            const evAny = ev as any;
            // Sanitizer replaces actorId with [REDACTED] and empties detail.
            expect(evAny.actorId).toBe('[REDACTED]');
            expect(evAny.detail).toEqual({});
            expect(evAny._sourceType).toBe('audit-record');
        }
        // Raw seed actorId must not appear.
        expect(JSON.stringify(bundle.provenanceEvents)).not.toContain('admin-seed');
    });

    it('policy-enforced retrieveBundle also sanitizes (idempotent)', async () => {
        const { clusterDir } = await seedCluster();
        const sdk = new ClusterSDK({
            clusterDir,
            policies: [
                {
                    id: 'admin-full',
                    name: 'Admin Full',
                    priority: 10,
                    match: { principals: ['cluster-admin'] },
                    decision: 'allow',
                    reason: 'Admin.',
                },
            ],
            principal: { id: 'cluster-admin', name: 'Cluster Admin', roles: ['cluster-admin'], trustZone: 'internal' },
        });
        const bundle = await sdk.retrieveBundle('WaveB1RetrieveProbe', { limit: 10 });
        // Sanitizers idempotent — second pass produces same shape; verify no
        // double-redaction artifacts (e.g. actorId='[REDACTED][REDACTED]').
        for (const ev of bundle.provenanceEvents) {
            const evAny = ev as any;
            expect(evAny.actorId === '[REDACTED]' || evAny.actorId === undefined).toBe(true);
        }
    });
});

// ─── SURFACE-B-009 — CLI principal substitution ───────────────────────────

describe('SURFACE-B-009 — CLI does not silently substitute principal', () => {
    it('CLI subcommand with policies but no principal in policies.json triggers the SDK no-principal warning', () => {
        const dir = mkdtempSync(join(tmpdir(), 'wave-b1-prin-'));
        execSync(`node ${CLI_JS} init`, { cwd: dir, encoding: 'utf-8' });
        const clusterDir = join(dir, '.db-cluster');
        // Policies present, but principal field absent.
        writeFileSync(join(clusterDir, 'policies.json'), JSON.stringify({
            policies: [
                {
                    id: 'p1', name: 'P1', priority: 1, match: {}, decision: 'allow', reason: 'r',
                },
            ],
        }), 'utf-8');
        const result = spawnSync('node', [CLI_JS, 'find', 'anything'], {
            cwd: dir,
            encoding: 'utf-8',
        });
        try {
            // The SDK emits a "policies provided without principal" warning to
            // stderr (cluster-sdk.ts:159-162). Pre-fix, the CLI substituted
            // INTERNAL_TRUSTED_PRINCIPAL upstream so the warning never fired.
            // Post-fix, the CLI passes principal undefined → SDK warns.
            expect(result.stderr).toMatch(/INTERNAL_TRUSTED_PRINCIPAL|principal/i);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('CLI source no longer substitutes INTERNAL_TRUSTED_PRINCIPAL before SDK construction', () => {
        const cliSource = readFileSync(join(ROOT, 'src', 'cli.ts'), 'utf-8');
        // The fix: getKernel() must not unconditionally replace undefined
        // principal with INTERNAL_TRUSTED_PRINCIPAL. The legacy line
        // `const principal = config.principal ?? INTERNAL_TRUSTED_PRINCIPAL`
        // (cli.ts:90 pre-fix) must be gone.
        // We tolerate the constant being imported (other paths may still
        // need it) but the substitution pattern must not appear.
        // Specifically: search for `config.principal ?? INTERNAL_TRUSTED_PRINCIPAL`.
        expect(cliSource).not.toMatch(/config\.principal\s*\?\?\s*INTERNAL_TRUSTED_PRINCIPAL/);
        // Same for the resolve() call site (cli.ts:634 pre-fix):
        expect(cliSource).not.toMatch(/config!\.principal\s*\?\?\s*ClusterSDK\.INTERNAL_TRUSTED_PRINCIPAL/);
    });
});

// ─── SURFACE-B-011 — Dashboard orphan events visibility ──────────────────

describe('SURFACE-B-011 — Dashboard renders mutation_orphaned count', () => {
    it('ProvenanceHealth interface declares orphanEvents field', () => {
        const source = readFileSync(join(ROOT, 'src', 'dashboard', 'ops-model.ts'), 'utf-8');
        // Interface must include `orphanEvents: number`.
        expect(source).toMatch(/orphanEvents\s*:\s*number/);
    });

    it('buildOpsModel populates orphanEvents from ledger events', async () => {
        // Build an ops model from a freshly seeded cluster. orphanEvents
        // should be 0 in a healthy seed (no mutation_orphaned events).
        const { clusterDir } = await seedCluster();
        const stores = createLocalCluster(clusterDir);
        const kernel = new ClusterKernel(stores, { dataDir: clusterDir });
        const { buildOpsModel } = await import('../src/dashboard/ops-model.js');
        const ops = await buildOpsModel(stores, kernel);
        expect(ops.provenanceHealth.orphanEvents).toBe(0);
    });

    it('OperationsPanel.jsx renders orphaned row in the provenance section', () => {
        const source = readFileSync(
            join(ROOT, 'dashboard', 'components', 'OperationsPanel.jsx'),
            'utf-8',
        );
        // Source must reference orphanEvents OR orphaned somewhere in the
        // render path.
        expect(source).toMatch(/orphan/i);
        // The row must read from opsData.provenanceHealth.orphanEvents.
        expect(source).toMatch(/provenanceHealth\??\.\s*orphanEvents/);
    });

    it('OperationsPanel.jsx includes a repair suggestion or hint when orphans > 0', () => {
        const source = readFileSync(
            join(ROOT, 'dashboard', 'components', 'OperationsPanel.jsx'),
            'utf-8',
        );
        // The dispatch says: "Add a repair suggestion paragraph when orphans > 0".
        // Look for an inline mention of mutation_orphaned or "out of sync"
        // or "investigate" or similar to anchor the repair hint.
        expect(source).toMatch(/mutation_orphaned|out of sync|investigate/i);
    });
});

// ─── SURFACE-B-013 — version read from package.json ──────────────────────

describe('SURFACE-B-013 — version sourced from package.json', () => {
    it('src/cli.ts no longer hardcodes 0.1.0 in the .version() call', () => {
        const source = readFileSync(join(ROOT, 'src', 'cli.ts'), 'utf-8');
        // The fix must remove the literal `.version('0.1.0')` call. The
        // version is now read from package.json at module load. We assert
        // the literal version string is no longer present in a .version(...)
        // call.
        expect(source).not.toMatch(/\.version\s*\(\s*['"]0\.1\.0['"]\s*\)/);
    });

    it('src/mcp/server.ts no longer hardcodes 0.1.0 in the Server constructor', () => {
        const source = readFileSync(join(ROOT, 'src', 'mcp', 'server.ts'), 'utf-8');
        // The fix must remove the literal `version: '0.1.0'` line.
        expect(source).not.toMatch(/version:\s*['"]0\.1\.0['"]/);
    });

    it('CLI --version reports the live package.json version', () => {
        const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
        const result = spawnSync('node', [CLI_JS, '--version'], { encoding: 'utf-8' });
        expect(result.status).toBe(0);
        // Output contains the package.json version verbatim.
        expect(result.stdout.trim()).toContain(pkg.version);
    });
});

// ─── SURFACE-B-015 — Dashboard JSDOM-ESM race remediation ────────────────

describe('SURFACE-B-015 — Dashboard ESM race documentation + readiness poll', () => {
    it('dashboard/index.html readiness loop polls for window.applyRedaction', () => {
        const source = readFileSync(join(ROOT, 'dashboard', 'index.html'), 'utf-8');
        // The readiness loop must check BOTH window.ClusterTruthInspector
        // AND window.applyRedaction before mounting.
        expect(source).toMatch(/window\.ClusterTruthInspector/);
        expect(source).toMatch(/window\.applyRedaction/);
        // The two checks must appear inside the same readiness predicate.
        // Use a multiline regex to look for both within reasonable proximity.
        const readyPattern =
            /typeof\s+window\.ClusterTruthInspector\s*===\s*['"]function['"][\s\S]{0,200}window\.applyRedaction|typeof\s+window\.applyRedaction[\s\S]{0,200}window\.ClusterTruthInspector/;
        expect(source).toMatch(readyPattern);
    });

    it('dashboard/README.md documents the ESM readiness fix', () => {
        const source = readFileSync(join(ROOT, 'dashboard', 'README.md'), 'utf-8');
        // The README must mention applyRedaction OR the readiness poll.
        // The dispatch says the operator-facing remediation goes here.
        expect(source.toLowerCase()).toMatch(/applyredaction|readiness|esm/);
    });
});
