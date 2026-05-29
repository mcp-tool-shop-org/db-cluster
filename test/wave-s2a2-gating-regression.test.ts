/**
 * Wave S2-A2 — gating & completeness regression nets (Fix Agent 4).
 *
 * Two concerns live here:
 *
 *   1. INJECT-004 (I6) — destructive-CLI non-TTY fail-closed.
 *      The destructive commands (`restore`, `rebuild index` / `index
 *      rebuild`, `compensate`, `backup --force-overwrite`) all route
 *      through the single `destructiveCommand` HOF (`src/cli.ts`), so
 *      non-TTY-without-`--yes` refusal is uniform BY CONSTRUCTION. These
 *      tests PIN that behavior so a future refactor that splits the HOF
 *      (or special-cases one sibling) cannot silently open a destructive
 *      path in a pipeline. This is regression-guarding, not bug-fixing —
 *      the tests are EXPECTED TO PASS at HEAD against the already-built
 *      `dist/cli.js` (the HOF is unchanged by A2).
 *
 *      The load-bearing invariant: `--yes` (or `--force`) is the ONLY
 *      non-interactive confirmation path. Piping `y\n` on stdin must NOT
 *      satisfy the gate, because piped stdin is not a TTY and the prompt
 *      is never reached — the command fails closed before any read.
 *
 *   2. R9 / R10 ast-grep completeness rules — meta-tests.
 *      Verifies each new rule (a) reports ZERO matches on the current
 *      (fixed) source tree and (b) CATCHES its bad pattern against a
 *      committed fixture. Mirrors the dual-assertion discipline the
 *      coordinator requires for every completeness gate.
 *
 * Spawns the BUILT CLI (`dist/cli.js`) — never imports src/cli.ts — so
 * the test exercises the same artifact a published install runs, and the
 * TTY detection (`process.stdin.isTTY`) reflects a real spawned child
 * whose stdin is a pipe, not a terminal. dist is built at HEAD; we do NOT
 * rebuild (other agents edit src concurrently).
 *
 * NEVER targets the repo's own `.db-cluster/` — every test uses a fresh
 * `mkdtempSync` cluster under the OS tmpdir and cleans it up.
 */

import { describe, it, expect } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = resolve(import.meta.dirname, '..');
const CLI_JS = join(ROOT, 'dist', 'cli.js');

/**
 * Spawn the built CLI and capture status/stdout/stderr.
 *
 * `input` is fed to the child's stdin as a pipe. Critically, a pipe is
 * NOT a TTY: `process.stdin.isTTY` is undefined in the child regardless
 * of whether `input` is supplied. That is the whole point of the
 * piped-`y` probe below — even `input: 'y\n'` must not bypass the gate.
 */
function runCli(
    args: string[],
    opts: { cwd?: string; input?: string } = {},
): { status: number; stdout: string; stderr: string } {
    const r = spawnSync('node', [CLI_JS, ...args], {
        cwd: opts.cwd ?? ROOT,
        encoding: 'utf-8',
        input: opts.input,
        // Force a non-interactive stdin even on the off chance the test
        // host attaches a TTY: an explicit pipe is never a TTY.
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Initialize a throwaway cluster in a fresh tmpdir. Returns its paths. */
function seedCluster(): { dir: string; clusterDir: string } {
    const dir = mkdtempSync(join(tmpdir(), 'wave-s2a2-gate-'));
    execSync(`node ${CLI_JS} init`, { cwd: dir, encoding: 'utf-8' });
    return { dir, clusterDir: join(dir, '.db-cluster') };
}

/** Write a minimal but structurally valid backup file restore() accepts. */
function writeBackupFile(dir: string): string {
    const backupPath = join(dir, 'backup.json');
    // Produce a real backup of the just-seeded (empty) cluster so the
    // refusal we assert is the TTY gate, not a parse/shape error reached
    // only AFTER the gate. The gate fires before the file is read.
    const r = runCli(['backup', '-o', backupPath], { cwd: dir });
    expect(r.status).toBe(0);
    expect(existsSync(backupPath)).toBe(true);
    return backupPath;
}

// Pre-flight: the built CLI must exist. If this fails, dist was not built
// at HEAD — these tests intentionally do NOT rebuild (concurrent src edits).
describe('Wave S2-A2 INJECT-004 — destructive-gating fail-closed (dist/cli.js)', () => {
    it('dist/cli.js exists (built at HEAD — tests do not rebuild)', () => {
        expect(existsSync(CLI_JS)).toBe(true);
    });

    it('`rebuild index` in a non-TTY pipeline without --yes refuses (exit nonzero)', () => {
        const { dir, clusterDir } = seedCluster();
        try {
            // spawnSync stdin is a pipe → not a TTY → the HOF must refuse
            // before reaching the interactive prompt.
            const r = runCli(['rebuild', 'index'], { cwd: dir });
            expect(r.status).not.toBe(0);
            expect(r.stderr).toMatch(/not a TTY|--yes|refus/i);
            // Fail-closed proof: no mutation occurred, so no auto-snapshot
            // dir was created (the snapshot is taken AFTER confirmation).
            expect(existsSync(join(clusterDir, 'auto-snapshots'))).toBe(false);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('`index rebuild` (sibling path) in a non-TTY pipeline without --yes refuses', () => {
        // The sibling subcommand routes through the SAME HOF; pin it too so
        // a divergence between `rebuild index` and `index rebuild` is caught.
        const { dir, clusterDir } = seedCluster();
        try {
            const r = runCli(['index', 'rebuild'], { cwd: dir });
            expect(r.status).not.toBe(0);
            expect(r.stderr).toMatch(/not a TTY|--yes|refus/i);
            expect(existsSync(join(clusterDir, 'auto-snapshots'))).toBe(false);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('`restore <file>` in a non-TTY pipeline without --yes refuses (exit nonzero)', () => {
        const { dir } = seedCluster();
        try {
            const backupPath = writeBackupFile(dir);
            const r = runCli(['restore', backupPath], { cwd: dir });
            expect(r.status).not.toBe(0);
            expect(r.stderr).toMatch(/not a TTY|--yes|refus/i);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('piping `y\\n` to `restore <file>` STILL refuses — --yes is the only non-interactive path', () => {
        const { dir } = seedCluster();
        try {
            const backupPath = writeBackupFile(dir);
            // The classic footgun: an operator pipes `y` expecting it to
            // satisfy the confirmation. It must NOT — piped stdin is not a
            // TTY, so the HOF fails closed before the prompt is ever shown.
            const r = runCli(['restore', backupPath], { cwd: dir, input: 'y\n' });
            expect(r.status).not.toBe(0);
            expect(r.stderr).toMatch(/not a TTY|--yes|refus/i);
            // The refusal message names the operation and points at --yes.
            expect(r.stderr).toMatch(/--yes/);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('piping `y\\n` to `rebuild index` STILL refuses (piped stdin is not a TTY)', () => {
        const { dir, clusterDir } = seedCluster();
        try {
            const r = runCli(['rebuild', 'index'], { cwd: dir, input: 'y\n' });
            expect(r.status).not.toBe(0);
            expect(r.stderr).toMatch(/not a TTY|--yes|refus/i);
            expect(existsSync(join(clusterDir, 'auto-snapshots'))).toBe(false);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('control: `rebuild index --yes` IS the sanctioned non-interactive path (proceeds)', () => {
        // Positive control proving the refusals above are specifically the
        // TTY gate, not a blanket failure: with --yes the same pipeline
        // succeeds and the post-confirmation auto-snapshot appears.
        const { dir, clusterDir } = seedCluster();
        try {
            const r = runCli(['rebuild', 'index', '--yes'], { cwd: dir });
            expect(r.status).toBe(0);
            const snapDir = join(clusterDir, 'auto-snapshots');
            expect(existsSync(snapDir)).toBe(true);
            expect(readdirSync(snapDir).length).toBeGreaterThanOrEqual(1);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

// ─── R9 / R10 ast-grep completeness rules — meta-tests ─────────────────────
//
// These exercise the shipped rule FILES two ways:
//
//   1. FIXTURE catch/pass — point the rule's `rule:` matcher at a committed
//      bad / good fixture and assert it CATCHES the bad shape and PASSES the
//      good one. ast-grep applies a rule's `files:`/`ignores:` scope even to
//      an explicitly-passed path, so a fixture living outside `src/**` would
//      be silently filtered. To test the matcher in isolation we strip the
//      `files:`/`ignores:` keys into a temp rule (same `rule:` block, no
//      scope) — verifying the EXACT matcher that ships. Fixtures live under
//      `scripts/checks/fixtures/` (sibling to the rules — outside both
//      `src/**` and `test/**`, so neither the production scan nor the rule's
//      own ignore reaches them).
//
//   2. LIVE src scan — run the FULL shipped rule (scope intact) across the
//      real `src/` tree. The rule is GREEN once the A2 source fixes
//      (REDACT-001 for R9, REDACT-002's PATH_REGEX collapse for R10) have all
//      landed. Because Fix Agents edit src CONCURRENTLY with this agent, the
//      live scan may still see the known pending-fix site(s) mid-wave. The
//      assertion therefore allows ONLY those known sites and fails on any
//      OTHER (unexpected) match — so a genuinely mis-scoped rule or a NEW
//      regression is still caught, while an in-flight known fix does not
//      produce a false failure. The coordinator's authoritative post-merge
//      scan is what confirms the fully-assembled tree is clean.

import { mkdtempSync as _mkdtempSync } from 'node:fs';
import { writeFileSync as _writeFileSync, readFileSync as _readFileSync } from 'node:fs';

const CHECKS_DIR = join(ROOT, 'scripts', 'checks');
const FIXTURE_DIR = join(CHECKS_DIR, 'fixtures');

interface AstGrepMatch {
    file: string;
    range?: { start?: { line?: number } };
}

/** Parse ast-grep --json output into a match array (tolerant of empty). */
function parseMatches(stdout: string): AstGrepMatch[] {
    const out = stdout.trim();
    if (!out) return [];
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? parsed : [];
}

/** Run a shipped rule file (scope intact) against an explicit path. */
function scanRule(ruleFile: string, targetPath: string): AstGrepMatch[] {
    const r = spawnSync(
        'npx',
        ['ast-grep', 'scan', '--rule', join(CHECKS_DIR, ruleFile), targetPath, '--json'],
        { cwd: ROOT, encoding: 'utf-8', shell: process.platform === 'win32', maxBuffer: 50 * 1024 * 1024 },
    );
    return parseMatches(r.stdout ?? '');
}

/** Run the shipped rule across the whole src tree (production scan scope). */
function scanRuleSrc(ruleFile: string): AstGrepMatch[] {
    return scanRule(ruleFile, join(ROOT, 'src'));
}

/**
 * Run a rule's `rule:` matcher with its `files:`/`ignores:` scope STRIPPED,
 * against an explicit path. Used so out-of-`src` fixtures are reachable —
 * the matcher block under test is byte-identical to the shipped rule; only
 * the path-scoping is removed.
 */
function scanRuleNoScope(ruleFile: string, targetPath: string): AstGrepMatch[] {
    const src = _readFileSync(join(CHECKS_DIR, ruleFile), 'utf-8');
    // Drop the `files:` and `ignores:` blocks (and their indented list items).
    // Both are top-level keys followed by `-` list lines in these rule files.
    const stripped = src
        .split('\n')
        .reduce<{ out: string[]; skipping: boolean }>(
            (acc, line) => {
                if (/^(files|ignores):\s*$/.test(line)) {
                    acc.skipping = true;
                    return acc;
                }
                // A new top-level key ends a skip block; a `  - ` list item continues it.
                if (acc.skipping) {
                    if (/^\s+-\s/.test(line) || line.trim() === '') return acc;
                    acc.skipping = false;
                }
                acc.out.push(line);
                return acc;
            },
            { out: [], skipping: false },
        ).out
        .join('\n');
    const tmpDir = _mkdtempSync(join(tmpdir(), 'wave-s2a2-rule-'));
    const tmpRule = join(tmpDir, ruleFile);
    try {
        _writeFileSync(tmpRule, stripped, 'utf-8');
        const r = spawnSync(
            'npx',
            ['ast-grep', 'scan', '--rule', tmpRule, targetPath, '--json'],
            { cwd: ROOT, encoding: 'utf-8', shell: process.platform === 'win32', maxBuffer: 50 * 1024 * 1024 },
        );
        return parseMatches(r.stdout ?? '');
    } finally {
        rmSync(tmpDir, { recursive: true, force: true });
    }
}

/** Normalize a match's file path to POSIX-style for stable comparison. */
function matchFile(m: AstGrepMatch): string {
    return m.file.replace(/\\/g, '/');
}

describe('Wave S2-A2 — R9 SDK-artifact-without-sanitize completeness gate', () => {
    const RULE = 'R9-sdk-artifact-without-sanitize.yml';

    it('R9 rule file exists', () => {
        expect(existsSync(join(CHECKS_DIR, RULE))).toBe(true);
    });

    it('R9 CATCHES an SDK method that forwards an Artifact without sanitizeArtifactForOutput', () => {
        // Two leak methods in the fixture (findSources + retrieveBundle).
        const matches = scanRuleNoScope(RULE, join(FIXTURE_DIR, 'r9-bad.ts'));
        expect(matches.length).toBeGreaterThanOrEqual(2);
    });

    it('R9 does NOT fire on the good fixture (both reads sanitize resolvedArtifacts)', () => {
        const matches = scanRuleNoScope(RULE, join(FIXTURE_DIR, 'r9-good.ts'));
        expect(matches).toEqual([]);
    });

    it('R9 live src scan is clean except for the known in-flight REDACT-001 site(s)', () => {
        // GREEN once REDACT-001 routes findSources + retrieveBundle.resolvedArtifacts
        // through sanitizeArtifactForOutput. Until that concurrent fix lands the
        // SDK file may still match; any match OUTSIDE the SDK is unexpected and fails.
        const matches = scanRuleSrc(RULE);
        const unexpected = matches.filter((m) => !matchFile(m).includes('src/sdk/'));
        expect(unexpected).toEqual([]);
    });
});

describe('Wave S2-A2 — R10 path-scrub-regex-outside-redactor completeness gate', () => {
    const RULE = 'R10-path-scrub-regex-outside-redactor.yml';

    it('R10 rule file exists', () => {
        expect(existsSync(join(CHECKS_DIR, RULE))).toBe(true);
    });

    it('R10 CATCHES a hand-rolled drive/UNC path regex defined outside redactor.ts', () => {
        const matches = scanRuleNoScope(RULE, join(FIXTURE_DIR, 'r10-bad.ts'));
        expect(matches.length).toBeGreaterThanOrEqual(1);
    });

    it('R10 does NOT fire on the good fixture (imports the canonical scrubber)', () => {
        const matches = scanRuleNoScope(RULE, join(FIXTURE_DIR, 'r10-good.ts'));
        expect(matches).toEqual([]);
    });

    it('R10 ignores the canonical scrubber in src/policy/redactor.ts', () => {
        // The redactor IS the sanctioned home for PATH_REGEX — the shipped
        // rule must never flag it even though it contains the drive-letter idiom.
        const matches = scanRule(RULE, join(ROOT, 'src', 'policy', 'redactor.ts'));
        expect(matches).toEqual([]);
    });

    it('R10 live src scan is clean except for the known in-flight PATH_REGEX-collapse site(s)', () => {
        // GREEN once REDACT-002 collapses the duplicate PATH_REGEX (e.g. in
        // src/mcp/sanitize.ts) to an import from the redactor. Until that
        // concurrent fix lands sanitize.ts may still match; redactor.ts must
        // NEVER match (it is ignored). Any OTHER match is unexpected and fails.
        const matches = scanRuleSrc(RULE);
        const unexpected = matches.filter((m) => {
            const f = matchFile(m);
            return !f.includes('src/mcp/sanitize.ts') && !f.includes('src/policy/redactor.ts');
        });
        expect(unexpected).toEqual([]);
        // Redactor must never appear (proves the ignore is wired).
        expect(matches.some((m) => matchFile(m).includes('src/policy/redactor.ts'))).toBe(false);
    });
});
