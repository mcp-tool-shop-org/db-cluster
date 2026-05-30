/**
 * Wave V2 — A4 regression: MCP version/command tools + CLI versions/list-commands.
 * The MCP/CLI surfaces DELEGATE to the policed kernel/SDK, so per-element
 * redaction + per-item gating are enforced below; here we pin the surface
 * shape, empty_reason, --json, and that redaction survives through the MCP tool.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { handleTool } from '../src/mcp/index.js';
import { ClusterSDK } from '../src/sdk/cluster-sdk.js';
import { createLocalCluster } from '../src/adapters/local/index.js';
import { ClusterKernel } from '../src/kernel/cluster-kernel.js';
import type { Policy, Principal } from '../src/types/policy.js';

const CLI = `node ${join(import.meta.dirname, '..', 'dist', 'cli.js')}`;

describe('Wave V2 — A4 MCP version/command tools', () => {
    let dir: string;
    let entityId: string;
    let commandId: string;

    beforeEach(async () => {
        dir = mkdtempSync(join(tmpdir(), 'db-cluster-v2-mcp-'));
        const cluster = createLocalCluster(dir);
        const k = new ClusterKernel(cluster, { dataDir: dir });
        const { entity } = await k.createEntity({ kind: 'doc', name: 'Doc', attributes: { secret: 'TOPSECRET' }, actorId: 'u' });
        entityId = entity.id;
        await cluster.canonical.update(entityId, { attributes: { secret: 'TOPSECRET2' } });
        const cmd = await k.proposeMutation({ verb: 'create_entity', targetStore: 'canonical', payload: { kind: 'doc', name: 'Pending', attributes: {} }, proposedBy: 'u' });
        commandId = cmd.id;
    });
    afterEach(() => {
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    it('cluster_list_entity_versions returns all versions + _meta', async () => {
        const sdk = new ClusterSDK({ clusterDir: dir });
        const result = await handleTool('cluster_list_entity_versions', { id: entityId }, sdk) as any;
        expect(result.versions).toHaveLength(2);
        expect(result._meta.operation).toBe('read');
        expect(result._meta.writesCluster).toBe(false);
    });

    it('cluster_get_entity_version fetches one version', async () => {
        const sdk = new ClusterSDK({ clusterDir: dir });
        const result = await handleTool('cluster_get_entity_version', { id: entityId, version: 1 }, sdk) as any;
        expect(result.version.version).toBe(1);
    });

    it('cluster_list_commands returns commands; empty query carries empty_reason', async () => {
        const sdk = new ClusterSDK({ clusterDir: dir });
        const result = await handleTool('cluster_list_commands', {}, sdk) as any;
        expect(result.commands.some((c: any) => c.id === commandId)).toBe(true);

        const empty = await handleTool('cluster_list_entity_versions', { id: 'unknown-xyz' }, sdk) as any;
        expect(empty.versions).toHaveLength(0);
        expect(empty._meta.empty_reason).toBeTruthy();
    });

    it('redaction survives through the MCP tool: a policed reader sees no raw history', async () => {
        const restricted: Principal = { id: 'r1', name: 'R', roles: ['restricted-reader'], trustZone: 'ai-facing' };
        const policies: Policy[] = [
            { id: 'rr', name: 'RR', priority: 20, match: { principals: ['restricted-reader'], capabilities: ['read_owner_truth'] }, decision: 'allow', reason: 'redacted', redaction: { id: 'strip', target: 'entity_attributes', behavior: 'strip', reason: 'restricted' } },
        ];
        const sdk = new ClusterSDK({ clusterDir: dir, policies, principal: restricted });
        const result = await handleTool('cluster_list_entity_versions', { id: entityId }, sdk) as any;
        expect(result.versions).toHaveLength(2);
        const serialized = JSON.stringify(result);
        expect(serialized).not.toContain('TOPSECRET'); // covers TOPSECRET and TOPSECRET2 — no raw history leak
    });
});

describe('Wave V2 — A4 CLI versions / list-commands (needs built dist)', () => {
    let TEST_DIR: string;
    const run = (cmd: string) => execSync(`${CLI} ${cmd}`, { cwd: TEST_DIR, encoding: 'utf-8' });

    beforeEach(() => { TEST_DIR = mkdtempSync(join(tmpdir(), 'db-cluster-v2-cli-')); run('init'); });
    afterEach(() => { try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* best-effort */ } });

    it('versions <id> lists entity versions; --json emits valid JSON', () => {
        const entityOut = run('entity create --kind concept --name "Thing"');
        const entityId = entityOut.match(/id:\s+(\S+)/)?.[1];
        expect(entityId).toBeTruthy();

        const out = run(`versions ${entityId}`);
        expect(out).toContain('v1');

        const json = run(`versions ${entityId} --json`);
        const parsed = JSON.parse(json);
        expect(Array.isArray(parsed)).toBe(true);
        expect(parsed).toHaveLength(1);
        expect(parsed[0].version).toBe(1);
    });

    it('list-commands lists commands; --json emits valid JSON', () => {
        run('entity create --kind concept --name "Thing"');
        const json = run('list-commands --json');
        const parsed = JSON.parse(json);
        expect(Array.isArray(parsed)).toBe(true);
    });
});
