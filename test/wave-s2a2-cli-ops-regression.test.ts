/**
 * Wave S2-A2 — CLI & ops error-surface regression suite (Fix Agent 2).
 *
 * Three LOW-severity egress / redaction findings on the CLI + ops boundary.
 * Each `describe` block is a FAIL→PASS gate written BEFORE the fix:
 *
 *  - REDACT-003 (I2): the CLI `ClusterError` catch arm rendered the raw
 *    `err.message`, which for path-bearing subclasses
 *    (StagedContentTamperedError, CommandQueueCorruptError,
 *    CommandQueuePersistenceLostError) leaks an absolute stagingPath /
 *    filePath / markerPath. The headline must be routed through the SAME
 *    scrubber the sibling adapter-error arm already uses — but the
 *    remediation hint (a static literal) must survive intact.
 *
 *  - EGRESS-002 (I7): `resolveClusterDir` read a `clusterDir` from
 *    `.db-cluster/config.json` and `resolve()`d it with no containment. An
 *    attacker who drops a malicious config.json in a cwd a victim later
 *    runs from could redirect the cluster root anywhere on disk. The
 *    config.json-sourced path must be contained to cwd. The explicit
 *    `DB_CLUSTER_DIR` env override is operator-intentional and stays
 *    unconstrained.
 *
 *  - EGRESS-003 (I2): the Postgres error surfaces in the CLI + ops layer
 *    (`stores list` postgres branch, doctor's postgres_migration check,
 *    migrations' checkMigrationStatus + verifySchema) surfaced raw
 *    `err.message`. No passwords today, but a unix-socket path
 *    (`/var/run/postgresql/.s.PGSQL.5432`) prints verbatim. Each routes
 *    through `redactErrorMessage`.
 *
 * All assertions run against the LIVE TypeScript source (vitest transforms
 * `../src/*.js` specifiers on the fly), so the gate reflects the source
 * edits without a `dist` rebuild. Throwaway temp dirs only; each is torn
 * down in `afterEach`/`finally`.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
    mkdtempSync,
    mkdirSync,
    writeFileSync,
    rmSync,
    realpathSync,
    readFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { resolveClusterDir, renderClusterErrorForCli } from '../src/cli.js';
import { StagedContentTamperedError } from '../src/kernel/errors.js';
import { checkMigrationStatus, verifySchema } from '../src/ops/migrations.js';
import { doctor } from '../src/ops/doctor.js';
import { createLocalCluster } from '../src/adapters/local/index.js';

const ROOT = resolve(import.meta.dirname, '..');

/** Track temp dirs for teardown. */
const created: string[] = [];
function tempDir(prefix: string): string {
    const d = mkdtempSync(join(tmpdir(), `wave-s2a2-${prefix}-`));
    created.push(d);
    return d;
}

afterEach(() => {
    while (created.length > 0) {
        const d = created.pop()!;
        try {
            rmSync(d, { recursive: true, force: true });
        } catch {
            /* best-effort */
        }
    }
});

// ─── REDACT-003 — CLI ClusterError headline is path-scrubbed ───────────────

describe('REDACT-003 — CLI ClusterError arm scrubs absolute paths from the headline', () => {
    it('scrubs an absolute stagingPath out of the rendered headline but keeps the hint', () => {
        // A path-bearing ClusterError subclass: its message embeds an
        // absolute stagingPath verbatim (kernel/errors.ts:469-474).
        const stagingPath =
            process.platform === 'win32'
                ? 'C:\\Users\\victim\\secret-project\\.db-cluster\\pending-content\\abc123.blob'
                : '/home/victim/secret-project/.db-cluster/pending-content/abc123.blob';
        const err = new StagedContentTamperedError(
            'sha256:claimed',
            stagingPath,
            'sha256:actual',
        );

        const rendered = renderClusterErrorForCli(err);

        // Both halves of the contract:
        // (a) the path is scrubbed — no absolute path / no stagingPath leak.
        expect(rendered).not.toContain(stagingPath);
        expect(rendered).not.toContain('victim');
        expect(rendered).not.toContain('secret-project');
        expect(rendered).toContain('<path>');
        // (b) the error still renders usefully: the typed remediation hint
        //     (a static literal, no path) survives intact.
        expect(rendered).toContain('→ try:');
        expect(rendered).toContain('preserved for forensic inspection');
    });

    it('leaves a path-free ClusterError message unchanged (no over-scrub)', () => {
        const err = new StagedContentTamperedError(
            'sha256:claimed',
            'relative-staging-token', // not an absolute path
            'sha256:actual',
        );
        const rendered = renderClusterErrorForCli(err);
        expect(rendered).toContain('relative-staging-token');
        expect(rendered).toContain('→ try:');
    });
});

// ─── EGRESS-002 — config.json clusterDir is contained to cwd ───────────────

describe('EGRESS-002 — config.json-sourced clusterDir cannot redirect outside cwd', () => {
    it('rejects/ignores an ABSOLUTE clusterDir pointing outside cwd', () => {
        const victimCwd = tempDir('egress2-abs-cwd');
        const attackerTarget = tempDir('egress2-abs-target');
        mkdirSync(join(victimCwd, '.db-cluster'), { recursive: true });
        writeFileSync(
            join(victimCwd, '.db-cluster', 'config.json'),
            JSON.stringify({ clusterDir: attackerTarget }),
        );

        const resolved = resolveClusterDir(victimCwd, {});

        // The cluster root must NOT have been redirected to the attacker's
        // out-of-cwd absolute path. Containment falls back to the in-cwd
        // default `<cwd>/.db-cluster`.
        const realResolved = realpathSync(resolved);
        const realTarget = realpathSync(attackerTarget);
        expect(realResolved).not.toBe(realTarget);
        expect(realResolved.startsWith(realpathSync(victimCwd))).toBe(true);
    });

    it('rejects/ignores a ../ traversal clusterDir escaping cwd', () => {
        const parent = tempDir('egress2-trav-parent');
        const victimCwd = join(parent, 'project');
        mkdirSync(join(victimCwd, '.db-cluster'), { recursive: true });
        // `../escaped` resolves to a sibling of project, i.e. outside cwd.
        writeFileSync(
            join(victimCwd, '.db-cluster', 'config.json'),
            JSON.stringify({ clusterDir: '../escaped' }),
        );

        const resolved = resolveClusterDir(victimCwd, {});
        const realResolved = realpathSync(resolved);
        expect(realResolved.startsWith(realpathSync(victimCwd))).toBe(true);
        expect(realResolved).not.toContain('escaped');
    });

    it('still honors a legitimate IN-CWD clusterDir', () => {
        const victimCwd = tempDir('egress2-legit-cwd');
        const legit = join(victimCwd, 'custom-data');
        mkdirSync(legit, { recursive: true });
        mkdirSync(join(victimCwd, '.db-cluster'), { recursive: true });
        writeFileSync(
            join(victimCwd, '.db-cluster', 'config.json'),
            JSON.stringify({ clusterDir: legit }),
        );

        const resolved = resolveClusterDir(victimCwd, {});
        expect(realpathSync(resolved)).toBe(realpathSync(legit));
    });

    it('leaves the explicit DB_CLUSTER_DIR env override unconstrained (operator intent)', () => {
        const victimCwd = tempDir('egress2-env-cwd');
        const outside = tempDir('egress2-env-outside');
        const resolved = resolveClusterDir(victimCwd, {
            DB_CLUSTER_DIR: outside,
        });
        // Env override is a documented operator escape hatch — it MAY point
        // outside cwd. (This half guards against over-correcting by clamping
        // the env path too.)
        expect(realpathSync(resolved)).toBe(realpathSync(outside));
    });
});

// ─── EGRESS-003 — Postgres error paths are scrubbed ────────────────────────

describe('EGRESS-003 — Postgres error surfaces scrub filesystem paths', () => {
    // A unix-socket path is the canonical leak the finding calls out.
    const SOCKET_PATH = '/var/run/postgresql/.s.PGSQL.5432';
    const pgErrMessage = `connect ENOENT ${SOCKET_PATH}`;

    /** A MigrationPool whose query always rejects with a path-bearing error. */
    const throwingMigrationPool = {
        query: async (_text: string, _values?: unknown[]) => {
            throw new Error(pgErrMessage);
        },
    };

    it('migrations.checkMigrationStatus scrubs the socket path from message', async () => {
        const status = await checkMigrationStatus(throwingMigrationPool);
        expect(status.migrated).toBe(false);
        expect(status.message).not.toContain(SOCKET_PATH);
        expect(status.message).toContain('<path>');
    });

    it('migrations.verifySchema scrubs the socket path from issues[]', async () => {
        const result = await verifySchema(throwingMigrationPool);
        expect(result.valid).toBe(false);
        expect(result.issues.length).toBeGreaterThan(0);
        expect(result.issues.join(' ')).not.toContain(SOCKET_PATH);
        expect(result.issues.join(' ')).toContain('<path>');
    });

    it('doctor postgres_migration check scrubs the socket path from its message', async () => {
        const dir = tempDir('egress3-doctor');
        const stores = createLocalCluster(dir);
        // postgresPool whose information_schema query throws a path-bearing error.
        const postgresPool = {
            query: async (_text: string, _values?: unknown[]) => {
                throw new Error(pgErrMessage);
            },
        };
        const health = await doctor(stores, { postgresPool });
        const pgCheck = health.checks.find((c) => c.name === 'postgres_migration');
        expect(pgCheck).toBeDefined();
        expect(pgCheck!.status).toBe('unreachable');
        expect(pgCheck!.message).not.toContain(SOCKET_PATH);
        expect(pgCheck!.message).toContain('<path>');
    });

    it('cli.ts stores-list Postgres-failure surface routes err.message through the scrubber', () => {
        // The `stores list` postgres branch lives inside a .action() that
        // calls process.exit on failure, so it is not directly unit-callable.
        // Guard the fix at the source: the raw `err.message` interpolation at
        // the Postgres-connection-failed line must be wrapped in
        // redactErrorMessage (the shared scrubber), and the bare
        // `${err.message}` form must be gone from that line.
        const src = readFileSync(join(ROOT, 'src', 'cli.ts'), 'utf-8');
        const line = src
            .split('\n')
            .find((l) => l.includes('Postgres connection failed'));
        expect(line, 'Postgres-connection-failed line present').toBeDefined();
        expect(line!).toContain('redactErrorMessage');
        expect(line!).not.toMatch(/\$\{\s*err\.message\s*\}/);
    });
});
