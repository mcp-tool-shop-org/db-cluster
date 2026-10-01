/**
 * Coverage — CLI operations surface (src/cli.ts).
 *
 * Child-process tests of `dist/cli.js` for the operator commands: doctor,
 * verify, stats, rebuild index/check, backup, restore (including the
 * auto-snapshot and conflict paths), stores list/verify/migrate,
 * migration-status, verify-schema and shell completion. Each test asserts on
 * exit code, output and the files / store state left behind.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CLI_JS = join(import.meta.dirname, '..', 'dist', 'cli.js');

interface Out { status: number | null; stdout: string; stderr: string }

function cli(cwd: string, args: string[], extraEnv: Record<string, string | undefined> = {}): Out {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.DB_CLUSTER_CANONICAL_BACKEND;
    delete env.DB_CLUSTER_POSTGRES_URL;
    delete env.DB_CLUSTER_DIR;
    delete env.DB_CLUSTER_OPERATOR;
    delete env.NO_COLOR;
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

function cleanup(...dirs: string[]): void {
    for (const d of dirs) {
        try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
    }
}

/** A cluster with one artifact and one entity; returns their ids. */
function seed(dir: string): { entityId: string; artifactId: string } {
    ok(dir, ['init']);
    writeFileSync(join(dir, 'doc.md'), '# Doc\n\nbody');
    const a = ok(dir, ['ingest', 'doc.md']);
    const e = ok(dir, ['entity', 'create', '--kind', 'note', '--name', 'Solid']);
    return { artifactId: grab(a.stdout, /artifact:\s+(\S+)/), entityId: grab(e.stdout, /id:\s+(\S+)/) };
}

/** Remove one entity from the owner store behind the index's back. */
function deleteEntityBehindIndex(dir: string, id: string): void {
    const file = join(dir, '.db-cluster', 'canonical', 'entities.json');
    const all = JSON.parse(readFileSync(file, 'utf-8')) as Array<{ id: string }>;
    writeFileSync(file, JSON.stringify(all.filter((e) => e.id !== id)));
}

describe('CLI operations', { timeout: 90_000 }, () => {
    let healthy: string;
    let ghost: string;
    let ghostEntityId: string;
    let healthyIds: { entityId: string; artifactId: string };

    beforeAll(() => {
        healthy = mkdtempSync(join(tmpdir(), 'cov-cli-ops-ok-'));
        healthyIds = seed(healthy);
        ghost = mkdtempSync(join(tmpdir(), 'cov-cli-ops-ghost-'));
        ghostEntityId = seed(ghost).entityId;
        deleteEntityBehindIndex(ghost, ghostEntityId);
    });

    afterAll(() => cleanup(healthy, ghost));

    describe('doctor', () => {
        it('reports a healthy cluster with sorted checks and exits 0', () => {
            const r = ok(healthy, ['doctor']);
            expect(r.stdout).toContain('Cluster: healthy');
            expect(r.stdout).toMatch(/Checks: \d+ total, \d+ healthy, 0 errors, 0 warnings/);
            expect(r.stdout).toContain('✓ [canonical] canonical_reachable');
            expect(r.stdout).not.toContain('Top fix:');
        });

        it('--json emits the health object even under --quiet', () => {
            const r = ok(healthy, ['--quiet', 'doctor', '--json']);
            const health = JSON.parse(r.stdout);
            expect(health.status).toBe('healthy');
            expect(health.summary.errors).toBe(0);
            expect(Array.isArray(health.checks)).toBe(true);
        });

        it('--quiet prints nothing in text mode', () => {
            const r = ok(healthy, ['--quiet', 'doctor']);
            expect(r.stdout).toBe('');
        });

        it('--log-level warn hides the verify progress lines but keeps the report', () => {
            const noisy = ok(healthy, ['verify']);
            expect(noisy.stderr).toMatch(/\[verify\] \d+\/\d+/);
            const r = ok(healthy, ['--log-level', 'warn', 'verify']);
            expect(r.stdout).toContain('Verification: healthy');
            expect(r.stderr).not.toContain('[verify]');
        });

        it('a degraded cluster lists the failing check first, adds a Top fix footer and exits 1', () => {
            const r = cli(ghost, ['doctor']);
            expect(r.status).toBe(1);
            expect(r.stdout).toContain('Cluster: degraded');
            const lines = r.stdout.split('\n').filter((l) => /^\s+[✓!✗] \[/.test(l));
            expect(lines[0]).toMatch(/^\s+! \[ledger\] provenance_references_valid/);
            expect(r.stdout).toContain('→ fix: db-cluster verify --json');
            expect(r.stdout).toContain('Top fix: db-cluster verify --json');
            expect(r.stdout).toContain('(check: provenance_references_valid');
        });

        it('a degraded cluster still exits 1 under --json and keeps stdout parseable', () => {
            const r = cli(ghost, ['doctor', '--json']);
            expect(r.status).toBe(1);
            expect(JSON.parse(r.stdout).status).toBe('degraded');
        });

        it('a corrupt store file exits 70 with the CORRUPT_STORE hint and no raw path in the headline', () => {
            const d = mkdtempSync(join(tmpdir(), 'cov-cli-ops-corrupt-'));
            try {
                seed(d);
                writeFileSync(join(d, '.db-cluster', 'canonical', 'entities.json'), '{');
                const r = cli(d, ['doctor']);
                expect(r.status).toBe(70);
                expect(r.stderr).toContain('Local store file is unreadable or corrupt: <path>');
                expect(r.stderr).toContain('→ try: Restore the cluster from a backup');
                const first = r.stderr.split('\n')[0]!;
                expect(first).not.toContain(d);
            } finally {
                cleanup(d);
            }
        });

        it('the same corruption under --json adds a structured error on stdout', () => {
            const d = mkdtempSync(join(tmpdir(), 'cov-cli-ops-corrupt2-'));
            try {
                seed(d);
                writeFileSync(join(d, '.db-cluster', 'canonical', 'entities.json'), '{');
                const r = cli(d, ['stats', '--json']);
                expect(r.status).toBe(70);
                const body = JSON.parse(r.stdout.trim().split('\n').pop()!);
                expect(body.error.code).toBe('CORRUPT_STORE');
                expect(body.error.message).toContain('<path>');
                expect(body.error.hint).toContain('Restore the cluster from a backup');
            } finally {
                cleanup(d);
            }
        });
    });

    describe('verify', () => {
        it('reports Verification: healthy and exits 0', () => {
            const r = ok(healthy, ['verify']);
            expect(r.stdout).toContain('Verification: healthy');
            expect(r.stdout).toContain('✓ command_receipt_bijection');
            expect(r.stderr).toMatch(/\[verify\] \d+\/\d+/);
        });

        it('--json honours --sample and --quiet leaves stdout empty in text mode', () => {
            const j = ok(healthy, ['verify', '--json', '--sample', '1']);
            expect(JSON.parse(j.stdout).status).toBe('healthy');
            const q = ok(healthy, ['--quiet', 'verify']);
            expect(q.stdout).toBe('');
            expect(q.stderr).not.toContain('[verify]');
        });

        it('exits 70 and marks the failing invariant when the index references a missing source', () => {
            const r = cli(ghost, ['verify']);
            expect(r.status).toBe(70);
            expect(r.stdout).toContain('Verification: corrupt');
            expect(r.stdout).toMatch(/✗ index_references_valid: 1 index record\(s\) reference non-existent source objects\./);
            expect(r.stdout).toMatch(/! provenance_references_valid/);
        });

        it('exits 70 under --json for the same condition', () => {
            const r = cli(ghost, ['verify', '--json']);
            expect(r.status).toBe(70);
            expect(JSON.parse(r.stdout).status).toBe('corrupt');
        });
    });

    describe('stats', () => {
        it('prints entity, command and receipt counts', () => {
            const r = ok(healthy, ['stats']);
            expect(r.stdout).toMatch(/Entities:\s+1\n/);
            expect(r.stdout).toMatch(/Commands:\s+2\n/);
            expect(r.stdout).toMatch(/Receipts:\s+2\n/);
        });

        it('--json emits the counts as an object', () => {
            expect(JSON.parse(ok(healthy, ['stats', '--json']).stdout)).toEqual({ entities: 1, commands: 2, receipts: 2 });
        });

        it('--quiet prints nothing in text mode but --json still prints', () => {
            expect(ok(healthy, ['--quiet', 'stats']).stdout).toBe('');
            expect(JSON.parse(ok(healthy, ['--quiet', 'stats', '--json']).stdout).entities).toBe(1);
        });
    });

    describe('rebuild', () => {
        it('check reports a clean index', () => {
            expect(ok(healthy, ['rebuild', 'check']).stdout).toContain('No stale records found.');
            expect(JSON.parse(ok(healthy, ['rebuild', 'check', '--json']).stdout)).toEqual([]);
        });

        it('check lists orphan index records with the suggested command', () => {
            const text = ok(ghost, ['rebuild', 'check']);
            expect(text.stdout).toContain('Found 1 stale record(s):');
            expect(text.stdout).toContain(`[orphan_index_record] canonical/${ghostEntityId}:`);
            const json = JSON.parse(ok(ghost, ['rebuild', 'check', '--json']).stdout);
            expect(json).toHaveLength(1);
            expect(json[0]).toMatchObject({ type: 'orphan_index_record', sourceId: ghostEntityId, suggestedCommand: 'db-cluster rebuild index' });
        });

        it('index --dry-run mutates nothing and takes no snapshot', () => {
            const d = mkdtempSync(join(tmpdir(), 'cov-cli-ops-dry-'));
            try {
                seed(d);
                const r = ok(d, ['rebuild', 'index', '--dry-run']);
                expect(r.stdout).toContain('(dry run)');
                expect(r.stderr).not.toContain('Auto-snapshot');
                expect(existsSync(join(d, '.db-cluster', 'auto-snapshots'))).toBe(false);
                const j = JSON.parse(ok(d, ['rebuild', 'index', '--dry-run', '--json']).stdout);
                expect(j.dryRun).toBe(true);
            } finally {
                cleanup(d);
            }
        });

        it('index refuses without --yes when stdin is not a TTY', () => {
            const r = cli(ghost, ['rebuild', 'index']);
            expect(r.status).toBe(1);
            expect(r.stderr).toContain('Refusing to rebuild index: stdin is not a TTY. Pass --yes to confirm non-interactively.');
        });

        it('index --yes snapshots first, drops the orphan record and leaves a clean index', () => {
            const d = mkdtempSync(join(tmpdir(), 'cov-cli-ops-rebuild-'));
            try {
                const { entityId } = seed(d);
                deleteEntityBehindIndex(d, entityId);
                expect(ok(d, ['rebuild', 'check']).stdout).toContain('Found 1 stale record(s):');
                const r = ok(d, ['rebuild', 'index', '--yes']);
                expect(r.stderr).toMatch(/Auto-snapshot saved to: .*rebuild-index/);
                expect(r.stderr).toMatch(/\[rebuild\] \d+\/\d+/);
                expect(r.stdout).toMatch(/Rebuilt: \d+ records/);
                expect(ok(d, ['rebuild', 'check']).stdout).toContain('No stale records found.');
                const snaps = readdirSync(join(d, '.db-cluster', 'auto-snapshots'));
                expect(snaps.some((n) => n.includes('rebuild-index'))).toBe(true);
            } finally {
                cleanup(d);
            }
        });

        it('index --force --json --quiet prints the result object only', () => {
            const d = mkdtempSync(join(tmpdir(), 'cov-cli-ops-rebuild2-'));
            try {
                seed(d);
                const r = ok(d, ['--quiet', 'rebuild', 'index', '--force', '--json']);
                const j = JSON.parse(r.stdout);
                expect(j).toMatchObject({ dryRun: false, errors: [] });
                expect(j.rebuilt).toBeGreaterThanOrEqual(2);
                expect(r.stderr).not.toContain('Auto-snapshot saved');
            } finally {
                cleanup(d);
            }
        });
    });

    describe('backup / restore', () => {
        it('backup with no -o prints the whole export as JSON on stdout', () => {
            const r = ok(healthy, ['backup']);
            const data = JSON.parse(r.stdout);
            expect(data.version).toBe(1);
            expect(data.entities).toHaveLength(1);
            expect(data.entities[0].id).toBe(healthyIds.entityId);
            expect(data.artifacts).toHaveLength(1);
            expect(data.receipts.length).toBe(2);
            expect(data.events.length).toBeGreaterThanOrEqual(2);
        });

        it('backup -o writes the file, reports on stderr and refuses to overwrite without --force', () => {
            const f = join(healthy, 'b1.json');
            const first = ok(healthy, ['backup', '-o', f]);
            expect(first.stdout).toBe('');
            expect(first.stderr).toContain('Backup written to');
            expect(JSON.parse(readFileSync(f, 'utf-8')).entities).toHaveLength(1);

            const again = cli(healthy, ['backup', '-o', 'b1.json']);
            expect(again.status).toBe(73);
            expect(again.stderr).toContain('Backup target already exists');
            expect(again.stderr).toContain('--force');

            const forced = ok(healthy, ['backup', '-o', 'b1.json', '--force']);
            expect(forced.stderr).toContain('Backup written to b1.json');
            const yes = ok(healthy, ['backup', '-o', 'b1.json', '--yes']);
            expect(yes.stderr).toContain('Backup written to b1.json');
        });

        it('backup -o under --quiet writes the file silently', () => {
            const f = join(healthy, 'b-quiet.json');
            const r = ok(healthy, ['--quiet', 'backup', '-o', f]);
            expect(r.stderr).not.toContain('Backup written');
            expect(existsSync(f)).toBe(true);
        });

        it('backup refusal under --json adds a BACKUP_TARGET_EXISTS error object (exit 73)', () => {
            ok(healthy, ['backup', '-o', 'b-json.json']);
            const r = cli(healthy, ['backup', '-o', 'b-json.json', '--json']);
            expect(r.status).toBe(73);
            const body = JSON.parse(r.stdout.trim().split('\n').pop()!);
            expect(body.error.code).toBe('BACKUP_TARGET_EXISTS');
            expect(body.error.hint).toContain('--force');
        });

        it('restore --dry-run previews counts without touching the target (text and JSON)', () => {
            const f = join(healthy, 'b-dry.json');
            ok(healthy, ['backup', '-o', f]);
            const target = mkdtempSync(join(tmpdir(), 'cov-cli-ops-restore-dry-'));
            try {
                ok(target, ['init']);
                const text = ok(target, ['restore', f, '--dry-run']);
                expect(text.stdout).toContain('Dry run (no mutation performed):');
                expect(text.stdout).toContain('Would restore: 1 entities,');
                expect(text.stdout).toContain('1 artifacts');
                const json = JSON.parse(ok(target, ['restore', f, '--dry-run', '--json']).stdout);
                expect(json.dryRun).toBe(true);
                expect(json.wouldRestore).toMatchObject({ entities: 1, artifacts: 1 });
                expect(JSON.parse(ok(target, ['stats', '--json']).stdout).entities).toBe(0);
                expect(existsSync(join(target, '.db-cluster', 'auto-snapshots'))).toBe(false);
            } finally {
                cleanup(target);
            }
        });

        it('restore into an empty cluster recreates the records and takes an auto-snapshot', () => {
            const f = join(healthy, 'b-restore.json');
            ok(healthy, ['backup', '-o', f]);
            const target = mkdtempSync(join(tmpdir(), 'cov-cli-ops-restore-'));
            try {
                ok(target, ['init']);
                const r = ok(target, ['restore', f, '--yes']);
                expect(r.stderr).toMatch(/Auto-snapshot saved to: .*restore/);
                expect(r.stdout).toContain('entities: 1 created, 0 skipped, 0 errored');
                expect(JSON.parse(ok(target, ['stats', '--json']).stdout)).toMatchObject({ entities: 1, receipts: 2 });
                expect(ok(target, ['inspect', healthyIds.entityId]).stdout).toContain('note/Solid');

                // A second restore of the same backup is idempotent: everything is skipped.
                const again = ok(target, ['restore', f, '--force', '--json']);
                const j = JSON.parse(again.stdout);
                expect(j.entities).toMatchObject({ created: 0, skipped: 1 });
                expect(j.warnings).toEqual([]);
            } finally {
                cleanup(target);
            }
        });

        it('restore --quiet prints no summary', () => {
            const f = join(healthy, 'b-restore-q.json');
            ok(healthy, ['backup', '-o', f]);
            const target = mkdtempSync(join(tmpdir(), 'cov-cli-ops-restore-q-'));
            try {
                ok(target, ['init']);
                const r = ok(target, ['--quiet', 'restore', f, '--yes']);
                expect(r.stdout).toBe('');
                expect(JSON.parse(ok(target, ['stats', '--json']).stdout).entities).toBe(1);
            } finally {
                cleanup(target);
            }
        });

        it('restore of a conflicting record reports the per-store error and exits 65', () => {
            const f = join(healthy, 'b-conflict.json');
            ok(healthy, ['backup', '-o', f]);
            const data = JSON.parse(readFileSync(f, 'utf-8'));
            data.entities[0].name = 'TAMPERED';
            writeFileSync(f, JSON.stringify(data));
            const r = cli(healthy, ['restore', f, '--yes']);
            expect(r.status).toBe(65);
            expect(r.stdout).toContain('entities: 0 created, 0 skipped, 1 errored');
            expect(r.stderr).toContain(`entities: Entity ${healthyIds.entityId}: Import conflict in canonical store`);
            // The live record is untouched.
            expect(ok(healthy, ['inspect', healthyIds.entityId]).stdout).toContain('note/Solid');
        });

        it('restore rejects a non-JSON backup with a positioned message and exit 1', () => {
            const f = join(healthy, 'b-bad.json');
            writeFileSync(f, '{');
            const r = cli(healthy, ['restore', f, '--yes']);
            expect(r.status).toBe(1);
            expect(r.stderr).toContain('Invalid JSON for backup file:');
            expect(r.stderr).toContain('"entities":[...]');
        });

        it('restore of a missing file exits 1 with a path-scrubbed message and the undo hint', () => {
            const r = cli(healthy, ['restore', 'no-such-backup.json', '--yes']);
            expect(r.status).toBe(1);
            expect(r.stderr).toContain("Error: ENOENT: no such file or directory, open '<path>'");
            expect(r.stderr).toContain('→ undo: restore the prior state from the auto-snapshot at');
            expect(r.stderr).toContain('cluster-snapshot.json');
        });

        it('restore under --json reports a system error by its own code', () => {
            const r = cli(healthy, ['restore', 'no-such-backup.json', '--yes', '--json']);
            expect(r.status).toBe(1);
            const body = JSON.parse(r.stdout.trim().split('\n').pop()!);
            expect(body.error.code).toBe('ENOENT');
            expect(body.error.hint).toBeNull();
        });

        it('an unexpected non-typed failure exits 1 as INTERNAL_ERROR under --json and prints Error: otherwise', () => {
            const f = join(healthy, 'b-null.json');
            writeFileSync(f, 'null');
            const plain = cli(healthy, ['restore', f, '--yes']);
            expect(plain.status).toBe(1);
            expect(plain.stderr).toContain("Error: Cannot read properties of null (reading 'version')");
            expect(plain.stderr).not.toContain('at restore');
            const json = cli(healthy, ['restore', f, '--yes', '--json']);
            expect(json.status).toBe(1);
            const body = JSON.parse(json.stdout.trim().split('\n').pop()!);
            expect(body.error).toMatchObject({ code: 'INTERNAL_ERROR', hint: null });
            expect(body.error.message).toContain('Cannot read properties of null');
        });

        it('restore refuses without --yes when stdin is not a TTY', () => {
            const r = cli(healthy, ['restore', 'whatever.json']);
            expect(r.status).toBe(1);
            expect(r.stderr).toContain('Refusing to restore: stdin is not a TTY. Pass --yes to confirm non-interactively.');
        });

        it('DEBUG=1 prints the full stack for an unexpected failure instead of the one-line message', () => {
            const f = join(healthy, 'b-null2.json');
            writeFileSync(f, 'null');
            const r = cli(healthy, ['restore', f, '--yes'], { DEBUG: '1' });
            expect(r.status).toBe(1);
            expect(r.stderr).toContain('TypeError: Cannot read properties of null');
            expect(r.stderr).toMatch(/\n\s+at restore /);
            expect(r.stderr).not.toMatch(/^Error: Cannot read properties/m);
        });
    });

    describe('stores', () => {
        it('list shows the local canonical backend and the three local stores', () => {
            const r = ok(healthy, ['stores', 'list']);
            expect(r.stdout).toContain('Backend     Store');
            expect(r.stdout).toMatch(/local\s+canonical/);
            expect(r.stdout).toMatch(/local\s+artifact/);
            expect(r.stdout).toMatch(/local\s+index/);
            expect(r.stdout).toMatch(/local\s+ledger/);
        });

        it('verify confirms the local cluster directory exists', () => {
            const r = ok(healthy, ['stores', 'verify']);
            expect(r.stdout).toContain('canonical: local');
            expect(r.stdout).toContain('✓ Local cluster directory exists');
            expect(r.stdout).toContain('Contract compatibility: all backends implement CanonicalStore interface');
        });

        it('verify tells the operator to init when no cluster exists', () => {
            const d = mkdtempSync(join(tmpdir(), 'cov-cli-ops-nocluster-'));
            try {
                const r = ok(d, ['stores', 'verify']);
                expect(r.stdout).toContain('✗ No cluster initialized. Run: db-cluster init');
            } finally {
                cleanup(d);
            }
        });

        it('migrate is a no-op for the local backend', () => {
            expect(ok(healthy, ['stores', 'migrate']).stdout).toContain('No migrations needed for local backend.');
        });

        it('an unknown backend exits 78 (INVALID_BACKEND_CONFIG) with a hint', () => {
            for (const sub of ['verify', 'migrate', 'list']) {
                const r = cli(healthy, ['stores', sub], { DB_CLUSTER_CANONICAL_BACKEND: 'mysql' });
                expect(r.status, sub).toBe(78);
                expect(r.stderr).toContain('→ try: Set DB_CLUSTER_CANONICAL_BACKEND');
            }
        });

        it('postgres without a URL exits 78', () => {
            const r = cli(healthy, ['stores', 'verify'], { DB_CLUSTER_CANONICAL_BACKEND: 'postgres' });
            expect(r.status).toBe(78);
            expect(r.stderr).toContain('DB_CLUSTER_POSTGRES_URL');
        });

        it('sqlite: list, verify and migrate open the database file', () => {
            const d = mkdtempSync(join(tmpdir(), 'cov-cli-ops-sqlite-'));
            try {
                const env = { DB_CLUSTER_CANONICAL_BACKEND: 'sqlite' };
                ok(d, ['init'], env);
                expect(ok(d, ['stores', 'list'], env).stdout).toMatch(/sqlite\s+canonical/);
                const v = ok(d, ['stores', 'verify'], env);
                expect(v.stdout).toContain('canonical: sqlite');
                expect(v.stdout).toContain('✓ SQLite database: .db-cluster/sqlite/cluster.db');
                const m = ok(d, ['stores', 'migrate'], env);
                expect(m.stdout).toContain('✓ SQLite schema ready (migrations run on open)');
                expect(existsSync(join(d, '.db-cluster', 'sqlite', 'cluster.db'))).toBe(true);
            } finally {
                cleanup(d);
            }
        });

        it('postgres verify against an unreachable server exits 1 and reports the failure', () => {
            const r = cli(healthy, ['stores', 'verify'], {
                DB_CLUSTER_CANONICAL_BACKEND: 'postgres',
                DB_CLUSTER_POSTGRES_URL: 'postgres://u:p@127.0.0.1:1/db',
            });
            expect(r.status).toBe(1);
            expect(r.stdout).toContain('canonical: postgres');
            expect(r.stderr).toContain('✗ Postgres connection failed:');
            expect(r.stderr).not.toContain('u:p');
        });

        it('postgres migrate against an unreachable server exits 1', () => {
            const r = cli(healthy, ['stores', 'migrate'], {
                DB_CLUSTER_CANONICAL_BACKEND: 'postgres',
                DB_CLUSTER_POSTGRES_URL: 'postgres://u:p@127.0.0.1:1/db',
            });
            expect(r.status).toBe(1);
            expect(r.stdout).not.toContain('Migrations applied');
            expect(r.stderr).toContain('Error:');
        });

        it('postgres migrate without a URL for a postgres backend is rejected at config time', () => {
            const r = cli(healthy, ['stores', 'migrate'], { DB_CLUSTER_CANONICAL_BACKEND: 'postgres' });
            expect(r.status).toBe(78);
        });
    });

    describe('migration-status / verify-schema', () => {
        it('both exit 1 when DB_CLUSTER_POSTGRES_URL is not set', () => {
            for (const sub of ['migration-status', 'verify-schema']) {
                const r = cli(healthy, [sub]);
                expect(r.status, sub).toBe(1);
                expect(r.stderr).toContain('DB_CLUSTER_POSTGRES_URL not set.');
            }
        });

        it('migration-status reports the connection failure instead of crashing', () => {
            const env = { DB_CLUSTER_POSTGRES_URL: 'postgres://u:p@127.0.0.1:1/db' };
            const text = ok(healthy, ['migration-status'], env);
            expect(text.stdout).toContain('Backend: postgres');
            expect(text.stdout).toContain('Migrated: false');
            expect(text.stdout).toContain('Tables: (none)');
            expect(text.stdout).toContain('Failed to check migration status:');
            const json = JSON.parse(ok(healthy, ['migration-status', '--json'], env).stdout);
            expect(json).toMatchObject({ backend: 'postgres', migrated: false, tables: [] });
        });

        it('verify-schema lists the issue for an unreachable server (text and JSON)', () => {
            const env = { DB_CLUSTER_POSTGRES_URL: 'postgres://u:p@127.0.0.1:1/db' };
            const text = ok(healthy, ['verify-schema'], env);
            expect(text.stdout).toContain('Schema valid: false');
            expect(text.stdout).toContain('✗ Schema verification failed:');
            const json = JSON.parse(ok(healthy, ['verify-schema', '--json'], env).stdout);
            expect(json.valid).toBe(false);
            expect(json.issues[0]).toContain('Schema verification failed');
        });
    });

    describe('completion', () => {
        it('bash script registers the completion function with every top-level command', () => {
            const r = ok(healthy, ['completion', 'bash']);
            expect(r.stdout).toContain('complete -F _db_cluster db-cluster');
            for (const cmd of ['init', 'ingest', 'doctor', 'backup', 'restore', 'completion', '--help-exit-codes']) {
                expect(r.stdout).toContain(cmd);
            }
            expect(r.stderr).toContain('# To install:');
        });

        it('zsh script has the #compdef header', () => {
            const r = ok(healthy, ['completion', 'zsh']);
            expect(r.stdout.startsWith('#compdef db-cluster')).toBe(true);
            expect(r.stdout).toContain("'stats'");
        });

        it.each(['pwsh', 'powershell'])('%s script registers an argument completer', (shell) => {
            const r = ok(healthy, ['completion', shell]);
            expect(r.stdout).toContain('Register-ArgumentCompleter -Native -CommandName db-cluster');
            expect(r.stdout).toContain("'verify'");
        });

        it('an unknown shell exits 1 with usage on stderr and nothing on stdout', () => {
            const r = cli(healthy, ['completion', 'fish']);
            expect(r.status).toBe(1);
            expect(r.stdout).toBe('');
            expect(r.stderr).toContain('Unknown shell: fish');
            expect(r.stderr).toContain('db-cluster completion bash | zsh | pwsh');
        });
    });
});
