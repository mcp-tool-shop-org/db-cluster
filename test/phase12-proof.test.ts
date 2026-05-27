/**
 * Phase 12 Proof Suite — verifies all dogfood findings are repaired.
 *
 * 14 required proofs:
 * 1.  Backup/restore preserves artifact truth.
 * 2.  Restore preserves or maps artifact IDs explicitly.
 * 3.  Commands persist across kernel instances.
 * 4.  Rejected commands remain rejected after restart.
 * 5.  Compensated commands preserve original history after restart.
 * 6.  commitMutation(create_entity) creates canonical truth and index record.
 * 7.  Command-created entity is retrievable.
 * 8.  Command-created entity is traceable to command/provenance/receipt.
 * 9.  Content-aware index finds dogfood docs by body content.
 * 10. Rebuilt index preserves improved search behavior.
 * 11. Dogfood replay no longer reproduces the four Phase 11 findings.
 * 12. Doctor/verify pass after repaired backup/restore.
 * 13. Policy/redaction still apply after restore.
 * 14. MCP/SDK/CLI observe the same repaired state.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalCluster } from '../src/adapters/local/index.js';
import { ClusterKernel } from '../src/kernel/cluster-kernel.js';
import { CommandQueue } from '../src/kernel/command-queue.js';
import { PolicyEnforcedKernel } from '../src/kernel/policy-enforced-kernel.js';
import { DEFAULT_POLICIES, DEFAULT_TRUST_ZONES, DEFAULT_VISIBILITY_RULES } from '../src/policy/default-policies.js';
import { backup, restore } from '../src/ops/backup.js';
import { rebuildIndex } from '../src/ops/rebuild.js';
import { doctor } from '../src/ops/doctor.js';
import { verify } from '../src/ops/verify.js';
import { runDogfoodReplay } from '../scripts/dogfood-replay.js';
import { ClusterSDK } from '../src/sdk/cluster-sdk.js';
import type { Principal } from '../src/types/policy.js';

let dataDir: string;
let kernel: ClusterKernel;

beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'phase12-proof-'));
    const stores = createLocalCluster(dataDir);
    kernel = new ClusterKernel(stores, { dataDir });

    // Set up cluster with artifacts and entities
    await kernel.ingestArtifact({
        filename: 'docs/phase-6-closeout.md',
        content: Buffer.from('# Phase 6 — MCP and SDK\nMCP tools expose cluster thesis. 16 tools via JSON-RPC.\nTypeScript SDK with type-safe methods.'),
        mimeType: 'text/markdown',
        actorId: 'operator',
    });
    await kernel.ingestArtifact({
        filename: 'docs/phase-5-closeout.md',
        content: Buffer.from('# Phase 5 — Mutation Law\nAI proposes, command runtime disposes.\nEvery mutation goes through propose validate approve commit.'),
        mimeType: 'text/markdown',
        actorId: 'operator',
    });
    await kernel.createEntity({ kind: 'phase', name: 'Phase 5 — Mutation Law', attributes: {}, actorId: 'operator' });
    await kernel.createEntity({ kind: 'phase', name: 'Phase 6 — MCP and SDK', attributes: {}, actorId: 'operator' });

    // Rebuild with content-aware indexing
    await rebuildIndex(stores);
});

afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true });
});

describe('Phase 12 proof suite', () => {
    it('Proof 1: Backup/restore preserves artifact truth', async () => {
        const stores = createLocalCluster(dataDir);
        const data = await backup(stores);

        const freshDir = mkdtempSync(join(tmpdir(), 'p12-p1-'));
        const freshStores = createLocalCluster(freshDir);
        const result = await restore(freshStores, data);

        expect(result.artifacts.created).toBeGreaterThan(0);
        expect(result.artifacts.errors).toHaveLength(0);

        // Content retrievable
        const artifacts = await freshStores.artifact.list({});
        const content = await freshStores.artifact.getContent(artifacts[0].id);
        expect(content).not.toBeNull();
        expect(content!.toString()).toContain('Phase');

        rmSync(freshDir, { recursive: true, force: true });
    });

    it('Proof 2: Restore preserves or maps artifact IDs explicitly', async () => {
        const stores = createLocalCluster(dataDir);
        const originalArtifacts = await stores.artifact.list({});
        const originalIds = originalArtifacts.map((a) => a.id);
        const data = await backup(stores);

        const freshDir = mkdtempSync(join(tmpdir(), 'p12-p2-'));
        const freshStores = createLocalCluster(freshDir);
        await restore(freshStores, data);

        for (const id of originalIds) {
            const restored = await freshStores.artifact.get(id);
            expect(restored).not.toBeNull();
            expect(restored!.id).toBe(id);
        }

        rmSync(freshDir, { recursive: true, force: true });
    });

    it('Proof 3: Commands persist across kernel instances', async () => {
        const stores = createLocalCluster(dataDir);
        const kA = new ClusterKernel(stores, { dataDir });

        const proposal = await kA.proposeMutation({
            verb: 'create_entity',
            targetStore: 'canonical',
            payload: { kind: 'finding', name: 'persist-proof', attributes: {} },
            proposedBy: 'agent',
        });
        await kA.validateMutation(proposal.id);

        const kB = new ClusterKernel(stores, { dataDir });
        const inspected = await kB.inspectCommand(proposal.id);
        expect(inspected.status).toBe('validated');
    });

    it('Proof 4: Rejected commands remain rejected after restart', async () => {
        const freshDir = mkdtempSync(join(tmpdir(), 'p12-p4-'));
        const stores = createLocalCluster(freshDir);
        const kA = new ClusterKernel(stores, { dataDir: freshDir });

        const proposal = await kA.proposeMutation({
            verb: 'create_entity',
            targetStore: 'canonical',
            payload: { kind: 'finding', name: 'reject-proof', attributes: {} },
            proposedBy: 'agent',
        });
        await kA.rejectMutation(proposal.id, 'operator', 'denied');

        const kB = new ClusterKernel(stores, { dataDir: freshDir });
        const inspected = await kB.inspectCommand(proposal.id);
        expect(inspected.status).toBe('rejected');

        rmSync(freshDir, { recursive: true, force: true });
    });

    it('Proof 5: Compensated commands preserve original history after restart', async () => {
        const freshDir = mkdtempSync(join(tmpdir(), 'p12-p5-'));
        const stores = createLocalCluster(freshDir);
        const kA = new ClusterKernel(stores, { dataDir: freshDir });

        const proposal = await kA.proposeMutation({
            verb: 'create_entity',
            targetStore: 'canonical',
            payload: { kind: 'finding', name: 'compensate-proof', attributes: {} },
            proposedBy: 'agent',
        });
        await kA.validateMutation(proposal.id);
        await kA.approveMutation(proposal.id, 'operator');
        const { command: committed } = await kA.commitMutation(proposal.id, 'operator');
        const { compensatingCommand } = await kA.compensateMutation(committed.id, 'operator', 'rollback');

        const kB = new ClusterKernel(stores, { dataDir: freshDir });
        const original = await kB.inspectCommand(committed.id);
        expect(original.status).toBe('compensated');
        expect(original.compensatingCommandId).toBe(compensatingCommand.id);

        rmSync(freshDir, { recursive: true, force: true });
    });

    it('Proof 6: commitMutation(create_entity) creates canonical truth and index record', async () => {
        const freshDir = mkdtempSync(join(tmpdir(), 'p12-p6-'));
        const stores = createLocalCluster(freshDir);
        const k = new ClusterKernel(stores, { dataDir: freshDir });

        const proposal = await k.proposeMutation({
            verb: 'create_entity',
            targetStore: 'canonical',
            payload: { kind: 'milestone', name: 'Auto-Index Proof', attributes: {} },
            proposedBy: 'agent',
        });
        await k.validateMutation(proposal.id);
        const { receipt } = await k.commitMutation(proposal.id, 'operator');
        const entityId = receipt.affectedIds[0];

        // Canonical truth
        const entity = await stores.canonical.get(entityId);
        expect(entity).not.toBeNull();
        expect(entity!.name).toBe('Auto-Index Proof');

        // Index record
        const results = await stores.index.search({ text: 'Auto-Index Proof' });
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].sourceId).toBe(entityId);

        rmSync(freshDir, { recursive: true, force: true });
    });

    it('Proof 7: Command-created entity is retrievable', async () => {
        const freshDir = mkdtempSync(join(tmpdir(), 'p12-p7-'));
        const stores = createLocalCluster(freshDir);
        const k = new ClusterKernel(stores, { dataDir: freshDir });

        const proposal = await k.proposeMutation({
            verb: 'create_entity',
            targetStore: 'canonical',
            payload: { kind: 'decision', name: 'Retrievable Decision Proof', attributes: {} },
            proposedBy: 'agent',
        });
        await k.validateMutation(proposal.id);
        await k.commitMutation(proposal.id, 'operator');

        const bundle = await k.retrieveBundle('Retrievable Decision');
        const found = bundle.resolvedEntities.find((re) => re.object.name === 'Retrievable Decision Proof');
        expect(found).toBeDefined();

        rmSync(freshDir, { recursive: true, force: true });
    });

    it('Proof 8: Command-created entity is traceable to command/provenance/receipt', async () => {
        const freshDir = mkdtempSync(join(tmpdir(), 'p12-p8-'));
        const stores = createLocalCluster(freshDir);
        const k = new ClusterKernel(stores, { dataDir: freshDir });

        const proposal = await k.proposeMutation({
            verb: 'create_entity',
            targetStore: 'canonical',
            payload: { kind: 'finding', name: 'Trace Proof Entity', attributes: {} },
            proposedBy: 'agent',
        });
        await k.validateMutation(proposal.id);
        const { receipt } = await k.commitMutation(proposal.id, 'operator');
        const entityId = receipt.affectedIds[0];

        // Provenance
        const events = await k.traceProvenance(entityId);
        expect(events.length).toBeGreaterThan(0);
        expect(events.some((e) => e.action === 'mutation_committed')).toBe(true);

        // Receipt
        expect(receipt.affectedIds).toContain(entityId);
        expect(receipt.resultSummary).toContain('Trace Proof Entity');

        rmSync(freshDir, { recursive: true, force: true });
    });

    it('Proof 9: Content-aware index finds dogfood docs by body content', async () => {
        const stores = createLocalCluster(dataDir);
        // MCP in Phase 6 body
        const mcpResults = await stores.index.search({ text: 'MCP' });
        expect(mcpResults.some((r) => r.text.includes('phase-6'))).toBe(true);

        // Mutation in Phase 5 body
        const mutResults = await stores.index.search({ text: 'mutation' });
        expect(mutResults.some((r) => r.text.includes('phase-5'))).toBe(true);
    });

    it('Proof 10: Rebuilt index preserves improved search behavior', async () => {
        const stores = createLocalCluster(dataDir);
        await stores.index.clear();
        await rebuildIndex(stores);

        const results = await stores.index.search({ text: 'MCP' });
        expect(results.length).toBeGreaterThan(0);
        expect(results.some((r) => r.sourceStore === 'artifact')).toBe(true);
    });

    it('Proof 11: Dogfood replay no longer reproduces the four Phase 11 findings', async () => {
        const result = await runDogfoodReplay();
        expect(result.findings.artifactRestoreFails).toBe(false);
        expect(result.findings.commandAutoIndexFails).toBe(false);
        expect(result.findings.commandPersistenceFails).toBe(false);
        expect(result.findings.contentRetrievalFails).toBe(false);
    });

    it('Proof 12: Doctor/verify pass after repaired backup/restore', async () => {
        const stores = createLocalCluster(dataDir);
        const data = await backup(stores);

        // STORES-R001: capture original IDs BEFORE restoring into a fresh
        // target so we can assert entity-ID preservation across restore.
        const originalEntities = await stores.canonical.list();
        const originalIds = originalEntities.map((e) => e.id).sort();
        expect(originalIds.length).toBeGreaterThan(0); // sanity

        const freshDir = mkdtempSync(join(tmpdir(), 'p12-p12-'));
        const freshStores = createLocalCluster(freshDir);
        await restore(freshStores, data);

        // STORES-R001: was `await doctor(freshStores)`. doctor() only checks
        // reachability; if STORES-001 (entity-ID preservation in
        // importSnapshot) ever regresses, doctor() still returns healthy and
        // the regression is invisible. verify() checks data consistency
        // (orphan subjects, index→source linkage) and would fail.
        const v = await verify(freshStores);
        expect(v.status).toBe('healthy');

        // STORES-R001 + TESTS-R004 item 4: positive entity-ID preservation
        // assertion — the IDs from the original cluster MUST match the IDs
        // in the restored cluster. If a future regression re-randomizes IDs
        // on restore, this test catches it.
        const restoredEntities = await freshStores.canonical.list();
        const restoredIds = restoredEntities.map((e) => e.id).sort();
        expect(restoredIds).toEqual(originalIds);

        rmSync(freshDir, { recursive: true, force: true });
    });

    it('Proof 13: Policy/redaction still apply after restore', async () => {
        const stores = createLocalCluster(dataDir);
        const data = await backup(stores);

        const freshDir = mkdtempSync(join(tmpdir(), 'p12-p13-'));
        const freshStores = createLocalCluster(freshDir);
        await restore(freshStores, data);

        const agent: Principal = { id: 'agent', name: 'Agent', roles: ['proposer'], trustZone: 'ai-facing' };
        const k = new PolicyEnforcedKernel(freshStores, { principal: agent }, {
            policies: DEFAULT_POLICIES,
            trustZones: DEFAULT_TRUST_ZONES,
            visibilityRules: DEFAULT_VISIBILITY_RULES,
        });

        // Agent can propose
        const proposal = await k.proposeMutation({
            verb: 'create_entity',
            targetStore: 'canonical',
            payload: { kind: 'finding', name: 'policy-after-restore', attributes: {} },
            proposedBy: 'agent',
        });
        expect(proposal.status).toBe('proposed');

        // Agent cannot commit
        await expect(k.commitMutation(proposal.id, 'agent')).rejects.toThrow();

        rmSync(freshDir, { recursive: true, force: true });
    });

    it('Proof 14: SDK observes the same repaired state', async () => {
        const freshDir = mkdtempSync(join(tmpdir(), 'p12-p14-'));
        const sdk = new ClusterSDK({ clusterDir: freshDir });

        // Create via the full mutation lifecycle. Wave A2 (KERNEL-R002)
        // removed the SDK auto-walk: callers must propose → validate →
        // approve → commit explicitly. Self-approve below mirrors the
        // previous backward-compat shape; surfaces that need genuine
        // separation of duties supply distinct actors.
        const proposal = await sdk.proposeMutation({
            verb: 'create_entity',
            targetStore: 'canonical',
            payload: { kind: 'finding', name: 'SDK Proof Entity', attributes: {} },
            proposedBy: 'operator',
        });
        await sdk.validateMutation(proposal.id);
        await sdk.approveMutation(proposal.id, 'operator');
        const { receipt } = await sdk.commitMutation(proposal.id, 'operator');
        const entityId = receipt.affectedIds[0];

        // SDK retrieval finds it
        const bundle = await sdk.retrieveBundle('SDK Proof');
        expect(bundle.resolvedEntities.some((re) => re.object.name === 'SDK Proof Entity')).toBe(true);

        // SDK can inspect the command
        const cmd = await sdk.inspectCommand(proposal.id);
        expect(cmd.status).toBe('committed');

        rmSync(freshDir, { recursive: true, force: true });
    });
});
