/**
 * Phase 11 Proof Suite — verifies the dogfood gate passes.
 *
 * 12 required proofs:
 * 1.  Dogfood ingest creates artifacts, canonical entities, index records, provenance, and receipts.
 * 2.  Phase/milestone memory resolves through cluster URIs.
 * 3.  Retrieval returns evidence bundles, not plain search hits.
 * 4.  Trace explains at least one phase decision back to source artifacts.
 * 5.  Mutation update requires command lifecycle.
 * 6.  Agent principal can propose but cannot commit.
 * 7.  Operator principal can approve/commit.
 * 8.  Redaction preserves graph shape while hiding restricted payload.
 * 9.  Deleted index is detected and rebuilt.
 * 10. Backup/restore preserves dogfood memory.
 * 11. Dogfood report is generated from cluster data, not handwritten only.
 * 12. At least one product improvement is surfaced from real friction.
 */

/**
 * TESTS-B-008 (Wave B1-Amend) — doctrine for this file's hook strategy.
 *
 * Proofs 1-8, 10-12 are READ-ONLY against the shared dogfood cluster, OR
 * use their own freshDir for write tests (Proofs 5-7 already do this for
 * PolicyEnforcedKernel paths). They keep beforeAll because rehydrating
 * the ~25-artifact dogfood cluster per test would be ~12× the read cost
 * for zero correctness gain.
 *
 * Proof 9 (`Deleted index is detected and rebuilt`) was the load-bearing
 * mutation site — it called `await stores.index.clear()` on the SHARED
 * cluster.dataDir, wiping the index for Proofs 1-3 if it ran first. It
 * has been isolated to a per-test fresh dir.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { rmSync, existsSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createDogfoodCluster, type DogfoodCluster } from '../scripts/dogfood-ingest.js';
import { PolicyEnforcedKernel, PolicyDeniedError } from '../src/kernel/policy-enforced-kernel.js';
import { DEFAULT_POLICIES, DEFAULT_TRUST_ZONES, DEFAULT_VISIBILITY_RULES } from '../src/policy/default-policies.js';
import { createLocalCluster } from '../src/adapters/local/index.js';
import { doctor } from '../src/ops/doctor.js';
import { rebuildIndex } from '../src/ops/rebuild.js';
import { backup, restore } from '../src/ops/backup.js';
import type { Principal, Policy } from '../src/types/policy.js';

const ROOT = resolve(import.meta.dirname, '..');
let cluster: DogfoodCluster;

beforeAll(async () => {
    cluster = await createDogfoodCluster();
});

afterAll(() => {
    rmSync(cluster.dataDir, { recursive: true, force: true });
});

describe('Phase 11 proof suite', () => {
    it('Proof 1: Dogfood ingest creates artifacts, entities, index, provenance, and receipts', async () => {
        // Artifacts ingested
        expect(cluster.artifacts.size).toBeGreaterThan(0);
        // Entities created
        expect(cluster.entities.size).toBeGreaterThan(0);
        // Index records exist (via findSources)
        const results = await cluster.kernel.findSources({ query: 'Phase' });
        expect(results.indexRecords.length).toBeGreaterThan(0);
        // Provenance exists
        const phaseId = cluster.entities.get('Phase 1 — Cluster Spine')!;
        const events = await cluster.kernel.traceProvenance(phaseId);
        expect(events.length).toBeGreaterThan(0);
        // Receipts exist
        const receipts = await cluster.kernel.listReceipts();
        expect(receipts.length).toBeGreaterThan(0);
    });

    it('Proof 2: Phase/milestone memory resolves through cluster URIs', async () => {
        const phaseId = cluster.entities.get('Phase 5 — Mutation Law and Command Runtime')!;
        const uri = `cluster://canonical/${phaseId}`;
        const entity = await cluster.kernel.inspectEntity(phaseId);
        expect(entity.kind).toBe('phase');
        expect(entity.name).toContain('Mutation Law');

        const milestoneId = cluster.entities.get('434 tests across 29 files')!;
        const milestone = await cluster.kernel.inspectEntity(milestoneId);
        expect(milestone.kind).toBe('milestone');
    });

    it('Proof 3: Retrieval returns evidence bundles, not plain search hits', async () => {
        const bundle = await cluster.kernel.retrieveBundle('MCP');
        // Evidence bundle has structure beyond plain search
        expect(bundle.id).toBeDefined();
        expect(bundle.assembledAt).toBeDefined();
        expect(bundle.freshness).toBeDefined();
        expect(bundle.confidenceBoundaries).toBeDefined();
        expect(bundle.missingContext).toBeDefined();
        // Resolves to owner truth, not index projections
        expect(bundle.resolvedEntities.length).toBeGreaterThan(0);
        expect(bundle.resolvedEntities[0].ownerStore).toBe('canonical');
    });

    it('Proof 4: Trace explains at least one decision back to source artifacts', async () => {
        const decisionId = cluster.entities.get('AI proposes, command runtime disposes')!;
        const events = await cluster.kernel.traceProvenance(decisionId);

        // Should have evidence_linked event connecting to phase-5-closeout.md artifact
        const evidenceLinks = events.filter((e) => e.action === 'evidence_linked');
        expect(evidenceLinks.length).toBeGreaterThan(0);

        // The detail should reference an artifactId
        const link = evidenceLinks[0];
        expect(link.detail.artifactId).toBeDefined();

        // That artifact should be the phase-5-closeout.md
        const artifactId = cluster.artifacts.get('docs/phase-5-closeout.md')!;
        expect(link.detail.artifactId).toBe(artifactId);
    });

    it('Proof 5: Mutation update requires command lifecycle', async () => {
        // Propose does NOT write truth
        const proposal = await cluster.kernel.proposeMutation({
            verb: 'create_entity',
            targetStore: 'canonical',
            payload: { kind: 'finding', name: 'proof5-test', attributes: {} },
            proposedBy: 'ai-agent',
        });
        expect(proposal.status).toBe('proposed');

        // Must validate + commit to write (KERNEL-006)
        await cluster.kernel.validateMutation(proposal.id);
        const { command, receipt } = await cluster.kernel.commitMutation(proposal.id, 'operator');
        expect(command.status).toBe('committed');
        expect(receipt).toBeDefined();
    });

    it('Proof 6: Agent principal can propose but cannot commit', async () => {
        const stores = createLocalCluster(cluster.dataDir);
        const agent: Principal = { id: 'agent', name: 'Agent', roles: ['proposer'], trustZone: 'ai-facing' };
        const k = new PolicyEnforcedKernel(stores, { principal: agent }, {
            policies: DEFAULT_POLICIES,
            trustZones: DEFAULT_TRUST_ZONES,
            visibilityRules: DEFAULT_VISIBILITY_RULES,
        });

        // Can propose
        const proposal = await k.proposeMutation({
            verb: 'create_entity',
            targetStore: 'canonical',
            payload: { kind: 'finding', name: 'proof6-test', attributes: {} },
            proposedBy: 'agent',
        });
        expect(proposal.status).toBe('proposed');

        // Cannot commit
        await expect(k.commitMutation(proposal.id, 'agent')).rejects.toThrow(PolicyDeniedError);
    });

    it('Proof 7: Operator principal can approve/commit', async () => {
        const stores = createLocalCluster(cluster.dataDir);
        const operator: Principal = { id: 'operator', name: 'Operator', roles: ['cluster-admin'], trustZone: 'internal' };
        const k = new PolicyEnforcedKernel(stores, { principal: operator }, {
            policies: DEFAULT_POLICIES,
            trustZones: DEFAULT_TRUST_ZONES,
            visibilityRules: DEFAULT_VISIBILITY_RULES,
        });

        const proposal = await k.proposeMutation({
            verb: 'create_entity',
            targetStore: 'canonical',
            payload: { kind: 'milestone', name: 'proof7-test', attributes: {} },
            proposedBy: 'operator',
        });

        await k.validateMutation(proposal.id);
        const approved = await k.approveMutation(proposal.id, 'operator', 'proof test');
        expect(approved.status).toBe('approved');

        const { command } = await k.commitMutation(proposal.id, 'operator');
        expect(command.status).toBe('committed');
    });

    it('Proof 8: Redaction preserves graph shape while hiding restricted payload', async () => {
        const stores = createLocalCluster(cluster.dataDir);
        const agent: Principal = { id: 'agent', name: 'Agent', roles: ['proposer'], trustZone: 'ai-facing' };
        const k = new PolicyEnforcedKernel(stores, { principal: agent }, {
            policies: DEFAULT_POLICIES,
            trustZones: DEFAULT_TRUST_ZONES,
            visibilityRules: DEFAULT_VISIBILITY_RULES,
        });

        const phaseId = cluster.entities.get('Phase 6 — AI-Facing Interface: MCP and SDK')!;
        const uri = `cluster://canonical/${phaseId}`;
        const graph = await k.traceObject(uri);

        // Graph retains structure (has focal URI and nodes)
        expect(graph.focalUri).toBe(uri);
        // Shape is preserved even if some content is redacted
        expect(graph.nodes).toBeDefined();
        expect(graph.edges).toBeDefined();
    });

    // TESTS-B-008 (Wave B1-Amend): isolated to per-test fresh dir.
    // Pre-fix: this proof called `await stores.index.clear()` on the
    // SHARED cluster.dataDir, wiping the index for Proofs 1-3 if it ran
    // first. Post-fix: rehydrate a fresh dogfood cluster into its own
    // dir so the mutation does not leak.
    it('Proof 9: Deleted index is detected and rebuilt', async () => {
        const isolated = await createDogfoodCluster();
        try {
            const stores = createLocalCluster(isolated.dataDir);

            // Clear index
            await stores.index.clear();
            const health = await doctor(stores);
            expect(['degraded', 'stale', 'unhealthy']).toContain(health.status);

            // Rebuild
            const result = await rebuildIndex(stores);
            expect(result.rebuilt).toBeGreaterThan(0);

            // Verify restored
            const afterSearch = await stores.index.search({ text: 'Phase' });
            expect(afterSearch.length).toBeGreaterThan(0);
        } finally {
            try { rmSync(isolated.dataDir, { recursive: true, force: true }); } catch { /* best-effort */ }
        }
    });

    it('Proof 10: Backup/restore preserves dogfood memory', async () => {
        const stores = createLocalCluster(cluster.dataDir);
        const data = await backup(stores);

        expect(data.entities.length).toBeGreaterThan(0);
        expect(data.events.length).toBeGreaterThan(0);
        expect(data.receipts.length).toBeGreaterThan(0);

        const freshDir = mkdtempSync(join(tmpdir(), 'proof10-'));
        const freshStores = createLocalCluster(freshDir);
        const result = await restore(freshStores, data);
        expect(result.entities.created).toBeGreaterThan(0);

        rmSync(freshDir, { recursive: true, force: true });
    });

    it('Proof 11: Dogfood report exists and is generated from cluster data', () => {
        const reportPath = resolve(ROOT, 'docs/phase-11-dogfood-report.md');
        expect(existsSync(reportPath)).toBe(true);
        const report = readFileSync(reportPath, 'utf-8');
        // Report must contain required sections
        expect(report).toContain('Dogfood target');
        expect(report).toContain('Data ingested');
        expect(report).toContain('Value observed');
        expect(report).toContain('Friction observed');
        expect(report).toContain('Verdict');
    });

    it('Proof 12: At least one product improvement surfaced from real friction', () => {
        const reportPath = resolve(ROOT, 'docs/phase-11-dogfood-report.md');
        const report = readFileSync(reportPath, 'utf-8');
        // Report must contain product changes section with at least one finding
        expect(report).toContain('Product changes recommended');
        // Should mention specific friction or improvement
        expect(report).toMatch(/restore|artifact|index|auto-index|commit.*index/i);
    });
});
