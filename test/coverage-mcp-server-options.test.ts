/**
 * Coverage — MCP server boundary configuration (`buildSDKOptions`,
 * `mcpCommitGateActive`).
 *
 * These are the fail-closed decisions that make the MCP surface AI-facing by
 * default. Each test pins one decision: what the server does with no env (the
 * redacting observer default), with a self-asserted principal (privileged zones
 * refused unless the operator opted in), with a malformed principal (refuse to
 * start), and with a policies file (sandboxed to the working directory, symlink
 * escapes refused, structurally validated, prototype-pollution keys refused).
 *
 * `process.chdir` is used to place the policies file inside the sandbox root;
 * `process.exit` is stubbed so the fail-closed exit can be observed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildSDKOptions, mcpCommitGateActive } from '../src/mcp/server.js';
import { PolicyConfigError } from '../src/mcp/config-validator.js';
import { DEFAULT_POLICIES, DEFAULT_TRUST_ZONES, DEFAULT_VISIBILITY_RULES } from '../src/policy/default-policies.js';

const ENV_KEYS = [
    'DB_CLUSTER_PRINCIPAL',
    'DB_CLUSTER_POLICIES_FILE',
    'DB_CLUSTER_MCP_ALLOW_PRIVILEGED',
    'DB_CLUSTER_MCP_TRUST_ZONE',
    'DB_CLUSTER_CANONICAL_BACKEND',
    'DB_CLUSTER_POSTGRES_URL',
] as const;

/** Directory junctions need no admin on Windows; probe once so a host that cannot link skips visibly. */
const CAN_LINK = (() => {
    const base = mkdtempSync(join(tmpdir(), 'coverage-mcp-linkprobe-'));
    try {
        mkdirSync(join(base, 'real'));
        symlinkSync(join(base, 'real'), join(base, 'link'), 'junction');
        return true;
    } catch {
        return false;
    } finally {
        try { rmSync(base, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
})();

const aiPrincipal = { id: 'agent-1', name: 'Agent One', roles: ['observer'], trustZone: 'ai-facing' };
const internalPrincipal = { id: 'root-1', name: 'Root One', roles: ['cluster-admin'], trustZone: 'internal' };

let sandbox: string;
let prevCwd: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
    savedEnv = {};
    for (const k of ENV_KEYS) {
        savedEnv[k] = process.env[k];
        delete process.env[k];
    }
    prevCwd = process.cwd();
    sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'coverage-mcp-options-')));
});

afterEach(() => {
    process.chdir(prevCwd);
    for (const k of ENV_KEYS) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
    }
    vi.restoreAllMocks();
    try { rmSync(sandbox, { recursive: true, force: true }); } catch { /* best-effort */ }
});

function writePolicies(name: string, body: unknown): string {
    const file = join(sandbox, name);
    writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body), 'utf-8');
    return file;
}

/** Stub process.exit so the fail-closed path is observable instead of fatal. */
function stubExit(): { errors: string[] } {
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.join(' ')); });
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
        throw new Error(`process.exit(${code})`);
    }) as never);
    return { errors };
}

// ─── no policies file ──────────────────────────────────────────────────────

describe('buildSDKOptions — defaults and principal handling', () => {
    it('with no environment it defaults to the redacting ai-facing observer', () => {
        const opts = buildSDKOptions();
        expect(opts.policies).toBe(DEFAULT_POLICIES);
        expect(opts.trustZones).toBe(DEFAULT_TRUST_ZONES);
        expect(opts.visibilityRules).toBe(DEFAULT_VISIBILITY_RULES);
        expect(opts.principal).toMatchObject({ id: 'mcp-ai-facing', roles: ['observer'], trustZone: 'ai-facing' });
        expect(opts.clusterDir.endsWith('.db-cluster')).toBe(true);
    });

    it('honours a valid non-privileged DB_CLUSTER_PRINCIPAL', () => {
        process.env.DB_CLUSTER_PRINCIPAL = JSON.stringify(aiPrincipal);
        expect(buildSDKOptions().principal).toEqual(aiPrincipal);
    });

    it('treats a whitespace-only DB_CLUSTER_PRINCIPAL as unset', () => {
        process.env.DB_CLUSTER_PRINCIPAL = '   ';
        expect(buildSDKOptions().principal?.id).toBe('mcp-ai-facing');
    });

    it('refuses a privileged principal unless the operator opted in', () => {
        process.env.DB_CLUSTER_PRINCIPAL = JSON.stringify(internalPrincipal);
        expect(() => buildSDKOptions()).toThrow(/Refusing to honor a privileged trust zone \('internal'\)/);
        expect(() => buildSDKOptions()).toThrow(/DB_CLUSTER_MCP_ALLOW_PRIVILEGED=1/);
    });

    it('refuses the cluster-admin zone too', () => {
        process.env.DB_CLUSTER_PRINCIPAL = JSON.stringify({ ...internalPrincipal, trustZone: 'cluster-admin' });
        expect(() => buildSDKOptions()).toThrow(/privileged trust zone \('cluster-admin'\)/);
    });

    it.each(['1', 'true', 'yes', ' 1 '])('accepts a privileged principal when ALLOW_PRIVILEGED=%j', (value) => {
        process.env.DB_CLUSTER_PRINCIPAL = JSON.stringify(internalPrincipal);
        process.env.DB_CLUSTER_MCP_ALLOW_PRIVILEGED = value;
        expect(buildSDKOptions().principal).toEqual(internalPrincipal);
    });

    it.each(['0', 'false', 'FALSE', ' false ', '', '   '])('does NOT treat ALLOW_PRIVILEGED=%j as an opt-in', (value) => {
        process.env.DB_CLUSTER_PRINCIPAL = JSON.stringify(internalPrincipal);
        process.env.DB_CLUSTER_MCP_ALLOW_PRIVILEGED = value;
        expect(() => buildSDKOptions()).toThrow(/Refusing to honor a privileged trust zone/);
    });

    it('DB_CLUSTER_MCP_TRUST_ZONE pins the boundary zone onto the principal', () => {
        process.env.DB_CLUSTER_PRINCIPAL = JSON.stringify(aiPrincipal);
        process.env.DB_CLUSTER_MCP_TRUST_ZONE = ' partner-zone ';
        const principal = buildSDKOptions().principal!;
        expect(principal.trustZone).toBe('partner-zone');
        expect(principal.id).toBe('agent-1');
    });

    it('a privileged DB_CLUSTER_MCP_TRUST_ZONE override is refused even for a non-privileged principal', () => {
        process.env.DB_CLUSTER_PRINCIPAL = JSON.stringify(aiPrincipal);
        process.env.DB_CLUSTER_MCP_TRUST_ZONE = 'internal';
        expect(() => buildSDKOptions()).toThrow(/privileged trust zone \('internal'\)/);
    });

    it('a blank DB_CLUSTER_MCP_TRUST_ZONE is ignored', () => {
        process.env.DB_CLUSTER_PRINCIPAL = JSON.stringify(aiPrincipal);
        process.env.DB_CLUSTER_MCP_TRUST_ZONE = '   ';
        expect(buildSDKOptions().principal).toEqual(aiPrincipal);
    });

    it('invalid principal JSON fails closed: logs the cause and exits 1, no options returned', () => {
        const { errors } = stubExit();
        process.env.DB_CLUSTER_PRINCIPAL = '{not json';
        expect(() => buildSDKOptions()).toThrow('process.exit(1)');
        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain('DB_CLUSTER_PRINCIPAL is structurally invalid: not valid JSON');
        expect(errors[0]).toContain('Refusing to start MCP server');
        expect(errors[0]).toContain('required fields: id, name, roles[], trustZone');
    });

    it.each([
        ['missing trustZone', { id: 'p', name: 'n', roles: [] }],
        ['non-array roles', { id: 'p', name: 'n', roles: 'observer', trustZone: 'z' }],
        ['a bare string', 'observer'],
    ])('a structurally invalid principal (%s) fails closed with exit 1', (_label, principal) => {
        const { errors } = stubExit();
        process.env.DB_CLUSTER_PRINCIPAL = JSON.stringify(principal);
        expect(() => buildSDKOptions()).toThrow('process.exit(1)');
        expect(errors[0]).toContain('DB_CLUSTER_PRINCIPAL is structurally invalid: missing or wrong-typed field(s)');
    });
});

// ─── commit gate ───────────────────────────────────────────────────────────

describe('mcpCommitGateActive', () => {
    it('is active by default (the AI surface must approve before commit)', () => {
        expect(mcpCommitGateActive()).toBe(true);
    });

    it('is relaxed by the operator opt-in', () => {
        process.env.DB_CLUSTER_MCP_ALLOW_PRIVILEGED = '1';
        expect(mcpCommitGateActive()).toBe(false);
    });

    it.each(['internal', 'cluster-admin'])('is relaxed by a pinned privileged zone (%s)', (zone) => {
        process.env.DB_CLUSTER_MCP_TRUST_ZONE = zone;
        expect(mcpCommitGateActive()).toBe(false);
    });

    it('stays active for a pinned non-privileged zone and for a "false" opt-in', () => {
        process.env.DB_CLUSTER_MCP_TRUST_ZONE = 'ai-facing';
        expect(mcpCommitGateActive()).toBe(true);
        process.env.DB_CLUSTER_MCP_ALLOW_PRIVILEGED = 'false';
        expect(mcpCommitGateActive()).toBe(true);
    });
});

// ─── policies file ─────────────────────────────────────────────────────────

describe('buildSDKOptions — DB_CLUSTER_POLICIES_FILE', () => {
    const goodPolicy = { id: 'p1', name: 'Allow reads', priority: 1, match: {}, decision: 'allow', reason: 'test' };

    it('uses the policies, trust zones, visibility rules and principal from the file', () => {
        writePolicies('policies.json', {
            policies: [goodPolicy],
            trustZones: [{ id: 'ai-facing', name: 'AI' }],
            visibilityRules: [{ id: 'v1' }],
            principal: aiPrincipal,
        });
        process.chdir(sandbox);
        process.env.DB_CLUSTER_POLICIES_FILE = 'policies.json';

        const opts = buildSDKOptions();

        expect(opts.policies).toEqual([goodPolicy]);
        expect(opts.trustZones).toEqual([{ id: 'ai-facing', name: 'AI' }]);
        expect(opts.visibilityRules).toEqual([{ id: 'v1' }]);
        expect(opts.principal).toEqual(aiPrincipal);
    });

    it('a file that omits sections keeps the AI-facing defaults for each omitted one', () => {
        writePolicies('policies.json', {});
        process.chdir(sandbox);
        process.env.DB_CLUSTER_POLICIES_FILE = 'policies.json';

        const opts = buildSDKOptions();

        expect(opts.policies).toBe(DEFAULT_POLICIES);
        expect(opts.trustZones).toBe(DEFAULT_TRUST_ZONES);
        expect(opts.visibilityRules).toBe(DEFAULT_VISIBILITY_RULES);
        expect(opts.principal?.id).toBe('mcp-ai-facing');
    });

    it('DB_CLUSTER_PRINCIPAL wins over the file principal', () => {
        writePolicies('policies.json', { policies: [goodPolicy], principal: { ...aiPrincipal, id: 'from-file' } });
        process.chdir(sandbox);
        process.env.DB_CLUSTER_POLICIES_FILE = 'policies.json';
        process.env.DB_CLUSTER_PRINCIPAL = JSON.stringify({ ...aiPrincipal, id: 'from-env' });

        expect(buildSDKOptions().principal?.id).toBe('from-env');
    });

    it('a privileged principal supplied by the file is refused like an env-supplied one', () => {
        writePolicies('policies.json', { principal: internalPrincipal });
        process.chdir(sandbox);
        process.env.DB_CLUSTER_POLICIES_FILE = 'policies.json';
        expect(() => buildSDKOptions()).toThrow(/Refusing to honor a privileged trust zone \('internal'\)/);
    });

    it('accepts an absolute path that lives inside the working directory', () => {
        const file = writePolicies('abs.json', { policies: [goodPolicy] });
        process.chdir(sandbox);
        process.env.DB_CLUSTER_POLICIES_FILE = file;
        expect(buildSDKOptions().policies).toEqual([goodPolicy]);
    });

    it('a whitespace-only path is ignored', () => {
        process.chdir(sandbox);
        process.env.DB_CLUSTER_POLICIES_FILE = '   ';
        expect(buildSDKOptions().policies).toBe(DEFAULT_POLICIES);
    });

    it('refuses a path that escapes the working directory, naming the variable', () => {
        const inner = join(sandbox, 'inner');
        mkdirSync(inner);
        writePolicies('outside.json', { policies: [goodPolicy] });
        process.chdir(inner);
        process.env.DB_CLUSTER_POLICIES_FILE = '../outside.json';
        expect(() => buildSDKOptions()).toThrow(/DB_CLUSTER_POLICIES_FILE path escapes the working directory: \.\.\/outside\.json/);
    });

    it('refuses a missing file with a not-found error', () => {
        process.chdir(sandbox);
        process.env.DB_CLUSTER_POLICIES_FILE = 'missing.json';
        expect(() => buildSDKOptions()).toThrow(/DB_CLUSTER_POLICIES_FILE not found: .*missing\.json/);
    });

    it('refuses a file that is not valid JSON', () => {
        writePolicies('broken.json', '{ "policies": [');
        process.chdir(sandbox);
        process.env.DB_CLUSTER_POLICIES_FILE = 'broken.json';
        expect(() => buildSDKOptions()).toThrow(/Failed to read .*broken\.json/);
    });

    it.each(['__proto__', 'constructor', 'prototype'])(
        'refuses a file carrying the prototype-pollution key %s without polluting Object.prototype',
        (danger) => {
            writePolicies('evil.json', `{"${danger}":{"polluted":"yes"},"policies":[]}`);
            process.chdir(sandbox);
            process.env.DB_CLUSTER_POLICIES_FILE = 'evil.json';

            let caught: unknown;
            try { buildSDKOptions(); } catch (e) { caught = e; }

            expect(caught).toBeInstanceOf(PolicyConfigError);
            expect((caught as PolicyConfigError).field).toBe('root');
            expect((caught as PolicyConfigError).message).toContain(`forbidden own-key '${danger}'`);
            expect(({} as Record<string, unknown>).polluted).toBeUndefined();
        },
    );

    it('refuses a structurally malformed file with a typed PolicyConfigError naming the field', () => {
        writePolicies('bad.json', { policies: [{ id: 'p1', decision: 7 }] });
        process.chdir(sandbox);
        process.env.DB_CLUSTER_POLICIES_FILE = 'bad.json';

        let caught: unknown;
        try { buildSDKOptions(); } catch (e) { caught = e; }
        expect(caught).toBeInstanceOf(PolicyConfigError);
        expect((caught as PolicyConfigError).code).toBe('INVALID_POLICY_CONFIG');
        expect((caught as PolicyConfigError).field).toBe('policies[0].decision');
    });

    it('a JSON array at the root is refused (not an object)', () => {
        writePolicies('array.json', '[]');
        process.chdir(sandbox);
        process.env.DB_CLUSTER_POLICIES_FILE = 'array.json';
        expect(() => buildSDKOptions()).toThrow(/Invalid policy config \(root\): expected a JSON object/);
    });

    it.skipIf(!CAN_LINK)('refuses a link that resolves outside the working directory even though the path looks local', () => {
        const outside = realpathSync(mkdtempSync(join(tmpdir(), 'coverage-mcp-outside-')));
        try {
            writeFileSync(join(outside, 'target.json'), JSON.stringify({ policies: [goodPolicy] }), 'utf-8');
            const inner = join(sandbox, 'inner');
            mkdirSync(inner);
            const link = join(inner, 'link');
            symlinkSync(outside, link, 'junction');
            process.chdir(inner);
            process.env.DB_CLUSTER_POLICIES_FILE = join('link', 'target.json');
            expect(() => buildSDKOptions()).toThrow(/resolves outside the working directory via symlink/);
        } finally {
            try { rmSync(outside, { recursive: true, force: true }); } catch { /* best-effort */ }
        }
    });
});
