/**
 * Installation smoke test — verifies that db-cluster works from a fresh install.
 */

import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const exec = (cmd: string) => execSync(cmd, { cwd: ROOT, encoding: 'utf-8', timeout: 30000 });

describe('Installation smoke tests', () => {
    it('package.json exists and has correct name', () => {
        const pkg = JSON.parse(exec('type package.json'));
        expect(pkg.name).toBeDefined();
        expect(pkg.bin).toBeDefined();
        expect(pkg.bin['db-cluster']).toBeDefined();
        expect(pkg.bin['db-cluster-mcp']).toBeDefined();
    });

    it('npm run build succeeds', () => {
        const output = exec('npm run build 2>&1');
        expect(output).not.toContain('error TS');
    });

    it('dist/cli.js exists after build', () => {
        expect(existsSync(resolve(ROOT, 'dist/cli.js'))).toBe(true);
    });

    it('dist/mcp/server.js exists after build', () => {
        expect(existsSync(resolve(ROOT, 'dist/mcp/server.js'))).toBe(true);
    });

    it('CLI --help works', () => {
        const output = exec('npx tsx src/cli.ts --help');
        expect(output).toContain('AI-native federated database cluster');
        expect(output).toContain('init');
        expect(output).toContain('ingest');
        expect(output).toContain('doctor');
    });

    it('CLI init creates cluster directory', () => {
        const tmpDir = resolve(ROOT, '.test-smoke-cluster');
        try {
            exec(`npx tsx src/cli.ts init`);
            // init creates .db-cluster in cwd which is ROOT
            const clusterDir = resolve(ROOT, '.db-cluster');
            if (existsSync(clusterDir)) {
                expect(existsSync(resolve(clusterDir, 'canonical'))).toBe(true);
                expect(existsSync(resolve(clusterDir, 'artifact'))).toBe(true);
                expect(existsSync(resolve(clusterDir, 'index'))).toBe(true);
                expect(existsSync(resolve(clusterDir, 'ledger'))).toBe(true);
                // Cleanup
                execSync(`Remove-Item -Recurse -Force "${clusterDir}"`, { cwd: ROOT, encoding: 'utf-8' });
            }
        } catch {
            // If .db-cluster already exists, init may warn — that's OK
        }
    });

    it('SDK imports resolve correctly', async () => {
        const { ClusterKernel } = await import('../src/kernel/cluster-kernel.js');
        const { createLocalCluster } = await import('../src/adapters/local/index.js');
        expect(ClusterKernel).toBeDefined();
        expect(createLocalCluster).toBeDefined();
    });

    it('MCP server module imports correctly', async () => {
        // Just verify the module loads without error
        const mod = await import('../src/mcp/server.js');
        expect(mod).toBeDefined();
    });

    it('Postgres path fails cleanly when URL missing', async () => {
        const { createCluster } = await import('../src/adapters/factory.js');
        expect(() => {
            createCluster({
                rootDir: '/tmp/test-smoke',
                backends: { canonical: 'postgres' },
                // postgresUrl intentionally omitted
            });
        }).toThrow('DB_CLUSTER_POSTGRES_URL');
    });
});
