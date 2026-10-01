/**
 * Coverage — redactor behaviours (src/policy/redactor.ts).
 *
 * The redactor is a security boundary: every test below pins BOTH what a rule
 * removes AND what it must leave alone. The shapes covered:
 *
 *  - the AGG-005 allowlist: unknown sidecar fields collapse to a typed
 *    RedactedMarker whose `kind` follows the value's runtime type;
 *  - every `strip` / `mask` / `summarize` / `hash` arm per domain type, and the
 *    runtime `default:` arm (a policy loaded from disk with an unknown
 *    behaviour literal falls back to the SAFEST behaviour, strip);
 *  - rules aimed at a different target are ignored (no over-redaction);
 *  - the error-message path scrubber (PATH_REGEX) on the shapes it must scrub
 *    and the neighbouring shapes it must leave alone.
 *
 * Fixtures use neutral placeholder names only.
 */

import { describe, it, expect } from 'vitest';
import {
    REDACTED,
    PATH_REGEX,
    redactArtifact,
    redactEntity,
    redactCommand,
    redactReceipt,
    redactProvenanceEvent,
    redactProvenanceActors,
    redactIndexRecord,
    redactIndexSourceUri,
    redactErrorMessage,
    isRedactedMarker,
} from '../src/policy/redactor.js';
import type { RedactionRule } from '../src/types/policy.js';
import type { Artifact } from '../src/types/artifact.js';
import type { Entity } from '../src/types/entity.js';
import type { Command } from '../src/types/command.js';
import type { Receipt } from '../src/types/receipt.js';
import type { ProvenanceEvent } from '../src/types/provenance-event.js';
import type { IndexRecord } from '../src/types/index-record.js';
import type { ProvenanceGraph } from '../src/types/provenance-graph.js';

function rule(
    target: RedactionRule['target'],
    behavior: RedactionRule['behavior'] | 'bogus-runtime-behavior',
): RedactionRule {
    return { id: `r-${target}-${behavior}`, target, behavior: behavior as RedactionRule['behavior'], reason: 'test' };
}

const artifact: Artifact = {
    id: 'art-1',
    filename: 'quarterly-notes.md',
    contentHash: 'abc123',
    mimeType: 'text/markdown',
    sizeBytes: 42,
    version: 3,
    storagePath: '/data/artifact/content/abc123',
    ingestedAt: '2026-01-01T00:00:00.000Z',
    owner: 'artifact',
};

const entity: Entity = {
    id: 'ent-1',
    kind: 'document',
    name: 'Roadmap',
    attributes: { secret: 'hunter2', tier: 'gold' },
    version: 2,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    owner: 'canonical',
};

const command: Command = {
    id: 'cmd-1',
    verb: 'create_entity',
    targetStore: 'canonical',
    payload: { kind: 'document', name: 'Roadmap', password: 'hunter2' },
    proposedAt: '2026-01-01T00:00:00.000Z',
    proposedBy: 'alicedoe',
    status: 'validated',
};

const receipt: Receipt = {
    id: 'rcpt-1',
    commandId: 'cmd-1',
    committedAt: '2026-01-01T00:00:00.000Z',
    resultSummary: 'created entity Roadmap',
    affectedIds: ['ent-1', 'ent-2', 'ent-3'],
    provenanceEventId: 'evt-1',
    integrityHash: 'hash-1',
    prevHash: 'hash-0',
};

const event: ProvenanceEvent = {
    id: 'evt-1',
    timestamp: '2026-01-01T00:00:00.000Z',
    action: 'entity_created',
    actorId: 'alicedoe',
    subjectId: 'ent-1',
    subjectStore: 'canonical',
    detail: {
        payload: { password: 'hunter2' },
        commandId: 'cmd-1',
        kind: 'document',
        entityId: 'ent-1',
        name: 'Roadmap',
        note: 'harmless context',
    },
    parentEventId: 'evt-0',
    owner: 'ledger',
    integrityHash: 'hash-e1',
    prevHash: 'hash-e0',
};

const indexRecord: IndexRecord = {
    id: 'idx-1',
    sourceId: 'ent-12345',
    sourceStore: 'canonical',
    text: 'document: Roadmap',
    metadata: { kind: 'document' },
    indexedAt: '2026-01-01T00:00:00.000Z',
    owner: 'index',
};

// ─── AGG-005 allowlist — unknown-field marker kinds ────────────────────────

describe('redactor allowlist — unknown sidecar fields become typed markers', () => {
    it('collapses each runtime type to the matching marker kind and keeps allowlisted fields verbatim', () => {
        const withSidecars = {
            ...entity,
            sidecarString: 's',
            sidecarNumber: 7,
            sidecarBuffer: Buffer.from('raw'),
            sidecarArray: [1, 2],
            sidecarObject: { a: 1 },
            sidecarNull: null,
            sidecarBool: true,
            sidecarUndefined: undefined,
        } as unknown as Entity;

        const out = redactEntity(withSidecars, []) as unknown as Record<string, unknown>;

        const kinds: Record<string, string> = {
            sidecarString: 'string',
            sidecarNumber: 'number',
            sidecarBuffer: 'buffer',
            sidecarArray: 'array',
            sidecarObject: 'object',
            sidecarNull: 'unknown',
            sidecarBool: 'unknown',
            sidecarUndefined: 'unknown',
        };
        for (const [key, kind] of Object.entries(kinds)) {
            expect(isRedactedMarker(out[key]), key).toBe(true);
            expect(out[key]).toEqual({ _redacted: true, kind, reason: 'unknown_field' });
        }

        // Allowlisted fields survive unchanged.
        expect(out.id).toBe('ent-1');
        expect(out.name).toBe('Roadmap');
        expect(out.version).toBe(2);
        expect(out.attributes).toEqual({ secret: 'hunter2', tier: 'gold' });
    });

    it('does not mutate its input', () => {
        const input = { ...entity, extra: 'x' } as unknown as Entity;
        redactEntity(input, [rule('entity_attributes', 'strip')]);
        expect((input as unknown as Record<string, unknown>).extra).toBe('x');
        expect(input.attributes).toEqual({ secret: 'hunter2', tier: 'gold' });
    });
});

// ─── Artifact ──────────────────────────────────────────────────────────────

describe('redactArtifact', () => {
    it('with no matching rule returns the allowlisted baseline (storagePath intact)', () => {
        const out = redactArtifact(artifact, [rule('entity_attributes', 'strip')]);
        expect(out).toEqual(artifact);
    });

    it('strip removes storagePath only', () => {
        const out = redactArtifact(artifact, [rule('artifact_content', 'strip')]);
        expect(out.storagePath).toBe(REDACTED);
        expect(out.filename).toBe('quarterly-notes.md');
        expect(out.contentHash).toBe('abc123');
        expect(out.id).toBe('art-1');
    });

    it('mask also hides the filename but keeps the extension derived from the mime type', () => {
        const out = redactArtifact(artifact, [rule('artifact_content', 'mask')]);
        expect(out.storagePath).toBe(REDACTED);
        expect(out.filename).toBe('[REDACTED].markdown');
        expect(out.filename).not.toContain('quarterly');
        expect(out.mimeType).toBe('text/markdown');
    });

    it('mask falls back to .bin when the mime type has no subtype', () => {
        const out = redactArtifact({ ...artifact, mimeType: 'opaque' }, [rule('artifact_content', 'mask')]);
        expect(out.filename).toBe('[REDACTED].bin');
    });

    it('summarize hides storagePath but keeps the filename', () => {
        const out = redactArtifact(artifact, [rule('artifact_content', 'summarize')]);
        expect(out.storagePath).toBe(REDACTED);
        expect(out.filename).toBe('quarterly-notes.md');
    });

    it('hash replaces storagePath with a sha256:redacted: reference to the content hash', () => {
        const out = redactArtifact(artifact, [rule('artifact_content', 'hash')]);
        expect(out.storagePath).toBe('sha256:redacted:abc123');
        expect(out.storagePath).not.toContain('/data/');
    });

    it('an unknown runtime behaviour falls back to strip (never returns the raw path)', () => {
        const out = redactArtifact(artifact, [rule('artifact_content', 'bogus-runtime-behavior')]);
        expect(out.storagePath).toBe(REDACTED);
    });

    it('only the first matching content rule applies', () => {
        const out = redactArtifact(artifact, [rule('artifact_content', 'hash'), rule('artifact_content', 'mask')]);
        expect(out.storagePath).toBe('sha256:redacted:abc123');
        expect(out.filename).toBe('quarterly-notes.md');
    });
});

// ─── Entity ────────────────────────────────────────────────────────────────

describe('redactEntity', () => {
    it('with no entity_attributes rule leaves attributes visible', () => {
        const out = redactEntity(entity, [rule('command_payload', 'strip')]);
        expect(out.attributes).toEqual({ secret: 'hunter2', tier: 'gold' });
    });

    it('strip empties attributes but keeps identity fields', () => {
        const out = redactEntity(entity, [rule('entity_attributes', 'strip')]);
        expect(out.attributes).toEqual({});
        expect(out.id).toBe('ent-1');
        expect(out.name).toBe('Roadmap');
        expect(out.version).toBe(2);
    });

    it('mask keeps the attribute KEYS but replaces every value', () => {
        const out = redactEntity(entity, [rule('entity_attributes', 'mask')]);
        expect(out.attributes).toEqual({ secret: REDACTED, tier: REDACTED });
        expect(JSON.stringify(out)).not.toContain('hunter2');
    });

    it('summarize reports only the attribute count', () => {
        const out = redactEntity(entity, [rule('entity_attributes', 'summarize')]);
        expect(out.attributes).toEqual({ _summary: '2 attributes redacted' });
    });

    it('hash reports only a redacted count token', () => {
        const out = redactEntity(entity, [rule('entity_attributes', 'hash')]);
        expect(out.attributes).toEqual({ _hash: 'sha256:redacted:2' });
    });

    it('an unknown runtime behaviour falls back to strip', () => {
        const out = redactEntity(entity, [rule('entity_attributes', 'bogus-runtime-behavior')]);
        expect(out.attributes).toEqual({});
    });
});

// ─── Command ───────────────────────────────────────────────────────────────

describe('redactCommand', () => {
    it('with no command_payload rule leaves the payload visible', () => {
        const out = redactCommand(command, [rule('receipt_details', 'strip')]);
        expect(out.payload).toEqual(command.payload);
    });

    it('strip empties the payload but keeps lifecycle fields', () => {
        const out = redactCommand(command, [rule('command_payload', 'strip')]);
        expect(out.payload).toEqual({});
        expect(out.verb).toBe('create_entity');
        expect(out.status).toBe('validated');
        expect(out.proposedBy).toBe('alicedoe');
    });

    it('mask keeps payload keys and masks values', () => {
        const out = redactCommand(command, [rule('command_payload', 'mask')]);
        expect(out.payload).toEqual({ kind: REDACTED, name: REDACTED, password: REDACTED });
    });

    it('summarize reports the field count and the verb only', () => {
        const out = redactCommand(command, [rule('command_payload', 'summarize')]);
        expect(out.payload).toEqual({ _summary: '3 fields redacted', verb: 'create_entity' });
        expect(JSON.stringify(out.payload)).not.toContain('hunter2');
    });

    it('hash replaces the whole payload with the redaction sentinel', () => {
        const out = redactCommand(command, [rule('command_payload', 'hash')]);
        expect(out.payload).toEqual({ _hash: REDACTED });
    });

    it('an unknown runtime behaviour falls back to strip', () => {
        const out = redactCommand(command, [rule('command_payload', 'bogus-runtime-behavior')]);
        expect(out.payload).toEqual({});
    });
});

// ─── Receipt ───────────────────────────────────────────────────────────────

describe('redactReceipt', () => {
    it('with no receipt_details rule leaves the receipt visible', () => {
        const out = redactReceipt(receipt, [rule('command_payload', 'strip')]);
        expect(out).toEqual(receipt);
    });

    it('strip clears the summary and the affected ids, keeping the audit chain fields', () => {
        const out = redactReceipt(receipt, [rule('receipt_details', 'strip')]);
        expect(out.resultSummary).toBe(REDACTED);
        expect(out.affectedIds).toEqual([]);
        expect(out.integrityHash).toBe('hash-1');
        expect(out.prevHash).toBe('hash-0');
        expect(out.commandId).toBe('cmd-1');
    });

    it('mask keeps the COUNT of affected ids but not their values', () => {
        const out = redactReceipt(receipt, [rule('receipt_details', 'mask')]);
        expect(out.resultSummary).toBe(REDACTED);
        expect(out.affectedIds).toEqual([REDACTED, REDACTED, REDACTED]);
    });

    it('summarize reports the number of affected objects and drops the ids', () => {
        const out = redactReceipt(receipt, [rule('receipt_details', 'summarize')]);
        expect(out.resultSummary).toBe('[Redacted: 3 objects affected]');
        expect(out.affectedIds).toEqual([]);
    });

    it('hash masks the affected ids as well (no covert side channel on the id values)', () => {
        const out = redactReceipt(receipt, [rule('receipt_details', 'hash')]);
        expect(out.resultSummary).toBe(REDACTED);
        expect(out.affectedIds).toEqual([REDACTED, REDACTED, REDACTED]);
        expect(out.affectedIds).not.toContain('ent-1');
    });

    it('an unknown runtime behaviour falls back to strip', () => {
        const out = redactReceipt(receipt, [rule('receipt_details', 'bogus-runtime-behavior')]);
        expect(out.resultSummary).toBe(REDACTED);
        expect(out.affectedIds).toEqual([]);
    });
});

// ─── Provenance event ──────────────────────────────────────────────────────

describe('redactProvenanceEvent', () => {
    it('with no rules returns the allowlisted baseline and drops unknown sidecars to markers', () => {
        const out = redactProvenanceEvent({ ...event, leaked: 'x' } as unknown as ProvenanceEvent, []) as unknown as Record<string, unknown>;
        expect(out.detail).toEqual(event.detail);
        expect(out.actorId).toBe('alicedoe');
        expect(out.leaked).toEqual({ _redacted: true, kind: 'string', reason: 'unknown_field' });
    });

    it('command_payload strips payload/commandId/kind/entityId/name from detail but keeps other detail keys', () => {
        const out = redactProvenanceEvent(event, [rule('command_payload', 'strip')]);
        expect(out.detail).toEqual({ note: 'harmless context' });
        expect(out.actorId).toBe('alicedoe');
    });

    it('command_payload on a detail that lacks those keys leaves the detail unchanged', () => {
        const plain = { ...event, detail: { note: 'only note' } };
        const out = redactProvenanceEvent(plain, [rule('command_payload', 'strip')]);
        expect(out.detail).toEqual({ note: 'only note' });
    });

    it('receipt_details wipes the whole detail object and wins over command_payload', () => {
        const out = redactProvenanceEvent(event, [rule('command_payload', 'strip'), rule('receipt_details', 'strip')]);
        expect(out.detail).toEqual({});
    });

    it('provenance_actors replaces the actor with the truthy REDACTED sentinel and keeps detail', () => {
        const out = redactProvenanceEvent(event, [rule('provenance_actors', 'strip')]);
        expect(out.actorId).toBe(REDACTED);
        expect(out.detail).toEqual(event.detail);
        expect(out.subjectId).toBe('ent-1');
    });

    it('provenance_actors mask yields the same sentinel as strip', () => {
        const strip = redactProvenanceEvent(event, [rule('provenance_actors', 'strip')]);
        const mask = redactProvenanceEvent(event, [rule('provenance_actors', 'mask')]);
        expect(mask.actorId).toBe(strip.actorId);
    });

    it('rules for unrelated targets change nothing', () => {
        const out = redactProvenanceEvent(event, [rule('entity_attributes', 'strip')]);
        expect(out.actorId).toBe('alicedoe');
        expect(out.detail).toEqual(event.detail);
    });
});

// ─── Provenance graph actors ───────────────────────────────────────────────

describe('redactProvenanceActors', () => {
    const graph: ProvenanceGraph = {
        focalUri: 'cluster://canonical/ent-1',
        direction: 'backward',
        nodes: [
            {
                uri: 'cluster://ledger/evt-1',
                type: 'provenance_event',
                ownerStore: 'ledger',
                isSourceTruth: true,
                label: 'entity_created by alicedoe',
                metadata: { actorId: 'alicedoe', proposedBy: 'alicedoe', action: 'entity_created' },
            },
            {
                uri: 'cluster://canonical/ent-1',
                type: 'entity',
                ownerStore: 'canonical',
                isSourceTruth: true,
                label: 'document: Roadmap',
            },
        ],
        edges: [
            {
                from: 'cluster://ledger/evt-1',
                to: 'cluster://canonical/ent-1',
                type: 'entity_created_by',
                reason: 'created by bob@example.org',
            },
        ],
        gaps: [],
        warnings: [],
        summary: {
            focalUri: 'cluster://canonical/ent-1',
            direction: 'backward',
            nodeCount: 2,
            edgeCount: 1,
            sourceTruthNodes: 2,
            derivativeNodes: 0,
            receiptCount: 0,
            gapCount: 0,
            warningCount: 0,
            oneLiner: 'x',
        },
        assembledAt: '2026-01-01T00:00:00.000Z',
    };

    it('with no provenance_actors rule returns the graph untouched (same reference)', () => {
        expect(redactProvenanceActors(graph, [rule('entity_attributes', 'strip')])).toBe(graph);
    });

    it('strip scrubs "by <actor>" in labels and edge reasons and removes actor metadata keys', () => {
        const out = redactProvenanceActors(graph, [rule('provenance_actors', 'strip')]);
        expect(out.nodes[0].label).toBe('entity_created by [REDACTED]');
        expect(out.edges[0].reason).toBe('created by [REDACTED]');
        expect(out.nodes[0].metadata).toEqual({
            actorId: undefined,
            proposedBy: undefined,
            action: 'entity_created',
        });
        // A label with no "by <actor>" shape is left alone, and a node without metadata stays without.
        expect(out.nodes[1].label).toBe('document: Roadmap');
        expect(out.nodes[1].metadata).toBeUndefined();
        expect(JSON.stringify(out)).not.toContain('alicedoe');
        expect(JSON.stringify(out)).not.toContain('bob@example.org');
    });

    it('mask leaves labels/reasons but replaces actor metadata with the sentinel', () => {
        const out = redactProvenanceActors(graph, [rule('provenance_actors', 'mask')]);
        expect(out.nodes[0].label).toBe('entity_created by alicedoe');
        expect(out.edges[0].reason).toBe('created by bob@example.org');
        expect(out.nodes[0].metadata).toEqual({
            actorId: REDACTED,
            proposedBy: REDACTED,
            action: 'entity_created',
        });
    });

    it('does not mutate the input graph', () => {
        redactProvenanceActors(graph, [rule('provenance_actors', 'strip')]);
        expect(graph.nodes[0].label).toBe('entity_created by alicedoe');
        expect(graph.nodes[0].metadata?.actorId).toBe('alicedoe');
    });
});

// ─── Index record ──────────────────────────────────────────────────────────

describe('redactIndexRecord', () => {
    it('with no index_source_uri rule keeps sourceId', () => {
        const out = redactIndexRecord(indexRecord, [rule('entity_attributes', 'strip')]);
        expect(out).toEqual(indexRecord);
    });

    it.each(['strip', 'mask', 'summarize'] as const)('%s replaces sourceId with the sentinel and keeps the rest', (behavior) => {
        const out = redactIndexRecord(indexRecord, [rule('index_source_uri', behavior)]);
        expect(out.sourceId).toBe(REDACTED);
        expect(out.sourceStore).toBe('canonical');
        expect(out.text).toBe('document: Roadmap');
    });

    it('hash exposes only the length of the source id', () => {
        const out = redactIndexRecord(indexRecord, [rule('index_source_uri', 'hash')]);
        expect(out.sourceId).toBe('sha256:redacted:9');
        expect(out.sourceId).not.toContain('12345');
    });

    it('an unknown runtime behaviour falls back to the sentinel', () => {
        const out = redactIndexRecord(indexRecord, [rule('index_source_uri', 'bogus-runtime-behavior')]);
        expect(out.sourceId).toBe(REDACTED);
    });

    it('unknown sidecar fields on the record become markers', () => {
        const out = redactIndexRecord({ ...indexRecord, rawVector: [0.1, 0.2] } as unknown as IndexRecord, []) as unknown as Record<string, unknown>;
        expect(out.rawVector).toEqual({ _redacted: true, kind: 'array', reason: 'unknown_field' });
    });
});

describe('redactIndexSourceUri (legacy helper)', () => {
    it('returns the record unchanged when no index_source_uri rule is present', () => {
        const rec = { sourceId: 'ent-1', sourceStore: 'canonical' };
        expect(redactIndexSourceUri(rec, [rule('entity_attributes', 'strip')])).toBe(rec);
    });

    it('replaces sourceId (whatever the behaviour) and keeps sourceStore', () => {
        const rec = { sourceId: 'ent-1', sourceStore: 'canonical' };
        expect(redactIndexSourceUri(rec, [rule('index_source_uri', 'hash')])).toEqual({
            sourceId: REDACTED,
            sourceStore: 'canonical',
        });
    });
});

// ─── Error-message path scrubber ───────────────────────────────────────────

describe('redactErrorMessage', () => {
    it('scrubs a posix absolute path out of an Error message', () => {
        expect(redactErrorMessage(new Error('ENOENT: no such file /var/lib/app/secret.json'))).toBe(
            'ENOENT: no such file <path>',
        );
    });

    it('scrubs windows drive paths (both separators) and UNC paths', () => {
        expect(redactErrorMessage('cannot open C:\\Users\\alicedoe\\AppData\\x.db now')).toBe('cannot open <path> now');
        expect(redactErrorMessage('cannot open D:/work/alicedoe/x.db now')).toBe('cannot open <path> now');
        expect(redactErrorMessage('share \\\\fileserver\\public\\x.db gone')).toBe('share <path> gone');
    });

    it('scrubs home-relative, dot-relative and bare relative paths', () => {
        expect(redactErrorMessage('read ~/notes/a.txt failed')).toBe('read <path> failed');
        expect(redactErrorMessage('read ./data/a.txt failed')).toBe('read <path> failed');
        expect(redactErrorMessage('read ../up/a.txt failed')).toBe('read <path> failed');
        expect(redactErrorMessage('Users\\alicedoe\\AppData\\secret.dat unreadable')).toBe('<path> unreadable');
        expect(redactErrorMessage('foo/bar/baz unreadable')).toBe('<path> unreadable');
    });

    it('leaves separator-free tokens alone (versions, hostnames, plain prose)', () => {
        const msg = 'upgrade to 1.2.3 via example.com for the retry';
        expect(redactErrorMessage(msg)).toBe(msg);
    });

    it('does not run away across whitespace into surrounding prose', () => {
        expect(redactErrorMessage('failed at /opt/app/x.js while loading plugin')).toBe(
            'failed at <path> while loading plugin',
        );
    });

    it('uses the error name when the message is empty', () => {
        const err = new Error('');
        err.name = 'ExplosionError';
        expect(redactErrorMessage(err)).toBe('ExplosionError');
    });

    it('falls back to "unknown error" for an Error with neither message nor name', () => {
        const err = new Error('');
        err.name = '';
        expect(redactErrorMessage(err)).toBe('unknown error');
    });

    it('passes a plain string through the scrubber', () => {
        expect(redactErrorMessage('bad file /etc/hosts')).toBe('bad file <path>');
    });

    it('returns "unknown error" for null and undefined', () => {
        expect(redactErrorMessage(null)).toBe('unknown error');
        expect(redactErrorMessage(undefined)).toBe('unknown error');
    });

    it('stringifies other values (and scrubs paths in the result)', () => {
        expect(redactErrorMessage(404)).toBe('404');
        expect(redactErrorMessage({ toString: () => 'boom at /srv/app/x' })).toBe('boom at <path>');
    });

    it('PATH_REGEX is global so every path in one message is scrubbed', () => {
        expect(PATH_REGEX.global).toBe(true);
        expect(redactErrorMessage('copy /a/b to /c/d')).toBe('copy <path> to <path>');
    });
});
