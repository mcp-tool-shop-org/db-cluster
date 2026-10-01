/**
 * Regression — the dashboard inspector must trace the object it is inspecting.
 *
 * inspector-data.ts builds dashboard identity URIs as
 * `cluster://<store>/<type>/<id>`, but the kernel's trace builder understands
 * only the canonical `cluster://<store>/<id>` form. Handing it the dashboard
 * form made every entity, artifact and index-record inspection trace a
 * "[MISSING] ... not found" gap instead of the object's real provenance.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLocalCluster } from '../src/adapters/local/index.js';
import { ClusterKernel } from '../src/kernel/cluster-kernel.js';
import { inspectEntity, inspectArtifact, inspectIndexRecord } from '../src/dashboard/inspector-data.js';

const ACTOR = 'operator';

describe('inspector provenance graphs trace the real object', () => {
    let dir: string;
    let kernel: ClusterKernel;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'cov-inspector-trace-'));
        kernel = new ClusterKernel(createLocalCluster(dir));
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('inspectEntity returns the entity creation edge and no MISSING gap node', async () => {
        const { entity } = await kernel.createEntity({ kind: 'note', name: 'traced-entity', attributes: {}, actorId: ACTOR });
        const obj = await inspectEntity(kernel, entity.id);
        const labels = obj.provenanceGraph.nodes.map((n) => n.label);
        expect(labels.some((l) => l.includes('[MISSING]'))).toBe(false);
        expect(labels).toContain('note: traced-entity');
        expect(obj.provenanceGraph.edges.map((e) => e.type)).toContain('entity_created_by');
    });

    it('inspectArtifact returns the ingest edge for an ingested artifact', async () => {
        const { artifact } = await kernel.ingestArtifact({
            filename: 'traced.txt', content: Buffer.from('traced'), mimeType: 'text/plain', actorId: ACTOR,
        });
        const obj = await inspectArtifact(kernel, artifact.id);
        const labels = obj.provenanceGraph.nodes.map((n) => n.label);
        expect(labels.some((l) => l.includes('[MISSING]'))).toBe(false);
        expect(labels).toContain('traced.txt v1');
        expect(obj.provenanceGraph.edges.map((e) => e.type)).toContain('artifact_ingested_from');
    });

    it('inspectIndexRecord traces through the index record to its owner truth', async () => {
        const { indexRecord } = await kernel.createEntity({ kind: 'note', name: 'traced-index', attributes: {}, actorId: ACTOR });
        const obj = await inspectIndexRecord(kernel, indexRecord.id);
        const labels = obj.provenanceGraph.nodes.map((n) => n.label);
        expect(labels.some((l) => l.includes('[MISSING]'))).toBe(false);
        expect(labels).toContain('note: traced-index');
        expect(obj.provenanceGraph.edges.map((e) => e.type)).toContain('entity_created_by');
    });
});
