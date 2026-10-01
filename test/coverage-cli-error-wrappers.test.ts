/**
 * Coverage — CLI error and confirmation wrappers (src/cli.ts), in-process.
 *
 * `cliCommand` and `destructiveCommand` are exported, so they are driven
 * directly here with `process.exit` / stderr / stdout stubbed. This reaches
 * what a child process cannot: a TTY confirmation prompt, and error shapes
 * that no CLI command produces on a healthy machine (adapter-style errors
 * carrying only a `code`, for every code the CLI maps to a remediation hint).
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

const readlineMock = vi.hoisted(() => ({
    answers: [] as string[],
    prompts: [] as string[],
    closed: 0,
}));

vi.mock('node:readline/promises', () => ({
    createInterface: () => ({
        question: async (prompt: string) => {
            readlineMock.prompts.push(prompt);
            return readlineMock.answers.shift() ?? '';
        },
        close: () => { readlineMock.closed += 1; },
    }),
}));

import { cliCommand, destructiveCommand, typedErrorToExitCode } from '../src/cli.js';
import { PolicyConfigError } from '../src/mcp/config-validator.js';
import { NotFoundError } from '../src/kernel/errors.js';

class ExitSignal extends Error {
    constructor(public readonly code: number | undefined) {
        super(`__exit__:${code}`);
    }
}

interface Captured { stdout: string; stderr: string; exitCode: number | undefined }

/** Stub process.exit / stdout / stderr, run `fn`, and report what it did. */
async function capture(fn: () => Promise<void>): Promise<Captured> {
    const out: Captured = { stdout: '', stderr: '', exitCode: undefined };
    vi.spyOn(process.stdout, 'write').mockImplementation(((c: string | Uint8Array) => {
        out.stdout += typeof c === 'string' ? c : Buffer.from(c).toString('utf-8');
        return true;
    }) as typeof process.stdout.write);
    vi.spyOn(process.stderr, 'write').mockImplementation(((c: string | Uint8Array) => {
        out.stderr += typeof c === 'string' ? c : Buffer.from(c).toString('utf-8');
        return true;
    }) as typeof process.stderr.write);
    vi.spyOn(console, 'error').mockImplementation(((...a: unknown[]) => {
        out.stderr += a.map(String).join(' ') + '\n';
    }) as typeof console.error);
    vi.spyOn(process, 'exit').mockImplementation(((code?: number): never => {
        out.exitCode = code;
        throw new ExitSignal(code);
    }) as typeof process.exit);
    try {
        await fn();
    } catch (e) {
        if (!(e instanceof ExitSignal)) throw e;
    }
    return out;
}

function setStdinTty(value: boolean | undefined): void {
    Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true, writable: true });
}

let originalTty: boolean | undefined;

beforeEach(() => {
    originalTty = process.stdin.isTTY;
    readlineMock.answers.length = 0;
    readlineMock.prompts.length = 0;
    readlineMock.closed = 0;
});

afterEach(() => {
    vi.restoreAllMocks();
    setStdinTty(originalTty);
});

describe('cliCommand — adapter-style typed errors map to a hint and an exit code', () => {
    // [code, expected exit code, a phrase from the code's CLI-flavoured hint]
    const table: Array<[string, number, string]> = [
        ['POLICY_DENIED', 77, 'db-cluster policy explain'],
        ['NOT_FOUND', 1, 'db-cluster find <query>'],
        ['PROVENANCE_MISSING', 1, 'db-cluster trace <uri>'],
        ['COMMAND_NOT_VALIDATED', 1, 'db-cluster validate <id> && db-cluster approve <id>'],
        ['COMMAND_REJECTED', 1, 'Rejected commands are terminal'],
        ['RECEIPT_FAILED', 70, 'db-cluster verify --json'],
        ['COMMAND_QUEUE_CORRUPT', 70, 'db-cluster restore <file>'],
        ['COMMAND_QUEUE_PERSISTENCE_LOST', 70, 'remove the marker file'],
        ['CONTENT_HASH_MISMATCH', 65, 'Recompute sha256(content)'],
        ['STAGED_CONTENT_TAMPERED', 65, 'staging directory'],
        ['INVALID_CONTENT_SHAPE', 65, 'payload.content must be a Buffer'],
        ['CORRUPT_STORE', 70, 'db-cluster doctor'],
        ['INVALID_CONTENT_HASH', 65, 're-supply the matching contentHash'],
        ['IMPORT_CONFLICT', 65, 'ID collision'],
        ['LEDGER_CYCLE_DETECTED', 70, 'clean backup'],
        ['INVALID_POLICY_CONFIG', 78, '.db-cluster/policies.json'],
        ['INVALID_REDACTION_RULE', 78, 'redaction rule is malformed'],
        ['INVALID_ROTATE_TIMESTAMP', 78, 'ISO-8601'],
        ['ROTATE_BOUNDARY_IN_FUTURE', 78, 'cannot be in the future'],
        ['INVALID_CLUSTER_URI', 65, 'cluster://<store>/<id>'],
        ['INVALID_ACTOR', 65, '--actor <id>'],
        ['INVALID_BACKEND_CONFIG', 78, 'DB_CLUSTER_CANONICAL_BACKEND'],
        ['RESOLVE_NOT_FOUND', 1, 'does not resolve'],
        ['BACKUP_TARGET_EXISTS', 73, '--force'],
        ['COMMAND_VALIDATION_FAILED', 65, 'structural validation'],
        ['COMMAND_NOT_FOUND', 1, 'db-cluster propose <command-json>'],
        ['COMMAND_ALREADY_TERMINAL', 1, 'db-cluster compensate <command-id>'],
        ['INVALID_STATE_TRANSITION', 1, 'db-cluster inspect-command <command-id>'],
    ];

    it.each(table)('%s → exit %i with a "→ try:" hint', async (code, exit, phrase) => {
        const wrapped = cliCommand(async () => {
            throw Object.assign(new Error(`boom ${code}`), { code });
        });
        const out = await capture(() => wrapped());
        expect(out.exitCode).toBe(exit);
        expect(out.exitCode).toBe(typedErrorToExitCode(code));
        expect(out.stderr).toContain(`Error: boom ${code}`);
        expect(out.stderr).toContain('→ try:');
        expect(out.stderr).toContain(phrase);
    });

    it('an unknown code exits 1 and prints no hint line', async () => {
        const wrapped = cliCommand(async () => {
            throw Object.assign(new Error('mystery'), { code: 'SOMETHING_NEW' });
        });
        const out = await capture(() => wrapped());
        expect(out.exitCode).toBe(1);
        expect(out.stderr).toContain('Error: mystery');
        expect(out.stderr).not.toContain('→ try:');
    });

    it('an error that carries its own remediationHint wins over the CLI table', async () => {
        const wrapped = cliCommand(async () => {
            throw Object.assign(new Error('custom'), { code: 'NOT_FOUND', remediationHint: 'use the bespoke fix' });
        });
        const out = await capture(() => wrapped());
        expect(out.stderr).toContain('→ try: use the bespoke fix');
        expect(out.stderr).not.toContain('db-cluster find <query>');
    });

    it('under --json the same error also lands on stdout with its hint', async () => {
        const wrapped = cliCommand(async (_o: { json?: boolean }) => {
            throw Object.assign(new Error('gone'), { code: 'NOT_FOUND' });
        });
        const out = await capture(() => wrapped({ json: true }));
        const body = JSON.parse(out.stdout);
        expect(body.error.code).toBe('NOT_FOUND');
        expect(body.error.message).toBe('gone');
        expect(body.error.hint).toContain('db-cluster find <query>');
        expect(out.exitCode).toBe(1);
    });

    it('under --json an unknown code reports a null hint', async () => {
        const wrapped = cliCommand(async (_o: { json?: boolean }) => {
            throw Object.assign(new Error('mystery'), { code: 'SOMETHING_NEW' });
        });
        const out = await capture(() => wrapped({ json: true }));
        expect(JSON.parse(out.stdout).error).toEqual({ code: 'SOMETHING_NEW', message: 'mystery', hint: null });
    });
});

describe('cliCommand — other error shapes', () => {
    it('PolicyConfigError exits 78, scrubs the path and prints the INVALID_POLICY_CONFIG hint', async () => {
        const wrapped = cliCommand(async () => {
            throw new PolicyConfigError('/home/someone/project/.db-cluster/policies.json', 'JSON.parse failed');
        });
        const out = await capture(() => wrapped());
        expect(out.exitCode).toBe(78);
        expect(out.stderr).toContain('Invalid policy config (');
        expect(out.stderr).not.toContain('/home/someone');
        expect(out.stderr).toContain('→ try: Fix .db-cluster/policies.json structure');
    });

    it('PolicyConfigError under --json emits the structured error on stdout', async () => {
        const wrapped = cliCommand(async (_o: { json?: boolean }) => {
            throw new PolicyConfigError('policies', 'expected an array');
        });
        const out = await capture(() => wrapped({ json: true }));
        const body = JSON.parse(out.stdout);
        expect(body.error.code).toBe('INVALID_POLICY_CONFIG');
        expect(body.error.message).toBe('Invalid policy config (policies): expected an array');
        expect(body.error.hint).toContain('Fix .db-cluster/policies.json structure');
        expect(out.exitCode).toBe(78);
    });

    it('a ClusterError under --json keeps the headline and hint separate', async () => {
        const wrapped = cliCommand(async (_o: { json?: boolean }) => {
            throw new NotFoundError('widget', '42');
        });
        const out = await capture(() => wrapped({ json: true }));
        const body = JSON.parse(out.stdout);
        expect(body.error.code).toBe('NOT_FOUND');
        expect(body.error.message).toBe('Not found in widget store: 42');
        expect(body.error.hint).toEqual(expect.any(String));
        expect(out.stderr).toContain('Not found in widget store: 42');
        expect(out.stderr).toContain('→ try:');
    });

    it('a thrown non-Error value becomes a generic internal error without leaking the value', async () => {
        const wrapped = cliCommand(async (_o: { json?: boolean }) => {
            throw 'secret-token-value'; // eslint-disable-line no-throw-literal
        });
        const out = await capture(() => wrapped({ json: true }));
        expect(out.exitCode).toBe(1);
        expect(out.stderr).toContain('Error: An internal error occurred.');
        expect(out.stderr).not.toContain('secret-token-value');
        expect(JSON.parse(out.stdout).error).toEqual({ code: 'INTERNAL_ERROR', message: 'An internal error occurred.', hint: null });
    });

    it('a plain Error is scrubbed of absolute paths; DEBUG=1 prints the raw error instead', async () => {
        const make = () => cliCommand(async () => {
            throw new Error('cannot open /var/secret/dir/file.json');
        });
        const scrubbed = await capture(() => make()());
        expect(scrubbed.stderr).toContain('Error: ');
        expect(scrubbed.stderr).not.toContain('/var/secret/dir');
        vi.restoreAllMocks();

        vi.stubEnv('DEBUG', '1');
        try {
            const raw = await capture(() => make()());
            expect(raw.stderr).toContain('/var/secret/dir/file.json');
            expect(raw.exitCode).toBe(1);
        } finally {
            vi.unstubAllEnvs();
        }
    });

    it('a successful action neither exits nor writes an error', async () => {
        let ran = false;
        const wrapped = cliCommand(async () => { ran = true; });
        const out = await capture(() => wrapped());
        expect(ran).toBe(true);
        expect(out.exitCode).toBeUndefined();
        expect(out.stderr).toBe('');
    });
});

describe('destructiveCommand — confirmation prompt', () => {
    const opts = { name: 'wipe thing', undoHint: 'restore from backup' };

    it('proceeds when the operator answers y (case and whitespace tolerant)', async () => {
        setStdinTty(true);
        readlineMock.answers.push('  Y ');
        let ran = false;
        const wrapped = destructiveCommand(async (_o: { yes?: boolean }) => { ran = true; }, opts);
        const out = await capture(() => wrapped({}));
        expect(ran).toBe(true);
        expect(out.exitCode).toBeUndefined();
        expect(readlineMock.prompts[0]).toContain('About to wipe thing. This is a destructive operation.');
        expect(readlineMock.prompts[0]).toContain('Proceed? (y/N)');
        expect(readlineMock.closed).toBe(1);
    });

    it.each(['n', '', 'yes please', 'N'])('cancels with exit 1 and does not run for answer %j', async (answer) => {
        setStdinTty(true);
        readlineMock.answers.push(answer);
        let ran = false;
        const wrapped = destructiveCommand(async (_o: { yes?: boolean }) => { ran = true; }, opts);
        const out = await capture(() => wrapped({}));
        expect(ran).toBe(false);
        expect(out.exitCode).toBe(1);
        expect(out.stderr).toContain('Cancelled. (To skip this prompt, pass --yes.)');
        expect(readlineMock.closed).toBe(1);
    });

    it('refuses on a non-TTY stdin without prompting', async () => {
        setStdinTty(false);
        let ran = false;
        const wrapped = destructiveCommand(async (_o: { yes?: boolean }) => { ran = true; }, opts);
        const out = await capture(() => wrapped({}));
        expect(ran).toBe(false);
        expect(out.exitCode).toBe(1);
        expect(out.stderr).toContain('Refusing to wipe thing: stdin is not a TTY. Pass --yes to confirm non-interactively.');
        expect(readlineMock.prompts).toEqual([]);
    });

    it.each([['yes', { yes: true }], ['force', { force: true }]])('--%s bypasses the prompt', async (_n, flags) => {
        setStdinTty(false);
        let ran = false;
        const wrapped = destructiveCommand(async (_o: object) => { ran = true; }, opts);
        const out = await capture(() => wrapped(flags));
        expect(ran).toBe(true);
        expect(out.exitCode).toBeUndefined();
        expect(readlineMock.prompts).toEqual([]);
    });

    it('--dry-run runs the action with no prompt even on a non-TTY', async () => {
        setStdinTty(false);
        let seen: unknown;
        const wrapped = destructiveCommand(async (o: { dryRun?: boolean }) => { seen = o; }, opts);
        const out = await capture(() => wrapped({ dryRun: true }));
        expect(seen).toEqual({ dryRun: true });
        expect(out.exitCode).toBeUndefined();
        expect(out.stderr).toBe('');
    });

    it('finds the options object even when commander appends the Command as the last argument', async () => {
        setStdinTty(false);
        let ran = false;
        const commandLike = { opts: () => ({}), name: () => 'wipe' };
        const wrapped = destructiveCommand(async (..._a: unknown[]) => { ran = true; }, opts);
        const out = await capture(() => wrapped('some-arg', { yes: true }, commandLike));
        expect(ran).toBe(true);
        expect(out.exitCode).toBeUndefined();
    });

    it('prints the undo hint and rethrows into the typed-error handler when the action fails', async () => {
        const wrapped = destructiveCommand(async (_o: { yes?: boolean }) => {
            throw new NotFoundError('thing', '9');
        }, opts);
        const out = await capture(() => wrapped({ yes: true }));
        expect(out.stderr).toContain('  → undo: restore from backup');
        expect(out.stderr).toContain('Not found in thing store: 9');
        expect(out.exitCode).toBe(1);
        // The undo hint comes before the error text.
        expect(out.stderr.indexOf('→ undo:')).toBeLessThan(out.stderr.indexOf('Not found in thing store: 9'));
    });
});
