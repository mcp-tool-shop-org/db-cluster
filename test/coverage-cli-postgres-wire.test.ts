/**
 * Coverage — CLI Postgres commands (src/cli.ts) against a fake wire server.
 *
 * `stores verify`, `stores migrate`, `migration-status` and `verify-schema`
 * talk to Postgres through `pg`. No Postgres is available in CI for this
 * suite, so a minimal server speaking the Postgres v3 wire protocol (startup,
 * simple and extended query, no authentication) runs in-process and answers
 * only the handful of catalog queries those commands issue. The real `pg`
 * driver and the real `dist/cli.js` run unmodified against it; the assertions
 * are on what the CLI prints, its exit code, and the SQL the server received.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server, type Socket } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CLI_JS = join(import.meta.dirname, '..', 'dist', 'cli.js');

// ─── Minimal Postgres wire server ──────────────────────────────────────────

interface ServerState {
    /** Does canonical_entities exist? */
    tableExists: boolean;
    /** Tables reported by information_schema.tables. */
    tables: string[];
    /** Columns reported for canonical_entities. */
    columns: string[];
    /** Every query text the server received. */
    queries: string[];
}

const OID = { bool: 16, int4: 23, text: 25 } as const;

function frame(type: string, body: Buffer): Buffer {
    const len = Buffer.alloc(4);
    len.writeInt32BE(body.length + 4);
    return Buffer.concat([Buffer.from(type, 'latin1'), len, body]);
}

function cstr(s: string): Buffer {
    return Buffer.concat([Buffer.from(s, 'utf-8'), Buffer.from([0])]);
}

function rowDescription(cols: Array<[string, number]>): Buffer {
    const parts: Buffer[] = [];
    const n = Buffer.alloc(2);
    n.writeInt16BE(cols.length);
    parts.push(n);
    for (const [name, oid] of cols) {
        const fixed = Buffer.alloc(18);
        fixed.writeInt32BE(0, 0);      // table oid
        fixed.writeInt16BE(0, 4);      // column attr number
        fixed.writeInt32BE(oid, 6);    // type oid
        fixed.writeInt16BE(-1, 10);    // type size
        fixed.writeInt32BE(-1, 12);    // type modifier
        fixed.writeInt16BE(0, 16);     // text format
        parts.push(cstr(name), fixed);
    }
    return frame('T', Buffer.concat(parts));
}

function dataRow(values: string[]): Buffer {
    const parts: Buffer[] = [];
    const n = Buffer.alloc(2);
    n.writeInt16BE(values.length);
    parts.push(n);
    for (const v of values) {
        const b = Buffer.from(v, 'utf-8');
        const len = Buffer.alloc(4);
        len.writeInt32BE(b.length);
        parts.push(len, b);
    }
    return frame('D', Buffer.concat(parts));
}

interface Result { cols: Array<[string, number]>; rows: string[][]; tag: string }

function resultFor(sql: string, st: ServerState): Result {
    if (/SELECT 1 AS ok/i.test(sql)) {
        return { cols: [['ok', OID.int4]], rows: [['1']], tag: 'SELECT 1' };
    }
    if (/SELECT EXISTS/i.test(sql) && /canonical_entities/.test(sql)) {
        return { cols: [['exists', OID.bool]], rows: [[st.tableExists ? 't' : 'f']], tag: 'SELECT 1' };
    }
    if (/SELECT table_name FROM information_schema\.tables/i.test(sql)) {
        return { cols: [['table_name', OID.text]], rows: st.tables.map((t) => [t]), tag: `SELECT ${st.tables.length}` };
    }
    if (/FROM information_schema\.columns/i.test(sql)) {
        return {
            cols: [['column_name', OID.text], ['data_type', OID.text]],
            rows: st.columns.map((c) => [c, 'text']),
            tag: `SELECT ${st.columns.length}`,
        };
    }
    return { cols: [], rows: [], tag: 'OK' };
}

function serve(sock: Socket, st: ServerState): void {
    let buf = Buffer.alloc(0);
    let started = false;
    let lastQuery = '';
    sock.on('error', () => { /* client hang-ups are fine */ });
    sock.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        for (;;) {
            if (!started) {
                if (buf.length < 8) return;
                const len = buf.readInt32BE(0);
                if (buf.length < len) return;
                const code = buf.readInt32BE(4);
                buf = buf.subarray(len);
                if (code === 80877103) { sock.write('N'); continue; } // SSLRequest: refuse
                started = true;
                sock.write(Buffer.concat([
                    frame('R', Buffer.from([0, 0, 0, 0])),
                    frame('Z', Buffer.from('I')),
                ]));
                continue;
            }
            if (buf.length < 5) return;
            const type = String.fromCharCode(buf[0]!);
            const len = buf.readInt32BE(1);
            if (buf.length < 1 + len) return;
            const body = buf.subarray(5, 1 + len);
            buf = buf.subarray(1 + len);
            switch (type) {
                case 'Q': {
                    const sql = body.toString('utf-8').replace(/\0$/, '');
                    st.queries.push(sql);
                    const r = resultFor(sql, st);
                    const out: Buffer[] = [];
                    if (r.cols.length) out.push(rowDescription(r.cols));
                    for (const row of r.rows) out.push(dataRow(row));
                    out.push(frame('C', cstr(r.tag)), frame('Z', Buffer.from('I')));
                    sock.write(Buffer.concat(out));
                    break;
                }
                case 'P': {
                    const nameEnd = body.indexOf(0);
                    const sqlEnd = body.indexOf(0, nameEnd + 1);
                    lastQuery = body.subarray(nameEnd + 1, sqlEnd).toString('utf-8');
                    st.queries.push(lastQuery);
                    sock.write(frame('1', Buffer.alloc(0)));
                    break;
                }
                case 'B':
                    sock.write(frame('2', Buffer.alloc(0)));
                    break;
                case 'D': {
                    const r = resultFor(lastQuery, st);
                    sock.write(r.cols.length ? rowDescription(r.cols) : frame('n', Buffer.alloc(0)));
                    break;
                }
                case 'E': {
                    const r = resultFor(lastQuery, st);
                    const out: Buffer[] = r.rows.map(dataRow);
                    out.push(frame('C', cstr(r.tag)));
                    sock.write(Buffer.concat(out));
                    break;
                }
                case 'S':
                    sock.write(frame('Z', Buffer.from('I')));
                    break;
                case 'X':
                    sock.end();
                    return;
                default:
                    break;
            }
        }
    });
}

// ─── Async CLI runner (the server shares this event loop) ──────────────────

interface Out { status: number | null; stdout: string; stderr: string }

function runCli(cwd: string, args: string[], env: Record<string, string>): Promise<Out> {
    return new Promise((resolveRun) => {
        const merged: NodeJS.ProcessEnv = { ...process.env };
        delete merged.DB_CLUSTER_CANONICAL_BACKEND;
        delete merged.DB_CLUSTER_POSTGRES_URL;
        delete merged.DB_CLUSTER_DIR;
        Object.assign(merged, env);
        const child = spawn(process.execPath, [CLI_JS, ...args], { cwd, env: merged });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => { stdout += d.toString(); });
        child.stderr.on('data', (d) => { stderr += d.toString(); });
        const timer = setTimeout(() => child.kill(), 45_000);
        child.on('close', (status) => {
            clearTimeout(timer);
            resolveRun({ status, stdout, stderr });
        });
    });
}

describe('CLI against a fake Postgres wire server', { timeout: 90_000 }, () => {
    let server: Server;
    let url: string;
    let cwd: string;
    const st: ServerState = { tableExists: true, tables: [], columns: [], queries: [] };

    beforeAll(async () => {
        cwd = mkdtempSync(join(tmpdir(), 'cov-cli-pg-'));
        server = createServer((sock) => serve(sock, st));
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
        const addr = server.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        url = `postgres://tester:secret@127.0.0.1:${port}/clusterdb`;
    });

    afterAll(async () => {
        await new Promise<void>((r) => server.close(() => r()));
        try { rmSync(cwd, { recursive: true, force: true }); } catch { /* best effort */ }
    });

    beforeEach(() => {
        st.tableExists = true;
        st.tables = ['canonical_entities'];
        st.columns = ['id', 'kind', 'name', 'attributes', 'created_at', 'updated_at'];
        st.queries = [];
    });

    const pgEnv = () => ({ DB_CLUSTER_CANONICAL_BACKEND: 'postgres', DB_CLUSTER_POSTGRES_URL: url });

    it('stores list reports postgres as the canonical backend', async () => {
        const r = await runCli(cwd, ['stores', 'list'], pgEnv());
        expect(r.status, r.stderr).toBe(0);
        expect(r.stdout).toMatch(/postgres\s+canonical/);
        expect(r.stdout).toMatch(/local\s+ledger/);
    });

    it('stores verify confirms the connection and the migrated table', async () => {
        const r = await runCli(cwd, ['stores', 'verify'], pgEnv());
        expect(r.status, r.stderr).toBe(0);
        expect(r.stdout).toContain('canonical: postgres');
        expect(r.stdout).toContain('✓ Postgres connection: OK');
        expect(r.stdout).toContain('✓ Migrations: canonical_entities table exists');
        expect(r.stdout).not.toContain('NOT found');
        expect(st.queries.some((q) => /SELECT 1 AS ok/i.test(q))).toBe(true);
        expect(r.stdout + r.stderr).not.toContain('secret');
    });

    it('stores verify tells the operator to migrate when the table is missing', async () => {
        st.tableExists = false;
        const r = await runCli(cwd, ['stores', 'verify'], pgEnv());
        expect(r.status, r.stderr).toBe(0);
        expect(r.stdout).toContain('✓ Postgres connection: OK');
        expect(r.stdout).toContain('✗ Migrations: canonical_entities table NOT found');
        expect(r.stdout).toContain('Run: db-cluster stores migrate');
    });

    it('stores migrate applies both migrations through the pool', async () => {
        const r = await runCli(cwd, ['stores', 'migrate'], pgEnv());
        expect(r.status, r.stderr).toBe(0);
        expect(r.stdout).toContain('✓ Migrations applied: canonical_entities table ready');
        expect(st.queries.some((q) => /CREATE TABLE IF NOT EXISTS canonical_entities/.test(q))).toBe(true);
        expect(st.queries.some((q) => /ALTER TABLE canonical_entities/i.test(q) && /version/i.test(q))).toBe(true);
    });

    it('migration-status lists the tables and reports migrated: true', async () => {
        st.tables = ['canonical_entities', 'other_table'];
        const text = await runCli(cwd, ['migration-status'], { DB_CLUSTER_POSTGRES_URL: url });
        expect(text.status, text.stderr).toBe(0);
        expect(text.stdout).toContain('Backend: postgres');
        expect(text.stdout).toContain('Migrated: true');
        expect(text.stdout).toContain('Tables: canonical_entities, other_table');
        expect(text.stdout).toContain('All required tables present: canonical_entities');

        const json = await runCli(cwd, ['migration-status', '--json'], { DB_CLUSTER_POSTGRES_URL: url });
        expect(JSON.parse(json.stdout)).toEqual({
            backend: 'postgres',
            migrated: true,
            tables: ['canonical_entities', 'other_table'],
            message: 'All required tables present: canonical_entities',
        });
    });

    it('migration-status reports missing tables', async () => {
        st.tables = [];
        const r = await runCli(cwd, ['migration-status'], { DB_CLUSTER_POSTGRES_URL: url });
        expect(r.status, r.stderr).toBe(0);
        expect(r.stdout).toContain('Migrated: false');
        expect(r.stdout).toContain('Tables: (none)');
        expect(r.stdout).toContain('Missing tables: canonical_entities');
    });

    it('verify-schema accepts the expected columns', async () => {
        const text = await runCli(cwd, ['verify-schema'], { DB_CLUSTER_POSTGRES_URL: url });
        expect(text.status, text.stderr).toBe(0);
        expect(text.stdout).toContain('Schema valid: true');
        expect(text.stdout).not.toContain('✗');
        const json = await runCli(cwd, ['verify-schema', '--json'], { DB_CLUSTER_POSTGRES_URL: url });
        expect(JSON.parse(json.stdout)).toEqual({ valid: true, issues: [] });
    });

    it('verify-schema lists each missing column', async () => {
        st.columns = ['id', 'kind', 'name'];
        const text = await runCli(cwd, ['verify-schema'], { DB_CLUSTER_POSTGRES_URL: url });
        expect(text.status, text.stderr).toBe(0);
        expect(text.stdout).toContain('Schema valid: false');
        expect(text.stdout).toContain("✗ canonical_entities: missing column 'attributes'");
        expect(text.stdout).toContain("✗ canonical_entities: missing column 'created_at'");
        expect(text.stdout).toContain("✗ canonical_entities: missing column 'updated_at'");
        expect(text.stdout).not.toContain("missing column 'id'");
        const json = JSON.parse((await runCli(cwd, ['verify-schema', '--json'], { DB_CLUSTER_POSTGRES_URL: url })).stdout);
        expect(json.valid).toBe(false);
        expect(json.issues).toHaveLength(3);
    });
});
