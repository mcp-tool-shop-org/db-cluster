import { describe, it, expect } from 'vitest';
import type { DashboardObject } from '../src/dashboard/dashboard-model.js';

/**
 * PolicyView type — mirrors dashboard/components/PolicyViewToggle.jsx
 */
interface PolicyView {
    principal: string;
    trustZone: string;
    visible: string[];
    redacted: string[];
}

/**
 * applyRedaction — mirrors the logic in PolicyViewToggle.jsx for testing.
 * Returns a copy with redacted paths replaced by '[REDACTED]'.
 * Source truth is never modified.
 */
function applyRedaction(dashObj: DashboardObject, policyView: PolicyView): DashboardObject {
    const copy = JSON.parse(JSON.stringify(dashObj)) as DashboardObject;
    const visible = new Set(policyView.visible);

    // If the object's store isn't visible, redact everything
    if (!visible.has(copy.ownerStore)) {
        copy.object = { _redacted: true } as unknown as Record<string, unknown>;
        copy.provenanceGraph = { nodes: [], edges: [], warnings: [{ type: 'redacted', message: 'store not visible to this principal' }] };
        copy.receipts = [];
        copy.warnings = [...copy.warnings, { type: 'redacted', severity: 'info', message: 'full object redacted for this view' }];
        return copy;
    }

    // Apply field-level redaction
    for (const field of policyView.redacted) {
        const [store, path] = field.split('.');
        if (store === copy.ownerStore || (store === 'artifact' && copy.type === 'artifact')) {
            if (path === '*') {
                copy.object = { _redacted: true } as unknown as Record<string, unknown>;
            } else if (copy.object && typeof copy.object === 'object' && path in copy.object) {
                (copy.object as Record<string, unknown>)[path] = '[REDACTED]';
            }
        }
    }

    return copy;
}

const VIEWS: Record<string, PolicyView> = {
    operator: {
        principal: 'operator',
        trustZone: 'internal',
        visible: ['canonical', 'artifact', 'index', 'ledger'],
        redacted: [],
    },
    agent: {
        principal: 'agent:claude',
        trustZone: 'internal',
        visible: ['canonical', 'index', 'ledger'],
        redacted: ['artifact.content'],
    },
    observer: {
        principal: 'observer',
        trustZone: 'external-read',
        visible: ['index', 'ledger'],
        redacted: ['canonical.attributes', 'artifact.content', 'artifact.storagePath'],
    },
    external: {
        principal: 'external-api',
        trustZone: 'external',
        visible: ['index'],
        redacted: ['canonical.*', 'artifact.*', 'ledger.receipts'],
    },
};

function makeEntity(): DashboardObject {
    return {
        uri: 'cluster://canonical/entity/ent-01',
        id: 'ent-01',
        type: 'entity',
        name: 'test entity',
        ownerStore: 'canonical',
        sourceType: 'owner-truth',
        freshness: 'fresh',
        object: { id: 'ent-01', kind: 'project', name: 'test', attributes: { secret: 'data' } },
        relationships: [],
        provenanceGraph: { nodes: [{ id: 'ent-01', uri: 'cluster://canonical/entity/ent-01', store: 'canonical', label: 'test' }], edges: [], warnings: [] },
        receipts: [{ id: 'r1', commandId: 'c1', verb: 'create_entity', summary: 'created', committedAt: '2026-01-01T00:00:00Z' }],
        warnings: [],
    };
}

function makeArtifact(): DashboardObject {
    return {
        uri: 'cluster://artifact/source/art-01',
        id: 'art-01',
        type: 'artifact',
        name: 'test.md',
        ownerStore: 'artifact',
        sourceType: 'source-truth',
        freshness: 'fresh',
        object: { id: 'art-01', name: 'test.md', content: 'secret content', storagePath: '/data/test.md' },
        relationships: [],
        provenanceGraph: { nodes: [], edges: [], warnings: [] },
        receipts: [],
        warnings: [],
    };
}

describe('Policy view toggle — redaction logic', () => {
    it('operator sees everything — no redaction', () => {
        const entity = makeEntity();
        const result = applyRedaction(entity, VIEWS.operator);

        expect(result.object).toEqual(entity.object);
        expect(result.receipts).toEqual(entity.receipts);
        expect(result.provenanceGraph).toEqual(entity.provenanceGraph);
    });

    it('agent cannot see artifact content', () => {
        const artifact = makeArtifact();
        const result = applyRedaction(artifact, VIEWS.agent);

        // agent view doesn't include 'artifact' store — full redaction
        expect(result.object).toHaveProperty('_redacted', true);
        expect(result.receipts).toEqual([]);
    });

    it('observer cannot see canonical — full redaction', () => {
        const entity = makeEntity();
        const result = applyRedaction(entity, VIEWS.observer);

        // canonical not in observer's visible stores
        expect(result.object).toHaveProperty('_redacted', true);
        expect(result.receipts).toEqual([]);
        expect(result.warnings.length).toBeGreaterThan(0);
    });

    it('external can only see index — everything else hidden', () => {
        const entity = makeEntity();
        const result = applyRedaction(entity, VIEWS.external);

        expect(result.object).toHaveProperty('_redacted', true);
        expect(result.receipts).toEqual([]);
    });

    it('redaction never mutates the original source object', () => {
        const entity = makeEntity();
        const originalObj = JSON.parse(JSON.stringify(entity.object));

        applyRedaction(entity, VIEWS.external);
        applyRedaction(entity, VIEWS.observer);

        // Original unchanged
        expect(entity.object).toEqual(originalObj);
    });

    it('field-level redaction replaces specific paths', () => {
        const artifact = makeArtifact();
        // Use operator view (can see artifact) but add a manual redaction
        const customView: PolicyView = {
            principal: 'custom',
            trustZone: 'internal',
            visible: ['canonical', 'artifact', 'index', 'ledger'],
            redacted: ['artifact.content'],
        };

        const result = applyRedaction(artifact, customView);

        expect(result.object.content).toBe('[REDACTED]');
        expect(result.object.storagePath).toBe('/data/test.md'); // not redacted
    });

    it('wildcard redaction replaces entire object', () => {
        const artifact = makeArtifact();
        const customView: PolicyView = {
            principal: 'strict',
            trustZone: 'internal',
            visible: ['canonical', 'artifact', 'index', 'ledger'],
            redacted: ['artifact.*'],
        };

        const result = applyRedaction(artifact, customView);

        expect(result.object).toHaveProperty('_redacted', true);
    });

    it('each view mode has a principal and trust zone', () => {
        for (const [key, view] of Object.entries(VIEWS)) {
            expect(view.principal).toBeTruthy();
            expect(view.trustZone).toBeTruthy();
            expect(view.visible).toBeInstanceOf(Array);
            expect(view.redacted).toBeInstanceOf(Array);
        }
    });
});
