/**
 * Coverage — TraceBuilder (src/provenance/trace-builder.ts).
 *
 * Builds provenance graphs over a real local cluster, planting the exact store
 * states each trace branch reacts to (missing owner truth, stale projections,
 * orphan events, receipts that point at artifacts, parent-event chains) and
 * asserting on the resulting nodes, edges, gaps and warnings, not just that the
 * builder ran. `renderProvenanceLabel` is tested directly: every label kind,
 * with and without each redaction axis, and the runtime default arm.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLocalCluster } from '../src/adapters/local/index.js';
import type { ClusterStores } from '../src/contracts/index.js';
import { TraceBuilder, renderProvenanceLabel } from '../src/provenance/trace-builder.js';
import type { LabelData } from '../src/provenance/trace-builder.js';
import type { ProvenanceGraph } from '../src/types/provenance-graph.js';
import type { RedactionRule } from '../src/types/policy.js';

function rule(target: RedactionRule['target']): RedactionRule {
    return { id: `r-${target}`, target, behavior: 'strip', reason: 'test' };
}

let dir: string;
let stores: ClusterStores;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'coverage-trace-'));
    stores = createLocalCluster(dir);
});

afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

async function trace(uri: string, options?: ConstructorParameters<typeof TraceBuilder>[2]): Promise<ProvenanceGraph> {
    return new TraceBuilder(stores, uri, options).build();
}

const nodeFor = (g: ProvenanceGraph, uri: string) => g.nodes.find((n) => n.uri === uri);
const edgesOfType = (g: ProvenanceGraph, type: string) => g.edges.filter((e) => e.type === type);

async function makeEntity(name = 'Roadmap') {
    return stores.canonical.create({ kind: 'document', name, attributes: {} });
}

async function makeArtifact(filename = 'spec.md', body = '# Spec') {
    return stores.artifact.ingest({ filename, content: Buffer.from(body), mimeType: 'text/markdown' });
}

// ─── renderProvenanceLabel ─────────────────────────────────────────────────

describe('renderProvenanceLabel', () => {
    const entity: LabelData = { kind: 'entity', kind_value: 'document', name: 'Roadmap' };
    const artifact: LabelData = { kind: 'artifact', filename: 'spec.md', version: 3 };
    const event: LabelData = { kind: 'provenance_event', action: 'entity_created', actorId: 'alicedoe' };

    it('renders every kind literally when no rule applies', () => {
        expect(renderProvenanceLabel(entity, [])).toBe('document: Roadmap');
        expect(renderProvenanceLabel(artifact, [])).toBe('spec.md v3');
        expect(renderProvenanceLabel(event, [])).toBe('entity_created by alicedoe');
        expect(renderProvenanceLabel({ kind: 'index_record', text: 'document: Roadmap' }, [])).toBe('[index] document: Roadmap');
        expect(renderProvenanceLabel({ kind: 'receipt', resultSummary: 'created 1' }, [])).toBe('Receipt: created 1');
        expect(renderProvenanceLabel({ kind: 'gap', description: 'Entity x not found' }, [])).toBe('[MISSING] Entity x not found');
    });

    it('entity_name redacts only the name, keeping the kind', () => {
        expect(renderProvenanceLabel(entity, [rule('entity_name')])).toBe('document: [REDACTED]');
    });

    it('artifact_filename redacts only the filename, keeping the version', () => {
        expect(renderProvenanceLabel(artifact, [rule('artifact_filename')])).toBe('[REDACTED] v3');
    });

    it('provenance_actors redacts only the actor, keeping the action', () => {
        expect(renderProvenanceLabel(event, [rule('provenance_actors')])).toBe('entity_created by [REDACTED]');
    });

    it('a rule for a different axis does not redact', () => {
        expect(renderProvenanceLabel(entity, [rule('artifact_filename'), rule('provenance_actors')])).toBe('document: Roadmap');
        expect(renderProvenanceLabel(artifact, [rule('entity_name')])).toBe('spec.md v3');
        expect(renderProvenanceLabel(event, [rule('entity_name')])).toBe('entity_created by alicedoe');
    });

    it('an unknown runtime label kind collapses to the redaction sentinel instead of leaking', () => {
        const bogus = { kind: 'from-the-future', secret: 'hunter2' } as unknown as LabelData;
        expect(renderProvenanceLabel(bogus, [])).toBe('[REDACTED]');
    });
});

// ─── Entity traces ─────────────────────────────────────────────────────────

describe('TraceBuilder — entity', () => {
    it('a missing entity yields a single gap node and a high-impact gap', async () => {
        const uri = 'cluster://canonical/does-not-exist';
        const g = await trace(uri);

        expect(g.nodes).toHaveLength(1);
        const node = nodeFor(g, uri)!;
        expect(node.isGap).toBe(true);
        expect(node.label).toBe('[MISSING] Entity does-not-exist not found');
        expect(node.ownerStore).toBeNull();
        expect(g.gaps).toEqual([
            { description: 'Entity does-not-exist not found', expectedUri: uri, store: 'canonical', impact: 'high' },
        ]);
        expect(g.summary.gapCount).toBe(1);
        expect(g.summary.sourceTruthNodes).toBe(0);
    });

    it('an entity with no ledger events reports a medium gap and a missing_provenance warning that omits the name', async () => {
        const e = await makeEntity('Confidential Plan');
        const uri = `cluster://canonical/${e.id}`;
        const g = await trace(uri, { direction: 'backward' });

        expect(g.gaps).toEqual([
            { description: `Entity ${e.id} has no provenance trail`, expectedUri: uri, store: 'ledger', impact: 'medium' },
        ]);
        expect(g.warnings).toEqual([
            { type: 'missing_provenance', subjectUri: uri, message: 'Entity document/[name] exists without supporting provenance' },
        ]);
        expect(JSON.stringify(g.warnings)).not.toContain('Confidential Plan');
    });

    it('includeGaps:false suppresses the missing-provenance gap and warning', async () => {
        const e = await makeEntity();
        const g = await trace(`cluster://canonical/${e.id}`, { direction: 'backward', includeGaps: false });
        expect(g.gaps).toEqual([]);
        expect(g.warnings).toEqual([]);
    });

    it('stores labelData on the node metadata beside the rendered label', async () => {
        const e = await makeEntity('Roadmap');
        const g = await trace(`cluster://canonical/${e.id}`);
        const node = nodeFor(g, `cluster://canonical/${e.id}`)!;
        expect(node.label).toBe('document: Roadmap');
        expect(node.isSourceTruth).toBe(true);
        expect(node.metadata?.labelData).toEqual({ kind: 'entity', kind_value: 'document', name: 'Roadmap' });
    });

    it('follows evidence_linked events backward into the artifact and links them with an evidence edge', async () => {
        const e = await makeEntity();
        const a = await makeArtifact();
        const created = await stores.ledger.append({
            action: 'entity_created', actorId: 'alicedoe', subjectId: e.id, subjectStore: 'canonical', detail: {},
        });
        const linked = await stores.ledger.append({
            action: 'evidence_linked', actorId: 'alicedoe', subjectId: e.id, subjectStore: 'canonical',
            detail: { artifactId: a.id },
        });
        const entityUri = `cluster://canonical/${e.id}`;
        const artUri = `cluster://artifact/${a.id}`;

        const g = await trace(entityUri, { direction: 'backward' });

        expect(nodeFor(g, artUri)?.label).toBe('spec.md v1');
        expect(nodeFor(g, `cluster://ledger/${created.id}`)?.label).toBe('entity_created by alicedoe');
        const ev = edgesOfType(g, 'evidence_linked_to');
        // one edge from the ledger event, one from the artifact — both pointing at the entity
        expect(ev.map((x) => x.from).sort()).toEqual([`cluster://ledger/${linked.id}`, artUri].sort());
        expect(ev.every((x) => x.to === entityUri)).toBe(true);
        expect(edgesOfType(g, 'entity_created_by').map((x) => x.from)).toEqual([`cluster://ledger/${created.id}`]);
        // events exist, so no missing-provenance gap for the entity (the artifact has none: that gap is its own)
        expect(g.gaps.map((x) => x.expectedUri)).toEqual([artUri]);
    });

    it('does not duplicate an identical edge when the same event is seen twice', async () => {
        const e = await makeEntity();
        const a = await makeArtifact();
        await stores.ledger.append({
            action: 'evidence_linked', actorId: 'alicedoe', subjectId: e.id, subjectStore: 'canonical',
            detail: { artifactId: a.id },
        });
        await stores.ledger.append({
            action: 'evidence_linked', actorId: 'alicedoe', subjectId: e.id, subjectStore: 'canonical',
            detail: { artifactId: a.id },
        });
        const g = await trace(`cluster://canonical/${e.id}`, { direction: 'backward' });
        const fromArtifact = g.edges.filter((x) => x.from === `cluster://artifact/${a.id}` && x.type === 'evidence_linked_to');
        expect(fromArtifact).toHaveLength(1);
    });

    it('forward direction finds index records derived from the entity, and includeIndex:false hides them', async () => {
        const e = await makeEntity('Roadmap');
        const rec = await stores.index.index({
            sourceId: e.id, sourceStore: 'canonical', text: 'document: Roadmap', metadata: {},
        });
        const entityUri = `cluster://canonical/${e.id}`;

        const withIndex = await trace(entityUri, { direction: 'forward', includeIndex: true });
        const idxNode = nodeFor(withIndex, `cluster://index/${rec.id}`)!;
        expect(idxNode.isSourceTruth).toBe(false);
        expect(idxNode.label).toBe('[index] document: Roadmap');
        expect(edgesOfType(withIndex, 'index_record_derived_from')).toHaveLength(1);
        // Forward traces skip the provenance backfill entirely.
        expect(withIndex.gaps).toEqual([]);
        expect(withIndex.summary.derivativeNodes).toBe(1);

        const without = await trace(entityUri, { direction: 'forward', includeIndex: false });
        expect(nodeFor(without, `cluster://index/${rec.id}`)).toBeUndefined();
    });

    it('includes receipts that affected the entity, and includeReceipts:false omits them', async () => {
        const e = await makeEntity();
        const r = await stores.ledger.appendReceipt({
            commandId: 'cmd-1', resultSummary: 'created entity', affectedIds: [e.id], provenanceEventId: 'evt-x',
        });
        const entityUri = `cluster://canonical/${e.id}`;

        const g = await trace(entityUri, { direction: 'backward', includeReceipts: true });
        const rNode = nodeFor(g, `cluster://receipt/${r.id}`)!;
        expect(rNode.label).toBe('Receipt: created entity');
        expect(g.edges.some((x) => x.type === 'receipt_emitted_for' && x.from === rNode.uri && x.to === entityUri)).toBe(true);
        expect(g.summary.receiptCount).toBe(1);

        const off = await trace(entityUri, { direction: 'backward', includeReceipts: false });
        expect(off.nodes.some((n) => n.type === 'receipt')).toBe(false);
    });

    it('stops at the depth limit and revisits nothing', async () => {
        const e = await makeEntity();
        const a = await makeArtifact();
        await stores.ledger.append({
            action: 'evidence_linked', actorId: 'alicedoe', subjectId: e.id, subjectStore: 'canonical',
            detail: { artifactId: a.id },
        });
        const artUri = `cluster://artifact/${a.id}`;

        const shallow = await trace(`cluster://canonical/${e.id}`, { direction: 'backward', depth: 1 });
        expect(nodeFor(shallow, artUri)).toBeUndefined(); // depth 1 reaches only the focal object

        const none = await trace(`cluster://canonical/${e.id}`, { direction: 'backward', depth: 0 });
        expect(none.nodes).toEqual([]);

        // Bidirectional entity <-> artifact loop terminates and visits each node once.
        const loop = await trace(`cluster://canonical/${e.id}`, { direction: 'bidirectional', depth: 10 });
        const uris = loop.nodes.map((n) => n.uri);
        expect(new Set(uris).size).toBe(uris.length);
    });
});

// ─── Artifact traces ───────────────────────────────────────────────────────

describe('TraceBuilder — artifact', () => {
    it('a missing artifact yields a gap node', async () => {
        const uri = 'cluster://artifact/nope';
        const g = await trace(uri);
        expect(nodeFor(g, uri)).toMatchObject({ isGap: true, label: '[MISSING] Artifact nope not found' });
        expect(g.gaps).toEqual([
            { description: 'Artifact nope not found', expectedUri: uri, store: 'artifact', impact: 'high' },
        ]);
    });

    it('an artifact with no ingestion event reports a medium gap and a filename-free warning', async () => {
        const a = await makeArtifact('secret-plan.md');
        const uri = `cluster://artifact/${a.id}`;
        const g = await trace(uri, { direction: 'backward' });

        expect(nodeFor(g, uri)?.label).toBe('secret-plan.md v1');
        expect(g.gaps).toEqual([
            { description: `Artifact ${a.id} has no provenance trail`, expectedUri: uri, store: 'ledger', impact: 'medium' },
        ]);
        expect(g.warnings).toEqual([
            { type: 'missing_provenance', subjectUri: uri, message: 'Artifact [filename] exists without supporting provenance' },
        ]);
        expect(JSON.stringify(g.warnings)).not.toContain('secret-plan');
    });

    it('backward trace links the ingestion event with an artifact_ingested_from edge', async () => {
        const a = await makeArtifact();
        const ev = await stores.ledger.append({
            action: 'artifact_ingested', actorId: 'alicedoe', subjectId: a.id, subjectStore: 'artifact', detail: {},
        });
        const g = await trace(`cluster://artifact/${a.id}`, { direction: 'backward' });
        const edge = edgesOfType(g, 'artifact_ingested_from');
        expect(edge).toHaveLength(1);
        expect(edge[0]).toMatchObject({
            from: `cluster://ledger/${ev.id}`, to: `cluster://artifact/${a.id}`, sourceEventId: ev.id,
        });
        expect(g.gaps).toEqual([]);
    });

    it('forward trace finds the entities that cite the artifact as evidence, and their index records', async () => {
        const e = await makeEntity('Roadmap');
        const a = await makeArtifact();
        const link = await stores.ledger.append({
            action: 'evidence_linked', actorId: 'alicedoe', subjectId: e.id, subjectStore: 'canonical',
            detail: { artifactId: a.id },
        });
        const rec = await stores.index.index({
            sourceId: a.id, sourceStore: 'artifact', text: 'spec.md # Spec', metadata: {},
        });
        const artUri = `cluster://artifact/${a.id}`;
        const entityUri = `cluster://canonical/${e.id}`;

        const g = await trace(artUri, { direction: 'forward', includeIndex: true });

        const forward = g.edges.find((x) => x.from === artUri && x.to === entityUri)!;
        expect(forward.type).toBe('evidence_linked_to');
        expect(forward.reason).toBe('Evidence link (forward)');
        expect(forward.sourceEventId).toBe(link.id);
        expect(nodeFor(g, entityUri)?.label).toBe('document: Roadmap');
        expect(nodeFor(g, `cluster://index/${rec.id}`)?.isSourceTruth).toBe(false);
    });

    it('forward trace of an artifact nobody cites adds no entity edges', async () => {
        const a = await makeArtifact();
        const g = await trace(`cluster://artifact/${a.id}`, { direction: 'forward', includeIndex: false });
        expect(g.edges).toEqual([]);
        expect(g.nodes).toHaveLength(1);
    });
});

// ─── Index-record traces ───────────────────────────────────────────────────

describe('TraceBuilder — index record', () => {
    it('a missing index record yields a gap node', async () => {
        const uri = 'cluster://index/nope';
        const g = await trace(uri);
        expect(nodeFor(g, uri)?.label).toBe('[MISSING] Index record nope not found');
        expect(g.gaps[0]).toMatchObject({ store: 'index', impact: 'high', expectedUri: uri });
    });

    it('an up-to-date record traces back to its owner with index_record_derived_from and no warnings', async () => {
        const e = await makeEntity('Roadmap');
        const rec = await stores.index.index({
            sourceId: e.id, sourceStore: 'canonical', text: 'document: Roadmap', metadata: {},
        });
        const g = await trace(`cluster://index/${rec.id}`, { direction: 'backward' });

        const edge = edgesOfType(g, 'index_record_derived_from');
        expect(edge).toHaveLength(1);
        expect(edge[0]).toMatchObject({
            from: `cluster://index/${rec.id}`, to: `cluster://canonical/${e.id}`, reason: 'Derived from owner truth',
        });
        expect(g.warnings.filter((w) => w.type === 'stale_index')).toEqual([]);
        expect(nodeFor(g, `cluster://canonical/${e.id}`)?.isSourceTruth).toBe(true);
    });

    it('a record whose text no longer matches the owner is flagged stale (edge + warning)', async () => {
        const e = await makeEntity('Roadmap');
        const rec = await stores.index.index({
            sourceId: e.id, sourceStore: 'canonical', text: 'document: Old Name', metadata: {},
        });
        const idxUri = `cluster://index/${rec.id}`;
        const g = await trace(idxUri, { direction: 'backward' });

        const stale = edgesOfType(g, 'stale_projection_of');
        expect(stale).toHaveLength(1);
        expect(stale[0].isWarning).toBe(true);
        expect(g.warnings).toContainEqual({
            type: 'stale_index',
            subjectUri: idxUri,
            message: `Index record ${rec.id} is a stale projection of cluster://canonical/${e.id}`,
        });
        expect(edgesOfType(g, 'index_record_derived_from')).toEqual([]);
    });

    it('a record whose canonical owner was never created is reported as missing owner truth', async () => {
        const rec = await stores.index.index({
            sourceId: 'ghost-entity', sourceStore: 'canonical', text: 'document: Ghost', metadata: {},
        });
        const idxUri = `cluster://index/${rec.id}`;
        const g = await trace(idxUri, { direction: 'backward' });

        const edge = edgesOfType(g, 'missing_owner_truth');
        expect(edge).toHaveLength(1);
        expect(edge[0]).toMatchObject({ to: 'cluster://canonical/ghost-entity', isWarning: true });
        expect(g.gaps).toContainEqual({
            description: `Index record ${rec.id} references canonical/ghost-entity which no longer exists`,
            expectedUri: 'cluster://canonical/ghost-entity',
            store: 'canonical',
            impact: 'high',
        });
        expect(g.warnings).toContainEqual({
            type: 'missing_owner_truth',
            subjectUri: idxUri,
            message: `Owner truth for index record ${rec.id} is missing`,
        });
    });

    it('an artifact-sourced record whose artifact exists traces to it (existence check, never stale)', async () => {
        const a = await makeArtifact();
        const rec = await stores.index.index({
            sourceId: a.id, sourceStore: 'artifact', text: 'anything at all', metadata: {},
        });
        const g = await trace(`cluster://index/${rec.id}`, { direction: 'backward' });

        expect(edgesOfType(g, 'index_record_derived_from')).toHaveLength(1);
        expect(edgesOfType(g, 'stale_projection_of')).toEqual([]);
        expect(nodeFor(g, `cluster://artifact/${a.id}`)?.label).toBe('spec.md v1');
    });

    it('an artifact-sourced record whose artifact is gone is missing owner truth', async () => {
        const rec = await stores.index.index({
            sourceId: 'ghost-artifact', sourceStore: 'artifact', text: 'x', metadata: {},
        });
        const g = await trace(`cluster://index/${rec.id}`, { direction: 'backward' });
        expect(edgesOfType(g, 'missing_owner_truth')).toHaveLength(1);
        expect(g.gaps.some((x) => x.store === 'artifact' && x.impact === 'high')).toBe(true);
    });

    it('a ledger-sourced record has no existence probe, so it is reported as missing owner truth', async () => {
        const rec = await stores.index.index({
            sourceId: 'evt-x', sourceStore: 'ledger', text: 'x', metadata: {},
        });
        const g = await trace(`cluster://index/${rec.id}`, { direction: 'backward' });
        const edge = edgesOfType(g, 'missing_owner_truth');
        expect(edge).toHaveLength(1);
        expect(edge[0].to).toBe('cluster://ledger/evt-x');
    });

    it('forward direction records the index node but does not chase the owner', async () => {
        const e = await makeEntity('Roadmap');
        const rec = await stores.index.index({
            sourceId: e.id, sourceStore: 'canonical', text: 'document: Roadmap', metadata: {},
        });
        const g = await trace(`cluster://index/${rec.id}`, { direction: 'forward' });
        expect(g.nodes).toHaveLength(1);
        expect(g.edges).toEqual([]);
    });
});

// ─── Ledger-event traces ───────────────────────────────────────────────────

describe('TraceBuilder — ledger event', () => {
    it('a missing event yields a gap node', async () => {
        const uri = 'cluster://ledger/nope';
        const g = await trace(uri);
        expect(nodeFor(g, uri)?.label).toBe('[MISSING] Event nope not found');
        expect(g.gaps[0]).toMatchObject({ store: 'ledger', impact: 'high' });
    });

    it('backward trace walks the parentEventId chain with entity_created_by edges', async () => {
        const e = await makeEntity();
        const parent = await stores.ledger.append({
            action: 'entity_created', actorId: 'alicedoe', subjectId: e.id, subjectStore: 'canonical', detail: {},
        });
        const child = await stores.ledger.append({
            action: 'mutation_committed', actorId: 'bobsmith', subjectId: e.id, subjectStore: 'canonical',
            detail: {}, parentEventId: parent.id,
        });
        const childUri = `cluster://ledger/${child.id}`;
        const parentUri = `cluster://ledger/${parent.id}`;

        const g = await trace(childUri, { direction: 'backward' });

        expect(nodeFor(g, childUri)?.label).toBe('mutation_committed by bobsmith');
        expect(nodeFor(g, parentUri)?.label).toBe('entity_created by alicedoe');
        expect(g.edges).toContainEqual(
            expect.objectContaining({ from: parentUri, to: childUri, type: 'entity_created_by', reason: 'Parent event' }),
        );
        // backward does not walk to the subject
        expect(nodeFor(g, `cluster://canonical/${e.id}`)).toBeUndefined();
    });

    it('forward trace follows the event to its subject, typing the edge by the action', async () => {
        const e = await makeEntity('Roadmap');
        const ev = await stores.ledger.append({
            action: 'mutation_committed', actorId: 'alicedoe', subjectId: e.id, subjectStore: 'canonical', detail: {},
        });
        const evUri = `cluster://ledger/${ev.id}`;
        const g = await trace(evUri, { direction: 'forward', includeReceipts: false });

        expect(g.edges).toContainEqual(
            expect.objectContaining({
                from: evUri, to: `cluster://canonical/${e.id}`, type: 'mutation_committed_by',
                reason: 'mutation_committed', sourceEventId: ev.id,
            }),
        );
        expect(nodeFor(g, `cluster://canonical/${e.id}`)?.label).toBe('document: Roadmap');
        expect(nodeFor(g, evUri)?.metadata).toMatchObject({ subjectId: e.id, subjectStore: 'canonical', action: 'mutation_committed' });
    });

    it.each([
        ['artifact_ingested', 'artifact_ingested_from'],
        ['entity_created', 'entity_created_by'],
        ['evidence_linked', 'evidence_linked_to'],
        ['mutation_committed', 'mutation_committed_by'],
        ['index_rebuilt', 'index_record_derived_from'],
        ['mutation_orphaned', 'missing_provenance'],
        ['some_unrecognised_action', 'entity_created_by'],
    ])('maps the %s action to a %s edge when traced forward', async (action, edgeType) => {
        const e = await makeEntity();
        const ev = await stores.ledger.append({
            action, actorId: 'alicedoe', subjectId: e.id, subjectStore: 'canonical', detail: {},
        });
        const g = await trace(`cluster://ledger/${ev.id}`, { direction: 'forward', includeReceipts: false });
        const edge = g.edges.find((x) => x.sourceEventId === ev.id && x.from === `cluster://ledger/${ev.id}`);
        expect(edge?.type).toBe(edgeType);
    });
});

// ─── Receipt traces ────────────────────────────────────────────────────────

describe('TraceBuilder — receipt', () => {
    it('a missing receipt yields a gap node', async () => {
        const uri = 'cluster://receipt/nope';
        const g = await trace(uri);
        expect(nodeFor(g, uri)?.label).toBe('[MISSING] Receipt nope not found');
        expect(g.gaps[0]).toMatchObject({ store: 'ledger', impact: 'high', expectedUri: uri });
    });

    it('backward trace follows the emitting provenance event', async () => {
        const e = await makeEntity();
        const ev = await stores.ledger.append({
            action: 'mutation_committed', actorId: 'alicedoe', subjectId: e.id, subjectStore: 'canonical', detail: {},
        });
        const r = await stores.ledger.appendReceipt({
            commandId: 'cmd-1', resultSummary: 'done', affectedIds: [e.id], provenanceEventId: ev.id,
        });
        const rUri = `cluster://receipt/${r.id}`;
        const evUri = `cluster://ledger/${ev.id}`;

        const g = await trace(rUri, { direction: 'backward' });

        expect(nodeFor(g, rUri)?.label).toBe('Receipt: done');
        expect(nodeFor(g, rUri)?.metadata).toMatchObject({ commandId: 'cmd-1', resultSummary: 'done' });
        expect(g.edges).toContainEqual(
            expect.objectContaining({
                from: evUri, to: rUri, type: 'receipt_emitted_for',
                reason: 'Receipt emitted for committed command', sourceEventId: ev.id,
            }),
        );
        expect(nodeFor(g, evUri)).toBeDefined();
        // backward does not fan out to the affected objects
        expect(nodeFor(g, `cluster://canonical/${e.id}`)).toBeUndefined();
    });

    it('forward trace fans out to affected entities and artifacts and skips ids that exist nowhere', async () => {
        const e = await makeEntity('Roadmap');
        const a = await makeArtifact('spec.md');
        const r = await stores.ledger.appendReceipt({
            commandId: 'cmd-2', resultSummary: 'multi', affectedIds: [e.id, a.id, 'vanished-id'], provenanceEventId: 'evt-none',
        });
        const rUri = `cluster://receipt/${r.id}`;

        const g = await trace(rUri, { direction: 'forward', includeReceipts: false });

        const committed = edgesOfType(g, 'mutation_committed_by');
        expect(committed.map((x) => x.to).sort()).toEqual(
            [`cluster://canonical/${e.id}`, `cluster://artifact/${a.id}`].sort(),
        );
        expect(committed.every((x) => x.from === rUri && x.reason === 'Affected by this receipt')).toBe(true);
        expect(nodeFor(g, `cluster://canonical/${e.id}`)?.label).toBe('document: Roadmap');
        expect(nodeFor(g, `cluster://artifact/${a.id}`)?.label).toBe('spec.md v1');
        expect(g.nodes.some((n) => n.uri.includes('vanished-id'))).toBe(false);
    });
});

// ─── Graph assembly ────────────────────────────────────────────────────────

describe('TraceBuilder — graph summary', () => {
    it('reports counts and a one-liner that names gaps and warnings', async () => {
        const e = await makeEntity();
        const uri = `cluster://canonical/${e.id}`;
        const g = await trace(uri, { direction: 'backward' });

        expect(g.focalUri).toBe(uri);
        expect(g.direction).toBe('backward');
        expect(g.summary).toMatchObject({
            focalUri: uri,
            direction: 'backward',
            nodeCount: 1,
            edgeCount: 0,
            sourceTruthNodes: 1,
            derivativeNodes: 0,
            receiptCount: 0,
            gapCount: 1,
            warningCount: 1,
        });
        expect(g.summary.oneLiner).toBe(`Trace from ${uri}: 1 nodes, 0 edges, 1 gaps, 1 warnings`);
        expect(Number.isNaN(Date.parse(g.assembledAt))).toBe(false);
    });

    it('omits the gap and warning clauses from the one-liner when there are none', async () => {
        const e = await makeEntity();
        await stores.ledger.append({
            action: 'entity_created', actorId: 'alicedoe', subjectId: e.id, subjectStore: 'canonical', detail: {},
        });
        const uri = `cluster://canonical/${e.id}`;
        const g = await trace(uri, { direction: 'backward' });
        expect(g.summary.oneLiner).toBe(`Trace from ${uri}: 2 nodes, 1 edges`);
    });

    it('defaults to a backward trace when no direction is given', async () => {
        const e = await makeEntity();
        const g = await trace(`cluster://canonical/${e.id}`);
        expect(g.direction).toBe('backward');
    });
});
