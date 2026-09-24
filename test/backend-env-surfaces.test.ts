/**
 * The CLI and the MCP server honor the configured canonical backend, or refuse.
 *
 * docs/mcp.md documents DB_CLUSTER_CANONICAL_BACKEND / DB_CLUSTER_POSTGRES_URL
 * for the MCP server, and the handbook and quickstart export them for the
 * CLI. Both surfaces used to build local stores unconditionally, so a
 * Postgres configuration was served from local JSON and nothing said so.
 * They now build their stores through createCluster(backendConfigFromEnv()).
 *
 *  - Postgres at an unreachable URL: a data command that reads the canonical
 *    store fails instead of quietly answering from local stores. Each probe
 *    has a control run without the variables that must succeed AND must have
 *    read the canonical store, so a pass cannot come from an unrelated error.
 *  - An unknown backend, or postgres without a URL, fails closed with
 *    INVALID_BACKEND_CONFIG (CLI exit 78; an MCP error envelope).
 *  - SQLite (gated like the other SQLite suites; CI requires the driver):
 *    an entity written through the CLI lives in .db-cluster/sqlite/cluster.db,
 *    the MCP server reads it back, and the local canonical store never sees it.
 *
 * Spawns the BUILT surfaces (dist/), like the other CLI tests.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { backendConfigFromEnv, createCluster } from '../src/adapters/factory.js';

const ROOT = resolve(import.meta.dirname, '..');
const CLI_JS = join(ROOT, 'dist', 'cli.js');
const MCP_JS = join(ROOT, 'dist', 'mcp', 'server.js');
const BUDGET_MS = 60_000;

/** Postgres at port 1 on loopback: nothing listens there, so any query fails fast. */
const POSTGRES_ENV = {
    DB_CLUSTER_CANONICAL_BACKEND: 'postgres',
    DB_CLUSTER_POSTGRES_URL: 'postgres://db-cluster:unused@127.0.0.1:1/none',
};

/** True iff better-sqlite3 resolves on this machine (does not load it). */
function hasSqlite(): boolean {
    try {
        createRequire(import.meta.url).resolve('better-sqlite3');
        return true;
    } catch {
        return false;
    }
}

/** The environment minus any backend settings the developer's shell might carry. */
function baseEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    delete env.DB_CLUSTER_CANONICAL_BACKEND;
    delete env.DB_CLUSTER_POSTGRES_URL;
    delete env.DB_CLUSTER_DIR;
    return env;
}

function runCli(cwd: string, args: string[], extraEnv: Record<string, string> = {}) {
    const r = spawnSync(process.execPath, [CLI_JS, ...args], {
        cwd,
        env: { ...baseEnv(), ...extraEnv },
        encoding: 'utf-8',
        timeout: BUDGET_MS,
    });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Create one entity through the CLI: propose, then a self-approved commit. */
function seedEntity(cwd: string, name: string, extraEnv: Record<string, string> = {}) {
    const proposal = runCli(cwd, ['--actor', 'backend-test', 'propose', JSON.stringify({
        verb: 'create_entity',
        targetStore: 'canonical',
        payload: { kind: 'note', name, attributes: {} },
    })], extraEnv);
    expect(proposal.status, proposal.stderr).toBe(0);
    const id = /Proposed command: (\S+)/.exec(proposal.stdout)?.[1];
    expect(id, proposal.stdout).toBeDefined();
    const commit = runCli(
        cwd,
        ['--actor', 'backend-test', 'commit', id!, '--self-approve', '--accept-soft-duty-bypass'],
        extraEnv,
    );
    expect(commit.status, commit.stderr).toBe(0);
}

function entityCount(cwd: string, extraEnv: Record<string, string> = {}): number {
    const r = runCli(cwd, ['stats', '--json'], extraEnv);
    expect(r.status, r.stderr).toBe(0);
    return JSON.parse(r.stdout).entities as number;
}

interface McpOutcome {
    /** The JSON-RPC response to the tools/call, if the server answered. */
    response?: { result?: { isError?: boolean; content?: Array<{ text: string }> }; error?: unknown };
    stderr: string;
}

/** initialize → notifications/initialized → one tools/call, over stdio. */
function callMcpTool(
    cwd: string,
    name: string,
    args: Record<string, unknown>,
    extraEnv: Record<string, string> = {},
): Promise<McpOutcome> {
    return new Promise((done) => {
        const child = spawn(process.execPath, [MCP_JS], {
            cwd,
            env: { ...baseEnv(), ...extraEnv },
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        let answer: McpOutcome['response'];
        const send = (msg: unknown) => child.stdin.write(`${JSON.stringify(msg)}\n`);
        // Resolve only once the child has exited: on Windows a live process's
        // working directory cannot be removed, so teardown must not race it.
        const finish = (response?: McpOutcome['response']) => {
            answer ??= response;
            if (child.exitCode === null && child.signalCode === null) child.kill();
        };
        child.on('exit', () => {
            clearTimeout(timer);
            done({ response: answer, stderr });
        });
        const timer = setTimeout(() => finish(undefined), BUDGET_MS - 5_000);
        child.stdout.on('data', (chunk: Buffer) => {
            stdout += chunk.toString('utf8');
            let nl: number;
            while ((nl = stdout.indexOf('\n')) >= 0) {
                const line = stdout.slice(0, nl);
                stdout = stdout.slice(nl + 1);
                let msg: { id?: number } & NonNullable<McpOutcome['response']>;
                try {
                    msg = JSON.parse(line);
                } catch {
                    continue;
                }
                if (msg.id === 1) {
                    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
                    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } });
                } else if (msg.id === 2) {
                    finish(msg);
                }
            }
        });
        child.stderr.on('data', (chunk: Buffer) => {
            stderr += chunk.toString('utf8');
        });
        send({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
                protocolVersion: '2025-06-18',
                capabilities: {},
                clientInfo: { name: 'backend-env-surfaces-test', version: '0' },
            },
        });
    });
}

/** The parsed JSON body of a tool result (success payload or error envelope). */
function body(r: McpOutcome): Record<string, unknown> {
    return JSON.parse(r.response?.result?.content?.[0]?.text ?? '{}');
}

/** True when the surface named the setting it did not honor. */
const namesTheSetting = (text: string) => /DB_CLUSTER_CANONICAL_BACKEND/.test(text);

describe('backend selection is validated before any store opens', () => {
    it.each([
        ['unset', {}, 'local'],
        ['blank', { DB_CLUSTER_CANONICAL_BACKEND: '  ' }, 'local'],
        ['sqlite', { DB_CLUSTER_CANONICAL_BACKEND: 'sqlite' }, 'sqlite'],
        ['postgres with a URL', { DB_CLUSTER_CANONICAL_BACKEND: ' postgres ', DB_CLUSTER_POSTGRES_URL: 'postgres://u@h/d' }, 'postgres'],
    ])('backendConfigFromEnv: %s -> %s', (_label, env, expected) => {
        expect(backendConfigFromEnv('/tmp/x', env).backends?.canonical).toBe(expected);
    });

    it.each([
        ['an unknown canonical backend', { DB_CLUSTER_CANONICAL_BACKEND: 'mysql' }],
        ['postgres without a URL', { DB_CLUSTER_CANONICAL_BACKEND: 'postgres' }],
    ])('backendConfigFromEnv refuses %s', (_label, env) => {
        expect(() => backendConfigFromEnv('/tmp/x', env)).toThrow(expect.objectContaining({ code: 'INVALID_BACKEND_CONFIG' }));
    });

    it.each([
        ['canonical', { canonical: 'mysql' }],
        ['artifact', { artifact: 'postgres' }],
        ['ledger', { ledger: 'json' }],
    ])('createCluster refuses an unknown %s backend instead of building a local store', (_store, backends) => {
        expect(() => createCluster({ rootDir: join(tmpdir(), 'never-created'), backends: backends as never }))
            .toThrow(expect.objectContaining({ code: 'INVALID_BACKEND_CONFIG' }));
    });
});

describe('a postgres canonical backend reaches the CLI and MCP surfaces', () => {
    let dir: string;

    beforeAll(() => {
        dir = mkdtempSync(join(tmpdir(), 'backend-env-postgres-'));
        const init = runCli(dir, ['init']);
        expect(init.status, init.stderr).toBe(0);
        seedEntity(dir, 'backend-probe');
    }, BUDGET_MS);

    afterAll(() => {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    });

    it('CLI control: `stats` succeeds without backend settings', () => {
        expect(entityCount(dir)).toBe(1);
    }, BUDGET_MS);

    it('CLI: `stats` with an unreachable postgres canonical does not quietly succeed on local stores', () => {
        const r = runCli(dir, ['stats'], POSTGRES_ENV);
        const quietLocalSuccess = r.status === 0 && !namesTheSetting(r.stderr);
        expect(quietLocalSuccess, `exit ${r.status}; stderr: ${r.stderr}`).toBe(false);
    }, BUDGET_MS);

    it('MCP control: cluster_find_sources resolves the entity from the canonical store', async () => {
        const r = await callMcpTool(dir, 'cluster_find_sources', { query: 'backend-probe' });
        expect(r.response?.result?.isError, r.stderr).not.toBe(true);
        expect((body(r).resolvedEntities as unknown[]).length).toBe(1);
    }, BUDGET_MS);

    it('MCP: cluster_find_sources with an unreachable postgres canonical does not quietly succeed on local stores', async () => {
        const r = await callMcpTool(dir, 'cluster_find_sources', { query: 'backend-probe' }, POSTGRES_ENV);
        const quietLocalSuccess =
            r.response?.result !== undefined &&
            r.response.result.isError !== true &&
            !namesTheSetting(r.stderr);
        expect(quietLocalSuccess, `response: ${JSON.stringify(r.response)}; stderr: ${r.stderr}`).toBe(false);
    }, BUDGET_MS);
});

describe('a misconfigured backend fails closed with INVALID_BACKEND_CONFIG', () => {
    let dir: string;

    beforeAll(() => {
        dir = mkdtempSync(join(tmpdir(), 'backend-env-invalid-'));
        const init = runCli(dir, ['init']);
        expect(init.status, init.stderr).toBe(0);
    }, BUDGET_MS);

    afterAll(() => {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    });

    it.each([
        ['an unknown backend', { DB_CLUSTER_CANONICAL_BACKEND: 'mysql' }],
        ['postgres without a URL', { DB_CLUSTER_CANONICAL_BACKEND: 'postgres' }],
    ])('CLI: %s exits 78 and names the variable', (_label, env) => {
        const r = runCli(dir, ['stats'], env);
        expect(r.status, r.stderr).toBe(78);
        expect(r.stderr).toMatch(/DB_CLUSTER_(CANONICAL_BACKEND|POSTGRES_URL)/);
    }, BUDGET_MS);

    it('MCP: an unknown backend is an INVALID_BACKEND_CONFIG error envelope', async () => {
        const r = await callMcpTool(dir, 'cluster_find_sources', { query: 'x' }, { DB_CLUSTER_CANONICAL_BACKEND: 'mysql' });
        expect(r.response?.result?.isError, JSON.stringify(r.response)).toBe(true);
        expect(body(r).code).toBe('INVALID_BACKEND_CONFIG');
    }, BUDGET_MS);
});

describe.skipIf(!hasSqlite())('a sqlite canonical backend works end to end on both surfaces', () => {
    const SQLITE_ENV = { DB_CLUSTER_CANONICAL_BACKEND: 'sqlite' };
    let dir: string;

    beforeAll(() => {
        dir = mkdtempSync(join(tmpdir(), 'backend-env-sqlite-'));
        const init = runCli(dir, ['init'], SQLITE_ENV);
        expect(init.status, init.stderr).toBe(0);
        seedEntity(dir, 'sqlite-probe', SQLITE_ENV);
    }, BUDGET_MS);

    afterAll(() => {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    });

    it('the CLI wrote the entity into .db-cluster/sqlite/cluster.db', () => {
        expect(existsSync(join(dir, '.db-cluster', 'sqlite', 'cluster.db'))).toBe(true);
        expect(entityCount(dir, SQLITE_ENV)).toBe(1);
    }, BUDGET_MS);

    it('the local canonical store never saw it', () => {
        expect(entityCount(dir)).toBe(0);
    }, BUDGET_MS);

    it('the MCP server reads it back from SQLite', async () => {
        const r = await callMcpTool(dir, 'cluster_find_sources', { query: 'sqlite-probe' }, SQLITE_ENV);
        expect(r.response?.result?.isError, r.stderr).not.toBe(true);
        expect((body(r).resolvedEntities as unknown[]).length).toBe(1);
    }, BUDGET_MS);
});
