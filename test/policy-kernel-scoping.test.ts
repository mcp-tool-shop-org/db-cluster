/**
 * What the policy-enforced kernel lets each caller see and do, checked per
 * verb and per item.
 *
 * test/policy-kernel.test.ts proves the coarse gate: a principal with no
 * grant is refused. The mutation run (docs/release-readiness.md, Stryker
 * section) showed what it leaves unproven. Nothing failed when a verb stopped
 * passing its store, verb or resource to the gate, when findSources stopped
 * filtering index records, when retrieveBundle stopped pruning the evidence
 * of objects it had filtered out, or when a session's trust zone stopped
 * overriding the principal's default. Each describe block below pins one of
 * those behaviours from the caller's side: which calls succeed, which items
 * come back, and what is redacted.
 *
 * Every cluster is seeded through an unpoliced ClusterKernel on the same
 * stores and data dir, the way an operator's recovery path writes, and the
 * policed kernel under test is built afterwards so it loads the same queue.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalCluster } from '../src/adapters/local/index.js';
import { ClusterKernel } from '../src/kernel/cluster-kernel.js';
import { NotFoundError } from '../src/kernel/errors.js';
import { PolicyEnforcedKernel, PolicyDeniedError } from '../src/kernel/policy-enforced-kernel.js';
import type { PolicyContext } from '../src/kernel/policy-enforced-kernel.js';
import { recordProvenance } from '../src/kernel/provenance.js';
import { errorToAiEnvelope } from '../src/policy/error-formatter.js';
import { REDACTED } from '../src/policy/redactor.js';
import type { ClusterStores } from '../src/contracts/index.js';
import type { Entity } from '../src/types/entity.js';
import type { Artifact } from '../src/types/artifact.js';
import type {
    Capability,
    Policy,
    PolicyMatch,
    Principal,
    RedactionRule,
    TrustZone,
    VisibilityRule,
} from '../src/types/policy.js';

// ─── Fixture ──────────────────────────────────────────────────────────────

const reader: Principal = { id: 'reader-1', name: 'Reader', roles: ['reader'], trustZone: 'internal' };

const ALL_CAPABILITIES: Capability[] = [
    'discover_existence', 'read_owner_truth', 'read_derivative', 'trace_provenance',
    'propose_mutation', 'validate_command', 'approve_command', 'reject_command',
    'commit_command', 'compensate_command', 'read_receipts', 'read_command', 'explain_retrieval',
];

/** Visibility rule that discloses every store; findSources vetoes index records without one. */
const ALL_VISIBLE: VisibilityRule = {
    id: 'all-visible',
    scope: { stores: ['*'] },
    existenceVisible: true,
    emitPlaceholder: false,
};

function allow(id: string, capabilities: Capability[], match: Partial<PolicyMatch> = {}, priority = 20, redaction?: RedactionRule): Policy {
    return {
        id,
        name: id,
        priority,
        match: { principals: ['reader'], capabilities, ...match },
        decision: 'allow',
        reason: `${id} grants it.`,
        ...(redaction ? { redaction } : {}),
    };
}

function deny(id: string, capabilities: Capability[], match: Partial<PolicyMatch> = {}, priority = 10): Policy {
    return {
        id,
        name: id,
        priority,
        match: { principals: ['reader'], capabilities, ...match },
        decision: 'deny',
        reason: `${id} refuses it.`,
    };
}

function strip(target: RedactionRule['target']): RedactionRule {
    return { id: `strip-${target}`, target, behavior: 'strip', reason: `${target} is withheld.` };
}

interface Fixture {
    dir: string;
    stores: ClusterStores;
    raw: ClusterKernel;
    entity: Entity;
    artifact: Artifact;
    entityUri: string;
    artifactUri: string;
}

const dirs: string[] = [];

afterEach(() => {
    for (const d of dirs.splice(0)) {
        try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
    }
});

/**
 * One entity and one artifact, both matching the query "zebra": the index
 * holds `concept: Zebra Handbook` and `zebra.md [text/markdown]`.
 */
async function seed(): Promise<Fixture> {
    const dir = mkdtempSync(join(tmpdir(), 'policy-scoping-'));
    dirs.push(dir);
    const stores = createLocalCluster(dir);
    const raw = new ClusterKernel(stores, { dataDir: dir });
    const { entity } = await raw.createEntity({
        kind: 'concept',
        name: 'Zebra Handbook',
        attributes: { habitat: 'savanna' },
        actorId: 'operator',
    });
    const { artifact } = await raw.ingestArtifact({
        filename: 'zebra.md',
        content: Buffer.from('zebra stripes are unique to each animal'),
        mimeType: 'text/markdown',
        actorId: 'operator',
    });
    return {
        dir,
        stores,
        raw,
        entity,
        artifact,
        entityUri: `cluster://canonical/${entity.id}`,
        artifactUri: `cluster://artifact/${artifact.id}`,
    };
}

function policed(
    f: Fixture,
    policies: Policy[],
    opts: { context?: Partial<PolicyContext>; visibilityRules?: VisibilityRule[]; trustZones?: TrustZone[] } = {},
): PolicyEnforcedKernel {
    return new PolicyEnforcedKernel(
        f.stores,
        { principal: reader, ...opts.context },
        { policies, visibilityRules: opts.visibilityRules ?? [], trustZones: opts.trustZones, dataDir: f.dir },
    );
}

/** Commit an update_entity command through the raw kernel; returns its id. */
async function commitUpdate(f: Fixture): Promise<string> {
    const cmd = await f.raw.proposeMutation({
        verb: 'update_entity',
        targetStore: 'canonical',
        payload: { entityId: f.entity.id, patch: { attributes: { habitat: 'grassland' } } },
        proposedBy: 'operator',
    });
    await f.raw.validateMutation(cmd.id);
    await f.raw.commitMutation(cmd.id, 'operator');
    return cmd.id;
}

async function denialOf(p: Promise<unknown>): Promise<PolicyDeniedError> {
    try {
        await p;
    } catch (err) {
        if (err instanceof PolicyDeniedError) return err;
        throw err;
    }
    throw new Error('expected a PolicyDeniedError, the call succeeded');
}

const sourceIds = (records: Array<{ sourceId: string }>) => records.map((r) => r.sourceId).sort();

// ─── PolicyDeniedError ────────────────────────────────────────────────────

describe('a denial names what would unlock the call', () => {
    it('the hint names the capability to acquire and the principal to grant it to', async () => {
        const f = await seed();
        const err = await denialOf(policed(f, []).inspectEntity(f.entity.id));
        expect(err.decision.capability).toBe('read_owner_truth');
        expect(err.remediationHint).toContain("'read_owner_truth' capability");
        expect(err.remediationHint).toContain('for principal reader-1');
        expect(err.remediationHint).toContain('`db-cluster policy explain`');
        const envelope = errorToAiEnvelope(err);
        expect(envelope.remediation_hint).toBe(err.remediationHint);
        expect(envelope.context).toMatchObject({ capability: 'read_owner_truth', principalId: 'reader-1' });
    });
});

// ─── Scoped grants, verb by verb ──────────────────────────────────────────

/**
 * Each verb must hand the gate the store, command verb or resource it acts
 * on. A grant scoped to exactly that is then enough; the same grant scoped to
 * something else is not (the engine refuses an allow whose constraint the
 * request leaves unspecified, so a verb that drops its scope is denied).
 */
interface ScopedCase {
    verb: string;
    grant: (f: Fixture, commandId: string) => Policy[];
    elsewhere: (f: Fixture, commandId: string) => Policy[];
    call: (k: PolicyEnforcedKernel, f: Fixture, commandId: string) => Promise<unknown>;
    /** Commit a command first, for the verbs that act on one. */
    needsCommand?: boolean;
}

const SCOPED: ScopedCase[] = [
    {
        verb: 'findSources (the index store)',
        grant: () => [allow('discover-index', ['discover_existence'], { stores: ['index'] })],
        elsewhere: () => [allow('discover-canonical', ['discover_existence'], { stores: ['canonical'] })],
        call: (k) => k.findSources({ query: 'zebra' }),
    },
    {
        verb: 'retrieveBundle (the index store)',
        grant: () => [allow('derive-index', ['read_derivative'], { stores: ['index'] })],
        elsewhere: () => [allow('derive-artifact', ['read_derivative'], { stores: ['artifact'] })],
        call: (k) => k.retrieveBundle('zebra'),
    },
    {
        verb: 'traceObject (the traced URI)',
        grant: (f) => [allow('trace-it', ['trace_provenance'], { uriPatterns: [f.entityUri] })],
        elsewhere: () => [allow('trace-other', ['trace_provenance'], { uriPatterns: ['cluster://canonical/other'] })],
        call: (k, f) => k.traceObject(f.entityUri),
    },
    {
        verb: 'why (the explained URI)',
        grant: (f) => [allow('why-it', ['trace_provenance'], { uriPatterns: [f.entityUri] })],
        elsewhere: () => [allow('why-other', ['trace_provenance'], { uriPatterns: ['cluster://canonical/other'] })],
        call: (k, f) => k.why(f.entityUri),
    },
    {
        verb: 'traceProvenance (the subject URI)',
        grant: (f) => [allow('trace-subject', ['trace_provenance'], { uriPatterns: [f.entityUri] })],
        elsewhere: () => [allow('trace-other', ['trace_provenance'], { uriPatterns: ['cluster://canonical/other'] })],
        call: (k, f) => k.traceProvenance(f.entity.id),
    },
    {
        verb: 'proposeMutation (target store and verb)',
        grant: () => [allow('propose-create', ['propose_mutation'], { stores: ['canonical'], commandVerbs: ['create_entity'] })],
        elsewhere: () => [allow('propose-update', ['propose_mutation'], { stores: ['canonical'], commandVerbs: ['update_entity'] })],
        call: (k) => k.proposeMutation({
            verb: 'create_entity',
            targetStore: 'canonical',
            payload: { kind: 'concept', name: 'Okapi' },
            proposedBy: 'reader-1',
        }),
    },
    {
        verb: 'inspectCommand (the command URI)',
        needsCommand: true,
        grant: (_f, id) => [allow('read-it', ['read_command'], { uriPatterns: [`cluster://ledger/${id}`] })],
        elsewhere: () => [allow('read-other', ['read_command'], { uriPatterns: ['cluster://ledger/other'] })],
        call: (k, _f, id) => k.inspectCommand(id),
    },
    {
        verb: 'compensateMutation (original store, verb compensate)',
        needsCommand: true,
        grant: () => [allow('compensate', ['compensate_command'], { stores: ['canonical'], commandVerbs: ['compensate'] })],
        elsewhere: () => [allow('compensate-update', ['compensate_command'], { stores: ['canonical'], commandVerbs: ['update_entity'] })],
        call: (k, _f, id) => k.compensateMutation(id, 'reader-1', 'undo'),
    },
    {
        verb: 'explainIndex (the index store)',
        grant: () => [allow('explain-index', ['explain_retrieval'], { stores: ['index'] })],
        elsewhere: () => [allow('explain-canonical', ['explain_retrieval'], { stores: ['canonical'] })],
        call: async (k, f) => {
            const [record] = await f.stores.index.search({ text: 'handbook' });
            return k.explainIndex(record.id);
        },
    },
    {
        verb: 'indexStatus (the index store)',
        grant: () => [allow('derive-index', ['read_derivative'], { stores: ['index'] })],
        elsewhere: () => [allow('derive-artifact', ['read_derivative'], { stores: ['artifact'] })],
        call: (k) => k.indexStatus(),
    },
    {
        verb: 'rebuildIndex (verb reindex)',
        grant: () => [allow('reindex', ['commit_command'], { commandVerbs: ['reindex'] })],
        elsewhere: () => [allow('create', ['commit_command'], { commandVerbs: ['create_entity'] })],
        call: (k) => k.rebuildIndex('reader-1'),
    },
    {
        verb: 'linkEvidence (canonical store, verb link_evidence)',
        grant: () => [allow('link', ['commit_command'], { stores: ['canonical'], commandVerbs: ['link_evidence'] })],
        elsewhere: () => [allow('create', ['commit_command'], { stores: ['canonical'], commandVerbs: ['create_entity'] })],
        call: (k, f) => k.linkEvidence({ artifactId: f.artifact.id, entityId: f.entity.id, actorId: 'reader-1' }),
    },
    {
        verb: 'listReceipts (the ledger store)',
        grant: () => [allow('receipts-ledger', ['read_receipts'], { stores: ['ledger'] })],
        elsewhere: () => [allow('receipts-canonical', ['read_receipts'], { stores: ['canonical'] })],
        call: (k) => k.listReceipts(),
    },
    {
        verb: 'listCommands (the ledger store)',
        grant: () => [allow('commands-ledger', ['read_command'], { stores: ['ledger'] })],
        elsewhere: () => [allow('commands-canonical', ['read_command'], { stores: ['canonical'] })],
        call: (k) => k.listCommands(),
    },
    {
        verb: 'listStaleRecords (the index store)',
        grant: () => [allow('explain-index', ['explain_retrieval'], { stores: ['index'] })],
        elsewhere: () => [allow('explain-canonical', ['explain_retrieval'], { stores: ['canonical'] })],
        call: (k) => k.listStaleRecords(),
    },
    {
        verb: 'ingestArtifact (artifact store, verb ingest_artifact)',
        grant: () => [allow('ingest', ['commit_command'], { stores: ['artifact'], commandVerbs: ['ingest_artifact'] })],
        elsewhere: () => [allow('create', ['commit_command'], { stores: ['artifact'], commandVerbs: ['create_entity'] })],
        call: (k) => k.ingestArtifact({
            filename: 'okapi.md',
            content: Buffer.from('okapi'),
            mimeType: 'text/markdown',
            actorId: 'reader-1',
        }),
    },
    {
        verb: 'createEntity (canonical store, verb create_entity)',
        grant: () => [allow('create', ['commit_command'], { stores: ['canonical'], commandVerbs: ['create_entity'] })],
        elsewhere: () => [allow('ingest', ['commit_command'], { stores: ['canonical'], commandVerbs: ['ingest_artifact'] })],
        call: (k) => k.createEntity({ kind: 'concept', name: 'Okapi', attributes: {}, actorId: 'reader-1' }),
    },
];

describe('a grant scoped to what a verb touches is honoured', () => {
    for (const c of SCOPED) {
        it(c.verb, async () => {
            const f = await seed();
            const id = c.needsCommand ? await commitUpdate(f) : '';
            // The out-of-scope twin first: compensating is not repeatable.
            await denialOf(c.call(policed(f, c.elsewhere(f, id)), f, id));
            await expect(c.call(policed(f, c.grant(f, id)), f, id)).resolves.toBeDefined();
        });
    }

    it('compensating an unknown command with a compensate grant reaches the kernel, which reports it missing', async () => {
        const f = await seed();
        const grant = [allow('compensate', ['compensate_command'], { commandVerbs: ['compensate'] })];
        await expect(policed(f, grant).compensateMutation('no-such-command', 'reader-1', 'undo'))
            .rejects.toBeInstanceOf(NotFoundError);
        const elsewhere = [allow('compensate-update', ['compensate_command'], { commandVerbs: ['update_entity'] })];
        await denialOf(policed(f, elsewhere).compensateMutation('no-such-command', 'reader-1', 'undo'));
    });
});

// ─── Per-item decisions ───────────────────────────────────────────────────

/**
 * A list verb decides each item against that item's own URI. A rule scoped
 * to the item's URI prefix therefore governs it, here visibly: the URI-scoped
 * grant carries a redaction and outranks a plain store grant that does not.
 */
describe('each item a list returns is decided against its own URI', () => {
    it('findSources redacts entities and artifacts under their URI-scoped grants', async () => {
        const f = await seed();
        const k = policed(f, [
            allow('discover', ['discover_existence']),
            allow('entity-by-uri', ['read_owner_truth'], { uriPatterns: ['cluster://canonical/'] }, 5, strip('entity_attributes')),
            allow('artifact-by-uri', ['read_owner_truth'], { uriPatterns: ['cluster://artifact/'] }, 5, strip('artifact_content')),
            allow('owner', ['read_owner_truth'], { stores: ['canonical', 'artifact'] }, 10),
        ]);
        const result = await k.findSources({ query: 'zebra' });
        expect(result.resolvedEntities.map((e) => e.id)).toEqual([f.entity.id]);
        expect(result.resolvedEntities[0].attributes).toEqual({});
        expect(result.resolvedArtifacts.map((a) => a.id)).toEqual([f.artifact.id]);
        expect(result.resolvedArtifacts[0].storagePath).toBe(REDACTED);
    });

    it('listEntityVersions and listArtifactVersions redact each version under its URI-scoped grant', async () => {
        const f = await seed();
        const k = policed(f, [
            allow('entity-by-uri', ['read_owner_truth'], { uriPatterns: [f.entityUri] }, 5, strip('entity_attributes')),
            allow('artifact-by-uri', ['read_owner_truth'], { uriPatterns: [f.artifactUri] }, 5, strip('artifact_content')),
            allow('owner', ['read_owner_truth'], { stores: ['canonical', 'artifact'] }, 10),
        ]);
        const versions = await k.listEntityVersions(f.entity.id);
        expect(versions).toHaveLength(1);
        expect(versions[0].attributes).toEqual({});
        const artifacts = await k.listArtifactVersions('zebra.md');
        expect(artifacts.map((a) => a.id)).toEqual([f.artifact.id]);
        expect(artifacts[0].storagePath).toBe(REDACTED);
    });

    it('inspectEntity and getEntityVersion redact the entity under its URI-scoped grant', async () => {
        const f = await seed();
        const k = policed(f, [
            allow('entity-by-uri', ['read_owner_truth'], { uriPatterns: [f.entityUri] }, 5, strip('entity_attributes')),
            allow('owner', ['read_owner_truth'], { stores: ['canonical'] }, 10),
        ]);
        expect((await k.inspectEntity(f.entity.id)).attributes).toEqual({});
        expect((await k.getEntityVersion(f.entity.id, 1))?.attributes).toEqual({});
    });

    it('listReceipts and listCommands redact each item under its URI-scoped grant', async () => {
        const f = await seed();
        await commitUpdate(f);
        const k = policed(f, [
            allow('receipt-by-uri', ['read_receipts'], { uriPatterns: ['cluster://receipt/'] }, 5, strip('receipt_details')),
            allow('command-by-uri', ['read_command'], { uriPatterns: ['cluster://ledger/'] }, 5, strip('command_payload')),
            allow('ledger', ['read_receipts', 'read_command'], { stores: ['ledger'] }, 10),
        ]);
        const receipts = await k.listReceipts();
        expect(receipts.length).toBeGreaterThan(0);
        for (const r of receipts) expect(r.resultSummary).toBe(REDACTED);
        const commands = await k.listCommands();
        expect(commands.length).toBeGreaterThan(0);
        for (const c of commands) expect(c.payload).toEqual({});
    });
});

describe('the direct write helpers return what they wrote, redacted under the grant that allowed it', () => {
    it('ingestArtifact and createEntity', async () => {
        const f = await seed();
        const k = policed(f, [
            allow('ingest', ['commit_command'], { commandVerbs: ['ingest_artifact'] }, 20, strip('artifact_content')),
            allow('create', ['commit_command'], { commandVerbs: ['create_entity'] }, 20, strip('entity_attributes')),
        ]);
        const ingested = await k.ingestArtifact({ filename: 'okapi.md', content: Buffer.from('okapi'), mimeType: 'text/markdown', actorId: 'reader-1' });
        expect(ingested.artifact.storagePath).toBe(REDACTED);
        const created = await k.createEntity({ kind: 'concept', name: 'Okapi', attributes: { habitat: 'forest' }, actorId: 'reader-1' });
        expect(created.entity.attributes).toEqual({});
        // The stores hold the unredacted truth.
        expect((await f.raw.inspectEntity(created.entity.id)).attributes).toEqual({ habitat: 'forest' });
    });
});

// ─── findSources: index records ───────────────────────────────────────────

/**
 * An index record mirrors its source (the entity's kind and name, the
 * artifact's filename), so findSources shows it only to a caller who may
 * read the derivative AND the source's owner truth, and only when
 * visibility rules disclose the source.
 */
describe('findSources shows an index record only to a caller who may read its source', () => {
    const everything = (extra: Policy[] = []) => [
        allow('discover', ['discover_existence']),
        allow('derive', ['read_derivative']),
        ...extra,
    ];

    it('a caller who may read everything gets both records and no empty-result note', async () => {
        const f = await seed();
        const k = policed(f, everything([allow('owner', ['read_owner_truth'])]), { visibilityRules: [ALL_VISIBLE] });
        const result = await k.findSources({ query: 'zebra' });
        expect(sourceIds(result.indexRecords)).toEqual([f.artifact.id, f.entity.id].sort());
        expect(result._meta).toBeUndefined();
    });

    it('a caller who may read only artifacts gets the artifact record, not the entity record', async () => {
        const f = await seed();
        const k = policed(f, everything([allow('owner-artifact', ['read_owner_truth'], { stores: ['artifact'] })]), { visibilityRules: [ALL_VISIBLE] });
        const result = await k.findSources({ query: 'zebra' });
        expect(sourceIds(result.indexRecords)).toEqual([f.artifact.id]);
        expect(result.resolvedEntities).toEqual([]);
    });

    it('a caller who may read only entities gets the entity record, not the artifact record', async () => {
        const f = await seed();
        const k = policed(f, everything([allow('owner-canonical', ['read_owner_truth'], { stores: ['canonical'] })]), { visibilityRules: [ALL_VISIBLE] });
        const result = await k.findSources({ query: 'zebra' });
        expect(sourceIds(result.indexRecords)).toEqual([f.entity.id]);
        expect(result.resolvedArtifacts).toEqual([]);
    });

    it('a caller who may read owner truth but not derivatives gets the objects and no records', async () => {
        const f = await seed();
        const k = policed(f, [allow('discover', ['discover_existence']), allow('owner', ['read_owner_truth'])], { visibilityRules: [ALL_VISIBLE] });
        const result = await k.findSources({ query: 'zebra' });
        expect(result.indexRecords).toEqual([]);
        expect(result.resolvedEntities).toHaveLength(1);
        expect(result.resolvedArtifacts).toHaveLength(1);
    });

    it('a caller whose owner grant is scoped to the entity kind still gets that entity record', async () => {
        const f = await seed();
        const k = policed(f, everything([allow('owner-concepts', ['read_owner_truth'], { stores: ['canonical'], kinds: ['concept'] })]), { visibilityRules: [ALL_VISIBLE] });
        const result = await k.findSources({ query: 'zebra' });
        expect(result.resolvedEntities.map((e) => e.id)).toEqual([f.entity.id]);
        expect(sourceIds(result.indexRecords)).toEqual([f.entity.id]);
    });

    it('a derivative grant scoped to entity URIs yields the entity record only', async () => {
        const f = await seed();
        const k = policed(f, [
            allow('discover', ['discover_existence']),
            allow('derive-entities', ['read_derivative'], { uriPatterns: ['cluster://canonical/'] }),
            allow('owner', ['read_owner_truth']),
        ], { visibilityRules: [ALL_VISIBLE] });
        const result = await k.findSources({ query: 'zebra' });
        expect(sourceIds(result.indexRecords)).toEqual([f.entity.id]);
    });

    it('a record derived from the ledger needs only the derivative grant', async () => {
        const f = await seed();
        await f.stores.index.index({ sourceId: 'event-1', sourceStore: 'ledger', text: 'zebra ledger note', metadata: {} });
        const k = policed(f, everything([allow('owner-canonical', ['read_owner_truth'], { stores: ['canonical'] })]), { visibilityRules: [ALL_VISIBLE] });
        const result = await k.findSources({ query: 'zebra' });
        expect(sourceIds(result.indexRecords)).toEqual(['event-1', f.entity.id].sort());
    });

    it('a record whose source a visibility rule hides is dropped', async () => {
        const f = await seed();
        const hideCanonical: VisibilityRule = { id: 'hide-canonical', scope: { stores: ['canonical'] }, existenceVisible: false, emitPlaceholder: false };
        const k = policed(f, everything([allow('owner', ['read_owner_truth'])]), { visibilityRules: [hideCanonical, ALL_VISIBLE] });
        const result = await k.findSources({ query: 'zebra' });
        expect(sourceIds(result.indexRecords)).toEqual([f.artifact.id]);
    });

    describe('a record whose source no longer resolves', () => {
        async function withGhosts() {
            const f = await seed();
            await f.stores.index.index({ sourceId: 'ghost-entity', sourceStore: 'canonical', text: 'concept: Zebra Ghost', metadata: {} });
            await f.stores.index.index({ sourceId: 'ghost-artifact', sourceStore: 'artifact', text: 'zebra-ghost.md [text/markdown]', metadata: {} });
            return f;
        }

        it('is shown to a caller who may read that store, as a result, not an empty one', async () => {
            const f = await withGhosts();
            const k = policed(f, everything([allow('owner', ['read_owner_truth'])]), { visibilityRules: [ALL_VISIBLE] });
            const result = await k.findSources({ query: 'ghost' });
            expect(result.resolvedEntities).toEqual([]);
            expect(result.resolvedArtifacts).toEqual([]);
            expect(sourceIds(result.indexRecords)).toEqual(['ghost-artifact', 'ghost-entity']);
            expect(result._meta).toBeUndefined();
        });

        it('is withheld from a caller who may not read that store', async () => {
            const f = await withGhosts();
            const canonicalOnly = policed(f, everything([allow('owner-canonical', ['read_owner_truth'], { stores: ['canonical'] })]), { visibilityRules: [ALL_VISIBLE] });
            expect(sourceIds((await canonicalOnly.findSources({ query: 'ghost' })).indexRecords)).toEqual(['ghost-entity']);
            const artifactOnly = policed(f, everything([allow('owner-artifact', ['read_owner_truth'], { stores: ['artifact'] })]), { visibilityRules: [ALL_VISIBLE] });
            expect(sourceIds((await artifactOnly.findSources({ query: 'ghost' })).indexRecords)).toEqual(['ghost-artifact']);
        });

        it('is listed as stale only when its source is disclosed', async () => {
            const f = await withGhosts();
            const hideGhost: VisibilityRule = { id: 'hide-ghost', scope: { stores: ['*'], uris: ['cluster://canonical/ghost-entity'] }, existenceVisible: false, emitPlaceholder: false };
            const k = policed(f, [allow('explain', ['explain_retrieval'])], { visibilityRules: [hideGhost, ALL_VISIBLE] });
            const stale = await k.listStaleRecords();
            expect(stale.map((s) => s.sourceId)).toEqual(['ghost-artifact']);
        });
    });
});

// ─── findSources: why a result is empty ───────────────────────────────────

describe('findSources says why a result is empty, and only when it is', () => {
    const fullReader = [allow('all', ALL_CAPABILITIES)];

    it('no note when entities come back but their records are not disclosed', async () => {
        const f = await seed();
        const result = await policed(f, fullReader).findSources({ query: 'handbook' });
        expect(result.resolvedEntities.map((e) => e.id)).toEqual([f.entity.id]);
        expect(result.indexRecords).toEqual([]);
        expect(result._meta).toBeUndefined();
    });

    it('no note when artifacts come back but their records are not disclosed', async () => {
        const f = await seed();
        const result = await policed(f, fullReader).findSources({ query: 'markdown' });
        expect(result.resolvedArtifacts.map((a) => a.id)).toEqual([f.artifact.id]);
        expect(result.indexRecords).toEqual([]);
        expect(result._meta).toBeUndefined();
    });

    it("a query that matches nothing keeps the kernel's no_match note", async () => {
        const f = await seed();
        const result = await policed(f, fullReader).findSources({ query: 'okapi' });
        expect(result._meta?.empty_reason).toBe('no_match');
    });

    it('matches the policy removed are counted, and the hint names the capabilities that would show them', async () => {
        const f = await seed();
        const result = await policed(f, [allow('discover', ['discover_existence'])]).findSources({ query: 'zebra' });
        expect(result.indexRecords).toEqual([]);
        expect(result.resolvedEntities).toEqual([]);
        expect(result.resolvedArtifacts).toEqual([]);
        // Two index records, one entity and one artifact matched before policy.
        expect(result._meta).toMatchObject({ empty_reason: 'all_filtered_by_policy', filteredCount: 4 });
        const hint = String(result._meta?.remediation_hint);
        expect(hint).toMatch(/^4 record\(s\) matched the query but were filtered out by policy/);
        expect(hint).toContain("'read_owner_truth'");
        expect(hint).toContain("'read_derivative'");
        expect(hint).toContain('grant the role/scope');
    });
});

// ─── retrieveBundle ───────────────────────────────────────────────────────

describe('retrieveBundle carries evidence only for objects the caller may read', () => {
    const derive = allow('derive', ['read_derivative']);

    it('a caller who may read everything gets both objects, their records, their events and the snippet', async () => {
        const f = await seed();
        const bundle = await policed(f, [derive, allow('owner', ['read_owner_truth'])]).retrieveBundle('zebra');
        expect(bundle.resolvedEntities.map((r) => r.object.id)).toEqual([f.entity.id]);
        expect(bundle.resolvedArtifacts.map((r) => r.object.id)).toEqual([f.artifact.id]);
        expect(bundle.resolvedArtifacts[0].snippet).toContain('zebra stripes');
        expect(sourceIds(bundle.indexRecords)).toEqual([f.artifact.id, f.entity.id].sort());
        expect(bundle.provenanceEvents.map((e) => e.subjectId).sort()).toEqual([f.artifact.id, f.entity.id].sort());
    });

    it('an entity the caller may not read leaves no record or event behind', async () => {
        const f = await seed();
        const bundle = await policed(f, [derive, allow('owner-artifact', ['read_owner_truth'], { stores: ['artifact'] })]).retrieveBundle('zebra');
        expect(bundle.resolvedEntities).toEqual([]);
        expect(bundle.resolvedArtifacts.map((r) => r.object.id)).toEqual([f.artifact.id]);
        expect(sourceIds(bundle.indexRecords)).toEqual([f.artifact.id]);
        expect(bundle.provenanceEvents.map((e) => e.subjectId)).toEqual([f.artifact.id]);
    });

    it('an artifact the caller may not read leaves no record or event behind', async () => {
        const f = await seed();
        const bundle = await policed(f, [derive, allow('owner-canonical', ['read_owner_truth'], { stores: ['canonical'] })]).retrieveBundle('zebra');
        expect(bundle.resolvedArtifacts).toEqual([]);
        expect(bundle.resolvedEntities.map((r) => r.object.id)).toEqual([f.entity.id]);
        expect(sourceIds(bundle.indexRecords)).toEqual([f.entity.id]);
        expect(bundle.provenanceEvents.map((e) => e.subjectId)).toEqual([f.entity.id]);
    });

    it("each object is redacted under its own owner-truth decision", async () => {
        const f = await seed();
        const bundle = await policed(f, [
            derive,
            allow('owner-canonical', ['read_owner_truth'], { stores: ['canonical'] }, 20, strip('entity_attributes')),
            // A label-only redaction: the content excerpt is still allowed.
            allow('owner-artifact', ['read_owner_truth'], { stores: ['artifact'] }, 20, strip('artifact_filename')),
        ]).retrieveBundle('zebra');
        expect(bundle.resolvedEntities[0].object.attributes).toEqual({});
        expect(bundle.resolvedArtifacts[0].object.storagePath).not.toBe(REDACTED);
        expect(bundle.resolvedArtifacts[0].snippet).toContain('zebra stripes');
    });

    it('a redaction on the retrieval grant itself applies to every object in the bundle', async () => {
        const f = await seed();
        const owner = allow('owner', ['read_owner_truth']);
        const entities = await policed(f, [allow('derive', ['read_derivative'], {}, 20, strip('entity_attributes')), owner]).retrieveBundle('zebra');
        expect(entities.resolvedEntities[0].object.attributes).toEqual({});
        const artifacts = await policed(f, [allow('derive', ['read_derivative'], {}, 20, strip('artifact_content')), owner]).retrieveBundle('zebra');
        expect(artifacts.resolvedArtifacts[0].object.storagePath).toBe(REDACTED);
        expect(artifacts.resolvedArtifacts[0]).not.toHaveProperty('snippet');
    });

    it('ledger events about a resolved subject are surfaced without their detail, unless their store claim is forged', async () => {
        const f = await seed();
        const claims: Array<string | undefined> = [undefined, 'canonical', 'artifact', 'index', 'ledger'];
        for (const targetStore of claims) {
            await recordProvenance(f.stores.ledger, `note_${targetStore ?? 'none'}`, 'operator', f.entity.id, 'ledger',
                targetStore === undefined ? { secret: 'kept out' } : { targetStore, secret: 'kept out' });
        }
        await recordProvenance(f.stores.ledger, 'note_forged', 'operator', f.entity.id, 'ledger', { targetStore: 'elsewhere' });
        await recordProvenance(f.stores.ledger, 'index_note', 'operator', f.entity.id, 'index', { secret: 'kept out' });

        const bundle = await policed(f, [derive, allow('owner', ['read_owner_truth'])]).retrieveBundle('zebra');
        const ledgerEvents = bundle.provenanceEvents.filter((e) => e.subjectStore === 'ledger' || e.subjectStore === 'index');
        expect(ledgerEvents.map((e) => e.action).sort()).toEqual(
            ['index_note', 'note_artifact', 'note_canonical', 'note_index', 'note_ledger', 'note_none'],
        );
        for (const e of ledgerEvents) expect(e.detail).toEqual({});
    });

    it('a ledger event is surfaced only to a caller who may read derivatives of the store it names', async () => {
        const f = await seed();
        await recordProvenance(f.stores.ledger, 'note_none', 'operator', f.entity.id, 'ledger', {});
        await recordProvenance(f.stores.ledger, 'note_index', 'operator', f.entity.id, 'ledger', { targetStore: 'index' });
        await recordProvenance(f.stores.ledger, 'note_canonical', 'operator', f.entity.id, 'ledger', { targetStore: 'canonical' });
        const owner = allow('owner', ['read_owner_truth']);
        const ledgerActions = async (policies: Policy[]) => (await policed(f, policies).retrieveBundle('zebra'))
            .provenanceEvents.filter((e) => e.subjectStore === 'ledger').map((e) => e.action).sort();

        // An event with no store claim is decided as a ledger derivative.
        expect(await ledgerActions([allow('derive-index', ['read_derivative'], { stores: ['index'] }), owner])).toEqual(['note_index']);
        expect(await ledgerActions([
            allow('derive-index', ['read_derivative'], { stores: ['index'] }),
            allow('derive-this-subject', ['read_derivative'], { uriPatterns: [`cluster://ledger/${f.entity.id}`] }),
            owner,
        ])).toEqual(['note_canonical', 'note_index', 'note_none']);
    });
});

// ─── Target store validation ──────────────────────────────────────────────

describe('proposeMutation refuses only a store that does not exist', () => {
    const proposeAnywhere = [allow('propose', ['propose_mutation'])];

    for (const store of ['index', 'ledger'] as const) {
        it(`a proposal to the ${store} store reaches the queue`, async () => {
            const f = await seed();
            const cmd = await policed(f, proposeAnywhere).proposeMutation({
                verb: 'reindex',
                targetStore: store,
                payload: {},
                proposedBy: 'reader-1',
            });
            expect(cmd.targetStore).toBe(store);
        });
    }

    it('an unknown store is refused by the fail-closed guard, which names it and the valid stores', async () => {
        const f = await seed();
        const err = await denialOf(policed(f, proposeAnywhere).proposeMutation({
            verb: 'create_entity',
            targetStore: 'shadow' as never,
            payload: {},
            proposedBy: 'reader-1',
        }));
        expect(err.decision).toMatchObject({
            decision: 'deny',
            matchedPolicyId: '__invalid_store_deny',
            capability: 'propose_mutation',
            principalId: 'reader-1',
            requiresApproval: false,
        });
        expect(err.decision.matchedPolicyName.length).toBeGreaterThan(0);
        expect(err.decision.reason).toContain("'shadow'");
        expect(err.decision.reason).toContain('canonical, artifact, index, ledger');
    });
});

// ─── Existence oracle ─────────────────────────────────────────────────────

/**
 * A caller allowed to read entities but carrying a per-resource deny could
 * otherwise tell "exists but denied" from "does not exist". The kernel
 * answers both with the same denial, naming the resource asked about.
 */
describe('a caller with a per-resource deny cannot probe for existence', () => {
    const policies = [
        allow('owner', ['read_owner_truth'], { stores: ['canonical'] }, 5),
        deny('no-secrets', ['read_owner_truth'], { kinds: ['secret'] }, 10),
    ];

    /** The guard's decision: identifiable, explained, and not an approval gate. */
    function expectGuardDenial(err: PolicyDeniedError, resourceUri: string, capability: Capability = 'read_owner_truth') {
        expect(err.decision).toMatchObject({
            decision: 'deny',
            matchedPolicyId: '__refined_deny',
            capability,
            principalId: 'reader-1',
            resourceUri,
            requiresApproval: false,
        });
        expect(err.decision.matchedPolicyName.length).toBeGreaterThan(0);
        expect(err.decision.reason.length).toBeGreaterThan(0);
        expect(err.message).toContain(`(policy: ${err.decision.matchedPolicyName})`);
    }

    it('inspectEntity on an unknown id is a denial for that resource', async () => {
        const f = await seed();
        expectGuardDenial(await denialOf(policed(f, policies).inspectEntity('no-such-entity')), 'cluster://canonical/no-such-entity');
    });

    it('getEntityVersion on a missing version is a denial for that resource, not null', async () => {
        const f = await seed();
        expectGuardDenial(await denialOf(policed(f, policies).getEntityVersion(f.entity.id, 99)), f.entityUri);
    });

    it('inspectCommand on an unknown id is a denial for that command, under a verb-scoped deny', async () => {
        const f = await seed();
        const commandPolicies = [
            allow('commands', ['read_command'], { stores: ['ledger'] }, 5),
            deny('no-deletes', ['read_command'], { commandVerbs: ['delete_entity'] }, 10),
        ];
        expectGuardDenial(
            await denialOf(policed(f, commandPolicies).inspectCommand('no-such-command')),
            'cluster://ledger/no-such-command',
            'read_command',
        );
        await expect(policed(f, [commandPolicies[0]]).inspectCommand('no-such-command')).rejects.toBeInstanceOf(NotFoundError);
    });

    it('without a per-resource deny, an unknown id is simply not found and a missing version null', async () => {
        const f = await seed();
        await expect(policed(f, [policies[0]]).inspectEntity('no-such-entity')).rejects.toBeInstanceOf(NotFoundError);
        await expect(policed(f, [policies[0]]).getEntityVersion(f.entity.id, 99)).resolves.toBeNull();
    });

    /**
     * The guard turns "not found" into a denial exactly when a deny rule
     * that could have fired on the refined request applies to this caller:
     * a deny, for this capability, naming this principal (or everyone), and
     * conditioned on a resource URI, entity kind or command verb.
     */
    const GUARD_CASES: Array<{ rule: string; policy: Policy; guarded: boolean }> = [
        { rule: 'a deny on a kind', policy: deny('d', ['read_owner_truth'], { kinds: ['secret'] }), guarded: true },
        { rule: 'a deny on a URI prefix', policy: deny('d', ['read_owner_truth'], { uriPatterns: ['cluster://canonical/secret-'] }), guarded: true },
        { rule: 'a deny on a command verb', policy: deny('d', ['read_owner_truth'], { commandVerbs: ['delete_entity'] }), guarded: true },
        { rule: 'a kind deny that names everyone', policy: deny('d', ['read_owner_truth'], { principals: [], kinds: ['secret'] }), guarded: true },
        { rule: 'a kind deny naming this principal among others', policy: deny('d', ['read_owner_truth'], { principals: ['someone-else', 'reader'], kinds: ['secret'] }), guarded: true },
        { rule: 'an allow on a kind', policy: allow('a', ['read_owner_truth'], { kinds: ['public'] }, 10), guarded: false },
        { rule: 'a kind deny for another capability', policy: deny('d', ['read_command'], { kinds: ['secret'] }), guarded: false },
        { rule: 'a kind deny for another principal', policy: deny('d', ['read_owner_truth'], { principals: ['someone-else'], kinds: ['secret'] }), guarded: false },
        { rule: 'a deny on another store only', policy: deny('d', ['read_owner_truth'], { stores: ['artifact'] }), guarded: false },
        { rule: 'a deny with an empty kind list', policy: deny('d', ['read_owner_truth'], { stores: ['artifact'], kinds: [] }), guarded: false },
        { rule: 'a deny with an empty URI list', policy: deny('d', ['read_owner_truth'], { stores: ['artifact'], uriPatterns: [] }), guarded: false },
        { rule: 'a deny with an empty verb list', policy: deny('d', ['read_owner_truth'], { stores: ['artifact'], commandVerbs: [] }), guarded: false },
    ];

    for (const c of GUARD_CASES) {
        it(`${c.rule} ${c.guarded ? 'turns an unknown id into a denial' : 'leaves an unknown id not found'}`, async () => {
            const f = await seed();
            const lookup = policed(f, [policies[0], c.policy]).inspectEntity('no-such-entity');
            if (c.guarded) await denialOf(lookup);
            else await expect(lookup).rejects.toBeInstanceOf(NotFoundError);
        });
    }
});

// ─── Trace visibility ─────────────────────────────────────────────────────

describe('traceObject hides the nodes visibility rules hide', () => {
    it('an artifact node in a hidden store is replaced, the rest of the graph stays', async () => {
        const f = await seed();
        await f.raw.linkEvidence({ artifactId: f.artifact.id, entityId: f.entity.id, actorId: 'operator' });
        const hideArtifacts: VisibilityRule = { id: 'hide-artifacts', scope: { stores: ['artifact'] }, existenceVisible: false, emitPlaceholder: true };
        const graph = await policed(f, [allow('trace', ['trace_provenance'])], { visibilityRules: [hideArtifacts, ALL_VISIBLE] })
            .traceObject(f.entityUri);
        const artifactNode = graph.nodes.find((n) => n.uri === f.artifactUri);
        expect(artifactNode?.label).toBe('[Access restricted]');
        expect(graph.nodes.find((n) => n.uri === f.entityUri)?.label).toBe('concept: Zebra Handbook');
    });
});

// ─── explainIndex ─────────────────────────────────────────────────────────

describe('explainIndex shows the source a record mirrors, as that caller may see it', () => {
    async function recordFor(f: Fixture, text: string) {
        const [record] = await f.stores.index.search({ text });
        return record;
    }

    it('a hidden source is reported absent, not shown', async () => {
        const f = await seed();
        const hideEntity: VisibilityRule = { id: 'hide-entity', scope: { stores: ['*'], uris: [f.entityUri] }, existenceVisible: false, emitPlaceholder: false };
        const k = policed(f, [allow('explain', ['explain_retrieval'])], { visibilityRules: [hideEntity, ALL_VISIBLE] });
        const explanation = await k.explainIndex((await recordFor(f, 'handbook')).id);
        expect(explanation.sourceObject).toBeNull();
        expect(explanation.sourceExists).toBe(false);
        const visible = await k.explainIndex((await recordFor(f, 'markdown')).id);
        expect(visible.sourceExists).toBe(true);
        expect((visible.sourceObject as Artifact).id).toBe(f.artifact.id);
    });

    it('each kind of source is redacted with its own redactor', async () => {
        const f = await seed();
        const event = await recordProvenance(f.stores.ledger, 'audit_note', 'operator', f.entity.id, 'canonical', {});
        const eventRecord = await f.stores.index.index({ sourceId: event.id, sourceStore: 'ledger', text: 'audit note', metadata: {} });
        const explain = (rule: RedactionRule) => policed(f, [allow('explain', ['explain_retrieval'], {}, 20, rule)], { visibilityRules: [ALL_VISIBLE] });

        const entity = (await explain(strip('entity_attributes')).explainIndex((await recordFor(f, 'handbook')).id)).sourceObject as Entity;
        expect(entity.id).toBe(f.entity.id);
        expect(entity.attributes).toEqual({});

        const artifact = (await explain(strip('artifact_content')).explainIndex((await recordFor(f, 'markdown')).id)).sourceObject as Artifact;
        expect(artifact.id).toBe(f.artifact.id);
        expect(artifact.storagePath).toBe(REDACTED);

        const ledgerExplanation = await explain(strip('provenance_actors')).explainIndex(eventRecord.id);
        expect(ledgerExplanation.sourceObject).toMatchObject({ id: event.id, action: 'audit_note', actorId: REDACTED });
    });

    it('a record whose source is gone is explained as stale, with nothing to redact', async () => {
        const f = await seed();
        const ghost = await f.stores.index.index({ sourceId: 'ghost-entity', sourceStore: 'canonical', text: 'concept: Phantom', metadata: {} });
        const k = policed(f, [allow('explain', ['explain_retrieval'], {}, 20, strip('entity_attributes'))], { visibilityRules: [ALL_VISIBLE] });
        const explanation = await k.explainIndex(ghost.id);
        expect(explanation).toMatchObject({ sourceExists: false, sourceObject: null, stale: true });
    });
});

// ─── traceBundle ──────────────────────────────────────────────────────────

describe('traceBundle applies the same visibility and actor redaction as traceObject', () => {
    it('hidden nodes are replaced and actors are masked', async () => {
        const f = await seed();
        const bundle = await f.raw.retrieveBundle('zebra');
        const hideArtifacts: VisibilityRule = { id: 'hide-artifacts', scope: { stores: ['artifact'] }, existenceVisible: false, emitPlaceholder: true };
        const graph = await policed(f, [allow('trace', ['trace_provenance'], {}, 20, strip('provenance_actors'))], { visibilityRules: [hideArtifacts, ALL_VISIBLE] })
            .traceBundle(bundle);
        expect(graph.nodes.find((n) => n.uri === f.artifactUri)?.label).toBe('[Access restricted]');
        expect(graph.nodes.find((n) => n.uri === f.entityUri)?.label).toBe('concept: Zebra Handbook');
        const events = graph.nodes.filter((n) => n.type === 'provenance_event');
        expect(events.length).toBeGreaterThan(0);
        for (const n of events) expect(n.label).not.toContain('operator');
    });
});

// ─── Trust zones ──────────────────────────────────────────────────────────

/**
 * The context's trust zone, when set, is the zone every decision uses; the
 * principal's own zone is only the default. Here a deny scoped to the
 * principal's default zone ('internal') must never fire, because the session
 * runs in 'external'.
 */
describe("a session's trust zone overrides the principal's default on every decision", () => {
    it('no check falls back to the principal zone while the session names one', async () => {
        const f = await seed();
        const commandId = await commitUpdate(f);
        await f.stores.index.index({ sourceId: 'ghost-entity', sourceStore: 'canonical', text: 'concept: Phantom Ghost', metadata: {} });
        await f.stores.index.index({ sourceId: 'ghost-artifact', sourceStore: 'artifact', text: 'phantom-ghost.md [text/markdown]', metadata: {} });
        const zones: TrustZone[] = ['internal', 'external'].map((id) => ({
            id,
            name: id,
            defaultCapabilities: [],
            defaultScope: { stores: ['*'] },
            approvalMode: 'auto',
            redactionRules: [],
            visibilityRules: [],
        }));
        const k = policed(f, [
            deny('not-from-internal', ALL_CAPABILITIES, { trustZones: ['internal'] }, 1),
            allow('everything', ALL_CAPABILITIES, {}, 50),
        ], { context: { trustZone: 'external' }, visibilityRules: [ALL_VISIBLE], trustZones: zones });

        const found = await k.findSources({ query: 'zebra' });
        expect(found.resolvedEntities).toHaveLength(1);
        expect(found.resolvedArtifacts).toHaveLength(1);
        expect(sourceIds(found.indexRecords)).toEqual([f.artifact.id, f.entity.id].sort());
        expect(sourceIds((await k.findSources({ query: 'ghost' })).indexRecords)).toEqual(['ghost-artifact', 'ghost-entity']);

        const bundle = await k.retrieveBundle('zebra');
        expect(bundle.resolvedEntities).toHaveLength(1);
        expect(bundle.resolvedArtifacts).toHaveLength(1);

        expect(await k.inspectEntity(f.entity.id)).toMatchObject({ id: f.entity.id });
        expect((await k.listEntityVersions(f.entity.id)).length).toBeGreaterThan(0);
        expect(await k.listArtifactVersions('zebra.md')).toHaveLength(1);
        expect((await k.listReceipts()).length).toBeGreaterThan(0);
        expect((await k.listCommands()).map((c) => c.id)).toContain(commandId);
    });
});
