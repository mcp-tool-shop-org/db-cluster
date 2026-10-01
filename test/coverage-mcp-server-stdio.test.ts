/**
 * Coverage — the MCP server as a real child process over stdio.
 *
 * Imported in-process the server never starts (it only runs when it is the
 * entry point). These tests launch the BUILT server (`dist/mcp/server.js`) the
 * way an MCP host does and speak newline-delimited JSON-RPC to it, asserting on
 * the handshake, the tool list, a tool result, the error envelope for a missing
 * cluster (with no absolute path leaking), and the fail-closed exit on a
 * malformed principal. stdin is ended so the child exits cleanly.
 *
 * Requires `npm run build` (like the other dist-based tests in this suite).
 */

import { describe, it, expect, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = resolve(import.meta.dirname, '..');
const SERVER = join(ROOT, 'dist', 'mcp', 'server.js');
const PKG_VERSION: string = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')).version;

interface RunResult {
    responses: Array<Record<string, any>>;
    stderr: string;
    code: number | null;
}

/**
 * Start the server, send `requests` (one JSON object per line), wait until every
 * request that carries an `id` has been answered (or the child exits), then end
 * stdin and wait for the exit.
 */
function runServer(env: Record<string, string>, cwd: string, requests: object[]): Promise<RunResult> {
    return new Promise((resolvePromise, reject) => {
        const baseEnv: NodeJS.ProcessEnv = { ...process.env };
        for (const k of Object.keys(baseEnv)) if (k.startsWith('DB_CLUSTER_')) delete baseEnv[k];
        const child = spawn(process.execPath, [SERVER], { cwd, env: { ...baseEnv, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });

        const responses: Array<Record<string, any>> = [];
        let stdoutBuf = '';
        let stderr = '';
        const expected = requests.filter((r) => 'id' in r).length;
        let ended = false;

        const timer = setTimeout(() => {
            child.kill();
            reject(new Error(`MCP server child timed out. stderr: ${stderr}`));
        }, 30_000);

        const endInput = () => {
            if (!ended) {
                ended = true;
                child.stdin.end();
            }
        };

        child.stdout.on('data', (chunk: Buffer) => {
            stdoutBuf += chunk.toString('utf-8');
            let nl: number;
            while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
                const line = stdoutBuf.slice(0, nl).trim();
                stdoutBuf = stdoutBuf.slice(nl + 1);
                if (line) responses.push(JSON.parse(line));
            }
            if (responses.length >= expected) endInput();
        });
        child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf-8'); });
        child.stdin.on('error', () => { /* child may exit before we finish writing */ });
        child.on('error', (e) => { clearTimeout(timer); reject(e); });
        child.on('close', (code) => {
            clearTimeout(timer);
            resolvePromise({ responses, stderr, code });
        });

        for (const r of requests) child.stdin.write(JSON.stringify(r) + '\n');
    });
}

const INIT = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'coverage-stdio', version: '0.0.0' } },
};
const INITIALIZED = { jsonrpc: '2.0', method: 'notifications/initialized' };

const dirs: string[] = [];

afterAll(() => {
    for (const d of dirs) {
        try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
});

function freshCluster(label: string, withCluster = true): string {
    const dir = mkdtempSync(join(tmpdir(), `coverage-mcp-stdio-${label}-`));
    dirs.push(dir);
    if (withCluster) mkdirSync(join(dir, '.db-cluster'));
    return dir;
}

describe('MCP server over stdio (built entry point)', () => {
    it('answers the handshake, lists tools and serves a tool call, then exits cleanly when stdin closes', async () => {
        const dir = freshCluster('ok');
        const { responses, code } = await runServer({}, dir, [
            INIT,
            INITIALIZED,
            { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
            { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'cluster_find_sources', arguments: { query: 'anything' } } },
        ]);

        expect(code).toBe(0);
        const byId = new Map(responses.map((r) => [r.id, r]));

        const init = byId.get(1)!.result;
        expect(init.serverInfo).toEqual({ name: 'db-cluster', version: PKG_VERSION });
        expect(init.capabilities.tools).toBeDefined();

        const tools = byId.get(2)!.result.tools as Array<{ name: string; annotations: Record<string, boolean> }>;
        const names = tools.map((t) => t.name);
        expect(names).toContain('cluster_find_sources');
        expect(names).toContain('cluster_commit_mutation');
        expect(tools.find((t) => t.name === 'cluster_commit_mutation')!.annotations.destructiveHint).toBe(true);

        const call = byId.get(3)!.result;
        expect(call.isError).toBeUndefined();
        const body = JSON.parse(call.content[0].text);
        expect(body._meta).toMatchObject({ operation: 'read', writesCluster: false, empty_reason: 'no_data' });
        expect(body.indexRecords).toEqual([]);
    });

    it('a tool call with no cluster returns an error envelope and does not leak the absolute path', async () => {
        const dir = freshCluster('nocluster', false);
        const { responses, code } = await runServer({}, dir, [
            INIT,
            INITIALIZED,
            { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'cluster_find_sources', arguments: { query: 'x' } } },
        ]);

        expect(code).toBe(0);
        const result = responses.find((r) => r.id === 2)!.result;
        expect(result.isError).toBe(true);
        const body = JSON.parse(result.content[0].text);
        expect(body._meta).toEqual({ operation: 'error' });
        expect(body.error).toContain('No cluster found');
        expect(body.error).toContain('db-cluster init');
        expect(result.content[0].text).not.toContain(dir);
        expect(result.content[0].text.toLowerCase()).not.toContain(tmpdir().toLowerCase());
    });

    it('fails closed with exit code 1 and a clear stderr message when DB_CLUSTER_PRINCIPAL is malformed', async () => {
        const dir = freshCluster('badprincipal');
        const { responses, stderr, code } = await runServer({ DB_CLUSTER_PRINCIPAL: '{"id": 7}' }, dir, [
            INIT,
            INITIALIZED,
            { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'cluster_find_sources', arguments: { query: 'x' } } },
        ]);

        expect(code).toBe(1);
        expect(stderr).toContain('DB_CLUSTER_PRINCIPAL is structurally invalid');
        expect(stderr).toContain('Refusing to start MCP server');
        // No tool result was ever produced for the call that triggered the refusal.
        expect(responses.find((r) => r.id === 2)).toBeUndefined();
    });

    it('refuses a self-asserted privileged principal on the AI surface, returning an error instead of serving', async () => {
        const dir = freshCluster('privileged');
        const principal = JSON.stringify({ id: 'root', name: 'Root', roles: ['cluster-admin'], trustZone: 'internal' });
        const { responses, code } = await runServer({ DB_CLUSTER_PRINCIPAL: principal }, dir, [
            INIT,
            INITIALIZED,
            { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'cluster_find_sources', arguments: { query: 'x' } } },
        ]);

        expect(code).toBe(0);
        const result = responses.find((r) => r.id === 2)!.result;
        expect(result.isError).toBe(true);
        expect(JSON.parse(result.content[0].text).error).toContain("Refusing to honor a privileged trust zone ('internal')");
    });
});
