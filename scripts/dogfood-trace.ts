/**
 * Dogfood trace script — trace provenance for project memory objects.
 *
 * Demonstrates that every entity/artifact can be traced back to source truth.
 *
 * Usage: npx tsx scripts/dogfood-trace.ts
 */

import { createDogfoodCluster } from './dogfood-ingest.js';
import { rmSync } from 'node:fs';

async function main() {
    const cluster = await createDogfoodCluster();
    const { kernel, dataDir, entities, artifacts } = cluster;

    console.log('\n=== Dogfood Trace Tasks ===\n');

    // Trace Phase 6
    const phase6Id = entities.get('Phase 6 — AI-Facing Interface: MCP and SDK');
    if (phase6Id) {
        console.log('─── Trace: Phase 6 ───');
        const uri = `cluster://canonical/${phase6Id}`;
        const graph = await kernel.traceObject(uri);
        console.log(`  URI: ${uri}`);
        console.log(`  Root: ${graph.root.label}`);
        console.log(`  Nodes: ${graph.nodes.length}`);
        console.log(`  Edges: ${graph.edges.length}`);
        console.log(`  Warnings: ${graph.warnings.length}`);
        const why = await kernel.why(uri);
        console.log(`  Why: ${why}`);
        console.log('');
    }

    // Trace decision: "AI proposes, command runtime disposes"
    const decisionId = entities.get('AI proposes, command runtime disposes');
    if (decisionId) {
        console.log('─── Trace: Decision "AI proposes, command runtime disposes" ───');
        const uri = `cluster://canonical/${decisionId}`;
        const graph = await kernel.traceObject(uri);
        console.log(`  URI: ${uri}`);
        console.log(`  Root: ${graph.root.label}`);
        console.log(`  Nodes: ${graph.nodes.length}`);
        console.log(`  Edges: ${graph.edges.length}`);
        const why = await kernel.why(uri);
        console.log(`  Why: ${why}`);
        console.log('');
    }

    // Trace finding: "Index is derivative"
    const findingId = entities.get('Index is always rebuildable from owner truth');
    if (findingId) {
        console.log('─── Trace: Finding "Index is always rebuildable" ───');
        const uri = `cluster://canonical/${findingId}`;
        const graph = await kernel.traceObject(uri);
        console.log(`  URI: ${uri}`);
        console.log(`  Root: ${graph.root.label}`);
        console.log(`  Nodes: ${graph.nodes.length}`);
        console.log(`  Edges: ${graph.edges.length}`);
        const why = await kernel.why(uri);
        console.log(`  Why: ${why}`);
        console.log('');
    }

    // Trace artifact: phase-10-closeout.md
    const artifactId = artifacts.get('docs/phase-10-closeout.md');
    if (artifactId) {
        console.log('─── Trace: Artifact docs/phase-10-closeout.md ───');
        const uri = `cluster://artifact/${artifactId}`;
        const graph = await kernel.traceObject(uri);
        console.log(`  URI: ${uri}`);
        console.log(`  Root: ${graph.root.label}`);
        console.log(`  Nodes: ${graph.nodes.length}`);
        console.log(`  Edges: ${graph.edges.length}`);
        const why = await kernel.why(uri);
        console.log(`  Why: ${why}`);
        console.log('');
    }

    // Trace milestone
    const milestoneId = entities.get('434 tests across 29 files');
    if (milestoneId) {
        console.log('─── Trace: Milestone "434 tests across 29 files" ───');
        const uri = `cluster://canonical/${milestoneId}`;
        const graph = await kernel.traceObject(uri);
        console.log(`  URI: ${uri}`);
        console.log(`  Root: ${graph.root.label}`);
        console.log(`  Nodes: ${graph.nodes.length}`);
        console.log(`  Edges: ${graph.edges.length}`);
        const why = await kernel.why(uri);
        console.log(`  Why: ${why}`);
        console.log('');
    }

    rmSync(dataDir, { recursive: true, force: true });
}

main().catch(console.error);
