/**
 * Coverage — the direct-run (command line) halves of the two dashboard
 * snapshot scripts.
 *
 * Each script decides it was invoked from the command line by inspecting
 * process.argv[1], and only then reads its arguments, writes the snapshot file
 * and exits. The library halves (generateSnapshot and friends) are covered
 * elsewhere; here argv is set the way the shell would set it, the module is
 * evaluated fresh, and the file it writes, the messages it prints and the
 * exit code it requests are asserted. process.exit is replaced so a failing
 * run cannot take the test worker down.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createLocalCluster } from '../src/adapters/local/index.js';
import { ClusterKernel } from '../src/kernel/cluster-kernel.js';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SNAPSHOT_SCRIPT = join(REPO_ROOT, 'scripts', 'dashboard-snapshot.ts');
const RK_SCRIPT = join(REPO_ROOT, 'scripts', 'repo-knowledge-dashboard-snapshot.ts');

class ExitSignal extends Error {
    constructor(public readonly code: number | undefined) {
        super(`process.exit(${code})`);
    }
}

describe('dashboard snapshot scripts — command line behaviour', () => {
    let dir: string;
    let clusterDir: string;
    let originalArgv: string[];
    let logs: string[];
    let errors: unknown[][];

    beforeEach(async () => {
        dir = mkdtempSync(join(tmpdir(), 'cov-snapshot-script-'));
        clusterDir = join(dir, 'cluster');
        originalArgv = [...process.argv];
        logs = [];
        errors = [];
        vi.spyOn(console, 'log').mockImplementation((...a) => { logs.push(a.map(String).join(' ')); });
        vi.spyOn(console, 'error').mockImplementation((...a) => { errors.push(a); });
        vi.resetModules();

        const stores = createLocalCluster(clusterDir);
        const kernel = new ClusterKernel(stores, { dataDir: clusterDir });
        await kernel.createEntity({ kind: 'project', name: 'snapshot-project', attributes: { phase: 1 }, actorId: 'op' });
        await kernel.createEntity({ kind: 'finding', name: 'snapshot-finding', attributes: {}, actorId: 'op' });
    });
    afterEach(() => {
        process.argv = originalArgv;
        vi.restoreAllMocks();
        vi.resetModules();
        rmSync(dir, { recursive: true, force: true });
    });

    describe('scripts/dashboard-snapshot.ts', () => {
        it('writes the snapshot JSON to the requested path, creating missing parent directories', async () => {
            const out = join(dir, 'nested', 'deeper', 'snapshot.json');
            process.argv = [process.argv[0], SNAPSHOT_SCRIPT, clusterDir, out];
            await import('../scripts/dashboard-snapshot.js');

            expect(existsSync(out)).toBe(true);
            const snapshot = JSON.parse(readFileSync(out, 'utf-8'));
            expect(snapshot.clusterDir).toBe(clusterDir);
            const names = snapshot.objects.filter((o: { type: string }) => o.type === 'entity').map((o: { name: string }) => o.name);
            expect(names.sort()).toEqual(['snapshot-finding', 'snapshot-project']);
            expect(snapshot.operations.doctorStatus.status).toBeDefined();
            expect(snapshot.operations.indexStatus.total).toBe(2);
            expect(logs).toContain(`Dashboard snapshot written to ${out}`);
            expect(logs).toContain(`  Objects: ${snapshot.objects.length}`);
            expect(logs.some((l) => l.startsWith('  Generated: '))).toBe(true);
        });

        it('reuses an existing output directory', async () => {
            const outDir = join(dir, 'existing-out');
            mkdirSync(outDir);
            const out = join(outDir, 'snap.json');
            process.argv = [process.argv[0], SNAPSHOT_SCRIPT, clusterDir, out];
            await import('../scripts/dashboard-snapshot.js');
            expect(JSON.parse(readFileSync(out, 'utf-8')).objects.length).toBeGreaterThan(0);
        });

        it('exits 1 with guidance when the cluster directory does not exist, writing nothing', async () => {
            const missing = join(dir, 'no-such-cluster');
            const out = join(dir, 'never-written.json');
            vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new ExitSignal(code); }) as never);
            process.argv = [process.argv[0], SNAPSHOT_SCRIPT, missing, out];
            await expect(import('../scripts/dashboard-snapshot.js')).rejects.toMatchObject({ code: 1 });
            expect(errors.map((e) => e.join(' '))).toEqual([
                `Cluster directory not found: ${missing}`,
                'Run the dogfood ingest script first: npx tsx scripts/dogfood-ingest.ts',
            ]);
            expect(existsSync(out)).toBe(false);
        });

        it('with no arguments it looks for the bundled example cluster', async () => {
            const example = join(REPO_ROOT, 'examples/dogfood-project-memory/.db-cluster');
            if (existsSync(example)) return; // would write into the repo; nothing to assert safely
            vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new ExitSignal(code); }) as never);
            process.argv = [process.argv[0], SNAPSHOT_SCRIPT];
            await expect(import('../scripts/dashboard-snapshot.js')).rejects.toMatchObject({ code: 1 });
            expect(String(errors[0][0])).toBe(`Cluster directory not found: ${example}`);
        });

        it('does nothing when imported rather than run from the command line', async () => {
            process.argv = [process.argv[0], join(dir, 'some-other-script.ts')];
            const mod = await import('../scripts/dashboard-snapshot.js');
            expect(typeof mod.generateSnapshot).toBe('function');
            expect(logs).toEqual([]);
            expect(errors).toEqual([]);
        });
    });

    describe('scripts/repo-knowledge-dashboard-snapshot.ts', () => {
        it('writes the snapshot, creating parent directories, and reports object count and health', async () => {
            const out = join(dir, 'rk', 'out', 'rk-snapshot.json');
            process.argv = [process.argv[0], RK_SCRIPT, clusterDir, 'my-repo', out];
            await import('../scripts/repo-knowledge-dashboard-snapshot.js');
            await vi.waitFor(() => expect(logs.some((l) => l.startsWith('  Health: '))).toBe(true), { timeout: 20000 });

            const snapshot = JSON.parse(readFileSync(out, 'utf-8'));
            expect(snapshot.repoName).toBe('my-repo');
            expect(snapshot.clusterDir).toBe(resolve(clusterDir));
            expect(snapshot.objects.filter((o: { type: string }) => o.type === 'entity')).toHaveLength(2);
            expect(snapshot.operations.overall).toBe('healthy');
            expect(logs[0]).toBe(`Generating repo-knowledge snapshot from: ${resolve(clusterDir)}`);
            expect(logs).toContain(`Snapshot written: ${resolve(out)}`);
            expect(logs).toContain(`  Objects: ${snapshot.objects.length}`);
            expect(logs).toContain('  Health: healthy');
        });

        it('exits 1 and reports the failure when snapshot generation throws', async () => {
            // A regular file where the cluster directory should be makes the store constructors fail.
            const blocker = join(dir, 'a-file-not-a-dir');
            const { writeFileSync } = await import('node:fs');
            writeFileSync(blocker, 'blocker');
            const exits: Array<number | undefined> = [];
            vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { exits.push(code); }) as never);
            const out = join(dir, 'never-written-rk.json');
            process.argv = [process.argv[0], RK_SCRIPT, blocker, 'my-repo', out];
            await import('../scripts/repo-knowledge-dashboard-snapshot.js');
            await vi.waitFor(() => expect(exits).toEqual([1]), { timeout: 20000 });
            expect(String(errors[0][0])).toBe('Snapshot generation failed:');
            expect(errors[0][1]).toBeInstanceOf(Error);
            expect(existsSync(out)).toBe(false);
        });

        it('does nothing when imported rather than run from the command line', async () => {
            process.argv = [process.argv[0], join(dir, 'other.ts')];
            const mod = await import('../scripts/repo-knowledge-dashboard-snapshot.js');
            expect(typeof mod.generateRepoKnowledgeSnapshot).toBe('function');
            expect(logs).toEqual([]);
            expect(errors).toEqual([]);
        });
    });
});
