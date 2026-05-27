/**
 * Wave A3 Kernel regression nets.
 *
 * Each test proves a FULL invariant — not just that an error type exists.
 *
 * Covers:
 *  - KERNEL-R2-001: inspectCommand fetch-before-enforce existence oracle
 *  - KERNEL-R2-003: performIndexRebuild() non-atomic empty-window
 *  - KERNEL-R2-004: traceProvenance returns un-redacted actorIds
 *  - KERNEL-R2-005: link_evidence writes outside outer try/catch
 *  - KERNEL-R2-006: redactProvenanceEvent strip behavior (sentinel + detail strip)
 *  - KERNEL-R2-008: detail.targetStore cast in retrieveBundle has no validation
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalCluster } from '../src/adapters/local/index.js';
import { ClusterKernel } from '../src/kernel/cluster-kernel.js';
import { PolicyEnforcedKernel, PolicyDeniedError } from '../src/kernel/policy-enforced-kernel.js';
import { NotFoundError, ReceiptFailedError } from '../src/kernel/errors.js';
import { redactProvenanceEvent, REDACTED } from '../src/policy/redactor.js';
import type { Policy, Principal, TrustZone, VisibilityRule, RedactionRule } from '../src/types/policy.js';
import type { ProvenanceEvent } from '../src/types/provenance-event.js';
import { recordProvenance } from '../src/kernel/provenance.js';

// ─── Shared test fixtures ──────────────────────────────────────────────────

const admin: Principal = {
    id: 'admin-1',
    name: 'Admin',
    roles: ['cluster-admin'],
    trustZone: 'internal',
};

const deniedPrincipal: Principal = {
    id: 'nobody-1',
    name: 'Nobody',
    roles: [],
    trustZone: 'external',
};

const basePolicies: Policy[] = [
    {
        id: 'admin-full',
        name: 'Admin Full',
        priority: 5,
        match: { principals: ['cluster-admin'] },
        decision: 'allow',
        reason: 'Admin gets everything.',
    },
];

const baseTrustZones: TrustZone[] = [
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
        id: 'external',
        name: 'External',
        defaultCapabilities: [],
        defaultScope: { stores: ['index'] },
        approvalMode: 'require_approval',
        redactionRules: [],
        visibilityRules: [],
    },
];

const baseVisibilityRules: VisibilityRule[] = [];

function makeKernels(opts?: {
    extraPolicies?: Policy[];
    extraTrustZones?: TrustZone[];
    extraVisibility?: VisibilityRule[];
}): {
    dir: string;
    stores: ReturnType<typeof createLocalCluster>;
    admin: PolicyEnforcedKernel;
    restricted: PolicyEnforcedKernel;
} {
    const dir = mkdtempSync(join(tmpdir(), 'wave-a3-kernel-'));
    const stores = createLocalCluster(dir);
    const policies = [...basePolicies, ...(opts?.extraPolicies ?? [])];
    const trustZones = [...baseTrustZones, ...(opts?.extraTrustZones ?? [])];
    const visibilityRules = [...baseVisibilityRules, ...(opts?.extraVisibility ?? [])];
    const adminKernel = new PolicyEnforcedKernel(
        stores,
        { principal: admin },
        { policies, trustZones, visibilityRules, dataDir: dir },
    );
    const restrictedKernel = new PolicyEnforcedKernel(
        stores,
        { principal: deniedPrincipal },
        { policies, trustZones, visibilityRules, dataDir: dir },
    );
    return { dir, stores, admin: adminKernel, restricted: restrictedKernel };
}

// ───────────────────────────────────────────────────────────────────────────
// KERNEL-R2-001 — inspectCommand existence oracle
// ───────────────────────────────────────────────────────────────────────────
//
// The OLD code fetched the command BEFORE calling enforce(). A denied
// principal calling inspectCommand(<existing-id>) got PolicyDeniedError;
// inspectCommand(<nonexistent-id>) got NotFoundError. The error type
// distinction was an oracle for whether the commandId existed.
//
// Full invariant: For a denied principal, the error TYPE observed for
// any commandId — existent or not — must be identical (PolicyDeniedError).

describe('KERNEL-R2-001 — inspectCommand fetch-before-enforce existence oracle', () => {
    it('denied principal observes identical error type for existent vs nonexistent commandIds (property-based)', async () => {
        const { dir, admin: adminKernel, restricted } = makeKernels();
        try {
            // Seed a real entity (which creates a synthetic command).
            await adminKernel.createEntity({
                kind: 'document',
                name: 'A Doc',
                attributes: {},
                actorId: 'admin-1',
            });

            // Find the synthetic command id via admin-side listReceipts.
            const receipts = await adminKernel.listReceipts({});
            const realCommandId = receipts[0]?.commandId;
            expect(realCommandId).toBeTruthy();

            // The denied principal must NOT be able to differentiate
            // existent vs non-existent commandIds.
            await fc.assert(
                fc.asyncProperty(fc.uuid(), async (fakeUuid) => {
                    let nonExistentErrType: string | undefined;
                    let existentErrType: string | undefined;
                    try {
                        await restricted.inspectCommand(fakeUuid);
                    } catch (err) {
                        nonExistentErrType = (err as Error).constructor.name;
                    }
                    try {
                        await restricted.inspectCommand(realCommandId!);
                    } catch (err) {
                        existentErrType = (err as Error).constructor.name;
                    }
                    // Both calls must throw.
                    expect(nonExistentErrType).toBeDefined();
                    expect(existentErrType).toBeDefined();
                    // Types must be IDENTICAL — no oracle.
                    expect(nonExistentErrType).toBe(existentErrType);
                    // And specifically PolicyDeniedError (not NotFoundError).
                    expect(nonExistentErrType).toBe('PolicyDeniedError');
                }),
                { numRuns: 25 },
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    // AGG-004 fix-up — verb-refinement second-stage oracle.
    //
    // The KERNEL-R2-001 fix introduced a 2-stage enforce: coarse pre-fetch
    // gate WITHOUT commandVerb, then fetch, then refine with commandVerb.
    // For a principal allowed at the coarse gate but denied for a specific
    // commandVerb, the OLD code path still leaked existence:
    //   - Existent commandId  → PolicyDeniedError from the second enforce
    //   - Nonexistent commandId → NotFoundError from the fetch
    // The fix-up unifies both to PolicyDeniedError.
    it('verb-refined-deny principal observes identical error type for existent vs nonexistent commandIds', async () => {
        // Principal allowed at coarse `read_command` (no commandVerb) but
        // denied for `create_entity` verb specifically.
        const verbAllowedExceptCreatePolicies: Policy[] = [
            {
                id: 'verb-deny-create',
                name: 'Deny create_entity verb',
                priority: 5,
                match: {
                    principals: ['verb-restricted-reader'],
                    capabilities: ['read_command'],
                    commandVerbs: ['create_entity'],
                },
                decision: 'deny',
                reason: 'create_entity verb is denied for this role.',
            },
            {
                id: 'verb-allow-coarse',
                name: 'Coarse allow read_command',
                priority: 10,
                match: {
                    principals: ['verb-restricted-reader'],
                    capabilities: ['read_command'],
                },
                decision: 'allow',
                reason: 'Coarse read_command allowed.',
            },
        ];

        const verbRestrictedPrincipal: Principal = {
            id: 'verb-restricted-1',
            name: 'VerbRestricted',
            roles: ['verb-restricted-reader'],
            trustZone: 'internal',
        };

        const { dir, admin: adminKernel } = makeKernels({
            extraPolicies: verbAllowedExceptCreatePolicies,
        });
        try {
            // Seed via admin so a real command (create_entity verb) exists.
            await adminKernel.createEntity({
                kind: 'document',
                name: 'VerbDoc',
                attributes: {},
                actorId: 'admin-1',
            });
            const receipts = await adminKernel.listReceipts({});
            const realCommandId = receipts[0]?.commandId;
            expect(realCommandId).toBeTruthy();

            // Build a fresh kernel for the verb-restricted principal so it
            // sees the same on-disk cluster.
            const stores = createLocalCluster(dir);
            const verbRestrictedKernel = new PolicyEnforcedKernel(
                stores,
                { principal: verbRestrictedPrincipal },
                {
                    policies: [...basePolicies, ...verbAllowedExceptCreatePolicies],
                    trustZones: baseTrustZones,
                    visibilityRules: [],
                    dataDir: dir,
                },
            );

            // Existent: coarse-allow → fetch succeeds → verb-refined deny.
            let existentErrType: string | undefined;
            try {
                await verbRestrictedKernel.inspectCommand(realCommandId!);
            } catch (err) {
                existentErrType = (err as Error).constructor.name;
            }

            // Nonexistent: coarse-allow → fetch throws NotFoundError. After
            // the fix, this must be unified to PolicyDeniedError when the
            // principal has any verb-conditioned deny rule.
            let nonExistentErrType: string | undefined;
            try {
                await verbRestrictedKernel.inspectCommand('00000000-0000-0000-0000-000000000000');
            } catch (err) {
                nonExistentErrType = (err as Error).constructor.name;
            }

            expect(existentErrType).toBeDefined();
            expect(nonExistentErrType).toBeDefined();
            expect(existentErrType).toBe('PolicyDeniedError');
            // The load-bearing assertion — both types must be identical:
            // a verb-restricted reader must not be able to distinguish
            // existent vs nonexistent commandIds.
            expect(nonExistentErrType).toBe(existentErrType);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

// ───────────────────────────────────────────────────────────────────────────
// AGG-004 fix-up — inspectEntity existence oracle (sibling of inspectCommand)
// ───────────────────────────────────────────────────────────────────────────
//
// Full invariant: For a principal whose read_owner_truth on canonical is
// denied at the per-resource policy gate, the error TYPE observed for
// inspectEntity(<id>) must be identical regardless of whether <id> exists.
// Pre-fix code at policy-enforced-kernel.ts:139 had the same shape as
// inspectCommand before its KERNEL-R2-001 fix: enforce → fetch → fetch
// throws NotFoundError for nonexistent vs PolicyDeniedError for existent.

describe('AGG-004 — inspectEntity existence oracle (sibling of inspectCommand)', () => {
    it('denied principal observes identical error type for existent vs nonexistent entity IDs (property-based)', async () => {
        const { dir, admin: adminKernel, restricted } = makeKernels();
        try {
            // Seed a real entity.
            const entityResult = await adminKernel.createEntity({
                kind: 'document',
                name: 'EntityOracleProbe',
                attributes: {},
                actorId: 'admin-1',
            });
            const realEntityId = entityResult.entity.id;
            expect(realEntityId).toBeTruthy();

            await fc.assert(
                fc.asyncProperty(fc.uuid(), async (fakeUuid) => {
                    let nonExistentErrType: string | undefined;
                    let existentErrType: string | undefined;
                    try {
                        await restricted.inspectEntity(fakeUuid);
                    } catch (err) {
                        nonExistentErrType = (err as Error).constructor.name;
                    }
                    try {
                        await restricted.inspectEntity(realEntityId);
                    } catch (err) {
                        existentErrType = (err as Error).constructor.name;
                    }
                    expect(nonExistentErrType).toBeDefined();
                    expect(existentErrType).toBeDefined();
                    // Both must yield PolicyDeniedError — no oracle.
                    expect(nonExistentErrType).toBe(existentErrType);
                    expect(nonExistentErrType).toBe('PolicyDeniedError');
                }),
                { numRuns: 25 },
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

// ───────────────────────────────────────────────────────────────────────────
// KERNEL-R2-003 — performIndexRebuild() non-atomic empty-window
// ───────────────────────────────────────────────────────────────────────────
//
// Full invariant: While a rebuildIndex is in flight, concurrent readers
// must always observe EITHER the pre-rebuild OR the post-rebuild state.
// They must NEVER observe an empty index window.

describe('KERNEL-R2-003 — performIndexRebuild() atomicity (regression of A2)', () => {
    it('rebuildIndex uses atomic replaceAll (not clear-then-loop)', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'wave-a3-rebuild-'));
        try {
            const stores = createLocalCluster(dir);
            const kernel = new ClusterKernel(stores, { dataDir: dir });

            const N = 5;
            for (let i = 0; i < N; i++) {
                await kernel.createEntity({
                    kind: 'concept',
                    name: `Pre-${i}`,
                    attributes: { index: i },
                    actorId: 'admin-1',
                });
            }
            expect(await stores.index.count()).toBe(N);

            // Instrument the IndexStore: record every state-mutating call
            // in order. The fix should call replaceAll (atomic). The bug
            // calls clear() then a loop of index() — observable as
            // multiple `clear` / `index` entries.
            const calls: string[] = [];
            const origClear = stores.index.clear.bind(stores.index);
            const origIndex = stores.index.index.bind(stores.index);
            const origReplaceAll = stores.index.replaceAll.bind(stores.index);
            stores.index.clear = async () => {
                calls.push('clear');
                return origClear();
            };
            stores.index.index = async (r: any) => {
                calls.push('index');
                return origIndex(r);
            };
            stores.index.replaceAll = async (rs: any) => {
                calls.push('replaceAll');
                return origReplaceAll(rs);
            };

            await kernel.rebuildIndex('admin-1');

            // Full invariant: the rebuild path MUST use replaceAll once
            // (atomic swap), and MUST NOT call clear() followed by a
            // loop of index() calls (the non-atomic path with an empty
            // window between clear and first index).
            const clearCount = calls.filter((c) => c === 'clear').length;
            const indexLoopCount = calls.filter((c) => c === 'index').length;
            const replaceAllCount = calls.filter((c) => c === 'replaceAll').length;

            expect(replaceAllCount).toBe(1);
            expect(clearCount).toBe(0);
            // No per-record index() calls from the rebuild path.
            expect(indexLoopCount).toBe(0);

            // And the final count is N (the rebuild ran correctly).
            expect(await stores.index.count()).toBe(N);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('reindex via commitMutation path also uses atomic replaceAll', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'wave-a3-reindex-cmd-'));
        try {
            const stores = createLocalCluster(dir);
            const kernel = new ClusterKernel(stores, { dataDir: dir });

            for (let i = 0; i < 5; i++) {
                await kernel.createEntity({
                    kind: 'concept',
                    name: `Pre-${i}`,
                    attributes: {},
                    actorId: 'admin-1',
                });
            }
            // Reset the call tracker AFTER seeding (so we don't count
            // create-entity index calls).
            const calls: string[] = [];
            const origClear = stores.index.clear.bind(stores.index);
            const origIndex = stores.index.index.bind(stores.index);
            const origReplaceAll = stores.index.replaceAll.bind(stores.index);
            stores.index.clear = async () => {
                calls.push('clear');
                return origClear();
            };
            stores.index.index = async (r: any) => {
                calls.push('index');
                return origIndex(r);
            };
            stores.index.replaceAll = async (rs: any) => {
                calls.push('replaceAll');
                return origReplaceAll(rs);
            };

            const cmd = await kernel.proposeMutation({
                verb: 'reindex',
                targetStore: 'index',
                payload: {},
                proposedBy: 'admin-1',
            });
            await kernel.validateMutation(cmd.id);
            await kernel.commitMutation(cmd.id, 'admin-1');

            // The commitMutation 'reindex' arm calls performIndexRebuild,
            // which must use replaceAll. Calling clear() first is the
            // non-atomic-rebuild bug.
            const clearCount = calls.filter((c) => c === 'clear').length;
            const replaceAllCount = calls.filter((c) => c === 'replaceAll').length;
            expect(replaceAllCount).toBe(1);
            expect(clearCount).toBe(0);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

// ───────────────────────────────────────────────────────────────────────────
// KERNEL-R2-004 — traceProvenance returns un-redacted actorIds
// ───────────────────────────────────────────────────────────────────────────
//
// Full invariant: when a `provenance_actors` redaction rule applies,
// the events returned by traceProvenance must have their actorId
// redacted to REDACTED (mask) or the sentinel (strip) — not raw.

describe('KERNEL-R2-004 — traceProvenance per-event redaction', () => {
    it('traceProvenance applies provenance_actors redaction to every event', async () => {
        const restrictedRule: RedactionRule = {
            id: 'mask-actors',
            target: 'provenance_actors',
            behavior: 'mask',
            reason: 'test',
        };
        const traceWithRedactPolicy: Policy = {
            id: 'restricted-trace',
            name: 'Restricted Trace',
            priority: 20,
            match: {
                principals: ['restricted-tracer'],
                capabilities: ['trace_provenance'],
            },
            decision: 'allow',
            reason: 'Can trace but actors must be masked.',
            redaction: restrictedRule,
        };

        const tracer: Principal = {
            id: 'tracer-1',
            name: 'Tracer',
            roles: ['restricted-tracer'],
            trustZone: 'internal',
        };

        const dir = mkdtempSync(join(tmpdir(), 'wave-a3-trace-'));
        try {
            const stores = createLocalCluster(dir);
            const policies = [...basePolicies, traceWithRedactPolicy];
            const adminKernel = new PolicyEnforcedKernel(
                stores,
                { principal: admin },
                { policies, trustZones: baseTrustZones, visibilityRules: [], dataDir: dir },
            );
            const tracerKernel = new PolicyEnforcedKernel(
                stores,
                { principal: tracer },
                { policies, trustZones: baseTrustZones, visibilityRules: [], dataDir: dir },
            );

            const seeded = await adminKernel.createEntity({
                kind: 'document',
                name: 'TraceMe',
                attributes: {},
                actorId: 'secret-actor-bob@example.com',
            });

            const events = await tracerKernel.traceProvenance(seeded.entity.id);
            expect(events.length).toBeGreaterThan(0);

            // The full invariant: NO event in the returned list exposes
            // the raw actorId. Every event's actorId is REDACTED.
            for (const ev of events) {
                expect(ev.actorId).not.toBe('secret-actor-bob@example.com');
                expect(ev.actorId).toBe(REDACTED);
            }
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

// ───────────────────────────────────────────────────────────────────────────
// KERNEL-R2-005 — link_evidence writes outside outer try/catch
// ───────────────────────────────────────────────────────────────────────────
//
// Full invariant: If the receipt write fails AFTER evidence_linked
// was emitted, an orphan-mutation event MUST be recorded so the state
// is recoverable, and a ReceiptFailedError MUST be thrown. We must
// never observe evidence_linked without either a paired receipt OR a
// paired mutation_orphaned event.

describe('KERNEL-R2-005 — link_evidence orphan-recovery on receipt failure', () => {
    it('receipt failure after evidence_linked triggers mutation_orphaned + ReceiptFailedError', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'wave-a3-link-orphan-'));
        try {
            const stores = createLocalCluster(dir);
            const kernel = new ClusterKernel(stores, { dataDir: dir });

            const entityResult = await kernel.createEntity({
                kind: 'document',
                name: 'EvidenceSubject',
                attributes: {},
                actorId: 'admin-1',
            });
            const artifactResult = await kernel.ingestArtifact({
                filename: 'evidence.txt',
                content: Buffer.from('evidence'),
                mimeType: 'text/plain',
                actorId: 'admin-1',
            });

            // Patch the ledger so the next appendReceipt call fails.
            const realAppendReceipt = stores.ledger.appendReceipt.bind(stores.ledger);
            let nextReceiptFailed = false;
            stores.ledger.appendReceipt = async (receipt: any) => {
                if (!nextReceiptFailed) {
                    nextReceiptFailed = true;
                    throw new Error('synthetic receipt failure');
                }
                return realAppendReceipt(receipt);
            };

            await expect(
                kernel.linkEvidence({
                    artifactId: artifactResult.artifact.id,
                    entityId: entityResult.entity.id,
                    actorId: 'admin-1',
                }),
            ).rejects.toThrow(ReceiptFailedError);

            // Invariant: ledger contains evidence_linked AND a
            // mutation_orphaned event paired with it.
            const events = await stores.ledger.listEvents({});
            const evidenceLinked = events.filter((e) => e.action === 'evidence_linked');
            const orphaned = events.filter((e) => e.action === 'mutation_orphaned');

            expect(evidenceLinked.length).toBeGreaterThanOrEqual(1);
            expect(orphaned.length).toBeGreaterThanOrEqual(1);

            const linkOrphan = orphaned.find((o) => (o.detail as any).verb === 'link_evidence');
            expect(linkOrphan).toBeDefined();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('provenance write failure (BEFORE receipt) still throws ReceiptFailedError, not a bare ledger error', async () => {
        // FULL invariant: link_evidence is a unified mutation. ANY
        // ledger-write failure must surface as ReceiptFailedError —
        // not a bare `Error('synthetic')`. The bug: in current code
        // the `recordProvenance('evidence_linked')` call sits OUTSIDE
        // the try/catch, so a failure there propagates as a raw error
        // (callers cannot pattern-match on ReceiptFailedError to
        // recover).
        const dir = mkdtempSync(join(tmpdir(), 'wave-a3-link-prov-fail-'));
        try {
            const stores = createLocalCluster(dir);
            const kernel = new ClusterKernel(stores, { dataDir: dir });

            const entityResult = await kernel.createEntity({
                kind: 'document',
                name: 'EvidenceSubject',
                attributes: {},
                actorId: 'admin-1',
            });
            const artifactResult = await kernel.ingestArtifact({
                filename: 'evidence.txt',
                content: Buffer.from('evidence'),
                mimeType: 'text/plain',
                actorId: 'admin-1',
            });

            // Force ledger.append to fail when the link_evidence
            // provenance write happens. The previous appends (from
            // createEntity / ingestArtifact) have already succeeded.
            const realAppend = stores.ledger.append.bind(stores.ledger);
            stores.ledger.append = async (ev: any) => {
                if (ev.action === 'evidence_linked') {
                    throw new Error('synthetic provenance failure');
                }
                return realAppend(ev);
            };

            // Capture the thrown error.
            let caught: Error | undefined;
            try {
                await kernel.linkEvidence({
                    artifactId: artifactResult.artifact.id,
                    entityId: entityResult.entity.id,
                    actorId: 'admin-1',
                });
            } catch (err) {
                caught = err as Error;
            }
            expect(caught).toBeDefined();
            // FULL invariant: typed ReceiptFailedError, not bare Error.
            expect(caught).toBeInstanceOf(ReceiptFailedError);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

// ───────────────────────────────────────────────────────────────────────────
// KERNEL-R2-006 — redactProvenanceEvent strip + sentinel + detail strip
// ───────────────────────────────────────────────────────────────────────────
//
// Full invariant (3 parts):
//  (a) strip behavior on actorId emits REDACTED sentinel (not empty string).
//  (b) command_payload strip removes identifying fields from `detail`
//      including kind, entityId, name — not just payload/commandId.
//  (c) non-sensitive fields are preserved.

describe('KERNEL-R2-006 — redactProvenanceEvent strip + sentinel + detail leak', () => {
    it('strip actorId emits REDACTED sentinel (not empty string)', () => {
        const event: ProvenanceEvent = {
            id: 'evt-1',
            timestamp: '2024-01-01T00:00:00.000Z',
            action: 'entity_created',
            actorId: 'alice@example.com',
            subjectId: 'subj-1',
            subjectStore: 'canonical',
            detail: {},
            owner: 'ledger',
        };
        const rule: RedactionRule = {
            id: 'strip-actors',
            target: 'provenance_actors',
            behavior: 'strip',
            reason: 'test',
        };
        const redacted = redactProvenanceEvent(event, [rule]);
        expect(redacted.actorId).toBe(REDACTED);
        // Specifically NOT empty string (the pre-fix behavior).
        expect(redacted.actorId).not.toBe('');
        // Truthy sentinel.
        expect(Boolean(redacted.actorId)).toBe(true);
    });

    it('command_payload strip removes kind/entityId/name from detail (not just payload/commandId)', () => {
        const event: ProvenanceEvent = {
            id: 'evt-2',
            timestamp: '2024-01-01T00:00:00.000Z',
            action: 'mutation_committed',
            actorId: 'alice@example.com',
            subjectId: 'subj-1',
            subjectStore: 'ledger',
            detail: {
                payload: { secret: 'pw' },
                commandId: 'cmd-1',
                kind: 'employee_salary',
                entityId: 'employee-7',
                name: 'Alice Johnson',
                verb: 'create_entity',
            },
            owner: 'ledger',
        };
        const rule: RedactionRule = {
            id: 'strip-payload',
            target: 'command_payload',
            behavior: 'strip',
            reason: 'test',
        };
        const redacted = redactProvenanceEvent(event, [rule]);
        // Sensitive: must be absent.
        expect(redacted.detail.payload).toBeUndefined();
        expect(redacted.detail.commandId).toBeUndefined();
        expect(redacted.detail.kind).toBeUndefined();
        expect(redacted.detail.entityId).toBeUndefined();
        expect(redacted.detail.name).toBeUndefined();
        // Non-sensitive: must be preserved.
        expect(redacted.detail.verb).toBe('create_entity');
    });

    it('property: redacted event preserves audit-essential fields, strips sensitive ones (fast-check)', () => {
        fc.assert(
            fc.property(
                fc.record({
                    id: fc.uuid(),
                    timestamp: fc.constant('2024-01-01T00:00:00.000Z'),
                    action: fc.constantFrom('entity_created', 'mutation_committed', 'artifact_ingested'),
                    actorId: fc.string({ minLength: 1, maxLength: 20 }),
                    subjectId: fc.uuid(),
                    subjectStore: fc.constantFrom('canonical', 'artifact', 'ledger', 'index'),
                    detail: fc.record({
                        kind: fc.string({ minLength: 1, maxLength: 12 }),
                        entityId: fc.string({ minLength: 1, maxLength: 12 }),
                        name: fc.string({ minLength: 1, maxLength: 12 }),
                        verb: fc.constant('create_entity'),
                    }),
                    owner: fc.constant('ledger'),
                }),
                (raw) => {
                    const event = raw as unknown as ProvenanceEvent;
                    const rules: RedactionRule[] = [
                        {
                            id: 'strip-actors',
                            target: 'provenance_actors',
                            behavior: 'strip',
                            reason: 'test',
                        },
                        {
                            id: 'strip-payload',
                            target: 'command_payload',
                            behavior: 'strip',
                            reason: 'test',
                        },
                    ];
                    const redacted = redactProvenanceEvent(event, rules);
                    // (a) sensitive fields absent
                    expect(redacted.actorId).toBe(REDACTED);
                    expect(redacted.detail.kind).toBeUndefined();
                    expect(redacted.detail.entityId).toBeUndefined();
                    expect(redacted.detail.name).toBeUndefined();
                    // (b) audit-essential structural fields preserved
                    expect(redacted.id).toBe(event.id);
                    expect(redacted.subjectId).toBe(event.subjectId);
                    expect(redacted.subjectStore).toBe(event.subjectStore);
                    expect(redacted.action).toBe(event.action);
                    expect(redacted.timestamp).toBe(event.timestamp);
                    // (c) non-sensitive detail preserved
                    expect(redacted.detail.verb).toBe('create_entity');
                },
            ),
            { numRuns: 30 },
        );
    });
});

// ───────────────────────────────────────────────────────────────────────────
// KERNEL-R2-008 — detail.targetStore cast in retrieveBundle has no validation
// ───────────────────────────────────────────────────────────────────────────
//
// Full invariant: an attacker-controlled string in detail.targetStore
// must NOT default-allow through matchStores. A ledger event with
// detail.targetStore='malicious-store-name' should be rejected or
// treated as opaque when a denying-restricted principal calls
// retrieveBundle.

describe('KERNEL-R2-008 — detail.targetStore validation in retrieveBundle', () => {
    it('malicious targetStore in ledger event detail is dropped (not default-allowed)', async () => {
        // The bug: an `allow read_derivative` policy WITHOUT a stores
        // constraint is intended for legitimate derivative stores
        // (index/canonical-backed/artifact-backed). When an attacker-
        // controlled `detail.targetStore` value flows into the policy
        // request as `ownerStore`, matchStores absorbs it under the
        // wildcard, so the forged event leaks through. The fix
        // validates `detail.targetStore` against the known store-type
        // union before passing it to the policy engine.
        const restrictedReader: Principal = {
            id: 'restricted-reader-1',
            name: 'Restricted Reader',
            roles: ['restricted-reader'],
            trustZone: 'internal',
        };

        // Allow read_derivative WITHOUT stores constraint — emulates
        // a "read derivatives in general" grant.
        const allowDerivativeWildcard: Policy = {
            id: 'restricted-reader-allow-derivative',
            name: 'Restricted Reader Allow Derivative',
            priority: 10,
            match: {
                principals: ['restricted-reader'],
                capabilities: ['read_derivative'],
            },
            decision: 'allow',
            reason: 'Generic derivative grant.',
        };
        // Also allow read_owner_truth for canonical so the bundle has
        // something resolved.
        const allowOwnerCanonical: Policy = {
            id: 'restricted-reader-owner',
            name: 'Restricted Reader Owner Canonical',
            priority: 10,
            match: {
                principals: ['restricted-reader'],
                capabilities: ['read_owner_truth'],
                stores: ['canonical'],
            },
            decision: 'allow',
            reason: 'Can read canonical owner truth.',
        };

        const dir = mkdtempSync(join(tmpdir(), 'wave-a3-target-validation-'));
        try {
            const stores = createLocalCluster(dir);
            const policies = [
                ...basePolicies,
                allowDerivativeWildcard,
                allowOwnerCanonical,
            ];
            const adminKernel = new PolicyEnforcedKernel(
                stores,
                { principal: admin },
                { policies, trustZones: baseTrustZones, visibilityRules: [], dataDir: dir },
            );
            const restrictedKernel = new PolicyEnforcedKernel(
                stores,
                { principal: restrictedReader },
                { policies, trustZones: baseTrustZones, visibilityRules: [], dataDir: dir },
            );

            // Seed a canonical entity so retrieveBundle has something.
            // The planner attaches provenance for any subject that
            // matches resolved entities — so we use the entity id as
            // the forged event's subjectId. The planner gathers events
            // via `listEvents({ subjectId })` and includes them in
            // bundle.provenanceEvents — including subjectStore='ledger'
            // entries that are filtered through the
            // detail.targetStore code path.
            const seeded = await adminKernel.createEntity({
                kind: 'document',
                name: 'Findable',
                attributes: {},
                actorId: 'admin-1',
            });

            // Inject a forged ledger event with the SAME subjectId as
            // the canonical entity but with subjectStore='ledger' and
            // a malicious detail.targetStore.
            await recordProvenance(
                stores.ledger,
                'forged_event',
                'attacker',
                seeded.entity.id,
                'ledger',
                {
                    targetStore: 'malicious-store-name',
                    payload: { stolen: 'data' },
                },
            );

            const bundle = await restrictedKernel.retrieveBundle('findable');

            // Sanity: the planner did surface SOMETHING (the entity is
            // resolved). The forged event is gathered alongside.
            expect(bundle.resolvedEntities.length).toBeGreaterThan(0);

            // FULL invariant: the forged event must NOT appear in the
            // policy-enforced output. matchStores must reject the
            // unknown 'malicious-store-name' instead of default-allow.
            const surfacedForged = bundle.provenanceEvents.filter(
                (e) => e.action === 'forged_event',
            );
            expect(surfacedForged.length).toBe(0);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
