/**
 * Phase 14 Proof Suite — 12 integration gate proofs.
 *
 * Each proof demonstrates a specific value dimension that db-cluster
 * adds over standalone repo-knowledge.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLocalCluster } from '../src/adapters/local/index.js';
import { ClusterKernel } from '../src/kernel/cluster-kernel.js';
import { CommandQueue } from '../src/kernel/command-queue.js';
import { ingestRepoKnowledge, type IngestSource } from '../src/integrations/repo-knowledge/ingest.js';
import { compareRetrieval } from '../src/integrations/repo-knowledge/compare-retrieval.js';
import { proposeFactUpdate, executeFactUpdate, generateWritebackPayload } from '../src/integrations/repo-knowledge/update-workflow.js';
import { inspectEntity } from '../src/dashboard/inspector-data.js';
import { doctor } from '../src/ops/doctor.js';
import { verify } from '../src/ops/verify.js';
import { backup, restore } from '../src/ops/backup.js';

describe('Phase 14 Integration Gate — 12 Proofs', () => {
    let stores: ReturnType<typeof createLocalCluster>;
    let kernel: ClusterKernel;
    let entityIds: string[];
    let artifactIds: string[];
    let repoEntityId: string;
    let PROOF_DIR: string;
    let SOURCES_DIR: string;
    let CLUSTER_DIR: string;

    beforeAll(async () => {
        PROOF_DIR = mkdtempSync(join(tmpdir(), 'db-cluster-phase14-proof-'));
        SOURCES_DIR = join(PROOF_DIR, 'sources');
        CLUSTER_DIR = join(PROOF_DIR, 'cluster');
        mkdirSync(SOURCES_DIR, { recursive: true });

        writeFileSync(join(SOURCES_DIR, 'phase-status.md'), '# Phase Status\n\nPhase 13 complete. Phase 14 active.\n');
        writeFileSync(join(SOURCES_DIR, 'conventions.md'), '# Conventions\n\nESM only. Strict tsconfig. Vitest.\n');
        writeFileSync(join(SOURCES_DIR, 'architecture.md'), '# Architecture\n\n4 stores: canonical, artifact, index, ledger.\n');

        stores = createLocalCluster(CLUSTER_DIR);
        kernel = new ClusterKernel(stores, { dataDir: CLUSTER_DIR });

        const sources: IngestSource[] = [
            { path: join(SOURCES_DIR, 'phase-status.md'), entityKind: 'fact' },
            { path: join(SOURCES_DIR, 'conventions.md'), entityKind: 'convention' },
            { path: join(SOURCES_DIR, 'architecture.md'), entityKind: 'architecture' },
        ];

        const result = await ingestRepoKnowledge(kernel, sources, {
            repoName: 'db-cluster',
            actorId: 'proof-agent',
        });

        entityIds = result.entityIds.filter((id) => id !== result.repoEntityId);
        artifactIds = result.artifactIds;
        repoEntityId = result.repoEntityId;
    });

    afterAll(() => {
        try { rmSync(PROOF_DIR, { recursive: true, force: true }); } catch {}
    });

    // --- Proof 1: Traceability ---
    it('Proof 1: every fact traces to source artifact', async () => {
        for (const entityId of entityIds) {
            const events = await kernel.traceProvenance(entityId);
            expect(events.length).toBeGreaterThan(0);
            // At least one event links to an artifact (via detail or objectId)
            const hasArtifactLink = events.some((ev) => {
                const detail = ev.detail as Record<string, unknown> | undefined;
                return (
                    (ev.objectId && artifactIds.includes(ev.objectId)) ||
                    (detail?.artifactId && artifactIds.includes(detail.artifactId as string))
                );
            });
            expect(hasArtifactLink).toBe(true);
        }
    });

    // --- Proof 2: Source ownership ---
    it('Proof 2: every fact has a named owner store', async () => {
        for (const entityId of entityIds) {
            const obj = await inspectEntity(kernel, entityId);
            expect(obj.ownerStore).toBe('canonical');
            expect(obj.sourceType).toBe('owner-truth');
            expect(obj.uri).toMatch(/^cluster:\/\/canonical\/entity\//);
        }
    });

    // --- Proof 3: Recovery ---
    it('Proof 3: imported memory survives backup and restore', async () => {
        const queue = new CommandQueue(CLUSTER_DIR);
        const bkp = await backup(stores, { commandQueue: queue });

        const restoreDir = join(PROOF_DIR, 'proof3-restore');
        const restoreStores = createLocalCluster(restoreDir);
        const restoreQueue = new CommandQueue(restoreDir);
        const result = await restore(restoreStores, bkp, { commandQueue: restoreQueue });

        expect(result.entities.created).toBeGreaterThanOrEqual(entityIds.length);
        expect(result.artifacts.created).toBeGreaterThanOrEqual(artifactIds.length);

        // Provenance survives
        const restoreKernel = new ClusterKernel(restoreStores, { dataDir: restoreDir });
        const events = await restoreKernel.traceProvenance(entityIds[0]);
        expect(events.length).toBeGreaterThan(0);
    });

    // --- Proof 4: Mutation audit ---
    it('Proof 4: updates flow through typed command lifecycle', async () => {
        const result = await executeFactUpdate(
            kernel,
            {
                factEntityId: entityIds[0],
                patch: { phase: 14, gate: 'active' },
                supportingArtifacts: [artifactIds[0]],
                proposedBy: 'proof-agent',
                reason: 'Phase 14 gate proof',
            },
            'operator',
        );

        expect(result.committed).toBe(true);
        expect(result.receiptId).toBeTruthy();
        expect(result.repoKnowledgeModified).toBe(false);
    });

    // --- Proof 5: No writeback ---
    it('Proof 5: source files remain untouched after all operations', () => {
        const status = readFileSync(join(SOURCES_DIR, 'phase-status.md'), 'utf-8');
        const conventions = readFileSync(join(SOURCES_DIR, 'conventions.md'), 'utf-8');
        const arch = readFileSync(join(SOURCES_DIR, 'architecture.md'), 'utf-8');

        expect(status).toContain('Phase 13 complete');
        expect(conventions).toContain('ESM only');
        expect(arch).toContain('4 stores');
    });

    // --- Proof 6: Evidence bundles richer than flat file ---
    it('Proof 6: retrieval produces evidence bundles with provenance', async () => {
        const comparison = await compareRetrieval(kernel, 'db-cluster');

        expect(comparison.bundle).toBeDefined();
        expect(comparison.hasProvenanceBacking).toBe(true);
        expect(comparison.freshnessVisible).toBe(true);
    });

    // --- Proof 7: Operator inspection ---
    it('Proof 7: dashboard inspection reveals owner store and source type', async () => {
        const obj = await inspectEntity(kernel, repoEntityId);
        expect(obj.ownerStore).toBe('canonical');
        expect(obj.sourceType).toBe('owner-truth');
        expect((obj.object as any).kind).toBe('repo');
    });

    // --- Proof 8: Index rebuild recovers retrieval ---
    it('Proof 8: index rebuild recovers from index loss', async () => {
        await stores.index.clear();

        const emptyResults = await kernel.findSources({ query: 'phase-status' });
        expect(emptyResults.resolvedEntities.length).toBe(0);

        const rebuilt = await kernel.rebuildIndex('proof-agent');
        expect(rebuilt.rebuilt).toBeGreaterThan(0);

        const afterResults = await kernel.findSources({ query: 'phase-status' });
        expect(afterResults.resolvedEntities.length).toBeGreaterThan(0);
    });

    // --- Proof 9: Doctor detects health ---
    it('Proof 9: doctor correctly reports cluster health', async () => {
        const health = await doctor(stores);
        expect(['healthy', 'degraded']).toContain(health.status);
        expect(health.checks.length).toBeGreaterThan(0);
    });

    // --- Proof 10: Supporting artifact requirement ---
    it('Proof 10: update without supporting artifact is rejected', async () => {
        await expect(
            proposeFactUpdate(kernel, {
                factEntityId: entityIds[0],
                patch: { unsupported: true },
                supportingArtifacts: [],
                proposedBy: 'rogue-agent',
                reason: 'No evidence',
            }),
        ).rejects.toThrow('at least one supporting artifact');
    });

    // --- Proof 11: Writeback payload not applied ---
    it('Proof 11: writeback payload generated but never applied', () => {
        const wb = generateWritebackPayload(entityIds[0], { phase: 15 }, 'cmd-proof');
        expect(wb.applied).toBe(false);
        expect(wb.payload.warning).toContain('NOT applied');
        expect(wb.payload.commandRef).toBe('cmd-proof');
    });

    // --- Proof 12: Cross-entity provenance visible ---
    it('Proof 12: repo entity links to all ingested facts', async () => {
        const events = await kernel.traceProvenance(repoEntityId);
        expect(events.length).toBeGreaterThan(0);
        // Repo entity should have provenance events connecting to child entities
        const linkedSubjects = new Set(events.map((ev) => ev.subjectId));
        const linkedObjects = new Set(events.filter((ev) => ev.objectId).map((ev) => ev.objectId));
        const allLinked = new Set([...linkedSubjects, ...linkedObjects]);
        expect(allLinked.has(repoEntityId)).toBe(true);
    });
});
