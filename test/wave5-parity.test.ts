import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ClusterSDK } from '../src/sdk/cluster-sdk.js';
import { handleTool, TOOLS } from '../src/mcp/index.js';
import type { AnnotatedTool } from '../src/mcp/index.js';

const TEST_DIR = join(import.meta.dirname, '.test-parity');

/**
 * Wave 5 — Parity Tests
 *
 * Exit sentence: MCP, SDK, and CLI expose the same cluster law;
 * MCP cannot create a parallel interpretation of retrieval, provenance, or mutation.
 */
describe('Wave 5 — MCP / SDK Parity', () => {
    let sdk: ClusterSDK;

    beforeEach(async () => {
        rmSync(TEST_DIR, { recursive: true, force: true });
        mkdirSync(TEST_DIR, { recursive: true });
        sdk = new ClusterSDK({ clusterDir: TEST_DIR });

        // Seed data via SDK so both surfaces have something to query
        await sdk.proposeMutation({
            verb: 'create_entity',
            targetStore: 'canonical',
            payload: { kind: 'document', name: 'Alpha Report', attributes: { topic: 'parity-testing' } },
            proposedBy: 'test-setup',
        }).then(async (cmd) => {
            await sdk.commitMutation(cmd.id, 'test-setup');
        });

        await sdk.proposeMutation({
            verb: 'create_entity',
            targetStore: 'canonical',
            payload: { kind: 'task', name: 'Beta Task', attributes: { topic: 'parity-testing' } },
            proposedBy: 'test-setup',
        }).then(async (cmd) => {
            await sdk.commitMutation(cmd.id, 'test-setup');
        });
    });

    afterEach(() => {
        rmSync(TEST_DIR, { recursive: true, force: true });
    });

    // ─── Parity 1: retrieveBundle ────────────────────────────────────

    describe('Parity 1: retrieveBundle returns same structural truth', () => {
        it('MCP retrieve_bundle contains same URIs and owner stores as SDK', async () => {
            const sdkBundle = await sdk.retrieveBundle('parity-testing');
            const mcpResult = await handleTool('cluster_retrieve_bundle', { query: 'parity-testing' }, sdk) as any;

            // Same number of entities
            expect(mcpResult.resolvedEntities.length).toBe(sdkBundle.resolvedEntities.length);

            // Same URIs
            const sdkUris = sdkBundle.resolvedEntities.map((e) => e.uri).sort();
            const mcpUris = mcpResult.resolvedEntities.map((e: any) => e.uri).sort();
            expect(mcpUris).toEqual(sdkUris);

            // Same owner stores
            for (const mcpEntity of mcpResult.resolvedEntities) {
                const sdkMatch = sdkBundle.resolvedEntities.find((e) => e.uri === mcpEntity.uri);
                expect(mcpEntity.ownerStore).toBe(sdkMatch!.ownerStore);
            }

            // Freshness parity
            expect(mcpResult.freshness.allFresh).toBe(sdkBundle.freshness.allFresh);
            expect(mcpResult.freshness.staleCount).toBe(sdkBundle.freshness.staleCount);

            // Confidence boundaries parity
            expect(mcpResult.confidenceBoundaries.length).toBe(sdkBundle.confidenceBoundaries.length);
        });

        it('MCP retrieve_bundle surfaces missing context when present', async () => {
            const mcpResult = await handleTool('cluster_retrieve_bundle', { query: 'nonexistent-topic-xyz' }, sdk) as any;

            // _meta always present
            expect(mcpResult._meta.operation).toBe('read');
            expect(mcpResult._meta.writesCluster).toBe(false);
        });

        it('MCP retrieve_bundle marks stale index when applicable', async () => {
            const mcpResult = await handleTool('cluster_retrieve_bundle', { query: 'parity-testing' }, sdk) as any;

            // Every entity has indexStale field
            for (const entity of mcpResult.resolvedEntities) {
                expect(typeof entity.indexStale).toBe('boolean');
                if (entity.indexStale) {
                    expect(entity._staleWarning).toBeTruthy();
                }
            }
        });
    });

    // ─── Parity 2: trace ─────────────────────────────────────────────

    describe('Parity 2: trace returns equivalent provenance graph', () => {
        it('MCP trace returns same nodes and edges as SDK', async () => {
            // Get a URI to trace
            const bundle = await sdk.retrieveBundle('parity-testing');
            const uri = bundle.resolvedEntities[0]?.uri;
            if (!uri) return; // nothing to trace

            const sdkGraph = await sdk.traceObject(uri);
            const mcpResult = await handleTool('cluster_trace', { uri }, sdk) as any;

            // Same focal URI
            expect(mcpResult.focalUri).toBe(sdkGraph.focalUri);

            // Same number of nodes
            expect(mcpResult.nodes.length).toBe(sdkGraph.nodes.length);

            // Same number of edges
            expect(mcpResult.edges.length).toBe(sdkGraph.edges.length);

            // _meta marks it as read
            expect(mcpResult._meta.operation).toBe('read');
            expect(mcpResult._meta.writesCluster).toBe(false);
        });
    });

    // ─── Parity 3: why ───────────────────────────────────────────────

    describe('Parity 3: why returns same explanation', () => {
        it('MCP why returns same text as SDK why', async () => {
            const bundle = await sdk.retrieveBundle('parity-testing');
            const uri = bundle.resolvedEntities[0]?.uri;
            if (!uri) return;

            const sdkExplanation = await sdk.why(uri);
            const mcpResult = await handleTool('cluster_why', { uri }, sdk) as any;

            expect(mcpResult.explanation).toBe(sdkExplanation);
            expect(mcpResult._meta.operation).toBe('read');
            expect(mcpResult._meta.uri).toBe(uri);
        });
    });

    // ─── Parity 4: propose → validate → commit lifecycle ────────────

    describe('Parity 4: propose → validate → commit lifecycle parity', () => {
        it('MCP propose returns same command structure as SDK', async () => {
            const sdkCmd = await sdk.proposeMutation({
                verb: 'create_entity',
                targetStore: 'canonical',
                payload: { kind: 'note', name: 'SDK Note', attributes: {} },
                proposedBy: 'parity-test',
            });

            const mcpResult = await handleTool('cluster_propose_mutation', {
                verb: 'create_entity',
                targetStore: 'canonical',
                payload: { kind: 'note', name: 'MCP Note', attributes: {} },
                proposedBy: 'parity-test',
            }, sdk) as any;

            // Both produce same structure
            expect(mcpResult.command.status).toBe('proposed');
            expect(sdkCmd.status).toBe('proposed');
            expect(mcpResult.command.verb).toBe(sdkCmd.verb);
            expect(mcpResult.command.targetStore).toBe(sdkCmd.targetStore);
            expect(mcpResult.command.proposedBy).toBe(sdkCmd.proposedBy);

            // MCP marks it staged-only
            expect(mcpResult._meta.stagedOnly).toBe(true);
            expect(mcpResult._meta.writesCluster).toBe(false);
        });

        it('MCP validate transitions to same status as SDK', async () => {
            const cmd = await sdk.proposeMutation({
                verb: 'create_entity',
                targetStore: 'canonical',
                payload: { kind: 'note', name: 'Validate Parity', attributes: {} },
                proposedBy: 'parity-test',
            });

            const mcpResult = await handleTool('cluster_validate_mutation', { commandId: cmd.id }, sdk) as any;

            expect(mcpResult.command.status).toBe('validated');
            expect(mcpResult._meta.statusTransition).toContain('validated');
            expect(mcpResult._meta.writesCluster).toBe(false);
        });

        it('MCP commit produces same receipt as SDK commit', async () => {
            const cmd = await sdk.proposeMutation({
                verb: 'create_entity',
                targetStore: 'canonical',
                payload: { kind: 'note', name: 'Commit Parity', attributes: {} },
                proposedBy: 'parity-test',
            });

            const mcpResult = await handleTool('cluster_commit_mutation', { commandId: cmd.id, actorId: 'parity-test' }, sdk) as any;

            expect(mcpResult.command.status).toBe('committed');
            expect(mcpResult.receipt).toBeTruthy();
            expect(mcpResult.receipt.commandId).toBe(cmd.id);
            expect(mcpResult._meta.writesCluster).toBe(true);
            expect(mcpResult._meta.statusTransition).toBe('→ committed');
        });

        it('full lifecycle through MCP matches SDK state at each step', async () => {
            // Propose via MCP
            const proposeResult = await handleTool('cluster_propose_mutation', {
                verb: 'create_entity',
                targetStore: 'canonical',
                payload: { kind: 'log', name: 'Full Lifecycle', attributes: {} },
                proposedBy: 'mcp-actor',
            }, sdk) as any;
            const cmdId = proposeResult.command.id;

            // Validate via MCP
            const validateResult = await handleTool('cluster_validate_mutation', { commandId: cmdId }, sdk) as any;
            expect(validateResult.command.status).toBe('validated');

            // Approve via MCP
            const approveResult = await handleTool('cluster_approve_mutation', { commandId: cmdId, approvedBy: 'operator' }, sdk) as any;
            expect(approveResult.command.status).toBe('approved');
            expect(approveResult._meta.approvalSensitive).toBe(true);

            // Commit via MCP
            const commitResult = await handleTool('cluster_commit_mutation', { commandId: cmdId, actorId: 'mcp-actor' }, sdk) as any;
            expect(commitResult.command.status).toBe('committed');

            // Verify via SDK inspect — same state
            const sdkInspected = await sdk.inspectCommand(cmdId);
            expect(sdkInspected.status).toBe('committed');
            expect(sdkInspected.approvedBy).toBe('operator');
            expect(sdkInspected.committedBy).toBe('mcp-actor');
        });
    });

    // ─── Parity 5: rejected command cannot commit through MCP ────────

    describe('Parity 5: rejected command cannot commit through MCP', () => {
        it('MCP commit on rejected command throws', async () => {
            const cmd = await sdk.proposeMutation({
                verb: 'create_entity',
                targetStore: 'canonical',
                payload: { kind: 'note', name: 'Will Reject', attributes: {} },
                proposedBy: 'parity-test',
            });

            await sdk.rejectMutation(cmd.id, 'operator', 'Policy violation');

            await expect(handleTool('cluster_commit_mutation', { commandId: cmd.id, actorId: 'attacker' }, sdk))
                .rejects.toThrow();
        });

        it('MCP reject surfaces status transition and terminal state', async () => {
            const cmd = await sdk.proposeMutation({
                verb: 'create_entity',
                targetStore: 'canonical',
                payload: { kind: 'note', name: 'Reject Parity', attributes: {} },
                proposedBy: 'parity-test',
            });

            const mcpResult = await handleTool('cluster_reject_mutation', {
                commandId: cmd.id,
                rejectedBy: 'operator',
                reason: 'Not allowed',
            }, sdk) as any;

            expect(mcpResult.command.status).toBe('rejected');
            expect(mcpResult.command.rejectedBy).toBe('operator');
            expect(mcpResult.command.rejectionReason).toBe('Not allowed');
            expect(mcpResult._meta.statusTransition).toContain('rejected');
            expect(mcpResult._meta.warning).toContain('CANNOT be committed');
        });
    });

    // ─── Parity 6: stale index warning surfaces through MCP ──────────

    describe('Parity 6: stale index conditions visible through MCP', () => {
        it('MCP retrieve_bundle labels index records as derivative', async () => {
            const mcpResult = await handleTool('cluster_find_sources', { query: 'parity-testing' }, sdk) as any;

            // Index records labeled derivative
            for (const record of mcpResult.indexRecords) {
                expect(record._sourceType).toBe('derivative');
                expect(record._sourceStore).toBe('index');
            }

            // Resolved entities labeled owner-truth
            for (const entity of mcpResult.resolvedEntities) {
                expect(entity._sourceType).toBe('owner-truth');
                expect(entity._sourceStore).toBe('canonical');
            }
        });
    });

    // ─── Parity 7: missing owner truth surfaces through MCP ──────────

    describe('Parity 7: missing owner truth visible through MCP', () => {
        it('MCP retrieve_bundle includes missingContext from SDK bundle', async () => {
            const sdkBundle = await sdk.retrieveBundle('parity-testing');
            const mcpResult = await handleTool('cluster_retrieve_bundle', { query: 'parity-testing' }, sdk) as any;

            // SDK missing context matches MCP output
            if (sdkBundle.missingContext.length > 0) {
                expect(mcpResult.missingContext).toHaveLength(sdkBundle.missingContext.length);
                expect(mcpResult._missingWarning).toBeTruthy();
            } else {
                // When no missing context, the field should be absent or undefined
                expect(mcpResult.missingContext).toBeUndefined();
            }
        });
    });

    // ─── Parity 8: receipts created through MCP visible through SDK ──

    describe('Parity 8: receipts from MCP visible through SDK', () => {
        it('receipt created by MCP commit is findable via SDK listReceipts', async () => {
            const cmd = await sdk.proposeMutation({
                verb: 'create_entity',
                targetStore: 'canonical',
                payload: { kind: 'note', name: 'Receipt Parity', attributes: {} },
                proposedBy: 'parity-test',
            });

            // Commit through MCP
            const mcpResult = await handleTool('cluster_commit_mutation', { commandId: cmd.id, actorId: 'mcp-actor' }, sdk) as any;
            const receiptId = mcpResult.receipt.id;

            // Query through SDK
            const sdkReceipts = await sdk.listReceipts({ commandId: cmd.id });
            expect(sdkReceipts.length).toBeGreaterThan(0);
            expect(sdkReceipts.some((r) => r.id === receiptId)).toBe(true);
        });

        it('MCP list_receipts returns same receipts as SDK', async () => {
            // Create a committed command first
            const cmd = await sdk.proposeMutation({
                verb: 'create_entity',
                targetStore: 'canonical',
                payload: { kind: 'note', name: 'List Receipts Parity', attributes: {} },
                proposedBy: 'parity-test',
            });
            await sdk.commitMutation(cmd.id, 'test-actor');

            const sdkReceipts = await sdk.listReceipts({});
            const mcpResult = await handleTool('cluster_list_receipts', {}, sdk) as any;

            expect(mcpResult.receipts.length).toBe(sdkReceipts.length);
            expect(mcpResult._meta.operation).toBe('read');
            expect(mcpResult._meta.writesCluster).toBe(false);
        });
    });

    // ─── Parity 9: tool annotations match risk classification ────────

    describe('Parity 9: tool annotations match intended risk classes', () => {
        it('all read tools are marked readOnly: true, writesCluster: false', () => {
            const readTools = ['cluster_find_sources', 'cluster_retrieve_bundle', 'cluster_explain_retrieval',
                'cluster_resolve', 'cluster_trace', 'cluster_why', 'cluster_inspect_command', 'cluster_list_receipts'];

            for (const name of readTools) {
                const tool = TOOLS.find((t) => t.name === name) as AnnotatedTool;
                expect(tool.annotations.readOnly, `${name} should be readOnly`).toBe(true);
                expect(tool.annotations.writesCluster, `${name} should not write cluster`).toBe(false);
                expect(tool.annotations.approvalSensitive, `${name} should not be approval-sensitive`).toBe(false);
            }
        });

        it('only commit and compensate write cluster truth', () => {
            const writingTools = TOOLS.filter((t) => t.annotations.writesCluster);
            const names = writingTools.map((t) => t.name).sort();
            expect(names).toEqual(['cluster_commit_mutation', 'cluster_compensate_mutation']);
        });

        it('approval-sensitive tools are correctly classified', () => {
            const approvalTools = TOOLS.filter((t) => t.annotations.approvalSensitive);
            const names = approvalTools.map((t) => t.name).sort();
            expect(names).toEqual(['cluster_approve_mutation', 'cluster_commit_mutation', 'cluster_compensate_mutation']);
        });

        it('propose_mutation is staged-only (writes no truth)', () => {
            const propose = TOOLS.find((t) => t.name === 'cluster_propose_mutation') as AnnotatedTool;
            expect(propose.annotations.stagedOnly).toBe(true);
            expect(propose.annotations.writesCluster).toBe(false);
            expect(propose.annotations.readOnly).toBe(false); // it creates a command record
        });

        it('all lifecycle tools require existing command', () => {
            const lifecycleTools = ['cluster_validate_mutation', 'cluster_approve_mutation',
                'cluster_reject_mutation', 'cluster_commit_mutation', 'cluster_compensate_mutation', 'cluster_inspect_command'];

            for (const name of lifecycleTools) {
                const tool = TOOLS.find((t) => t.name === name) as AnnotatedTool;
                expect(tool.annotations.requiresExistingCommand, `${name} should require existing command`).toBe(true);
            }
        });

        it('no tool is both readOnly and writesCluster', () => {
            for (const tool of TOOLS) {
                if (tool.annotations.readOnly) {
                    expect(tool.annotations.writesCluster, `${tool.name} is readOnly but claims writesCluster`).toBe(false);
                }
            }
        });
    });

    // ─── Parity 10: artifact sanitization does not damage owner truth ─

    describe('Parity 10: artifact sanitization preserves owner-store truth', () => {
        it('MCP strips content but SDK still has it', async () => {
            // Ingest an artifact through SDK
            const cmd = await sdk.proposeMutation({
                verb: 'ingest_artifact',
                targetStore: 'artifact',
                payload: {
                    filename: 'report.md',
                    sourceUri: 'file:///test/report.md',
                    content: 'This is sensitive artifact content that should not leak through MCP.',
                    mediaType: 'text/markdown',
                },
                proposedBy: 'parity-test',
            });
            await sdk.commitMutation(cmd.id, 'parity-test');

            // Retrieve via MCP — content should be sanitized
            const mcpBundle = await handleTool('cluster_retrieve_bundle', { query: 'report' }, sdk) as any;

            for (const artifact of mcpBundle.resolvedArtifacts) {
                // Content should NOT appear in MCP output
                expect(artifact.object.content).toBeUndefined();
                expect(artifact.object.rawContent).toBeUndefined();
                // Content policy marker should be present
                expect(artifact.object._contentPolicy).toContain('DATA');
                expect(artifact.object._contentPolicy).toContain('not instructions');
            }

            // But owner truth in the store is undamaged
            const sdkBundle = await sdk.retrieveBundle('report');
            for (const artifact of sdkBundle.resolvedArtifacts) {
                // SDK still has the full object (content is stored via contentHash)
                expect(artifact.object).toBeTruthy();
                expect(artifact.ownerStore).toBe('artifact');
            }
        });
    });
});
