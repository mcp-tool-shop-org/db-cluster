/**
 * Example: Research Evidence Cluster
 *
 * A research team stores papers, claims, and source notes.
 * The cluster proves: retrieve evidence bundle, trace claim to artifact,
 * stale index detection via doctor().
 *
 * Uses: artifact store (papers), canonical store (claims/topics/sources),
 *       index store (discovery), ledger store (provenance + receipts).
 */

import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClusterSDK } from '@mcptoolshop/db-cluster/sdk';
import { doctor } from '@mcptoolshop/db-cluster';
// Raw stores come from the explicit /unsafe escape hatch (KERNEL-001): the
// package root no longer exports the raw factories. This example builds raw
// stores purely to hand them to the standalone ops (operator-tooling use).
import { createLocalCluster } from '@mcptoolshop/db-cluster/unsafe';

async function main() {
    const dataDir = mkdtempSync(join(tmpdir(), 'research-cluster-'));
    const sdk = new ClusterSDK({ clusterDir: dataDir });

    console.log('=== Research Evidence Cluster ===\n');

    async function ingest(filename: string, content: string, mimeType: string) {
        // Wave A4 fix-up: ingest_artifact propose requires `contentHash` for
        // staging-area integrity (KERNEL-B-007). Pre-hash the Buffer once.
        const contentBuf = Buffer.from(content);
        const contentHash = createHash('sha256').update(contentBuf).digest('hex');
        const cmd = await sdk.proposeMutation({
            verb: 'ingest_artifact',
            targetStore: 'artifact',
            payload: { filename, content: contentBuf, mimeType, contentHash },
            proposedBy: 'researcher',
        });
        await sdk.validateMutation(cmd.id);
        await sdk.approveMutation(cmd.id, 'researcher-approver', 'auto-approved in example');
        const { receipt } = await sdk.commitMutation(cmd.id, 'researcher');
        return receipt.affectedIds[0];
    }

    async function createClaim(name: string, attributes: Record<string, unknown>) {
        const cmd = await sdk.proposeMutation({
            verb: 'create_entity',
            targetStore: 'canonical',
            payload: { kind: 'claim', name, attributes },
            proposedBy: 'researcher',
        });
        await sdk.validateMutation(cmd.id);
        await sdk.approveMutation(cmd.id, 'researcher-approver', 'auto-approved in example');
        const { receipt } = await sdk.commitMutation(cmd.id, 'researcher');
        return receipt.affectedIds[0];
    }

    // Ingest research papers (artifacts)
    const paper1Id = await ingest(
        'smith-2025-ai-safety.pdf',
        'Smith et al. 2025: AI systems require structured mutation boundaries to prevent unauthorized state changes.',
        'application/pdf',
    );

    const paper2Id = await ingest(
        'chen-2024-provenance.pdf',
        'Chen & Wang 2024: Provenance tracking reduces trust calibration errors by 40% in AI-assisted systems.',
        'application/pdf',
    );

    console.log('Papers ingested:', paper1Id, paper2Id);

    // Create claims
    const claim1Id = await createClaim('Mutation boundaries prevent unauthorized writes', {
        confidence: 'high',
        source: 'smith-2025',
        domain: 'safety',
    });

    const claim2Id = await createClaim('Provenance reduces trust calibration errors', {
        confidence: 'high',
        source: 'chen-2024',
        domain: 'trust',
    });

    // Create a topic via update_entity-style propose+commit is not needed —
    // a fresh create_entity command works here too.
    const topicCmd = await sdk.proposeMutation({
        verb: 'create_entity',
        targetStore: 'canonical',
        payload: {
            kind: 'topic',
            name: 'AI Database Safety',
            attributes: { relatedClaims: [claim1Id, claim2Id] },
        },
        proposedBy: 'researcher',
    });
    await sdk.validateMutation(topicCmd.id);
    await sdk.approveMutation(topicCmd.id, 'researcher-approver', 'auto-approved in example');
    const { receipt: topicReceipt } = await sdk.commitMutation(topicCmd.id, 'researcher');
    const topicId = topicReceipt.affectedIds[0];

    console.log('Claims created:', claim1Id, '|', claim2Id);
    console.log('Topic:', topicId);

    // Retrieve evidence bundle
    console.log('\n--- Retrieve: "safety mutation" ---');
    const bundle = await sdk.retrieveBundle('safety mutation');
    console.log('Entities:', bundle.resolvedEntities.length);
    console.log('Artifacts:', bundle.resolvedArtifacts.length);
    console.log('All fresh:', bundle.freshness.allFresh);

    // Trace claim to source artifact
    console.log('\n--- Trace claim provenance ---');
    const graph = await sdk.traceObject(`cluster://canonical/${claim1Id}`);
    console.log('Provenance nodes:', graph.nodes.length);
    for (const node of graph.nodes) {
        console.log(`  ${node.label} (${node.uri})`);
    }

    // Demonstrate stale index detection via the ops layer (doctor reads stores directly).
    console.log('\n--- Stale index detection ---');
    const stores = createLocalCluster(dataDir);
    await stores.index.clear();
    const health = await doctor(stores);
    console.log('After index wipe, doctor says:', health.status);
    const indexCheck = health.checks.find((c) => c.name === 'index_populated');
    console.log('Index check:', indexCheck?.message);
    console.log('Repair available:', indexCheck?.repairAvailable);

    // Cleanup
    rmSync(dataDir, { recursive: true, force: true });
    console.log('\nDone.');
}

main().catch(console.error);
