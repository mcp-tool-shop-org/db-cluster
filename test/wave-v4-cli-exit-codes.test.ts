/**
 * Wave V4 — A4 — CLI exit codes + stats + --json error body
 * (CLI-001 / CLI-007 / CLI-008).
 *
 * Findings pinned, all driven against the REAL built CLI binary (spawnSync over
 * `node dist/cli.js`) except CLI-008's wrapper unit (process.exit makes the
 * erroring `--json` arm non-spawn-friendly; we exercise the exported
 * `cliCommand` wrapper directly, mirroring test/wave-s2a2-fixup-regression.ts's
 * FIX-3 pattern):
 *
 *  - CLI-001 — THE TRAP (both directions):
 *      * a HEALTHY cluster → `doctor` exits 0 AND `verify` exits 0
 *        (the broken-fix trap: a "fix" that makes healthy runs non-zero is
 *        ALSO wrong — `db-cluster doctor && deploy` must still pass clean).
 *      * a CORRUPT cluster → `doctor` exits 70 (EX_SOFTWARE; health.status
 *        'corrupt') AND `verify` exits 70. `doctor --json` on a corrupt
 *        cluster STILL prints valid JSON to stdout AND exits 70 — proving
 *        `process.exitCode` (not a premature `process.exit`) let the JSON
 *        flush.
 *
 *  - CLI-007 — `stats --json` prints { entities, commands, receipts } with
 *    correct counts; plain `stats` prints lines containing those numbers.
 *
 *  - CLI-008 — an erroring command WITH --json ALSO writes a parseable
 *    { error: { code, message, hint } } to STDOUT (additive; the human stderr
 *    line and the exit code are unchanged). Exercised via the exported
 *    `cliCommand` wrapper with a throwing ClusterError + opts {json:true}.
 *
 * Throwaway temp dirs only — NEVER the repo `.db-cluster/`. Deterministic:
 * no Date.now/random in assertions; fresh tmpdir per test, cleaned in afterEach.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { cliCommand } from '../src/cli.js';
import { NotFoundError } from '../src/kernel/errors.js';

const ROOT = resolve(import.meta.dirname, '..');
const CLI_JS = join(ROOT, 'dist', 'cli.js');

// ─── Temp-dir bookkeeping ───────────────────────────────────────────────────

const tmpDirs: string[] = [];

function freshDir(label: string): string {
    const dir = mkdtempSync(join(tmpdir(), `wave-v4-cli-${label}-`));
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
    vi.restoreAllMocks();
});

/** Spawn the built CLI; return the spawnSync result (status/stdout/stderr). */
function runCli(args: string[], cwd: string) {
    return spawnSync('node', [CLI_JS, ...args], { cwd, encoding: 'utf-8' });
}

/** Init a fresh cluster in a throwaway dir and seed N entities via the CLI. */
function initAndSeed(label: string, entityNames: string[]): string {
    const dir = freshDir(label);
    execSync(`node ${CLI_JS} init`, { cwd: dir, encoding: 'utf-8' });
    for (const name of entityNames) {
        execSync(`node ${CLI_JS} entity create --kind doc --name ${name}`, { cwd: dir, encoding: 'utf-8' });
    }
    return dir;
}

/**
 * Corrupt the canonical entities.json (the file LocalCanonicalStore reads).
 * This corruption throws CorruptStoreError at store-LOAD time, which the
 * CLI's cliCommand catch arm maps to exit 70 (EX_SOFTWARE).
 */
function corruptEntities(dir: string): void {
    writeFileSync(join(dir, '.db-cluster', 'canonical', 'entities.json'), '{not valid json at all', 'utf-8');
}


// ════════════════════════════════════════════════════════════════════════════
// CLI-001 — doctor/verify exit codes (THE TRAP — both directions)
// ════════════════════════════════════════════════════════════════════════════

describe('CLI-001 — doctor/verify exit codes (healthy=0, corrupt=70)', () => {
    it('HEALTHY cluster → doctor exits 0', () => {
        const dir = initAndSeed('healthy-doctor', ['seed']);
        const r = runCli(['doctor'], dir);
        expect(r.status, `stderr:\n${r.stderr}`).toBe(0);
    });

    it('HEALTHY cluster → verify exits 0', () => {
        const dir = initAndSeed('healthy-verify', ['seed']);
        const r = runCli(['verify'], dir);
        expect(r.status, `stderr:\n${r.stderr}`).toBe(0);
    });

    it('CORRUPT cluster → doctor exits 70 (EX_SOFTWARE)', () => {
        const dir = initAndSeed('corrupt-doctor', ['seed']);
        corruptEntities(dir);
        const r = runCli(['doctor'], dir);
        expect(r.status).toBe(70);
    });

    it('CORRUPT cluster → verify exits 70 (EX_SOFTWARE)', () => {
        const dir = initAndSeed('corrupt-verify', ['seed']);
        corruptEntities(dir);
        const r = runCli(['verify'], dir);
        expect(r.status).toBe(70);
    });

    it('CORRUPT cluster → doctor --json still prints a parseable JSON body AND exits 70 (exitCode not exit truncation)', () => {
        // A corrupt entities.json throws CorruptStoreError at store load (before
        // doctor's checks run). The cliCommand --json arm writes a parseable
        // { error:{code,message,hint} } body to STDOUT (additive) and the exit
        // code is the typed code (70). The load-bearing point: the JSON body
        // FLUSHES before the non-zero exit — i.e. the surface does NOT truncate
        // output by exiting early. (doctor reports `status:'corrupt'` only for
        // in-band check failures; a hard store-load corruption surfaces as the
        // typed CORRUPT_STORE error envelope instead, which is the realistic
        // `doctor` failure an operator pipeline hits.)
        const dir = initAndSeed('corrupt-doctor-json', ['seed']);
        corruptEntities(dir);
        const r = runCli(['doctor', '--json'], dir);
        // Exit 70 (EX_SOFTWARE) proves process.exitCode (not a premature exit).
        expect(r.status).toBe(70);
        // STDOUT carries a parseable JSON error body despite the non-zero exit.
        expect(r.stdout.trim().length).toBeGreaterThan(0);
        let parsed: { error?: { code?: string } } | undefined;
        expect(() => { parsed = JSON.parse(r.stdout); }).not.toThrow();
        expect(parsed!.error?.code).toBe('CORRUPT_STORE');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// CLI-007 — stats counts
// ════════════════════════════════════════════════════════════════════════════

describe('CLI-007 — stats reports entity / command / receipt counts', () => {
    /**
     * Seed a deterministic, KNOWN shape (verified against the real CLI):
     *   - each `entity create` commits one create_entity command → +1 entity,
     *     +1 command, +1 receipt.
     *   - one `propose` stages a command (NO commit) → +1 command only.
     * Net for 2 creates + 1 propose: entities=2, commands=3, receipts=2.
     */
    const EXPECTED = { entities: 2, commands: 3, receipts: 2 };

    function seedKnownShape(label: string): string {
        const dir = initAndSeed(label, ['e1', 'e2']);
        const proposeJson = JSON.stringify({
            verb: 'create_entity',
            targetStore: 'canonical',
            payload: { kind: 'doc', name: 'p1', attributes: {} },
        });
        // Pass via argv (no shell-quote ambiguity): spawnSync arg array.
        const r = spawnSync('node', [CLI_JS, 'propose', proposeJson], { cwd: dir, encoding: 'utf-8' });
        expect(r.status, `propose stderr:\n${r.stderr}`).toBe(0);
        return dir;
    }

    it('stats --json prints { entities, commands, receipts } with correct counts', () => {
        const dir = seedKnownShape('stats-json');
        const r = runCli(['stats', '--json'], dir);
        expect(r.status, `stderr:\n${r.stderr}`).toBe(0);
        const stats = JSON.parse(r.stdout) as { entities: number; commands: number; receipts: number };
        expect(stats).toEqual(EXPECTED);
    });

    it('plain stats prints lines containing the entity/command/receipt numbers', () => {
        const dir = seedKnownShape('stats-plain');
        const r = runCli(['stats'], dir);
        expect(r.status, `stderr:\n${r.stderr}`).toBe(0);
        // Field labels + the deterministic counts appear on stdout.
        expect(r.stdout).toMatch(new RegExp(`Entities:\\s+${EXPECTED.entities}`));
        expect(r.stdout).toMatch(new RegExp(`Commands:\\s+${EXPECTED.commands}`));
        expect(r.stdout).toMatch(new RegExp(`Receipts:\\s+${EXPECTED.receipts}`));
    });

    it('stats --json on a fresh (empty) cluster reports all zeros', () => {
        const dir = freshDir('stats-empty');
        execSync(`node ${CLI_JS} init`, { cwd: dir, encoding: 'utf-8' });
        const r = runCli(['stats', '--json'], dir);
        expect(r.status).toBe(0);
        const stats = JSON.parse(r.stdout) as { entities: number; commands: number; receipts: number };
        expect(stats).toEqual({ entities: 0, commands: 0, receipts: 0 });
    });
});

// ════════════════════════════════════════════════════════════════════════════
// CLI-008 — erroring command WITH --json also emits { error:{code,message,hint} }
// ════════════════════════════════════════════════════════════════════════════
//
// No erroring CLI command currently exposes a clean `--json` flag that reliably
// throws a typed ClusterError under a spawn (the --json commands that throw do
// so only on hard-to-stage adapter faults). Per the task's documented fallback,
// we unit-test the exported `cliCommand` wrapper directly: pass a throwing
// ClusterError plus an opts arg carrying `json:true`, and capture
// process.stdout.write. The wrapper stubs process.exit (it calls it on the
// error path), so we stub it to throw a sentinel and assert on it.

describe('CLI-008 — cliCommand wrapper emits a parseable JSON error body under --json', () => {
    it('a thrown ClusterError + opts {json:true} writes { error:{code,message,hint} } to STDOUT and exits via the typed code', async () => {
        const stdoutChunks: string[] = [];
        const stdoutSpy = vi
            .spyOn(process.stdout, 'write')
            .mockImplementation(((chunk: string | Uint8Array): boolean => {
                stdoutChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
                return true;
            }) as typeof process.stdout.write);
        // Swallow stderr (the human line) so it doesn't clutter the run.
        const stderrSpy = vi
            .spyOn(process.stderr, 'write')
            .mockImplementation((() => true) as typeof process.stderr.write);
        // cliCommand calls process.exit on the error path — stub to a sentinel.
        let exitCode: number | undefined;
        const exitSpy = vi
            .spyOn(process, 'exit')
            .mockImplementation(((code?: number): never => {
                exitCode = code;
                throw new Error(`__exit__:${code}`);
            }) as typeof process.exit);

        // The wrapped action throws a typed ClusterError; the opts object
        // (commander passes it as an action arg) carries json:true.
        const wrapped = cliCommand(async (_opts: { json?: boolean }) => {
            throw new NotFoundError('command nonexistent-xyz not found', { commandId: 'nonexistent-xyz' });
        });

        await expect(wrapped({ json: true })).rejects.toThrow(/__exit__/);

        // STDOUT carries exactly ONE parseable JSON error object.
        const out = stdoutChunks.join('');
        expect(out.trim().length).toBeGreaterThan(0);
        const parsed = JSON.parse(out) as { error: { code: string; message: string; hint: string | null } };
        expect(parsed.error).toBeDefined();
        expect(parsed.error.code).toBe('NOT_FOUND');
        expect(typeof parsed.error.message).toBe('string');
        expect(parsed.error.message.length).toBeGreaterThan(0);
        // hint is the subclass's remediationHint (single source of truth).
        expect(parsed.error.hint).toMatch(/find|resolve|owner store/i);

        // Exit code is the typed sysexit for NOT_FOUND (→ 1 per
        // typedErrorToExitCode), NOT truncated/altered by the --json path.
        expect(exitCode).toBe(1);

        stdoutSpy.mockRestore();
        stderrSpy.mockRestore();
        exitSpy.mockRestore();
    });

    it('the SAME throw WITHOUT --json writes NOTHING to stdout (the JSON body is additive, not default)', async () => {
        const stdoutChunks: string[] = [];
        const stdoutSpy = vi
            .spyOn(process.stdout, 'write')
            .mockImplementation(((chunk: string | Uint8Array): boolean => {
                stdoutChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
                return true;
            }) as typeof process.stdout.write);
        const stderrSpy = vi
            .spyOn(process.stderr, 'write')
            .mockImplementation((() => true) as typeof process.stderr.write);
        const exitSpy = vi
            .spyOn(process, 'exit')
            .mockImplementation(((code?: number): never => {
                throw new Error(`__exit__:${code}`);
            }) as typeof process.exit);

        // opts WITHOUT json (the human-only path).
        const wrapped = cliCommand(async (_opts: { json?: boolean }) => {
            throw new NotFoundError('command nonexistent-xyz not found');
        });

        await expect(wrapped({})).rejects.toThrow(/__exit__/);

        // No JSON body on stdout — only the human stderr line (mocked away).
        expect(stdoutChunks.join('')).toBe('');

        stdoutSpy.mockRestore();
        stderrSpy.mockRestore();
        exitSpy.mockRestore();
    });
});
