/**
 * Coverage — CLI configuration surface (src/cli.ts).
 *
 * Child-process tests for everything that decides *how* a command runs:
 * global flags (--version, --help, --quiet, --log-level, --no-color,
 * --help-exit-codes), operator identity resolution, cluster directory
 * resolution (DB_CLUSTER_DIR, .db-cluster/config.json), the optional
 * .db-cluster/policies.json (fail-closed validation, principal handling,
 * separation of duties) and the `policy explain` / `policy test` dry-run
 * commands.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, userInfo } from 'node:os';

const ROOT = join(import.meta.dirname, '..');
const CLI_JS = join(ROOT, 'dist', 'cli.js');
const PKG_VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')).version as string;

interface Out { status: number | null; stdout: string; stderr: string }

function cli(cwd: string, args: string[], extraEnv: Record<string, string | undefined> = {}): Out {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.DB_CLUSTER_CANONICAL_BACKEND;
    delete env.DB_CLUSTER_POSTGRES_URL;
    delete env.DB_CLUSTER_DIR;
    delete env.DB_CLUSTER_OPERATOR;
    delete env.NO_COLOR;
    delete env.FORCE_COLOR;
    delete env.DEBUG;
    for (const [k, v] of Object.entries(extraEnv)) {
        if (v === undefined) delete env[k]; else env[k] = v;
    }
    const r = spawnSync(process.execPath, [CLI_JS, ...args], { cwd, env, encoding: 'utf-8', timeout: 60_000 });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function ok(cwd: string, args: string[], extraEnv: Record<string, string | undefined> = {}): Out {
    const r = cli(cwd, args, extraEnv);
    expect(r.status, `${args.join(' ')}\n${r.stderr}`).toBe(0);
    return r;
}

function grab(out: string, re: RegExp): string {
    const m = re.exec(out);
    expect(m, `pattern ${re} not found in:\n${out}`).not.toBeNull();
    return m![1]!;
}

const tmpDirs: string[] = [];
function freshDir(label: string): string {
    const d = mkdtempSync(join(tmpdir(), `cov-cli-cfg-${label}-`));
    tmpDirs.push(d);
    return d;
}
afterAll(() => {
    for (const d of tmpDirs) {
        try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
    }
});

function freshCluster(label: string): string {
    const d = freshDir(label);
    ok(d, ['init']);
    return d;
}

function writePolicies(dir: string, body: unknown): void {
    writeFileSync(join(dir, '.db-cluster', 'policies.json'), typeof body === 'string' ? body : JSON.stringify(body));
}

function proposeUpdate(dir: string, actor: string, entityId: string, name: string): string {
    const r = ok(dir, ['--actor', actor, 'propose', JSON.stringify({
        verb: 'update_entity',
        targetStore: 'canonical',
        payload: { entityId, patch: { name } },
    })]);
    return grab(r.stdout, /Proposed command: (\S+)/);
}

function commandStatus(dir: string, id: string): string {
    return JSON.parse(ok(dir, ['inspect-command', id]).stdout).status as string;
}

describe('global options', { timeout: 60_000 }, () => {
    let dir: string;
    beforeAll(() => { dir = freshCluster('global'); });

    it('--version prints the package.json version', () => {
        const r = ok(dir, ['--version']);
        expect(r.stdout.trim()).toBe(PKG_VERSION);
    });

    it('--help lists the subcommands and the exit-code summary', () => {
        const r = ok(dir, ['--help']);
        expect(r.stdout).toContain('AI-native federated database cluster.');
        for (const sub of ['init', 'ingest', 'entity', 'link', 'find', 'propose', 'commit', 'compensate', 'policy', 'stores', 'doctor', 'verify', 'rebuild', 'backup', 'restore', 'completion']) {
            expect(r.stdout).toMatch(new RegExp(`^\\s+${sub}[\\s|]`, 'm'));
        }
        expect(r.stdout).toContain('77  EX_NOPERM   — POLICY_DENIED');
        expect(r.stdout).toContain('--help-exit-codes');
    });

    it('commit --help documents the separation-of-duties flags', () => {
        const r = ok(dir, ['commit', '--help']);
        expect(r.stdout).toContain('Separation of duties:');
        expect(r.stdout).toContain('--self-approve');
        expect(r.stdout).toContain('--accept-soft-duty-bypass');
    });

    it('--help-exit-codes prints the table and exits 0, with or without a subcommand', () => {
        const alone = ok(dir, ['--help-exit-codes']);
        expect(alone.stdout).toContain('db-cluster exit-code table');
        expect(alone.stdout).toMatch(/\|\s+73\s+\| EX_CANTCREAT \| BACKUP_TARGET_EXISTS/);
        expect(alone.stdout).toMatch(/\|\s+65\s+\| EX_DATAERR/);
        const withSub = ok(dir, ['stats', '--help-exit-codes']);
        expect(withSub.stdout).toBe(alone.stdout);
        expect(withSub.stdout).not.toMatch(/Entities:/);
    });

    it('an unknown command exits 1 with commander usage text', () => {
        const r = cli(dir, ['frobnicate']);
        expect(r.status).toBe(1);
        expect(r.stderr).toContain("unknown command 'frobnicate'");
    });

    it('--log-level with an unknown value warns and carries on at info level', () => {
        const r = ok(dir, ['--log-level', 'chatty', 'stats']);
        expect(r.stderr).toContain("Unknown --log-level value: chatty; defaulting to 'info'");
        expect(r.stdout).toContain('Entities:');
    });

    it.each(['debug', 'INFO', 'Warn', 'error'])('--log-level %s is accepted silently (case-insensitive)', (level) => {
        const r = ok(dir, ['--log-level', level, 'stats']);
        expect(r.stderr).not.toContain('Unknown --log-level');
        expect(r.stdout).toContain('Entities:');
    });

    it('--quiet is also accepted after the subcommand', () => {
        const r = ok(dir, ['stats', '--quiet']);
        expect(r.stdout).toBe('');
    });

    it('error output is colored when forced and plain with --no-color', () => {
        const colored = cli(dir, ['inspect', 'nope'], { FORCE_COLOR: '1' });
        expect(colored.status).toBe(1);
        expect(colored.stderr).toContain('\u001b[31m');
        const plain = cli(dir, ['--no-color', 'inspect', 'nope'], { FORCE_COLOR: '1' });
        expect(plain.status).toBe(1);
        expect(plain.stderr).not.toContain('\u001b[');
        expect(plain.stderr).toContain('Not found in canonical store: nope');
    });

    it('NO_COLOR keeps output plain', () => {
        const r = cli(dir, ['inspect', 'nope'], { FORCE_COLOR: '1', NO_COLOR: '1' });
        expect(r.stderr).not.toContain('\u001b[');
    });

    it('commands that need a cluster say so when there is none', () => {
        const empty = freshDir('nocluster');
        for (const args of [['find', 'x'], ['receipts'], ['inspect', 'x'], ['propose', '{}']]) {
            const r = cli(empty, args);
            expect(r.status, args.join(' ')).toBe(1);
            expect(r.stderr).toContain('No cluster found. Run `db-cluster init` first.');
        }
        expect(existsSync(join(empty, '.db-cluster'))).toBe(false);
    });

    it('propose with non-JSON text localises the failure inside the string', () => {
        const r = cli(dir, ['propose', 'nojson']);
        expect(r.status).toBe(1);
        expect(r.stderr).toContain('Invalid JSON for command JSON:');
        expect(r.stderr).toContain('Input near position');
        expect(r.stderr).toContain('nojson');
    });
});

describe('JSON argument diagnostics', { timeout: 60_000 }, () => {
    let dir: string;
    beforeAll(() => { dir = freshCluster('jsondiag'); });

    it('points a caret at the end of the snippet V8 quotes for a long input', () => {
        const input = '{"verb":"create_entity","targetStore":"canonical","payload":}';
        const r = cli(dir, ['propose', input]);
        expect(r.status).toBe(1);
        expect(r.stderr).toContain("Unexpected token '}'");
        expect(r.stderr).toContain(`Input near position ${input.length - 1}:`);
        const lines = r.stderr.split('\n');
        const snippetIdx = lines.findIndex((l) => l.startsWith('    ') && l.includes('"payload":}'));
        expect(snippetIdx).toBeGreaterThan(-1);
        const snippet = lines[snippetIdx]!.slice(4);
        const caret = lines[snippetIdx + 1]!.slice(4);
        // The caret sits under the offending '}' (the last character of the input).
        expect(snippet[caret.indexOf('^')]).toBe('}');
    });

    it('puts the caret under the first character when the very start is not JSON', () => {
        const r = cli(dir, ['propose', 'This is not json at all, really not json']);
        expect(r.status).toBe(1);
        expect(r.stderr).toContain('Input near position 0:');
        const lines = r.stderr.split('\n');
        const caretLine = lines.find((l) => /^\s+\^$/.test(l))!;
        expect(caretLine).toBe('    ^');
    });

    it('shows a trailing-comma failure with the position V8 reports', () => {
        const r = cli(dir, ['entity', 'create', '--kind', 'k', '--name', 'n', '--attr', '{"a":1,}']);
        expect(r.status).toBe(1);
        expect(r.stderr).toMatch(/Input near position \d+:/);
        expect(r.stderr).toContain('{"a":1,}');
    });
});

describe('operator identity', { timeout: 60_000 }, () => {
    let dir: string;
    let entityId: string;
    beforeAll(() => {
        dir = freshCluster('operator');
        entityId = grab(ok(dir, ['entity', 'create', '--kind', 'n', '--name', 'op']).stdout, /id:\s+(\S+)/);
    });

    const proposedBy = (id: string): string => JSON.parse(ok(dir, ['inspect-command', id]).stdout).proposedBy;

    it('falls back to the OS user when nothing is set', () => {
        const id = grab(ok(dir, ['propose', JSON.stringify({ verb: 'update_entity', targetStore: 'canonical', payload: { entityId, patch: { name: 'a' } } })]).stdout, /Proposed command: (\S+)/);
        expect(proposedBy(id)).toBe(userInfo().username);
    });

    it('uses DB_CLUSTER_OPERATOR when set', () => {
        const r = ok(dir, ['propose', JSON.stringify({ verb: 'update_entity', targetStore: 'canonical', payload: { entityId, patch: { name: 'b' } } })], { DB_CLUSTER_OPERATOR: 'env-operator' });
        expect(proposedBy(grab(r.stdout, /Proposed command: (\S+)/))).toBe('env-operator');
    });

    it('--actor beats DB_CLUSTER_OPERATOR', () => {
        const r = ok(dir, ['--actor', 'flag-operator', 'propose', JSON.stringify({ verb: 'update_entity', targetStore: 'canonical', payload: { entityId, patch: { name: 'c' } } })], { DB_CLUSTER_OPERATOR: 'env-operator' });
        expect(proposedBy(grab(r.stdout, /Proposed command: (\S+)/))).toBe('flag-operator');
    });

    it('a blank --actor is ignored in favour of the environment', () => {
        const r = ok(dir, ['--actor', '   ', 'propose', JSON.stringify({ verb: 'update_entity', targetStore: 'canonical', payload: { entityId, patch: { name: 'd' } } })], { DB_CLUSTER_OPERATOR: 'env-operator' });
        expect(proposedBy(grab(r.stdout, /Proposed command: (\S+)/))).toBe('env-operator');
    });

    it('an environment-chosen operator that proposed the command gets no warning when it is --actor-distinct', () => {
        const id = grab(ok(dir, ['--actor', 'p1', 'propose', JSON.stringify({ verb: 'update_entity', targetStore: 'canonical', payload: { entityId, patch: { name: 'e' } } })]).stdout, /Proposed command: (\S+)/);
        const c = ok(dir, ['commit', id], { DB_CLUSTER_OPERATOR: 'p2' });
        expect(c.stderr).not.toContain('WARNING');
        expect(JSON.parse(ok(dir, ['inspect-command', id]).stdout).approvedBy).toBe('p2');
    });
});

describe('cluster directory resolution', { timeout: 60_000 }, () => {
    it('DB_CLUSTER_DIR relocates the cluster and is honoured from any cwd', () => {
        const cwd = freshDir('envdir-cwd');
        const target = join(freshDir('envdir-target'), 'cluster-root');
        const env = { DB_CLUSTER_DIR: target };
        ok(cwd, ['init'], env);
        expect(existsSync(join(target, 'canonical'))).toBe(true);
        expect(existsSync(join(cwd, '.db-cluster'))).toBe(false);
        ok(cwd, ['entity', 'create', '--kind', 'k', '--name', 'moved'], env);
        const other = freshDir('envdir-other');
        expect(JSON.parse(ok(other, ['stats', '--json'], env).stdout).entities).toBe(1);
        // Without the variable the other directory has no cluster.
        expect(cli(other, ['find', 'moved']).status).toBe(1);
    });

    it('a blank DB_CLUSTER_DIR is ignored', () => {
        const cwd = freshDir('envdir-blank');
        ok(cwd, ['init'], { DB_CLUSTER_DIR: '   ' });
        expect(existsSync(join(cwd, '.db-cluster', 'canonical'))).toBe(true);
    });

    it('config.json clusterDir inside the working directory is honoured', () => {
        const cwd = freshDir('cfg-inside');
        mkdirSync(join(cwd, '.db-cluster'), { recursive: true });
        writeFileSync(join(cwd, '.db-cluster', 'config.json'), JSON.stringify({ clusterDir: 'data/store' }));
        const r = ok(cwd, ['init']);
        expect(r.stderr).not.toContain('ignoring');
        expect(existsSync(join(cwd, 'data', 'store', 'canonical'))).toBe(true);
        ok(cwd, ['entity', 'create', '--kind', 'k', '--name', 'pinned']);
        expect(JSON.parse(ok(cwd, ['stats', '--json']).stdout).entities).toBe(1);
        expect(existsSync(join(cwd, '.db-cluster', 'canonical'))).toBe(false);
    });

    it('config.json clusterDir that escapes the working directory is ignored with a warning', () => {
        const parent = freshDir('cfg-outside');
        const cwd = join(parent, 'work');
        mkdirSync(join(cwd, '.db-cluster'), { recursive: true });
        writeFileSync(join(cwd, '.db-cluster', 'config.json'), JSON.stringify({ clusterDir: '../escaped' }));
        const r = ok(cwd, ['--version']);
        expect(r.stderr).toContain('Warning: ignoring .db-cluster/config.json `clusterDir`');
        expect(r.stderr).toContain('DB_CLUSTER_DIR');
        expect(existsSync(join(parent, 'escaped'))).toBe(false);
    });

    it('an escaping clusterDir falls back to the in-directory default', () => {
        const parent = freshDir('cfg-outside2');
        const cwd = join(parent, 'work');
        mkdirSync(join(cwd, '.db-cluster'), { recursive: true });
        writeFileSync(join(cwd, '.db-cluster', 'config.json'), JSON.stringify({ clusterDir: '../escaped' }));
        const r = ok(cwd, ['init']);
        // `.db-cluster` already exists (it holds config.json), so init reports that.
        expect(r.stdout).toContain('Cluster already initialized at .db-cluster/');
        expect(r.stderr).toContain('ignoring .db-cluster/config.json');
        expect(existsSync(join(parent, 'escaped'))).toBe(false);
    });

    it('a malformed config.json is ignored silently', () => {
        const cwd = freshDir('cfg-bad');
        mkdirSync(join(cwd, '.db-cluster'), { recursive: true });
        writeFileSync(join(cwd, '.db-cluster', 'config.json'), '{ not json');
        const r = ok(cwd, ['init']);
        expect(r.stderr).toBe('');
        expect(r.stdout).toContain('Cluster already initialized');
    });

    it('a config.json without a clusterDir string is ignored', () => {
        const cwd = freshDir('cfg-empty');
        mkdirSync(join(cwd, '.db-cluster'), { recursive: true });
        writeFileSync(join(cwd, '.db-cluster', 'config.json'), JSON.stringify({ clusterDir: '  ' }));
        const r = ok(cwd, ['init']);
        expect(r.stderr).toBe('');
    });
});

describe('policies.json handling', { timeout: 90_000 }, () => {
    const adminPolicies = {
        policies: [{ id: 'admin-full-access', name: 'Admin', priority: 10, match: { principals: ['cluster-admin'] }, decision: 'allow', reason: 'admin' }],
        principal: { id: 'root', name: 'Root', roles: ['cluster-admin'], trustZone: 'internal' },
    };

    it('malformed JSON fails closed with exit 78 and a path-free message', () => {
        const d = freshCluster('pol-badjson');
        writePolicies(d, 'not json at all');
        const r = cli(d, ['find', 'x']);
        expect(r.status).toBe(78);
        expect(r.stderr).toContain('Invalid policy config (<path>): JSON.parse failed');
        expect(r.stderr).toContain('→ try: Fix .db-cluster/policies.json structure');
        expect(r.stderr).not.toContain(d);
    });

    it('a structurally invalid file names the offending field (exit 78) and --json adds the error object', () => {
        const d = freshCluster('pol-badshape');
        writePolicies(d, { policies: 'nope' });
        const r = cli(d, ['versions', 'x', '--json']);
        expect(r.status).toBe(78);
        expect(r.stderr).toContain('Invalid policy config (policies): expected an array');
        const body = JSON.parse(r.stdout.trim().split('\n').pop()!);
        expect(body.error.code).toBe('INVALID_POLICY_CONFIG');
        expect(body.error.message).toBe('Invalid policy config (policies): expected an array');
    });

    it('a policies.json that cannot be read (a directory) is reported as read failed (exit 78)', () => {
        const d = freshCluster('pol-dir');
        mkdirSync(join(d, '.db-cluster', 'policies.json'));
        const r = cli(d, ['find', 'x']);
        expect(r.status).toBe(78);
        expect(r.stderr).toContain('read failed');
    });

    it('policies without a principal warn once and fall back to the trusted principal', () => {
        const d = freshCluster('pol-noprincipal');
        writePolicies(d, { policies: [{ id: 'allow-all', name: 'Allow all', priority: 1, match: {}, decision: 'allow', reason: 'open' }] });
        const r = ok(d, ['find', 'anything']);
        expect(r.stderr).toContain('policies configured without principal — using INTERNAL_TRUSTED_PRINCIPAL');
        expect(r.stdout).toContain('Found 0 index record(s)');
    });

    it('an empty policy file leaves the kernel in raw mode (no warning, no enforcement)', () => {
        const d = freshCluster('pol-empty');
        writePolicies(d, {});
        const r = ok(d, ['entity', 'create', '--kind', 'k', '--name', 'free']);
        expect(r.stderr).toBe('');
    });

    it('a principal without the capability is denied with exit 77; --json adds the structured error', () => {
        const d = freshCluster('pol-denied');
        const entityId = grab(ok(d, ['entity', 'create', '--kind', 'k', '--name', 'guarded']).stdout, /id:\s+(\S+)/);
        writePolicies(d, {
            policies: [{ id: 'nobody', name: 'Nobody', priority: 1, match: { principals: ['nobody'] }, decision: 'allow', reason: 'x' }],
            principal: { id: 'stranger', name: 'Stranger', roles: [], trustZone: 'internal' },
        });
        const plain = cli(d, ['inspect', entityId]);
        expect(plain.status).toBe(77);
        expect(plain.stderr).toContain('Policy denied: read_owner_truth');
        expect(plain.stderr).toContain('principal stranger');
        expect(plain.stdout).not.toContain('guarded');

        const json = cli(d, ['versions', entityId, '--json']);
        expect(json.status).toBe(77);
        const body = JSON.parse(json.stdout.trim().split('\n').pop()!);
        expect(body.error.code).toBe('POLICY_DENIED');
        expect(body.error.hint).toContain('policy explain');
    });

    it('a permitted principal can read through the policy-enforced SDK path of resolve', () => {
        const d = freshCluster('pol-resolve');
        const entityId = grab(ok(d, ['entity', 'create', '--kind', 'k', '--name', 'visible']).stdout, /id:\s+(\S+)/);
        writePolicies(d, adminPolicies);
        const r = ok(d, ['resolve', `cluster://canonical/${entityId}`]);
        expect(r.stdout).toContain('store: canonical');
        expect(r.stdout).toContain('"name": "visible"');
        expect(r.stderr).not.toContain('without principal');
    });

    it('resolve under a principal-less policy file warns through the SDK', () => {
        const d = freshCluster('pol-resolve-np');
        const entityId = grab(ok(d, ['entity', 'create', '--kind', 'k', '--name', 'v2']).stdout, /id:\s+(\S+)/);
        writePolicies(d, { policies: [{ id: 'allow-all', name: 'Allow all', priority: 1, match: {}, decision: 'allow', reason: 'open' }] });
        const r = ok(d, ['resolve', `cluster://canonical/${entityId}`]);
        expect(r.stdout).toContain('"name": "v2"');
        expect(r.stderr.toLowerCase()).toContain('principal');
    });

    it('with policies configured, commit refuses when proposer and operator are the same (exit 1)', () => {
        const d = freshCluster('pol-selfcommit');
        const entityId = grab(ok(d, ['entity', 'create', '--kind', 'k', '--name', 'e']).stdout, /id:\s+(\S+)/);
        writePolicies(d, adminPolicies);
        const id = proposeUpdate(d, 'root', entityId, 'renamed');
        const r = cli(d, ['--actor', 'root', 'commit', id]);
        expect(r.status).toBe(1);
        expect(r.stderr).toContain('Refusing to commit: proposer (root) is the same as operator (root).');
        expect(commandStatus(d, id)).toBe('proposed');
    });

    it('with policies configured, approve by the proposer is refused unless --self-approve', () => {
        const d = freshCluster('pol-selfapprove');
        const entityId = grab(ok(d, ['entity', 'create', '--kind', 'k', '--name', 'e']).stdout, /id:\s+(\S+)/);
        writePolicies(d, adminPolicies);
        const id = proposeUpdate(d, 'root', entityId, 'renamed');
        ok(d, ['--actor', 'validator', 'validate', id]);
        const refused = cli(d, ['--actor', 'root', 'approve', id]);
        expect(refused.status).toBe(1);
        expect(refused.stderr).toContain('Refusing to commit: proposer (root) is the same as operator (root).');
        expect(commandStatus(d, id)).toBe('validated');

        const acknowledged = ok(d, ['--actor', 'root', 'approve', id, '--self-approve']);
        expect(acknowledged.stderr).toContain('--self-approve set. Same identity (root) proposed and committed');
        expect(acknowledged.stdout).toContain('status:     approved');
    });

    it('a different operator completes the lifecycle under the admin policy', () => {
        const d = freshCluster('pol-lifecycle');
        const entityId = grab(ok(d, ['entity', 'create', '--kind', 'k', '--name', 'e']).stdout, /id:\s+(\S+)/);
        writePolicies(d, adminPolicies);
        const id = proposeUpdate(d, 'author', entityId, 'renamed-by-policy');
        const c = ok(d, ['--actor', 'reviewer', 'commit', id]);
        expect(c.stdout).toContain('status:  committed');
        expect(ok(d, ['inspect', entityId]).stdout).toContain('k/renamed-by-policy');
    });

    it('a principal that may not approve is denied at commit time: validated but never approved or committed', () => {
        const d = freshCluster('pol-noapprove');
        const entityId = grab(ok(d, ['entity', 'create', '--kind', 'k', '--name', 'e']).stdout, /id:\s+(\S+)/);
        writePolicies(d, {
            policies: [
                { id: 'deny-commit', name: 'No commit', priority: 15, match: { principals: ['proposer'], capabilities: ['commit_command', 'approve_command', 'compensate_command'] }, decision: 'deny', reason: 'nope' },
                { id: 'proposer-ok', name: 'Proposer', priority: 20, match: { principals: ['proposer'], capabilities: ['discover_existence', 'read_owner_truth', 'read_command', 'propose_mutation', 'validate_command'] }, decision: 'allow', reason: 'ok' },
            ],
            principal: { id: 'bot', name: 'Bot', roles: ['proposer'], trustZone: 'internal' },
        });
        const id = proposeUpdate(d, 'bot', entityId, 'blocked');
        const r = cli(d, ['--actor', 'someone-else', 'commit', id]);
        expect(r.status).toBe(77);
        expect(r.stderr).toContain('Policy denied: approve_command — nope (policy: No commit)');
        expect(commandStatus(d, id)).toBe('validated');
        expect(ok(d, ['--actor', 'x', 'inspect', entityId]).stdout).not.toContain('blocked');
    });
});

describe('policy explain / policy test', { timeout: 60_000 }, () => {
    it('without policies.json it says so and evaluates the default set (allow)', () => {
        const d = freshCluster('pe-default-allow');
        const r = ok(d, ['policy', 'explain', '--principal', 'olive', '--roles', 'observer', '--capability', 'read_owner_truth']);
        expect(r.stderr).toContain('Notice: no .db-cluster/policies.json found; evaluating against default policy set.');
        expect(r.stdout).toContain('Decision: ALLOW');
        expect(r.stdout).toContain('Matched policy: Observer Read Access (observer-read)');
        expect(r.stdout).not.toContain('Closest allow');
    });

    it('a default-set deny names the firing clauses, the closest unlocking rule and the visibility', () => {
        const d = freshCluster('pe-default-deny');
        const r = ok(d, ['policy', 'explain', '--principal', 'bob', '--roles', 'proposer', '--capability', 'commit_command', '--store', 'canonical', '--uri', 'cluster://canonical/x']);
        expect(r.stdout).toContain('Decision: DENY');
        expect(r.stdout).toContain('Matched policy: Proposer Cannot Commit (proposer-deny-commit)');
        expect(r.stdout).toContain("Which clauses fired in 'Proposer Cannot Commit':");
        expect(r.stdout).toContain('- principals clause matched (one of: proposer)');
        expect(r.stdout).toContain('- capabilities clause matched (commit_command is in the rule)');
        expect(r.stdout).toContain('Closest allow rule(s) that would unlock this:');
        expect(r.stdout).toContain('Cluster Admin Full Access (admin-full-access)');
        expect(r.stdout).toContain('needs: role/principal one of: cluster-admin');
        expect(r.stdout).toMatch(/Visibility: existence (VISIBLE|HIDDEN)/);
    });

    it('an unmatched request falls to the default deny and lists up to three unlocking rules', () => {
        const d = freshCluster('pe-default-none');
        const r = ok(d, ['policy', 'explain', '--principal', 'zed', '--capability', 'read_owner_truth', '--trust-zone', 'external', '--store', 'ledger', '--uri', 'cluster://ledger/zzz']);
        expect(r.stdout).toContain('Matched policy: Default Deny (__default_deny)');
        expect(r.stdout).toContain('Trust zone: external');
        expect(r.stdout).toContain('Resource: cluster://ledger/zzz');
        expect(r.stdout).toContain('Visibility: existence HIDDEN');
        const rules = r.stdout.match(/^ {2}- .+\(.+\)$/gm) ?? [];
        expect(rules.length).toBe(3);
    });

    describe('with a custom policies.json', () => {
        let d: string;
        beforeAll(() => {
            d = freshCluster('pe-custom');
            writePolicies(d, {
                policies: [
                    { id: 'deny-ext-ledger', name: 'Deny ext ledger', priority: 10, match: { principals: ['ext'], capabilities: ['read_owner_truth'], trustZones: ['external'], stores: ['ledger'] }, decision: 'deny', reason: 'no ledger for externals' },
                    { id: 'allow-int', name: 'Allow internal', priority: 50, match: { principals: ['ext'], capabilities: ['read_owner_truth'], trustZones: ['internal'] }, decision: 'allow', reason: 'ok' },
                ],
                visibilityRules: [{ id: 'v1', scope: { stores: ['ledger'] }, existenceVisible: true, emitPlaceholder: true }],
            });
        });

        it('reports every clause that fired, the missing trust zone and the placeholder visibility', () => {
            const r = ok(d, ['policy', 'explain', '--principal', 'ext', '--roles', 'ext', '--capability', 'read_owner_truth', '--trust-zone', 'external', '--store', 'ledger', '--uri', 'cluster://ledger/abc']);
            expect(r.stderr).not.toContain('Notice:');
            expect(r.stdout).toContain('Decision: DENY');
            expect(r.stdout).toContain('- trustZones clause matched (external)');
            expect(r.stdout).toContain('- stores clause matched (ledger)');
            expect(r.stdout).toContain('Allow internal (allow-int)');
            expect(r.stdout).toContain('needs: trustZone one of: internal');
            expect(r.stdout).toContain('Visibility: existence VISIBLE (placeholder emitted)');
        });

        it('allows the principal in the internal zone', () => {
            const r = ok(d, ['policy', 'explain', '--principal', 'ext', '--roles', 'ext', '--capability', 'read_owner_truth']);
            expect(r.stdout).toContain('Decision: ALLOW');
            expect(r.stdout).toContain('Matched policy: Allow internal (allow-int)');
        });

        it('policy test summarises allow/deny per capability using the cluster policies', () => {
            const r = ok(d, ['policy', 'test', '--principal', 'ext', '--roles', 'ext', '--capabilities', 'read_owner_truth,commit_command', '--trust-zone', 'external', '--store', 'ledger']);
            expect(r.stdout).toContain('Policy test for ext [ext] in zone external:');
            expect(r.stdout).toContain('✗ read_owner_truth: DENY — no ledger for externals (deny-ext-ledger)');
            expect(r.stdout).toContain('✗ commit_command: DENY — No matching policy found. Default is deny. (__default_deny)');
            expect(r.stdout).toContain('Summary: 0 allowed, 2 denied out of 2 actions.');
        });

        it('policy test marks allowed capabilities with a tick', () => {
            const r = ok(d, ['policy', 'test', '--principal', 'ext', '--roles', 'ext', '--capabilities', 'read_owner_truth']);
            expect(r.stdout).toContain('✓ read_owner_truth: ALLOW — ok (allow-int)');
            expect(r.stdout).toContain('Summary: 1 allowed, 0 denied out of 1 actions.');
        });
    });

    it('a deny with no allow rule anywhere says there is no 1- or 2-step fix', () => {
        const d = freshCluster('pe-noallow');
        writePolicies(d, {
            policies: [{ id: 'deny-all', name: 'Deny all', priority: 1, match: { principals: ['bob'] }, decision: 'deny', reason: 'closed' }],
        });
        const r = ok(d, ['policy', 'explain', '--principal', 'bob', '--roles', 'bob', '--capability', 'commit_command']);
        expect(r.stdout).toContain('Decision: DENY');
        expect(r.stdout).toContain('No 1- or 2-step allow rule found. Add a new policy or grant additional roles.');
    });

    it('policy explain and test require their options', () => {
        const d = freshCluster('pe-required');
        const e = cli(d, ['policy', 'explain', '--principal', 'x']);
        expect(e.status).not.toBe(0);
        expect(e.stderr).toContain("required option '--capability <cap>'");
        const t = cli(d, ['policy', 'test', '--principal', 'x']);
        expect(t.status).not.toBe(0);
        expect(t.stderr).toContain("required option '--capabilities <caps>'");
    });

    it('a malformed policies.json also stops the dry-run commands (exit 78)', () => {
        const d = freshCluster('pe-bad');
        writePolicies(d, '{');
        for (const args of [
            ['policy', 'explain', '--principal', 'x', '--capability', 'read_owner_truth'],
            ['policy', 'test', '--principal', 'x', '--capabilities', 'read_owner_truth'],
        ]) {
            const r = cli(d, args);
            expect(r.status, args.join(' ')).toBe(78);
        }
    });
});
