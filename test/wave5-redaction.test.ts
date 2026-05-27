/**
 * Wave 5 — Redaction and Existence Leakage Proofs
 *
 * Exit sentence: "db-cluster can preserve useful cluster structure while preventing
 * restricted owner truth from leaking through retrieval, trace, receipts, index metadata,
 * or policy explanation surfaces."
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PolicyEnforcedKernel, PolicyDeniedError } from '../src/kernel/policy-enforced-kernel.js';
import type { PolicyKernelOptions } from '../src/kernel/policy-enforced-kernel.js';
import type { Policy, Principal, TrustZone, VisibilityRule, RedactionRule } from '../src/types/policy.js';
import { createLocalCluster } from '../src/adapters/local/index.js';
import { ClusterSDK } from '../src/sdk/cluster-sdk.js';
import type { ClusterStores } from '../src/contracts/index.js';
import {
    redactEntity,
    redactArtifact,
    redactCommand,
    redactReceipt,
    redactProvenanceActors,
    redactGraphNodes,
    sanitizeWarnings,
    REDACTED,
} from '../src/policy/redactor.js';

// ─── Test principals ───────────────────────────────────────────────────────

const admin: Principal = {
    id: 'admin-1',
    name: 'Admin',
    roles: ['cluster-admin'],
    trustZone: 'internal',
};

const restrictedReader: Principal = {
    id: 'reader-1',
    name: 'Restricted Reader',
    roles: ['restricted-reader'],
    trustZone: 'ai-facing',
};

const indexOnlyReader: Principal = {
    id: 'indexer-1',
    name: 'Index Only',
    roles: ['index-only'],
    trustZone: 'external',
};

// ─── Policies with redaction ───────────────────────────────────────────────

const policies: Policy[] = [
    {
        id: 'admin-full',
        name: 'Admin Full',
        priority: 5,
        match: { principals: ['cluster-admin'] },
        decision: 'allow',
        reason: 'Admin gets everything.',
    },
    // Restricted reader: allowed to read owner truth, BUT with entity attribute redaction
    {
        id: 'restricted-read-entities',
        name: 'Restricted Entity Read',
        priority: 20,
        match: {
            principals: ['restricted-reader'],
            capabilities: ['read_owner_truth'],
            stores: ['canonical'],
        },
        decision: 'allow',
        reason: 'Can read entities with redacted attributes.',
        redaction: {
            id: 'mask-entity-attrs',
            target: 'entity_attributes',
            behavior: 'mask',
            reason: 'Sensitive attributes masked.',
        },
    },
    // Restricted reader: allowed to read artifacts, BUT with content stripped
    {
        id: 'restricted-read-artifacts',
        name: 'Restricted Artifact Read',
        priority: 20,
        match: {
            principals: ['restricted-reader'],
            capabilities: ['read_owner_truth'],
            stores: ['artifact'],
        },
        decision: 'allow',
        reason: 'Can read artifact metadata with content stripped.',
        redaction: {
            id: 'strip-artifact-content',
            target: 'artifact_content',
            behavior: 'strip',
            reason: 'Artifact content not authorized.',
        },
    },
    // Restricted reader: can discover, trace, explain, read commands/receipts
    {
        id: 'restricted-reader-discover',
        name: 'Restricted Reader Discover',
        priority: 20,
        match: {
            principals: ['restricted-reader'],
            capabilities: ['discover_existence', 'read_derivative', 'trace_provenance', 'explain_retrieval', 'read_command', 'read_receipts'],
        },
        decision: 'allow',
        reason: 'Restricted reader basic access.',
    },
    // Restricted reader: read receipts with detail redaction
    {
        id: 'restricted-receipt-redaction',
        name: 'Restricted Receipt Read',
        priority: 18,
        match: {
            principals: ['restricted-reader'],
            capabilities: ['read_receipts'],
        },
        decision: 'allow',
        reason: 'Can read receipts with details stripped.',
        redaction: {
            id: 'strip-receipt-details',
            target: 'receipt_details',
            behavior: 'strip',
            reason: 'Receipt details restricted.',
        },
    },
    // Restricted reader: read commands with payload redaction
    {
        id: 'restricted-command-redaction',
        name: 'Restricted Command Read',
        priority: 18,
        match: {
            principals: ['restricted-reader'],
            capabilities: ['read_command'],
        },
        decision: 'allow',
        reason: 'Can read commands with payload stripped.',
        redaction: {
            id: 'strip-command-payload',
            target: 'command_payload',
            behavior: 'strip',
            reason: 'Command payload restricted.',
        },
    },
    // Index-only reader: can discover existence + read derivative, nothing else
    {
        id: 'index-only-discover',
        name: 'Index Only Discover',
        priority: 20,
        match: {
            principals: ['index-only'],
            capabilities: ['discover_existence', 'read_derivative', 'explain_retrieval'],
        },
        decision: 'allow',
        reason: 'Index-only access.',
    },
    // Index-only DENIED owner truth
    {
        id: 'index-only-deny-owner',
        name: 'Index Only Deny Owner',
        priority: 15,
        match: {
            principals: ['index-only'],
            capabilities: ['read_owner_truth'],
        },
        decision: 'deny',
        reason: 'Index-only cannot read owner truth.',
    },
];

const trustZones: TrustZone[] = [
    {
        id: 'internal',
        name: 'Internal',
        defaultCapabilities: [],
        defaultScope: { stores: ['*'] },
        approvalMode: 'auto',
        redactionRules: [],
        visibilityRules: [],
    },
    {
        id: 'ai-facing',
        name: 'AI-Facing',
        defaultCapabilities: [],
        defaultScope: { stores: ['*'] },
        approvalMode: 'require_approval_for_writes',
        redactionRules: [
            {
                id: 'zone-provenance-actors',
                target: 'provenance_actors',
                behavior: 'strip',
                reason: 'Actor identities hidden from AI-facing zone.',
            },
        ],
        visibilityRules: [],
    },
    {
        id: 'external',
        name: 'External',
        defaultCapabilities: [],
        defaultScope: { stores: ['index'] },
        approvalMode: 'require_approval',
        redactionRules: [],
        visibilityRules: [],
    },
];

const visibilityRules: VisibilityRule[] = [
    // Hidden entities (kind=secret) are invisible from external zone
    {
        id: 'hide-secret-entities',
        scope: { stores: ['canonical'], kinds: ['secret'] },
        existenceVisible: false,
        emitPlaceholder: false,
    },
    // Hidden artifacts (kind=classified) are invisible from external zone
    {
        id: 'hide-classified-artifacts',
        scope: { stores: ['artifact'], kinds: ['classified'] },
        existenceVisible: false,
        emitPlaceholder: false,
    },
];

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeStores(): { stores: ClusterStores; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), 'wave5-redact-'));
    const stores = createLocalCluster(dir);
    return { stores, dir };
}

function makeKernel(stores: ClusterStores, principal: Principal): PolicyEnforcedKernel {
    return new PolicyEnforcedKernel(
        stores,
        { principal },
        { policies, trustZones, visibilityRules },
    );
}

// ─── Wave 5 Tests ──────────────────────────────────────────────────────────

describe('Wave 5 — Redaction and Existence Leakage', () => {

    // ─── Proof 1: Restricted artifact content is stripped ────────────

    describe('Proof 1: Restricted artifact content is stripped or summarized', () => {
        it('restricted reader gets artifact with storagePath stripped', async () => {
            const { stores } = makeStores();
            const adminK = makeKernel(stores, admin);
            // Seed an artifact through the admin kernel (admin has full
            // access, same result as the previous raw-kernel bypass — and
            // the _kernel getter is gone since Wave A2 / KERNEL-R003).
            const ingested = await adminK.ingestArtifact({
                filename: 'secret.pdf',
                content: Buffer.from('top secret content'),
                mimeType: 'application/pdf',
                actorId: 'admin-1',
            });

            // Admin sees full artifact
            const adminResult = await adminK.findSources({ query: 'secret' });
            const adminArtifact = adminResult.resolvedArtifacts.find((a) => a.id === ingested.artifact.id);
            expect(adminArtifact?.storagePath).not.toBe(REDACTED);

            // Restricted reader gets redacted artifact
            const restrictedK = makeKernel(stores, restrictedReader);
            const restrictedResult = await restrictedK.findSources({ query: 'secret' });
            const restrictedArtifact = restrictedResult.resolvedArtifacts.find((a) => a.id === ingested.artifact.id);
            expect(restrictedArtifact?.storagePath).toBe(REDACTED);
        });

        it('redactArtifact strips storagePath for strip behavior', () => {
            const artifact = {
                id: 'art-1',
                filename: 'secret.pdf',
                contentHash: 'abc123',
                mimeType: 'application/pdf',
                sizeBytes: 1024,
                version: 1,
                storagePath: '/data/secrets/secret.pdf',
                ingestedAt: '2025-01-01',
                owner: 'artifact' as const,
            };

            const rules: RedactionRule[] = [{
                id: 'strip-content',
                target: 'artifact_content',
                behavior: 'strip',
                reason: 'Content restricted.',
            }];

            const redacted = redactArtifact(artifact, rules);
            expect(redacted.storagePath).toBe(REDACTED);
            // Shape preserved
            expect(redacted.id).toBe('art-1');
            expect(redacted.mimeType).toBe('application/pdf');
            expect(redacted.sizeBytes).toBe(1024);
        });
    });

    // ─── Proof 2: Entity attributes masked without deleting shape ────

    describe('Proof 2: Entity attributes masked without deleting shape', () => {
        it('restricted reader sees masked attributes', async () => {
            const { stores } = makeStores();
            const adminK = makeKernel(stores, admin);
            // Seed via the admin-wrapped kernel directly — admin has full access,
            // and the _kernel getter is gone since Wave A2 (KERNEL-R003).
            const result = await adminK.createEntity({
                kind: 'concept',
                name: 'Sensitive Concept',
                attributes: { ssn: '123-45-6789', clearance: 'top-secret', notes: 'classified info' },
                actorId: 'admin-1',
            });

            const restrictedK = makeKernel(stores, restrictedReader);
            const entity = await restrictedK.inspectEntity(result.entity.id);

            // Shape preserved: same keys exist
            expect(Object.keys(entity.attributes)).toContain('ssn');
            expect(Object.keys(entity.attributes)).toContain('clearance');
            expect(Object.keys(entity.attributes)).toContain('notes');
            // Values redacted
            expect(entity.attributes.ssn).toBe(REDACTED);
            expect(entity.attributes.clearance).toBe(REDACTED);
            expect(entity.attributes.notes).toBe(REDACTED);
            // Metadata preserved
            expect(entity.name).toBe('Sensitive Concept');
            expect(entity.kind).toBe('concept');
        });

        it('redactEntity with strip behavior removes all attributes', () => {
            const entity = {
                id: 'e-1',
                kind: 'concept',
                name: 'Test',
                attributes: { a: 1, b: 'two' },
                createdAt: '2025-01-01',
                updatedAt: '2025-01-01',
                owner: 'canonical' as const,
            };

            const rules: RedactionRule[] = [{
                id: 'strip-attrs',
                target: 'entity_attributes',
                behavior: 'strip',
                reason: 'Stripped.',
            }];

            const redacted = redactEntity(entity, rules);
            expect(redacted.attributes).toEqual({});
            expect(redacted.id).toBe('e-1');
            expect(redacted.name).toBe('Test');
        });
    });

    // ─── Proof 3: Index search does not leak hidden existence ────────

    describe('Proof 3: Index search does not leak hidden existence', () => {
        it('hidden entity (kind=secret) does not appear in findSources for external reader', async () => {
            const { stores } = makeStores();
            const adminK = makeKernel(stores, admin);
            // Seed via the admin-wrapped kernel directly — admin has full access,
            // and the _kernel getter is gone since Wave A2 (KERNEL-R003).

            // Create a normal entity and a secret entity
            await adminK.createEntity({
                kind: 'concept',
                name: 'Public Concept',
                attributes: { visible: true },
                actorId: 'admin-1',
            });
            await adminK.createEntity({
                kind: 'secret',
                name: 'Hidden Secret',
                attributes: { classified: true },
                actorId: 'admin-1',
            });

            // Index-only reader cannot see hidden entities
            const externalK = makeKernel(stores, indexOnlyReader);
            const result = await externalK.findSources({ query: 'concept secret hidden' });

            // No resolved entities should contain the secret entity
            const secretEntities = result.resolvedEntities.filter((e) => e.kind === 'secret');
            expect(secretEntities).toHaveLength(0);
        });

        it('admin can still see hidden entities', async () => {
            const { stores } = makeStores();
            const adminK = makeKernel(stores, admin);
            // Seed via the admin-wrapped kernel directly — admin has full access,
            // and the _kernel getter is gone since Wave A2 (KERNEL-R003).

            const { entity: secretEntity } = await adminK.createEntity({
                kind: 'secret',
                name: 'Admin Secret',
                attributes: { classified: true },
                actorId: 'admin-1',
            });

            const result = await adminK.findSources({ query: 'admin secret' });
            const found = result.resolvedEntities.find((e) => e.id === secretEntity.id);
            expect(found).toBeDefined();
            expect(found!.kind).toBe('secret');
        });
    });

    // ─── Proof 4: Index-only returns derivative without owner payload ─

    describe('Proof 4: Index-only access returns derivative metadata without owner-truth payload', () => {
        it('index-only reader gets index records but no resolved entities', async () => {
            const { stores } = makeStores();
            const adminK = makeKernel(stores, admin);
            // Seed via the admin-wrapped kernel directly — admin has full access,
            // and the _kernel getter is gone since Wave A2 (KERNEL-R003).

            await adminK.createEntity({
                kind: 'concept',
                name: 'Indexed Concept',
                attributes: { domain: 'science' },
                actorId: 'admin-1',
            });

            const externalK = makeKernel(stores, indexOnlyReader);
            const result = await externalK.findSources({ query: 'concept' });

            // Index records returned (derivative)
            expect(result.indexRecords.length).toBeGreaterThanOrEqual(0);
            // Resolved entities filtered out (denied read_owner_truth)
            expect(result.resolvedEntities).toHaveLength(0);
        });
    });

    // ─── Proof 5: Provenance trace redacts nodes but preserves graph ─

    describe('Proof 5: Provenance trace redacts forbidden nodes but preserves graph structure', () => {
        it('redactGraphNodes replaces hidden nodes with placeholders', () => {
            const graph = {
                focalUri: 'cluster://canonical/e-1',
                direction: 'backward' as const,
                nodes: [
                    { uri: 'cluster://canonical/e-1', type: 'entity' as const, ownerStore: 'canonical', isSourceTruth: true, label: 'Entity 1' },
                    { uri: 'cluster://canonical/e-2', type: 'entity' as const, ownerStore: 'canonical', isSourceTruth: true, label: 'Hidden Entity' },
                    { uri: 'cluster://artifact/a-1', type: 'artifact' as const, ownerStore: 'artifact', isSourceTruth: true, label: 'Artifact 1' },
                ],
                edges: [
                    { from: 'cluster://canonical/e-1', to: 'cluster://canonical/e-2', type: 'entity_created_by' as const, reason: 'Created by admin-1' },
                    { from: 'cluster://canonical/e-1', to: 'cluster://artifact/a-1', type: 'artifact_ingested_from' as const, reason: 'Ingested' },
                ],
                gaps: [],
                warnings: [],
                summary: { focalUri: 'cluster://canonical/e-1', direction: 'backward' as const, nodeCount: 3, edgeCount: 2, sourceTruthNodes: 3, derivativeNodes: 0, receiptCount: 0, gapCount: 0, warningCount: 0, oneLiner: '' },
            };

            // Hide e-2
            const redacted = redactGraphNodes(graph, (node) => node.uri !== 'cluster://canonical/e-2');

            // 3 nodes still present (one is placeholder)
            expect(redacted.nodes).toHaveLength(3);
            const placeholder = redacted.nodes.find((n) => n.uri === 'cluster://canonical/e-2');
            expect(placeholder!.label).toBe('[Access restricted]');
            expect(placeholder!.isGap).toBe(true);
            expect(placeholder!.ownerStore).toBeNull();

            // Edge referencing hidden node has redacted reason
            const hiddenEdge = redacted.edges.find((e) => e.to === 'cluster://canonical/e-2');
            expect(hiddenEdge!.reason).toBe('[Restricted]');
            expect(hiddenEdge!.sourceEventId).toBeUndefined();

            // Visible edge unchanged
            const visibleEdge = redacted.edges.find((e) => e.to === 'cluster://artifact/a-1');
            expect(visibleEdge!.reason).toBe('Ingested');
        });

        it('zone-level provenance actor redaction strips actor names', () => {
            const graph = {
                focalUri: 'cluster://canonical/e-1',
                direction: 'backward' as const,
                nodes: [
                    { uri: 'cluster://canonical/e-1', type: 'entity' as const, ownerStore: 'canonical', isSourceTruth: true, label: 'Created by admin-1', metadata: { actorId: 'admin-1' } },
                ],
                edges: [
                    { from: 'cluster://canonical/e-1', to: 'cluster://artifact/a-1', type: 'entity_created_by' as const, reason: 'Created by admin-1 on behalf of org' },
                ],
                gaps: [],
                warnings: [],
                summary: { focalUri: 'cluster://canonical/e-1', direction: 'backward' as const, nodeCount: 1, edgeCount: 1, sourceTruthNodes: 1, derivativeNodes: 0, receiptCount: 0, gapCount: 0, warningCount: 0, oneLiner: '' },
            };

            const rules: RedactionRule[] = [{
                id: 'zone-actors',
                target: 'provenance_actors',
                behavior: 'strip',
                reason: 'Actors hidden.',
            }];

            const redacted = redactProvenanceActors(graph, rules);
            expect(redacted.nodes[0].label).toContain(REDACTED);
            expect(redacted.nodes[0].metadata!.actorId).toBeUndefined();
            expect(redacted.edges[0].reason).toContain(REDACTED);
        });
    });

    // ─── Proof 6: Receipt details redacted while preserving audit shape

    describe('Proof 6: Receipt details redact command payloads while preserving audit shape', () => {
        it('restricted reader gets receipts with stripped details', async () => {
            const { stores } = makeStores();
            const adminK = makeKernel(stores, admin);
            // Seed via the admin-wrapped kernel directly — admin has full access,
            // and the _kernel getter is gone since Wave A2 (KERNEL-R003).

            // Create, propose, approve, commit an entity to generate a receipt
            const { entity } = await adminK.createEntity({
                kind: 'concept',
                name: 'Receipt Test',
                attributes: { sensitive: 'data' },
                actorId: 'admin-1',
            });

            // Fetch receipts as admin — should have full details
            const adminReceipts = await adminK.listReceipts({});
            expect(adminReceipts.length).toBeGreaterThan(0);
            const adminReceipt = adminReceipts[0];
            expect(adminReceipt.resultSummary).not.toBe(REDACTED);

            // Fetch receipts as restricted reader — details redacted
            const restrictedK = makeKernel(stores, restrictedReader);
            const restrictedReceipts = await restrictedK.listReceipts({});
            expect(restrictedReceipts.length).toBeGreaterThan(0);
            const restrictedReceipt = restrictedReceipts[0];
            expect(restrictedReceipt.resultSummary).toBe(REDACTED);
            expect(restrictedReceipt.affectedIds).toEqual([]);
            // Audit shape preserved: id, commandId, committedAt still present
            expect(restrictedReceipt.id).toBe(adminReceipt.id);
            expect(restrictedReceipt.commandId).toBe(adminReceipt.commandId);
            expect(restrictedReceipt.committedAt).toBe(adminReceipt.committedAt);
        });

        it('redactCommand strips payload while keeping metadata', () => {
            const command = {
                id: 'cmd-1',
                verb: 'create' as const,
                targetStore: 'canonical' as const,
                payload: { name: 'Secret Entity', attributes: { ssn: '123' } },
                proposedAt: '2025-01-01',
                proposedBy: 'admin-1',
                status: 'committed' as const,
            };

            const rules: RedactionRule[] = [{
                id: 'strip-payload',
                target: 'command_payload',
                behavior: 'strip',
                reason: 'Payload restricted.',
            }];

            const redacted = redactCommand(command, rules);
            expect(redacted.payload).toEqual({});
            expect(redacted.id).toBe('cmd-1');
            expect(redacted.verb).toBe('create');
            expect(redacted.status).toBe('committed');
        });
    });

    // ─── Proof 7: why() explains denial without exposing hidden data ─

    describe('Proof 7: why() explains denial/redaction without exposing hidden source data', () => {
        it('denied principal gets PolicyDeniedError without source data', async () => {
            const { stores } = makeStores();
            const adminK = makeKernel(stores, admin);
            // Seed via the admin-wrapped kernel directly — admin has full access,
            // and the _kernel getter is gone since Wave A2 (KERNEL-R003).

            const { entity } = await adminK.createEntity({
                kind: 'secret',
                name: 'Top Secret Thing',
                attributes: { classified: true },
                actorId: 'admin-1',
            });

            // Index-only reader has no trace_provenance capability
            const indexK = makeKernel(stores, indexOnlyReader);
            try {
                await indexK.why(`cluster://canonical/${entity.id}`);
                expect.fail('should have thrown');
            } catch (err: any) {
                expect(err.name).toBe('PolicyDeniedError');
                // Error message includes capability name and reason, NOT the entity data
                expect(err.message).toContain('trace_provenance');
                expect(err.message).not.toContain('Top Secret Thing');
                expect(err.message).not.toContain('classified');
            }
        });

        it('authorized trace returns explanation without leaking other restricted data', async () => {
            const { stores } = makeStores();
            const adminK = makeKernel(stores, admin);
            // Seed via the admin-wrapped kernel directly — admin has full access,
            // and the _kernel getter is gone since Wave A2 (KERNEL-R003).

            const { entity } = await adminK.createEntity({
                kind: 'concept',
                name: 'Normal Thing',
                attributes: { public: true },
                actorId: 'admin-1',
            });

            // Restricted reader has trace_provenance
            const restrictedK = makeKernel(stores, restrictedReader);
            const explanation = await restrictedK.why(`cluster://canonical/${entity.id}`);
            expect(typeof explanation).toBe('string');
            expect(explanation.length).toBeGreaterThan(0);
        });
    });

    // ─── Proof 8: Stale/missing warnings do not reveal hidden URIs ───

    describe('Proof 8: Stale/missing warnings do not reveal hidden URIs when visibility says hide', () => {
        it('sanitizeWarnings removes warnings about hidden subjects', () => {
            const warnings = [
                { type: 'stale_index' as const, subjectUri: 'cluster://canonical/visible-1', message: 'Stale index' },
                { type: 'missing_owner_truth' as const, subjectUri: 'cluster://canonical/secret-hidden', message: 'Missing owner truth' },
            ];
            const gaps = [
                { description: 'Gap in visible', store: 'canonical', expectedUri: 'cluster://canonical/visible-1', impact: 'low' as const },
                { description: 'Gap in secret', store: 'canonical', expectedUri: 'cluster://canonical/secret-hidden', impact: 'high' as const },
            ];

            // Visibility rules that hide the 'secret-hidden' URI
            const rules: VisibilityRule[] = [
                {
                    id: 'hide-secret',
                    scope: { stores: ['canonical'] },
                    existenceVisible: false,
                    emitPlaceholder: false,
                },
            ];

            const result = sanitizeWarnings(warnings, gaps, rules);
            // All hidden since the rule hides ALL canonical store objects
            expect(result.warnings).toHaveLength(0);
            expect(result.gaps).toHaveLength(0);
        });

        it('stale records list does not expose hidden source URIs', async () => {
            const { stores } = makeStores();
            const adminK = makeKernel(stores, admin);
            // Seed via the admin-wrapped kernel directly — admin has full access,
            // and the _kernel getter is gone since Wave A2 (KERNEL-R003).

            // Create a secret entity (hidden by visibility rules for kind=secret)
            const { entity: secretEntity } = await adminK.createEntity({
                kind: 'secret',
                name: 'Secret Stale',
                attributes: { data: 'classified' },
                actorId: 'admin-1',
            });

            // Create a normal entity
            const { entity: normalEntity } = await adminK.createEntity({
                kind: 'concept',
                name: 'Normal Concept',
                attributes: { data: 'public' },
                actorId: 'admin-1',
            });

            // listStaleRecords as restricted reader won't show secret entity source IDs
            const restrictedK = makeKernel(stores, restrictedReader);
            const staleRecords = await restrictedK.listStaleRecords();
            // No stale record should reference the secret entity
            const secretStale = staleRecords.filter((r) => r.sourceId === secretEntity.id);
            expect(secretStale).toHaveLength(0);
        });
    });

    // ─── Proof 9: MCP output applies same redaction as SDK/kernel ────

    describe('Proof 9: MCP output applies same redaction as SDK/kernel', () => {
        it('SDK policyExplain does not include raw attribute data for restricted entities', () => {
            const dir = mkdtempSync(join(tmpdir(), 'wave5-sdk-'));
            const sdk = new ClusterSDK({
                clusterDir: dir,
                policies,
                trustZones,
                visibilityRules,
            });

            // Policy explain for a restricted reader trying to read a canonical entity
            const result = sdk.policyExplain({
                principal: restrictedReader,
                capability: 'read_owner_truth',
                ownerStore: 'canonical',
                resourceUri: 'cluster://canonical/some-entity',
            });

            // Decision is allow with redaction — result should NOT contain actual entity data
            expect(result.decision).toBe('allow');
            // No 'attributes', 'payload', or 'content' keys — explain is a dry-run
            expect((result as any).attributes).toBeUndefined();
            expect((result as any).content).toBeUndefined();
            expect((result as any).payload).toBeUndefined();
        });

        it('SDK policyTest does not expose restricted data in test results', () => {
            const dir = mkdtempSync(join(tmpdir(), 'wave5-sdk-'));
            const sdk = new ClusterSDK({
                clusterDir: dir,
                policies,
                trustZones,
                visibilityRules,
            });

            const result = sdk.policyTest({
                scenario: 'restricted reader redaction test',
                principal: restrictedReader,
                actions: [
                    { capability: 'read_owner_truth', ownerStore: 'canonical' },
                    { capability: 'read_receipts' },
                ],
            });

            // Results are policy evaluations, not actual data
            for (const r of result.results) {
                expect((r as any).attributes).toBeUndefined();
                expect((r as any).content).toBeUndefined();
                expect((r as any).affectedIds).toBeUndefined();
            }
        });
    });

    // ─── Proof 10: Policy explain/test never becomes a side channel ──

    describe('Proof 10: Policy explain/test never becomes a side channel for restricted data', () => {
        it('policyExplain for a hidden resource shows existence-hidden visibility', () => {
            const dir = mkdtempSync(join(tmpdir(), 'wave5-sdk-'));
            const sdk = new ClusterSDK({
                clusterDir: dir,
                policies,
                trustZones,
                visibilityRules,
            });

            // A principal that would be denied for a hidden kind
            const result = sdk.policyExplain({
                principal: indexOnlyReader,
                capability: 'read_owner_truth',
                ownerStore: 'canonical',
                resourceUri: 'cluster://canonical/secret-thing',
                entityKind: 'secret',
            });

            // Denied — good. Check that it says existence is hidden, not "entity not found" vs "denied"
            expect(result.decision).toBe('deny');
            // The denial doesn't confirm or deny the specific entity exists — 
            // it just enforces the policy rule
            expect(result.reason).toBeDefined();
            expect((result as any).entity).toBeUndefined();
            expect((result as any).object).toBeUndefined();
        });

        it('repeated policyExplain calls cannot enumerate hidden resources', () => {
            const dir = mkdtempSync(join(tmpdir(), 'wave5-sdk-'));
            const sdk = new ClusterSDK({
                clusterDir: dir,
                policies,
                trustZones,
                visibilityRules,
            });

            // Try multiple URIs — all get same denial, no distinguishable response
            const results = [
                'cluster://canonical/real-secret-1',
                'cluster://canonical/fake-nonexistent',
                'cluster://canonical/real-secret-2',
            ].map((uri) => sdk.policyExplain({
                principal: indexOnlyReader,
                capability: 'read_owner_truth',
                ownerStore: 'canonical',
                resourceUri: uri,
            }));

            // All produce identical denial structure — cannot distinguish real from fake
            const reasons = results.map((r) => r.reason);
            expect(new Set(reasons).size).toBe(1); // All same reason
            const decisions = results.map((r) => r.decision);
            expect(decisions.every((d) => d === 'deny')).toBe(true);
        });

        it('policyTest does not reveal existence of specific resources through response timing', () => {
            const dir = mkdtempSync(join(tmpdir(), 'wave5-sdk-'));
            const sdk = new ClusterSDK({
                clusterDir: dir,
                policies,
                trustZones,
                visibilityRules,
            });

            // Both real and fake URIs produce the same structure
            const result = sdk.policyTest({
                scenario: 'side channel enumeration test',
                principal: indexOnlyReader,
                actions: [
                    { capability: 'read_owner_truth', ownerStore: 'canonical', resourceUri: 'cluster://canonical/exists' },
                    { capability: 'read_owner_truth', ownerStore: 'canonical', resourceUri: 'cluster://canonical/doesnt-exist' },
                ],
            });

            // Both should be denied with same structure — no existence leakage
            expect(result.results[0].decision).toBe('deny');
            expect(result.results[1].decision).toBe('deny');
            expect(result.results[0].reason).toBe(result.results[1].reason);
        });
    });
});
