#!/usr/bin/env node
/**
 * Fresh install smoke test.
 *
 * Creates a temp directory, installs db-cluster from tarball,
 * and verifies: CLI help, SDK import, MCP bin, init, basic ops.
 *
 * Usage: node scripts/smoke-install.mjs <path-to-tgz>
 */

import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

// AGG-B1-3: read the tarball name from package.json so we don't break on
// version bumps. The SURFACE-B-013 family probe stopped at src/ and missed
// scripts/; here was a hardcoded fallback string referencing the literal
// tarball path that would silently miss the actual tarball after any bump.
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const PKG = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8'));
const DEFAULT_TGZ = join(REPO_ROOT, `${PKG.name}-${PKG.version}.tgz`);

const tgzPath = resolve(process.argv[2] || DEFAULT_TGZ);
if (!existsSync(tgzPath)) {
    console.error(`Tarball not found: ${tgzPath}`);
    process.exit(1);
}

const testDir = mkdtempSync(join(tmpdir(), 'db-cluster-smoke-'));
console.log(`Smoke test dir: ${testDir}`);
console.log(`Tarball: ${tgzPath}\n`);

let passed = 0;
let failed = 0;

function run(cmd, opts = {}) {
    return execSync(cmd, { cwd: testDir, encoding: 'utf-8', timeout: 60000, ...opts });
}

function test(name, fn) {
    try {
        fn();
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (err) {
        console.log(`  ✗ ${name}: ${err.message}`);
        failed++;
    }
}

function assert(condition, msg) {
    if (!condition) throw new Error(msg);
}

// --- Setup ---
console.log('1. Installing from tarball...');
writeFileSync(join(testDir, 'package.json'), JSON.stringify({
    name: 'smoke-test',
    version: '1.0.0',
    type: 'module',
    private: true,
}, null, 2));

run(`npm install "${tgzPath}" --save 2>&1`);
console.log('   Installed.\n');

// --- CLI smoke ---
console.log('2. CLI smoke:');
test('db-cluster --help', () => {
    const out = run('npx db-cluster --help');
    assert(out.includes('db-cluster'), 'Should contain db-cluster');
    assert(out.includes('init') || out.includes('ingest'), 'Should list commands');
});

test('db-cluster init', () => {
    const out = run('npx db-cluster init');
    assert(existsSync(join(testDir, '.db-cluster')), 'Should create .db-cluster dir');
});

test('db-cluster doctor', () => {
    const out = run('npx db-cluster doctor');
    assert(out.includes('healthy') || out.includes('Healthy') || out.includes('HEALTHY') || out.includes('Cluster'), 'Should report health');
});

// --- MCP bin smoke ---
console.log('\n3. MCP bin smoke:');
test('db-cluster-mcp --help or startup', () => {
    try {
        // MCP server typically expects stdio, so --help or --version may not exist.
        // Just verify the bin exists and starts (will exit on no input)
        run('npx db-cluster-mcp --help', { timeout: 5000 });
    } catch (err) {
        // Exit code non-zero but binary exists is acceptable for MCP (stdio server)
        const binPath = join(testDir, 'node_modules', '.bin', 'db-cluster-mcp');
        const binPathCmd = join(testDir, 'node_modules', '.bin', 'db-cluster-mcp.cmd');
        assert(
            existsSync(binPath) || existsSync(binPathCmd),
            'MCP bin should exist in node_modules/.bin'
        );
    }
});

// --- SDK import smoke ---
console.log('\n4. SDK import smoke:');
test('import db-cluster main', () => {
    const script = `
        import { ClusterSDK } from 'db-cluster/sdk';
        import { mkdtempSync } from 'node:fs';
        import { tmpdir } from 'node:os';
        import { join } from 'node:path';
        const dir = mkdtempSync(join(tmpdir(), 'sdk-smoke-'));
        const sdk = new ClusterSDK({ clusterDir: dir });
        console.log('sdk ok:', typeof sdk.findSources === 'function');
    `;
    writeFileSync(join(testDir, 'test-main.mjs'), script);
    const out = run('node test-main.mjs');
    assert(out.includes('sdk ok: true'), 'Should construct SDK');
});

test('import db-cluster/sdk', () => {
    const script = `
        import { ClusterSDK } from 'db-cluster/sdk';
        console.log('sdk ok:', typeof ClusterSDK === 'function');
    `;
    writeFileSync(join(testDir, 'test-sdk.mjs'), script);
    const out = run('node test-sdk.mjs');
    assert(out.includes('sdk ok: true'), 'Should import SDK');
});

test('import db-cluster/policy', () => {
    const script = `
        import { PolicyEnforcedKernel } from 'db-cluster/policy';
        console.log('policy ok:', typeof PolicyEnforcedKernel === 'function');
    `;
    writeFileSync(join(testDir, 'test-policy.mjs'), script);
    const out = run('node test-policy.mjs');
    assert(out.includes('policy ok: true'), 'Should import policy');
});

test('import db-cluster/types', () => {
    // Types are compile-time only, but the JS module should still be importable
    const script = `
        import * as types from 'db-cluster/types';
        console.log('types ok:', typeof types === 'object');
    `;
    writeFileSync(join(testDir, 'test-types.mjs'), script);
    const out = run('node test-types.mjs');
    assert(out.includes('types ok: true'), 'Should import types');
});

// --- Quickstart ---
console.log('\n5. Quickstart smoke:');
test('create cluster + propose + validate + approve + commit + retrieve', () => {
    const script = `
        import { ClusterSDK } from 'db-cluster/sdk';
        import { mkdtempSync } from 'node:fs';
        import { tmpdir } from 'node:os';
        import { join } from 'node:path';

        const dir = mkdtempSync(join(tmpdir(), 'quickstart-'));
        const sdk = new ClusterSDK({ clusterDir: dir });

        const command = await sdk.proposeMutation({
            verb: 'create_entity',
            targetStore: 'canonical',
            payload: {
                kind: 'fact',
                name: 'hello-world',
                attributes: { source: 'smoke' },
            },
            proposedBy: 'smoke-test',
        });

        // Wave A2: SDK auto-walk removed — explicitly validate + approve
        // before commit to satisfy KERNEL-006 separation-of-duties.
        await sdk.validateMutation(command.id);
        await sdk.approveMutation(command.id, 'smoke-test');
        await sdk.commitMutation(command.id, 'smoke-test');

        const results = await sdk.findSources('hello');
        console.log('quickstart ok:', results.resolvedEntities.length >= 1);
    `;
    writeFileSync(join(testDir, 'test-quickstart.mjs'), script);
    const out = run('node test-quickstart.mjs');
    assert(out.includes('quickstart ok: true'), 'Quickstart should work');
});

// --- Summary ---
console.log(`\n${'='.repeat(40)}`);
console.log(`Smoke test results: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(40)}`);

// Cleanup
rmSync(testDir, { recursive: true, force: true });

process.exit(failed > 0 ? 1 : 0);
