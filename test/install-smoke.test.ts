/**
 * Installation smoke test — verifies that db-cluster works from a fresh install.
 *
 * TESTS-005 + TESTS-006: this test no longer shells out to PowerShell-only or
 * cmd-only utilities (`type`, `Remove-Item`), no longer invokes `npm run build`
 * from inside vitest, and no longer assumes a particular shell. Build is a
 * CI/release-gate concern (see scripts/release-gate.mjs); this test verifies
 * the SHAPE of the package and the SHAPE of a previously-built dist.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

describe('Installation smoke tests', () => {
    it('package.json exists and has correct name', () => {
        // Replaced `exec('type package.json')` — `type` is a Windows-only cmd.exe
        // builtin (TESTS-005). Read the file directly instead.
        const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf-8'));
        expect(pkg.name).toBeDefined();
        expect(pkg.bin).toBeDefined();
        expect(pkg.bin['db-cluster']).toBeDefined();
        expect(pkg.bin['db-cluster-mcp']).toBeDefined();
    });

    it('dist/cli.js exists after a prior build (and has a shebang)', () => {
        // TESTS-006: removed `exec('npm run build')` invocation. Building from
        // inside a test is the wrong dependency direction — that responsibility
        // belongs to scripts/release-gate.mjs (and CI per CIDOCS-001).
        const cliPath = resolve(ROOT, 'dist/cli.js');
        if (!existsSync(cliPath)) {
            // No dist yet — surface this as a clear skip-shaped message rather
            // than a misleading "build failed" assertion in this test. The
            // release-gate / CI workflow owns the build check.
            console.warn(
                '[install-smoke] dist/cli.js missing — run `npm run build` (or release-gate) first.',
            );
        }
        expect(existsSync(cliPath)).toBe(true);
        const firstLine = readFileSync(cliPath, 'utf-8').split('\n', 1)[0];
        expect(firstLine.startsWith('#!')).toBe(true);
    });

    it('dist/mcp/server.js exists after build', () => {
        expect(existsSync(resolve(ROOT, 'dist/mcp/server.js'))).toBe(true);
    });

    it('CLI source file declares the expected commands (no shell invocation)', () => {
        // Replaced `exec('npx tsx src/cli.ts --help')`. Importing the CLI module
        // would trigger commander's auto-parse via `program.parse()` at the
        // bottom of cli.ts — a side effect we don't want inside vitest. Instead,
        // read the source and assert it declares the documented command groups.
        const cliSource = readFileSync(resolve(ROOT, 'src/cli.ts'), 'utf-8');
        expect(cliSource).toContain('AI-native federated database cluster');
        expect(cliSource).toMatch(/\.command\(['"]init['"]\)/);
        expect(cliSource).toMatch(/\.command\(['"]ingest/);
        expect(cliSource).toMatch(/\.command\(['"]doctor/);
    });

    it('CLI init initializes a cluster directory layout', async () => {
        // TESTS-005: removed `Remove-Item` PowerShell cmdlet call and the
        // `npx tsx` shell-out. Drive init through the SDK directly instead.
        const tmpDir = resolve(ROOT, '.test-smoke-cluster');
        try {
            rmSync(tmpDir, { recursive: true, force: true });
            const { createLocalCluster } = await import('../src/adapters/local/index.js');
            createLocalCluster(tmpDir);
            // The local cluster creates the per-store subdirectories on demand.
            expect(existsSync(resolve(tmpDir, 'canonical'))).toBe(true);
            expect(existsSync(resolve(tmpDir, 'artifact'))).toBe(true);
            expect(existsSync(resolve(tmpDir, 'index'))).toBe(true);
            expect(existsSync(resolve(tmpDir, 'ledger'))).toBe(true);
        } finally {
            rmSync(tmpDir, { recursive: true, force: true });
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
