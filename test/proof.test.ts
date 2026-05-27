import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createLocalCluster } from '../src/adapters/local/index.js';
import { ClusterKernel } from '../src/kernel/cluster-kernel.js';
import { ProvenanceMissingError } from '../src/kernel/errors.js';
import type { ClusterStores } from '../src/contracts/index.js';

const TEST_DIR = join(import.meta.dirname, '.test-proof');

describe('Wave 5 — Proof Tests', () => {
    let cluster: ClusterStores;
    let kernel: ClusterKernel;

    beforeEach(() => {
        rmSync(TEST_DIR, { recursive: true, force: true });
        mkdirSync(TEST_DIR, { recursive: true });
        cluster = createLocalCluster(TEST_DIR);
        kernel = new ClusterKernel(cluster, { dataDir: TEST_DIR });
    });

    afterEach(() => {
        rmSync(TEST_DIR, { recursive: true, force: true });
    });

    describe('Index rebuild proof', () => {
        it('index can be cleared and rebuilt from owned stores', async () => {
            // Populate cluster with real data
            const { artifact } = await kernel.ingestArtifact({
                filename: 'source.md',
                content: Buffer.from('# Source Truth'),
                mimeType: 'text/markdown',
                actorId: 'user-1',
            });
            const { entity } = await kernel.createEntity({
                kind: 'concept',
                name: 'Provenance',
                attributes: { domain: 'architecture' },
                actorId: 'user-1',
            });

            // Verify index has records
            expect(await cluster.index.count()).toBe(2);
            const beforeFind = await kernel.findSources({ query: 'source' });
            expect(beforeFind.indexRecords.length).toBeGreaterThan(0);

            // Destroy the index completely
            await cluster.index.clear();
            expect(await cluster.index.count()).toBe(0);

            // Rebuild: re-index from owned stores
            const entities = await cluster.canonical.list();
            for (const e of entities) {
                await cluster.index.index({
                    sourceId: e.id,
                    sourceStore: 'canonical',
                    text: `${e.kind}: ${e.name}`,
                    metadata: { kind: e.kind, ...e.attributes },
                });
            }
            const artifacts = await cluster.artifact.list();
            for (const a of artifacts) {
                await cluster.index.index({
                    sourceId: a.id,
                    sourceStore: 'artifact',
                    text: `${a.filename} [${a.mimeType}]`,
                    metadata: { filename: a.filename, mimeType: a.mimeType },
                });
            }

            // Prove index is back
            expect(await cluster.index.count()).toBe(2);
            const afterFind = await kernel.findSources({ query: 'source' });
            expect(afterFind.resolvedArtifacts).toHaveLength(1);
            expect(afterFind.resolvedArtifacts[0].id).toBe(artifact.id);

            const entityFind = await kernel.findSources({ query: 'Provenance' });
            expect(entityFind.resolvedEntities).toHaveLength(1);
            expect(entityFind.resolvedEntities[0].id).toBe(entity.id);
        });
    });

    describe('No mutation without command proof', () => {
        it('every helper-method receipt cites an inspectable command', async () => {
            // KERNEL-002 fix: synthetic commands manufactured inside the
            // helper write methods (ingestArtifact / createEntity / linkEvidence /
            // rebuildIndex) must be persisted via saveCommand so the resulting
            // receipt.commandId resolves through inspectCommand. The old proof
            // here checked prototype names — a structural no-op that passed
            // regardless of whether stores were exposed. The real invariant is
            // "every receipt cites a real command on the inspectable surface."
            const { artifact, receipt: artifactReceipt } = await kernel.ingestArtifact({
                filename: 'no-orphan.md',
                content: Buffer.from('# Truth has receipts'),
                mimeType: 'text/markdown',
                actorId: 'user-1',
            });
            const artifactCmd = await kernel.inspectCommand(artifactReceipt.commandId);
            expect(artifactCmd).toBeDefined();
            expect(artifactCmd.status).toBe('committed');
            expect(artifactCmd.verb).toBe('ingest_artifact');
            expect(artifactCmd.proposedBy).toBe('user-1');

            const { entity, receipt: entityReceipt } = await kernel.createEntity({
                kind: 'thesis',
                name: 'No orphans',
                attributes: { conf: 'high' },
                actorId: 'user-1',
            });
            const entityCmd = await kernel.inspectCommand(entityReceipt.commandId);
            expect(entityCmd).toBeDefined();
            expect(entityCmd.status).toBe('committed');
            expect(entityCmd.verb).toBe('create_entity');

            const { receipt: linkReceipt } = await kernel.linkEvidence({
                artifactId: artifact.id,
                entityId: entity.id,
                actorId: 'user-1',
            });
            const linkCmd = await kernel.inspectCommand(linkReceipt.commandId);
            expect(linkCmd).toBeDefined();
            expect(linkCmd.status).toBe('committed');
            expect(linkCmd.verb).toBe('link_evidence');

            const { receipt: rebuildReceipt } = await kernel.rebuildIndex('user-1');
            const rebuildCmd = await kernel.inspectCommand(rebuildReceipt.commandId);
            expect(rebuildCmd).toBeDefined();
            expect(rebuildCmd.status).toBe('committed');
            expect(rebuildCmd.verb).toBe('reindex');
        });

        it('proposeMutation produces zero store writes', async () => {
            // Snapshot store state
            const entitiesBefore = await cluster.canonical.list();
            const artifactsBefore = await cluster.artifact.list();
            const eventsBefore = await cluster.ledger.listEvents();
            const receiptsBefore = await cluster.ledger.listReceipts();
            const indexBefore = await cluster.index.count();

            // Propose multiple mutations
            await kernel.proposeMutation({
                verb: 'create_entity',
                targetStore: 'canonical',
                payload: { kind: 'test', name: 'Ghost', attributes: {} },
                proposedBy: 'user-1',
            });
            await kernel.proposeMutation({
                verb: 'update_entity',
                targetStore: 'canonical',
                payload: { entityId: 'fake-id', patch: { name: 'New' } },
                proposedBy: 'user-1',
            });

            // Assert nothing changed in any store
            expect(await cluster.canonical.list()).toEqual(entitiesBefore);
            expect(await cluster.artifact.list()).toEqual(artifactsBefore);
            expect(await cluster.ledger.listEvents()).toEqual(eventsBefore);
            expect(await cluster.ledger.listReceipts()).toEqual(receiptsBefore);
            expect(await cluster.index.count()).toBe(indexBefore);
        });

        it('commitMutation is the only path to canonical state change', async () => {
            // Create via kernel verb (which internally uses command pattern)
            const { entity } = await kernel.createEntity({
                kind: 'test',
                name: 'Original',
                attributes: {},
                actorId: 'user-1',
            });

            // Propose an update
            const cmd = await kernel.proposeMutation({
                verb: 'update_entity',
                targetStore: 'canonical',
                payload: { entityId: entity.id, patch: { name: 'Updated' } },
                proposedBy: 'user-1',
            });

            // Before commit: entity unchanged
            const beforeCommit = await kernel.inspectEntity(entity.id);
            expect(beforeCommit.name).toBe('Original');

            // KERNEL-006 fix: commitMutation now requires the command to be
            // validated (or approved) — proposed-direct-to-committed is no
            // longer permitted at the kernel layer. Walk the full lifecycle.
            await kernel.validateMutation(cmd.id);
            await kernel.commitMutation(cmd.id, 'user-1');
            const afterCommit = await kernel.inspectEntity(entity.id);
            expect(afterCommit.name).toBe('Updated');
        });
    });

    describe('Artifact immutability proof', () => {
        it('re-ingesting same filename creates a new version, not overwrite', async () => {
            const r1 = await kernel.ingestArtifact({
                filename: 'report.md',
                content: Buffer.from('Version 1 content'),
                mimeType: 'text/markdown',
                actorId: 'user-1',
            });
            const r2 = await kernel.ingestArtifact({
                filename: 'report.md',
                content: Buffer.from('Version 2 content'),
                mimeType: 'text/markdown',
                actorId: 'user-1',
            });

            // Different IDs, different versions
            expect(r1.artifact.id).not.toBe(r2.artifact.id);
            expect(r1.artifact.version).toBe(1);
            expect(r2.artifact.version).toBe(2);

            // Both versions still retrievable
            const v1Content = await cluster.artifact.getContent(r1.artifact.id);
            const v2Content = await cluster.artifact.getContent(r2.artifact.id);
            expect(v1Content?.toString()).toBe('Version 1 content');
            expect(v2Content?.toString()).toBe('Version 2 content');

            // Version history preserved
            const versions = await cluster.artifact.versions('report.md');
            expect(versions).toHaveLength(2);
            expect(versions[0].version).toBe(1);
            expect(versions[1].version).toBe(2);
        });

        it('identical content is deduplicated but tracked as separate artifacts', async () => {
            const content = Buffer.from('shared content');
            const a = await kernel.ingestArtifact({
                filename: 'a.txt',
                content,
                mimeType: 'text/plain',
                actorId: 'user-1',
            });
            const b = await kernel.ingestArtifact({
                filename: 'b.txt',
                content,
                mimeType: 'text/plain',
                actorId: 'user-1',
            });

            // Same content hash, different artifact IDs
            expect(a.artifact.contentHash).toBe(b.artifact.contentHash);
            expect(a.artifact.id).not.toBe(b.artifact.id);

            // Both resolve independently
            expect(await cluster.artifact.get(a.artifact.id)).toBeTruthy();
            expect(await cluster.artifact.get(b.artifact.id)).toBeTruthy();
        });
    });

    describe('Receipt completeness proof', () => {
        it('every kernel write operation emits a receipt', async () => {
            await kernel.ingestArtifact({
                filename: 'one.txt',
                content: Buffer.from('one'),
                mimeType: 'text/plain',
                actorId: 'user-1',
            });
            const { entity } = await kernel.createEntity({
                kind: 'test',
                name: 'Two',
                attributes: {},
                actorId: 'user-1',
            });
            const { artifact } = await kernel.ingestArtifact({
                filename: 'three.txt',
                content: Buffer.from('three'),
                mimeType: 'text/plain',
                actorId: 'user-1',
            });
            await kernel.linkEvidence({
                artifactId: artifact.id,
                entityId: entity.id,
                actorId: 'user-1',
            });

            const cmd = await kernel.proposeMutation({
                verb: 'create_entity',
                targetStore: 'canonical',
                payload: { kind: 'test', name: 'Four', attributes: {} },
                proposedBy: 'user-1',
            });
            // KERNEL-006: commit now requires validated/approved.
            await kernel.validateMutation(cmd.id);
            await kernel.commitMutation(cmd.id, 'user-1');

            // 5 write operations = 5 receipts
            const receipts = await kernel.listReceipts();
            expect(receipts).toHaveLength(5);

            // Each receipt has required fields
            for (const r of receipts) {
                expect(r.id).toBeTruthy();
                expect(r.commandId).toBeTruthy();
                expect(r.committedAt).toBeTruthy();
                expect(r.resultSummary).toBeTruthy();
                expect(r.provenanceEventId).toBeTruthy();
            }
        });
    });

    describe('Trace survives restart proof', () => {
        it('provenance written in one kernel instance is traceable in another', async () => {
            // First kernel instance: do work
            const { artifact } = await kernel.ingestArtifact({
                filename: 'persist.md',
                content: Buffer.from('persisted truth'),
                mimeType: 'text/markdown',
                actorId: 'user-1',
            });
            const { entity } = await kernel.createEntity({
                kind: 'claim',
                name: 'Persistence works',
                attributes: {},
                actorId: 'user-1',
            });
            await kernel.linkEvidence({
                artifactId: artifact.id,
                entityId: entity.id,
                actorId: 'user-1',
            });

            // Second kernel instance: same data dir, new objects
            const cluster2 = createLocalCluster(TEST_DIR);
            const kernel2 = new ClusterKernel(cluster2, { dataDir: TEST_DIR });

            // Trace from second instance
            const entityTrace = await kernel2.traceProvenance(entity.id);
            expect(entityTrace.length).toBeGreaterThanOrEqual(2);
            expect(entityTrace.some((e) => e.action === 'entity_created')).toBe(true);
            expect(entityTrace.some((e) => e.action === 'evidence_linked')).toBe(true);

            const artifactTrace = await kernel2.traceProvenance(artifact.id);
            expect(artifactTrace.some((e) => e.action === 'artifact_ingested')).toBe(true);

            // Receipts also survive
            const receipts = await kernel2.listReceipts();
            expect(receipts.length).toBeGreaterThanOrEqual(3);
        });
    });

    describe('Index is not truth proof', () => {
        it('corrupted index does not affect canonical/artifact truth', async () => {
            const { entity } = await kernel.createEntity({
                kind: 'important',
                name: 'Critical Record',
                attributes: { value: 42 },
                actorId: 'user-1',
            });
            const { artifact } = await kernel.ingestArtifact({
                filename: 'critical.pdf',
                content: Buffer.from('critical evidence'),
                mimeType: 'application/pdf',
                actorId: 'user-1',
            });

            // Destroy the index entirely
            await cluster.index.clear();

            // Canonical truth remains inspectable
            const inspected = await kernel.inspectEntity(entity.id);
            expect(inspected.name).toBe('Critical Record');
            expect(inspected.attributes).toEqual({ value: 42 });
            expect(inspected.owner).toBe('canonical');

            // Artifact truth remains retrievable
            const art = await cluster.artifact.get(artifact.id);
            expect(art).toBeTruthy();
            expect(art!.filename).toBe('critical.pdf');
            const content = await cluster.artifact.getContent(artifact.id);
            expect(content?.toString()).toBe('critical evidence');

            // Provenance still works
            const trace = await kernel.traceProvenance(entity.id);
            expect(trace.length).toBeGreaterThan(0);
        });

        it('find returns empty when index is cleared, but truth exists', async () => {
            await kernel.createEntity({
                kind: 'test',
                name: 'Invisible after clear',
                attributes: {},
                actorId: 'user-1',
            });

            // Clear index
            await cluster.index.clear();

            // Find returns nothing (index is empty)
            const result = await kernel.findSources({ query: 'Invisible' });
            expect(result.indexRecords).toHaveLength(0);

            // But canonical truth still exists
            const all = await cluster.canonical.list();
            expect(all.some((e) => e.name === 'Invisible after clear')).toBe(true);
        });
    });

    describe('Drift detection proof (TESTS-008 — always-on local equivalent of Phase 8 Proof 3)', () => {
        it('direct adapter mutation is detectable as drift (no receipt, verify() flags it)', async () => {
            // Seed: create an entity through the kernel — receipt emitted.
            const { entity } = await kernel.createEntity({
                kind: 'drifted',
                name: 'Original',
                attributes: { v: 1 },
                actorId: 'user-1',
            });

            // Snapshot the receipt count BEFORE the bypass.
            const beforeReceipts = await kernel.listReceipts();
            const updateBefore = beforeReceipts.filter((r) =>
                r.resultSummary.includes('Updated entity'),
            );
            expect(updateBefore).toHaveLength(0);

            // Bypass kernel: write directly to the canonical adapter.
            // This is the local-adapter equivalent of phase8-proof Proof 3,
            // which only runs against Postgres. Without an always-on local
            // version, the "no mutation without command" drift signal was
            // invisible on the default test path.
            await cluster.canonical.update(entity.id, {
                name: 'Drifted',
                attributes: { v: 99 },
            });

            // Data changed in canonical truth.
            const raw = await cluster.canonical.get(entity.id);
            expect(raw).not.toBeNull();
            expect(raw!.name).toBe('Drifted');
            expect(raw!.attributes).toEqual({ v: 99 });

            // No "Updated entity" receipt was emitted for this change — the
            // bypass is detectable as drift.
            const afterReceipts = await kernel.listReceipts();
            const updateAfter = afterReceipts.filter((r) =>
                r.resultSummary.includes('Updated entity'),
            );
            expect(updateAfter).toHaveLength(0);

            // The index still has the OLD text (`drifted: Original`) but the
            // canonical entity now reads "Drifted" — verify() builds the
            // expected text as `${entity.kind}: ${entity.name}` and searches
            // the index for it; the old index entry doesn't match so the
            // index_references_valid check flips to 'stale'.
            //
            // TESTS-R008: was a loose `checks.some(c => c.status !== 'healthy')`.
            // Any future regression that flipped an UNRELATED check (e.g.
            // provenance_references_valid going stale for a different reason)
            // would silently pass this test. Now we pin the SPECIFIC check
            // expected to fire, and additionally assert the other checks
            // remain healthy — so we're catching the actual drift, not a
            // sibling bug.
            const { verify } = await import('../src/ops/verify.js');
            const health = await verify(cluster);

            const indexCheck = health.checks.find((c) => c.name === 'index_references_valid');
            expect(indexCheck, 'verify() must include the index_references_valid check').toBeDefined();
            expect(indexCheck!.status).toBe('stale');

            // The other checks should still be healthy — proves we're catching
            // the drift (canonical-vs-index mismatch) and not picking up an
            // unrelated regression.
            const otherChecks = health.checks.filter((c) => c.name !== 'index_references_valid');
            for (const c of otherChecks) {
                expect(
                    c.status,
                    `Unrelated check ${c.name} flipped to ${c.status} — drift test may be catching the wrong bug`,
                ).toBe('healthy');
            }
        });
    });

    describe('Golden path regression fixture', () => {
        it('full lifecycle: ingest → entity → link → find → inspect → trace → propose → commit → receipts', async () => {
            // 1. Ingest
            const { artifact } = await kernel.ingestArtifact({
                filename: 'evidence.md',
                content: Buffer.from('# Evidence\nSpecialized stores preserve truth.'),
                mimeType: 'text/markdown',
                actorId: 'operator',
            });
            expect(artifact.owner).toBe('artifact');

            // 2. Create entity
            const { entity } = await kernel.createEntity({
                kind: 'thesis',
                name: 'Federated Truth Stores',
                attributes: { confidence: 'high' },
                actorId: 'operator',
            });
            expect(entity.owner).toBe('canonical');

            // 3. Link evidence
            const { provenance: linkProv } = await kernel.linkEvidence({
                artifactId: artifact.id,
                entityId: entity.id,
                actorId: 'operator',
            });
            expect(linkProv.action).toBe('evidence_linked');

            // 4. Find (resolves from owner stores)
            const found = await kernel.findSources({ query: 'federated' });
            expect(found.resolvedEntities.length + found.resolvedArtifacts.length).toBeGreaterThan(0);

            // 5. Inspect (canonical truth, not projection)
            const inspected = await kernel.inspectEntity(entity.id);
            expect(inspected.owner).toBe('canonical');
            expect(inspected.attributes).toEqual({ confidence: 'high' });

            // 6. Trace
            const trace = await kernel.traceProvenance(entity.id);
            expect(trace.some((e) => e.action === 'entity_created')).toBe(true);
            expect(trace.some((e) => e.action === 'evidence_linked')).toBe(true);

            // 7. Propose (zero writes)
            const eventsBefore = await cluster.ledger.listEvents();
            const cmd = await kernel.proposeMutation({
                verb: 'update_entity',
                targetStore: 'canonical',
                payload: { entityId: entity.id, patch: { attributes: { confidence: 'proven' } } },
                proposedBy: 'operator',
            });
            const eventsAfter = await cluster.ledger.listEvents();
            expect(eventsAfter).toEqual(eventsBefore);
            expect(cmd.status).toBe('proposed');

            // 8. Validate + Commit (KERNEL-006: validation is now required)
            await kernel.validateMutation(cmd.id);
            const { receipt } = await kernel.commitMutation(cmd.id, 'operator');
            expect(receipt.commandId).toBe(cmd.id);

            // 9. Receipts account for full lifecycle
            const allReceipts = await kernel.listReceipts();
            expect(allReceipts.length).toBeGreaterThanOrEqual(4);

            // 10. Provenance missing fails honestly for unknown IDs
            await expect(
                kernel.traceProvenance('nonexistent-xyz'),
            ).rejects.toThrow(ProvenanceMissingError);
        });
    });
});
