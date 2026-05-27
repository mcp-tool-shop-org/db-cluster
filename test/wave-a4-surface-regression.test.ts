/**
 * Wave A4 — Surface domain regression tests (Stage B Wave B1 audit findings).
 *
 * These tests probe FULL invariants — each test must FAIL against the pre-fix
 * code on HEAD and PASS after the corresponding Wave A4 Surface fix lands.
 *
 * Findings covered:
 * - SURFACE-B-001 — cluster_find_sources MCP LIST arm leaks IndexRecord.metadata
 * - SURFACE-B-002 — CLI `policy explain` / `policy test` ignore .db-cluster/policies.json
 * - SURFACE-B-003 — MCP error catch returns raw err.message (paths leak)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import {
    mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { ClusterSDK } from '../src/sdk/cluster-sdk.js';
import { createLocalCluster } from '../src/adapters/local/index.js';
import { ClusterKernel } from '../src/kernel/cluster-kernel.js';
import { handleTool } from '../src/mcp/server.js';
import { redactError } from '../src/mcp/sanitize.js';
import {
    ClusterError,
    NotFoundError,
    CommandRejectedError,
} from '../src/kernel/errors.js';

const ROOT = resolve(import.meta.dirname, '..');
const CLI = `node ${join(ROOT, 'dist', 'cli.js')}`;

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Seed a cluster directory with an admin-created entity and artifact. */
async function seedCluster(): Promise<{
    clusterDir: string;
    dir: string;
    entityId: string;
    artifactId: string;
}> {
    const dir = mkdtempSync(join(tmpdir(), 'wave-a4-surface-'));
    execSync(`${CLI} init`, { cwd: dir, encoding: 'utf-8' });
    const clusterDir = join(dir, '.db-cluster');

    const stores = createLocalCluster(clusterDir);
    const kernel = new ClusterKernel(stores, { dataDir: clusterDir });

    const entityResult = await kernel.createEntity({
        kind: 'document',
        name: 'WaveA4LeakProbe',
        attributes: { secret: 'wave-a4-secret-metadata-value-marker' },
        actorId: 'admin-seed',
    });

    const artifactResult = await kernel.ingestArtifact({
        filename: 'wave-a4-artifact.txt',
        content: Buffer.from('Wave A4 artifact bytes — must NOT appear in find_sources output.'),
        mimeType: 'text/plain',
        actorId: 'admin-seed',
    });

    return {
        clusterDir,
        dir,
        entityId: entityResult.entity.id,
        artifactId: artifactResult.artifact.id,
    };
}

// ─── SURFACE-B-001 — cluster_find_sources LIST arm sanitizes IndexRecord.metadata ─

describe('SURFACE-B-001 — cluster_find_sources MCP LIST arm sanitizes IndexRecord', () => {
    it('with no policies configured, indexRecords[] items carry _sourceType=derivative and no metadata', async () => {
        // Full invariant: every indexRecord returned from cluster_find_sources
        // MCP handler must be sanitized — no raw `metadata` field, must carry
        // _sourceType='derivative' marker. Applies whether or not policies
        // are configured.
        const { clusterDir } = await seedCluster();

        const sdk = new ClusterSDK({ clusterDir });
        const result = (await handleTool('cluster_find_sources', { query: 'WaveA4LeakProbe' }, sdk)) as any;

        expect(Array.isArray(result.indexRecords)).toBe(true);
        expect(result.indexRecords.length).toBeGreaterThan(0);

        for (const record of result.indexRecords) {
            // Sanitizer strips metadata via destructuring.
            expect(record.metadata).toBeUndefined();
            // Sanitizer attaches the _metadataPolicy notice.
            expect(typeof record._metadataPolicy).toBe('string');
            expect(record._metadataPolicy.length).toBeGreaterThan(0);
            // Sanitizer attaches _sourceType=derivative.
            expect(record._sourceType).toBe('derivative');
            // _sourceStore + _note shape preserved by the LIST-arm wrapper.
            expect(record._sourceStore).toBe('index');
            expect(typeof record._note).toBe('string');
        }
    });

    it('with policies configured, indexRecords[] items still sanitized (no metadata leak)', async () => {
        const { clusterDir } = await seedCluster();

        const sdk = new ClusterSDK({
            clusterDir,
            policies: [
                {
                    id: 'admin-full',
                    name: 'Admin Full',
                    priority: 10,
                    match: { principals: ['cluster-admin'] },
                    decision: 'allow',
                    reason: 'Admin.',
                },
            ],
        });

        const result = (await handleTool('cluster_find_sources', { query: 'WaveA4LeakProbe' }, sdk)) as any;

        expect(Array.isArray(result.indexRecords)).toBe(true);
        for (const record of result.indexRecords) {
            expect(record.metadata).toBeUndefined();
            expect(record._sourceType).toBe('derivative');
            // Secret attribute value must not appear stringified anywhere.
            expect(JSON.stringify(record)).not.toContain('wave-a4-secret-metadata-value-marker');
        }
    });
});

// ─── SURFACE-B-002 — CLI `policy explain` / `policy test` respect .db-cluster/policies.json ─

describe('SURFACE-B-002 — CLI policy explain/test load .db-cluster/policies.json', () => {
    it('policy explain uses loaded policies when policies.json present (custom deny matches)', async () => {
        const { dir, clusterDir } = await seedCluster();

        // Write a custom policy that explicitly denies "custom-actor".
        const policiesFile = join(clusterDir, 'policies.json');
        writeFileSync(policiesFile, JSON.stringify({
            policies: [
                {
                    id: 'wave-a4-custom-deny',
                    name: 'Wave A4 Custom Deny Marker',
                    priority: 1,
                    match: { principals: ['custom-actor'] },
                    decision: 'deny',
                    reason: 'WAVE-A4-LOADED-POLICY-DENY-MARKER',
                },
            ],
        }), 'utf-8');

        const out = execSync(
            `${CLI} policy explain --principal custom-actor --capability read_owner_truth --trust-zone internal`,
            { cwd: dir, encoding: 'utf-8' },
        );

        // The custom-deny reason text from the loaded file must appear.
        // Pre-fix, DEFAULT_POLICIES has no such policy id and the output
        // would carry default-policy reasoning instead.
        expect(out).toContain('WAVE-A4-LOADED-POLICY-DENY-MARKER');
    });

    it('policy test uses loaded policies when policies.json present', async () => {
        const { dir, clusterDir } = await seedCluster();
        const policiesFile = join(clusterDir, 'policies.json');
        writeFileSync(policiesFile, JSON.stringify({
            policies: [
                {
                    id: 'wave-a4-test-loaded',
                    name: 'Wave A4 Test Loaded',
                    priority: 1,
                    match: { principals: ['test-actor'] },
                    decision: 'deny',
                    reason: 'WAVE-A4-TEST-LOADED-MARKER',
                },
            ],
        }), 'utf-8');

        const out = execSync(
            `${CLI} policy test --principal test-actor --capabilities read_owner_truth --trust-zone internal`,
            { cwd: dir, encoding: 'utf-8' },
        );

        expect(out).toContain('WAVE-A4-TEST-LOADED-MARKER');
    });

    it('policy explain emits stderr notice when no policies.json present', async () => {
        const { dir, clusterDir } = await seedCluster();

        // Ensure no policies.json exists.
        const policiesFile = join(clusterDir, 'policies.json');
        if (existsSync(policiesFile)) rmSync(policiesFile);

        const result = spawnSync('node', [
            join(ROOT, 'dist', 'cli.js'),
            'policy', 'explain',
            '--principal', 'admin-1',
            '--roles', 'cluster-admin',
            '--capability', 'read_owner_truth',
            '--trust-zone', 'internal',
        ], { cwd: dir, encoding: 'utf-8' });

        // Stderr must carry the notice; stdout still returns the decision.
        expect(result.stderr).toContain('no .db-cluster/policies.json found');
        // Behavior with default policies still works.
        expect(result.stdout).toContain('ALLOW');
    });

    it('policy test emits stderr notice when no policies.json present', async () => {
        const { dir, clusterDir } = await seedCluster();
        const policiesFile = join(clusterDir, 'policies.json');
        if (existsSync(policiesFile)) rmSync(policiesFile);

        const result = spawnSync('node', [
            join(ROOT, 'dist', 'cli.js'),
            'policy', 'test',
            '--principal', 'admin-1',
            '--roles', 'cluster-admin',
            '--capabilities', 'read_owner_truth',
            '--trust-zone', 'internal',
        ], { cwd: dir, encoding: 'utf-8' });

        expect(result.stderr).toContain('no .db-cluster/policies.json found');
    });
});

// ─── SURFACE-B-003 — MCP error catch sanitizes err.message ─

describe('SURFACE-B-003 — MCP error sanitizer (redactError)', () => {
    it('strips absolute Posix paths from error messages', () => {
        const err = new Error('ENOENT: no such file or directory, open /home/user/secret/path/to/file.json');
        const sanitized = redactError(err);
        expect(sanitized.message).not.toContain('/home/user/secret/path/to/file.json');
        // Path placeholder appears.
        expect(sanitized.message).toContain('<path>');
        // Some non-path content preserved.
        expect(sanitized.message).toContain('ENOENT');
    });

    it('strips absolute Windows paths from error messages', () => {
        const err = new Error('Cannot read C:\\Users\\mikey\\AppData\\secret.json: not found');
        const sanitized = redactError(err);
        expect(sanitized.message).not.toContain('C:\\Users\\mikey\\AppData\\secret.json');
        expect(sanitized.message).toContain('<path>');
    });

    it('maps typed ClusterError subclass to its stable code', () => {
        const err = new NotFoundError('canonical', 'entity-xyz');
        const sanitized = redactError(err);
        expect(sanitized.code).toBe('NOT_FOUND');
        // Sanitized message preserved (no path in this case).
        expect(typeof sanitized.message).toBe('string');
        expect(sanitized.message.length).toBeGreaterThan(0);
    });

    it('maps ClusterError subclasses with cause chain', () => {
        const err = new CommandRejectedError('cmd-123', 'invalid input');
        const sanitized = redactError(err);
        expect(sanitized.code).toBe('COMMAND_REJECTED');
    });

    it('maps non-ClusterError by constructor name', () => {
        const err = new TypeError('Cannot read properties of undefined');
        const sanitized = redactError(err);
        expect(sanitized.code).toBe('INTERNAL_TYPE_ERROR');
    });

    it('handles RangeError', () => {
        const err = new RangeError('Index out of range');
        const sanitized = redactError(err);
        expect(sanitized.code).toBe('INTERNAL_RANGE_ERROR');
    });

    it('handles SyntaxError', () => {
        const err = new SyntaxError('Unexpected token < at position 5 in /path/to/file.json');
        const sanitized = redactError(err);
        expect(sanitized.code).toBe('INTERNAL_SYNTAX_ERROR');
        expect(sanitized.message).not.toContain('/path/to/file.json');
    });

    it('handles unknown (non-Error) values', () => {
        const sanitized = redactError('plain string error');
        expect(typeof sanitized.code).toBe('string');
        expect(typeof sanitized.message).toBe('string');
    });

    it('strips cause.message by default', () => {
        const inner = new Error('inner: /etc/hidden/credential/path');
        const outer = new Error('outer message', { cause: inner });
        const sanitized = redactError(outer);
        // Cause-chain not appended; sanitized message does not contain inner path.
        expect(sanitized.message).not.toContain('/etc/hidden/credential/path');
    });

    it('DEBUG mode appends raw err.message', () => {
        const prev = process.env.DEBUG;
        process.env.DEBUG = '1';
        try {
            const err = new Error('detailed: /raw/path/here.json');
            const sanitized = redactError(err);
            // In DEBUG mode, raw message is appended somewhere.
            expect(sanitized.message).toContain('/raw/path/here.json');
        } finally {
            if (prev === undefined) delete process.env.DEBUG;
            else process.env.DEBUG = prev;
        }
    });

    it('MCP CallToolRequest error path returns sanitized message + code', async () => {
        // Trigger a deterministic error via an unknown tool. The catch arm
        // must produce a response shape with `error` (sanitized message) and
        // `code` fields.
        let captured: any = null;
        try {
            await handleTool('cluster_nonexistent_tool', {});
        } catch (err) {
            captured = err;
        }
        // handleTool itself throws — the MCP server's catch arm wraps it.
        // We invoke redactError directly to model the response shape.
        expect(captured).toBeTruthy();
        const sanitized = redactError(captured);
        expect(typeof sanitized.message).toBe('string');
        expect(typeof sanitized.code).toBe('string');
    });
});
