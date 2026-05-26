/**
 * Dogfood ingestion script — db-cluster ingests its own project history.
 *
 * Artifacts: README.md, CHANGELOG.md, phase closeout docs
 * Canonical entities: project, phases, decisions, milestones, findings
 * Provenance: links decisions/findings to source artifacts
 * Receipts: every operation produces a receipt
 *
 * Usage: npx tsx scripts/dogfood-ingest.ts
 */

import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createLocalCluster } from '../src/adapters/local/index.js';
import { ClusterKernel } from '../src/kernel/cluster-kernel.js';

const ROOT = resolve(import.meta.dirname, '..');

export interface DogfoodCluster {
    kernel: ClusterKernel;
    dataDir: string;
    artifacts: Map<string, string>; // filename → artifact ID
    entities: Map<string, string>;  // name → entity ID
}

/**
 * Create and populate a dogfood cluster with db-cluster's own project memory.
 * Exported so tests can use it.
 */
export async function createDogfoodCluster(options?: { dataDir?: string }): Promise<DogfoodCluster> {
    const dataDir = options?.dataDir ?? mkdtempSync(join(tmpdir(), 'dogfood-'));
    const stores = createLocalCluster(dataDir);
    const kernel = new ClusterKernel(stores, { dataDir });
    const artifacts = new Map<string, string>();
    const entities = new Map<string, string>();

    const actorId = 'dogfood-ingest';

    // ─── Ingest artifacts ──────────────────────────────────────────────

    const artifactFiles = [
        { path: 'README.md', kind: 'readme' },
        { path: 'CHANGELOG.md', kind: 'changelog' },
        { path: 'docs/phase-1-closeout.md', kind: 'closeout_doc' },
        { path: 'docs/phase-2-closeout.md', kind: 'closeout_doc' },
        { path: 'docs/phase-3-closeout.md', kind: 'closeout_doc' },
        { path: 'docs/phase-4-closeout.md', kind: 'closeout_doc' },
        { path: 'docs/phase-5-closeout.md', kind: 'closeout_doc' },
        { path: 'docs/phase-6-closeout.md', kind: 'closeout_doc' },
        { path: 'docs/phase-7-closeout.md', kind: 'closeout_doc' },
        { path: 'docs/phase-8-closeout.md', kind: 'closeout_doc' },
        { path: 'docs/phase-9-closeout.md', kind: 'closeout_doc' },
        { path: 'docs/phase-10-closeout.md', kind: 'closeout_doc' },
    ];

    console.log('=== Ingesting artifacts ===');
    for (const file of artifactFiles) {
        const fullPath = resolve(ROOT, file.path);
        if (!existsSync(fullPath)) {
            console.log(`  SKIP: ${file.path} (not found)`);
            continue;
        }
        const content = readFileSync(fullPath);
        const result = await kernel.ingestArtifact({
            filename: file.path,
            content,
            mimeType: 'text/markdown',
            actorId,
        });
        artifacts.set(file.path, result.artifact.id);
        console.log(`  OK: ${file.path} → ${result.artifact.id}`);
    }

    // ─── Create canonical entities ─────────────────────────────────────

    console.log('\n=== Creating canonical entities ===');

    // Project
    const project = await kernel.createEntity({
        kind: 'project',
        name: 'db-cluster',
        attributes: {
            description: 'AI-native federated database cluster',
            repo: 'mcp-tool-shop-org/db-cluster',
            status: 'Phase 10 complete',
        },
        actorId,
    });
    entities.set('db-cluster', project.entity.id);
    console.log(`  Project: ${project.entity.name} → ${project.entity.id}`);

    // Phases
    const phases = [
        { name: 'Phase 1 — Cluster Spine', tag: 'phase-1' },
        { name: 'Phase 2 — Cross-Store Identity and Rebuildable Index', tag: 'phase-2' },
        { name: 'Phase 3 — Retrieval Planner and Evidence Bundles', tag: 'phase-3' },
        { name: 'Phase 4 — Provenance Graph and Trace Surface', tag: 'phase-4' },
        { name: 'Phase 5 — Mutation Law and Command Runtime', tag: 'phase-5' },
        { name: 'Phase 6 — AI-Facing Interface: MCP and SDK', tag: 'phase-6' },
        { name: 'Phase 7 — Policy, Permissions, and Trust Boundaries', tag: 'phase-7' },
        { name: 'Phase 8 — Physical Store Expansion', tag: 'phase-8' },
        { name: 'Phase 9 — Operations, Rebuild, and Recovery', tag: 'phase-9-operations-recovery' },
        { name: 'Phase 10 — Developer Product Surface', tag: 'phase-10-developer-product-surface' },
    ];

    for (const phase of phases) {
        const result = await kernel.createEntity({
            kind: 'phase',
            name: phase.name,
            attributes: { status: 'closed', tag: phase.tag },
            actorId,
        });
        entities.set(phase.name, result.entity.id);
        console.log(`  Phase: ${phase.name} → ${result.entity.id}`);
    }

    // Decisions
    const decisions = [
        { name: 'Cluster is the product', supported_by: 'README.md' },
        { name: 'Index is derivative', supported_by: 'docs/phase-2-closeout.md' },
        { name: 'AI proposes, command runtime disposes', supported_by: 'docs/phase-5-closeout.md' },
        { name: 'Every fact has an owner store', supported_by: 'README.md' },
        { name: 'Policy cannot weaken existing guarantees', supported_by: 'docs/phase-7-closeout.md' },
        { name: 'Operational state is explicit', supported_by: 'docs/phase-9-closeout.md' },
    ];

    for (const decision of decisions) {
        const result = await kernel.createEntity({
            kind: 'decision',
            name: decision.name,
            attributes: { supported_by: decision.supported_by },
            actorId,
        });
        entities.set(decision.name, result.entity.id);
        console.log(`  Decision: ${decision.name} → ${result.entity.id}`);
    }

    // Milestones
    const milestones = [
        { name: '434 tests across 29 files', tag: 'phase-10-developer-product-surface' },
        { name: '399 tests across 26 files', tag: 'phase-9-operations-recovery' },
    ];

    for (const ms of milestones) {
        const result = await kernel.createEntity({
            kind: 'milestone',
            name: ms.name,
            attributes: { tag: ms.tag },
            actorId,
        });
        entities.set(ms.name, result.entity.id);
        console.log(`  Milestone: ${ms.name} → ${result.entity.id}`);
    }

    // Findings
    const findings = [
        { name: 'Index is always rebuildable from owner truth', observed_in: 'docs/phase-9-closeout.md' },
        { name: 'MCP tools expose cluster thesis without dumbing it down', observed_in: 'docs/phase-6-closeout.md' },
        { name: 'Policy sits above cluster law, never weakens it', observed_in: 'docs/phase-7-closeout.md' },
    ];

    for (const finding of findings) {
        const result = await kernel.createEntity({
            kind: 'finding',
            name: finding.name,
            attributes: { observed_in: finding.observed_in },
            actorId,
        });
        entities.set(finding.name, result.entity.id);
        console.log(`  Finding: ${finding.name} → ${result.entity.id}`);
    }

    // ─── Link evidence (provenance edges) ──────────────────────────────

    console.log('\n=== Linking evidence ===');

    // Link phase closeout docs to phases
    for (let i = 0; i < phases.length; i++) {
        const closeoutPath = `docs/phase-${i + 1}-closeout.md`;
        const artifactId = artifacts.get(closeoutPath);
        const entityId = entities.get(phases[i].name);
        if (artifactId && entityId) {
            await kernel.linkEvidence({
                artifactId,
                entityId,
                actorId,
                detail: { edge: 'phase_closed_by' },
            });
            console.log(`  ${phases[i].name} ← ${closeoutPath}`);
        }
    }

    // Link decisions to supporting artifacts
    for (const decision of decisions) {
        const artifactId = artifacts.get(decision.supported_by);
        const entityId = entities.get(decision.name);
        if (artifactId && entityId) {
            await kernel.linkEvidence({
                artifactId,
                entityId,
                actorId,
                detail: { edge: 'decision_supported_by' },
            });
            console.log(`  "${decision.name}" ← ${decision.supported_by}`);
        }
    }

    // Link findings to observed-in artifacts
    for (const finding of findings) {
        const artifactId = artifacts.get(finding.observed_in);
        const entityId = entities.get(finding.name);
        if (artifactId && entityId) {
            await kernel.linkEvidence({
                artifactId,
                entityId,
                actorId,
                detail: { edge: 'finding_observed_in' },
            });
            console.log(`  "${finding.name}" ← ${finding.observed_in}`);
        }
    }

    console.log('\n=== Dogfood ingestion complete ===');
    console.log(`  Artifacts: ${artifacts.size}`);
    console.log(`  Entities: ${entities.size}`);
    console.log(`  Data dir: ${dataDir}`);

    return { kernel, dataDir, artifacts, entities };
}

// ─── CLI entry point ───────────────────────────────────────────────────────

if (import.meta.url === `file:///${resolve(process.argv[1]).replace(/\\/g, '/')}`) {
    createDogfoodCluster().catch(console.error);
}
