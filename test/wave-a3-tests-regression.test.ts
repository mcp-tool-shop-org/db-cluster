/**
 * Wave A3 — Tests-domain regression nets.
 *
 * These tests close gaps surfaced in re-audit-2 where existing tests proved
 * only PART of an invariant. The Wave A3 strategy is "test the full
 * invariant, not just the convenient half." Each block here documents the
 * full invariant in a comment, then asserts every leg.
 *
 * Findings covered:
 *
 * - TESTS-R2-001 — ReceiptFailedError must leave the canonical store DIRTY
 *   (mutation applied) AND emit no receipt. The pre-Wave-A3 test only
 *   asserted error type + orphan event. Both legs are essential — the
 *   orphan event is meaningful only because the store is dirty; the dirty
 *   store is recoverable only because the orphan event exists.
 *
 * - TESTS-R2-002 — LocalCanonicalStore.importSnapshot must preserve `id`,
 *   `createdAt`, and `updatedAt`. The pre-Wave-A3 coverage was end-to-end
 *   only (via backup/restore in phase12-proof). A regression that
 *   re-randomized IDs at the adapter would only fail integration tests,
 *   not unit. This file restores the unit-level canary, with a fast-check
 *   property covering arbitrary inputs.
 *
 * - TESTS-R2-003 — cluster_resolve on an artifact URI must return a
 *   sanitized object with `storagePath` undefined and the
 *   `_sourceType: 'owner-truth'` + `_contentPolicy` markers. Existing
 *   wave6-proof tests covered only the error path; positive sanitized
 *   output was not asserted. Depends on the Surface agent's
 *   SURFACE-R2-003 fix being landed (the SDK + MCP layers now sanitize
 *   all five store types, not just two).
 *
 * - TESTS-R2-004 — the restricted-principal e2e in policy-surface that
 *   asserts "filtered to 0" must first assert the seed succeeded. The
 *   pre-Wave-A3 test silently false-positives if seeding fails. The
 *   precondition assertion uses the ADMIN kernel/SDK on a separate
 *   connection so the data is provably present before the restricted
 *   kernel filters it.
 *
 * - TESTS-R2-005 — CorruptStoreError coverage extended to LocalLedgerStore
 *   (events.json + receipts.json) and LocalArtifactStore (artifacts.json).
 *   Previously only canonical + index were covered.
 *
 * - TESTS-R2-007 — index-derivation invariant restored at the ADMIN
 *   surface, not just the storage layer. The pre-Wave-A3 test pivoted
 *   from `adminK._kernel.findSources()` (removed in Wave A2 / KERNEL-R003)
 *   to a direct `stores.index.search()` doctrine probe — losing the
 *   admin-surface contract. Both legs are asserted here.
 *
 * - TESTS-R2-008 — dashboard React's `applyRedaction` wiring is a
 *   static-source regression net. JSDOM is not configured in
 *   `vitest.config.ts` and adding it is out of test-only scope. The
 *   principled alternative proves the dashboard cannot diverge from the
 *   shared `dashboard/lib/apply-redaction.js` module (which IS unit
 *   tested in `test/dashboard-policy-view.test.ts`).
 *
 * These tests live in a separate file (not in `typed-error-regression.test.ts`)
 * so Wave A3 sibling agents (Kernel + Stores) can also add to the typed-error
 * file without sequencing conflicts. The describe block names here are
 * distinct from any other Wave A3 file.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { createLocalCluster } from '../src/adapters/local/index.js';
import { LocalCanonicalStore } from '../src/adapters/local/local-canonical-store.js';
import { LocalLedgerStore } from '../src/adapters/local/local-ledger-store.js';
import { LocalArtifactStore } from '../src/adapters/local/local-artifact-store.js';
import { ClusterKernel } from '../src/kernel/cluster-kernel.js';
import { ReceiptFailedError } from '../src/kernel/errors.js';
import { CorruptStoreError } from '../src/adapters/local/errors.js';
import { ClusterSDK } from '../src/sdk/cluster-sdk.js';
import { handleTool } from '../src/mcp/server.js';
import { applyRedaction } from '../dashboard/lib/apply-redaction.js';
import type { Entity } from '../src/types/entity.js';
import type { Policy, Principal } from '../src/types/policy.js';
import type { DashboardObject } from '../src/dashboard/dashboard-model.js';

const CLI = `node ${join(resolve(import.meta.dirname, '..'), 'dist', 'cli.js')}`;

describe('Wave A3 — Tests regression nets', () => {

    // ─── TESTS-R2-001 — ReceiptFailedError + dirty-store + no-receipt ─
    //
    // FULL INVARIANT: when the post-mutation provenance/receipt sequence
    // fails after the canonical mutation has landed, the kernel MUST:
    //   1. throw ReceiptFailedError (typed error)
    //   2. attempt + persist a `mutation_orphaned` ledger event
    //   3. leave the canonical store DIRTY (the entity is still in canonical)
    //   4. emit NO receipt for the failed commit
    //   5. cite the orphaned entity's id in the orphan event so recovery
    //      scripts can scan the ledger and reconcile
    //
    // HALF THAT WAS MISSING: the pre-Wave-A3 test asserted only legs 1 + 2.
    // The dirty-store side (leg 3) and the no-receipt side (leg 4) were
    // both unasserted, so a regression that, e.g., transactionally rolled
    // back the canonical write (changing the invariant entirely) would
    // pass the pre-A3 test — but the orphan event would then point to a
    // nonexistent entity, breaking the recovery contract.

    describe('TESTS-R2-001 — ReceiptFailedError leaves canonical dirty + no receipt', () => {
        it('createEntity: error thrown + orphan event written + canonical dirty + no receipt + orphan cites entity id', async () => {
            const dir = mkdtempSync(join(tmpdir(), 'wa3-tests-r001-'));
            const stores = createLocalCluster(dir);
            const kernel = new ClusterKernel(stores, { dataDir: dir });

            // Patch ledger.append so the FIRST entity_created append fails
            // (forcing the orphan path). Subsequent appends (mutation_orphaned)
            // pass through to the real implementation.
            const realAppend = stores.ledger.append.bind(stores.ledger);
            const calls: Array<{ action: string; subjectId?: string }> = [];
            let primaryFailed = false;
            stores.ledger.append = async (event: any) => {
                calls.push({ action: event.action, subjectId: event.subjectId });
                if (event.action === 'entity_created' && !primaryFailed) {
                    primaryFailed = true;
                    throw new Error('synthetic ledger failure — wave A3 r2-001 probe');
                }
                return realAppend(event);
            };

            const receiptsBefore = await stores.ledger.listReceipts({});
            const entitiesBefore = await stores.canonical.list();

            // ── Leg 1: error type ────────────────────────────────────────
            await expect(
                kernel.createEntity({
                    kind: 'document',
                    name: 'WaveA3OrphanedEntity',
                    attributes: { topic: 'r2-001-canary' },
                    actorId: 'operator',
                }),
            ).rejects.toThrow(ReceiptFailedError);

            // ── Leg 2: orphan event attempted AND persisted ─────────────
            const orphanAppendAttempts = calls.filter((c) => c.action === 'mutation_orphaned');
            expect(orphanAppendAttempts.length).toBeGreaterThan(0);

            const events = await stores.ledger.listEvents({});
            const orphanEvents = events.filter((e) => e.action === 'mutation_orphaned');
            expect(orphanEvents.length).toBeGreaterThan(0);

            // ── Leg 3 (TESTS-R2-001): canonical store is DIRTY ──────────
            // The entity write happened before the failing append, so the
            // canonical store now holds a row with NO receipt — exactly the
            // state the orphan event is designed to surface for recovery.
            const entitiesAfter = await stores.canonical.list();
            expect(entitiesAfter.length).toBe(entitiesBefore.length + 1);
            const orphaned = entitiesAfter.find((e) => e.name === 'WaveA3OrphanedEntity');
            expect(orphaned).toBeDefined();
            expect(orphaned!.kind).toBe('document');
            expect((orphaned!.attributes as Record<string, unknown>).topic).toBe('r2-001-canary');

            // ── Leg 4 (TESTS-R2-001): NO receipt for the failed commit ──
            const receiptsAfter = await stores.ledger.listReceipts({});
            expect(receiptsAfter.length).toBe(receiptsBefore.length);

            // ── Leg 5 (TESTS-R2-001): orphan event cites the orphaned id ──
            // The orphan event MUST reference the canonical entity id so a
            // future `verify()` / `doctor()` / recovery script can scan the
            // ledger for mutation_orphaned events and reconcile dirty rows.
            // The id can be on the event's top-level subjectId field (the
            // current kernel records it there) or inside detail.
            const citingEvents = orphanEvents.filter(
                (e) => e.subjectId === orphaned!.id
                    || (e.detail as Record<string, unknown> | undefined)?.subjectId === orphaned!.id,
            );
            expect(citingEvents.length).toBeGreaterThan(0);

            rmSync(dir, { recursive: true, force: true });
        });
    });

    // ─── TESTS-R2-002 — importSnapshot ID + timestamp preservation ──────
    //
    // FULL INVARIANT: LocalCanonicalStore.importSnapshot must preserve
    //   1. `id` (the canonical entity id provided by the caller)
    //   2. `createdAt` (the original creation timestamp)
    //   3. `updatedAt` (the original update timestamp)
    //   4. idempotency: a second importSnapshot of the same id is a no-op
    //      and returns the existing record (NOT the incoming body)
    //   5. retrievability: store.get(id) returns the same entity
    //
    // HALF THAT WAS MISSING: phase12-proof tests this end-to-end via
    // backup/restore, but never directly at the adapter unit level. If
    // importSnapshot were to silently regress to ingest()-style randomized
    // UUIDs, end-to-end would break — but with no unit canary, the actual
    // adapter behaviour change would be hidden behind two layers of plumbing.

    describe('TESTS-R2-002 — LocalCanonicalStore.importSnapshot preserves id + timestamps', () => {
        it('preserves id, createdAt, updatedAt for fixed input', async () => {
            const dir = mkdtempSync(join(tmpdir(), 'wa3-tests-r002-fixed-'));
            const store = new LocalCanonicalStore(dir);

            const fixed: Entity = {
                id: 'fixed-uuid-1234-5678-aaaa-1111',
                kind: 'document',
                name: 'Fixed Snapshot',
                attributes: { topic: 'r2-002' },
                createdAt: '2024-01-15T08:30:00.000Z',
                updatedAt: '2024-01-16T12:45:00.000Z',
                owner: 'canonical',
            };

            const returned = await store.importSnapshot(fixed);

            // Identity preservation.
            expect(returned.id).toBe('fixed-uuid-1234-5678-aaaa-1111');
            expect(returned.createdAt).toBe('2024-01-15T08:30:00.000Z');
            expect(returned.updatedAt).toBe('2024-01-16T12:45:00.000Z');
            expect(returned.owner).toBe('canonical');

            // Retrievability by the same id.
            const fetched = await store.get('fixed-uuid-1234-5678-aaaa-1111');
            expect(fetched).not.toBeNull();
            expect(fetched!.id).toBe('fixed-uuid-1234-5678-aaaa-1111');
            expect(fetched!.createdAt).toBe('2024-01-15T08:30:00.000Z');
            expect(fetched!.updatedAt).toBe('2024-01-16T12:45:00.000Z');
            expect(fetched!.kind).toBe('document');
            expect(fetched!.name).toBe('Fixed Snapshot');

            rmSync(dir, { recursive: true, force: true });
        });

        it('is idempotent — second import of same id returns the EXISTING record unchanged', async () => {
            const dir = mkdtempSync(join(tmpdir(), 'wa3-tests-r002-idem-'));
            const store = new LocalCanonicalStore(dir);

            const first: Entity = {
                id: 'idem-fixed-uuid',
                kind: 'document',
                name: 'Original Name',
                attributes: { v: 1 },
                createdAt: '2024-01-01T00:00:00.000Z',
                updatedAt: '2024-01-01T00:00:00.000Z',
                owner: 'canonical',
            };
            await store.importSnapshot(first);

            // Wave A4 (STORES-B-003): backup/restore re-runs with IDENTICAL
            // content remain idempotent — silent return-of-existing. The
            // pre-A4 test attempted a DIFFERENT body at the same id and
            // asserted silent-first-write-wins; STORES-B-003 reclassified
            // that as a silent-tampering security hole, replacing it with a
            // typed ImportConflictError. True idempotency (same id + same
            // bytes returns existing) is now the load-bearing invariant
            // backup/restore actually relies on; the conflict-on-diff case
            // is covered in test/wave-a4-stores-regression.test.ts
            // (STORES-B-003 — content conflict).
            const returned = await store.importSnapshot(first);
            expect(returned.id).toBe('idem-fixed-uuid');
            expect(returned.name).toBe('Original Name');
            expect((returned.attributes as Record<string, unknown>).v).toBe(1);
            expect(returned.createdAt).toBe('2024-01-01T00:00:00.000Z');
            expect(returned.updatedAt).toBe('2024-01-01T00:00:00.000Z');

            // List has exactly one record for that id.
            const all = await store.list();
            expect(all.filter((e) => e.id === 'idem-fixed-uuid')).toHaveLength(1);

            rmSync(dir, { recursive: true, force: true });
        });

        it('property: arbitrary id + payload preserves identity-bearing fields', async () => {
            // fast-check property covering arbitrary UUIDs, kinds, names,
            // and ISO timestamps. The property: across all valid inputs,
            // importSnapshot must preserve id, createdAt, updatedAt. A
            // regression to random-id assignment would surface as a
            // counterexample within seconds.
            // fc.date() can emit Invalid Date values on edge cases; we
            // generate ms-since-epoch in a finite window and convert
            // ourselves so .toISOString() is always well-defined.
            const MIN_MS = new Date('2020-01-01T00:00:00.000Z').getTime();
            const MAX_MS = new Date('2026-01-01T00:00:00.000Z').getTime();
            await fc.assert(
                fc.asyncProperty(
                    fc.uuid(),
                    fc.record({
                        kind: fc.constantFrom('document', 'concept', 'event', 'task', 'finding'),
                        name: fc.string({ minLength: 1, maxLength: 40 }).filter((s) => s.trim().length > 0),
                        topic: fc.string({ minLength: 0, maxLength: 24 }),
                        createdAt: fc.integer({ min: MIN_MS, max: MAX_MS }).map((ms) => new Date(ms).toISOString()),
                        updatedAt: fc.integer({ min: MIN_MS, max: MAX_MS }).map((ms) => new Date(ms).toISOString()),
                    }),
                    async (id, payload) => {
                        const dir = mkdtempSync(join(tmpdir(), 'wa3-tests-r002-prop-'));
                        try {
                            const store = new LocalCanonicalStore(dir);
                            const fixed: Entity = {
                                id,
                                kind: payload.kind,
                                name: payload.name,
                                attributes: { topic: payload.topic },
                                createdAt: payload.createdAt,
                                updatedAt: payload.updatedAt,
                                owner: 'canonical',
                            };
                            const returned = await store.importSnapshot(fixed);
                            const fetched = await store.get(id);
                            return returned.id === id
                                && returned.createdAt === payload.createdAt
                                && returned.updatedAt === payload.updatedAt
                                && fetched !== null
                                && fetched.id === id
                                && fetched.createdAt === payload.createdAt
                                && fetched.updatedAt === payload.updatedAt;
                        } finally {
                            rmSync(dir, { recursive: true, force: true });
                        }
                    },
                ),
                { numRuns: 20 },
            );
        });
    });

    // ─── TESTS-R2-005 — CorruptStoreError on all 4 local stores ──────────
    //
    // FULL INVARIANT: every local-adapter store (canonical, index, ledger,
    // artifact) wraps JSON.parse failures in CorruptStoreError. The error
    //   1. is an instance of CorruptStoreError
    //   2. carries the offending file path on `.filePath`
    //   3. contains the file path in its `.message`
    //
    // HALF THAT WAS MISSING: pre-Wave-A3 coverage tested canonical + index
    // only. LocalLedgerStore (events.json + receipts.json) and
    // LocalArtifactStore (artifacts.json) had no failing-on-removal test.

    describe('TESTS-R2-005 — CorruptStoreError covers all 4 local stores', () => {
        it('LocalLedgerStore throws CorruptStoreError on corrupt events.json', () => {
            const dir = mkdtempSync(join(tmpdir(), 'wa3-tests-r005-le-'));
            mkdirSync(dir, { recursive: true });
            const filePath = join(dir, 'events.json');
            writeFileSync(filePath, '{ definitely not json', 'utf-8');

            try {
                expect(() => new LocalLedgerStore(dir)).toThrow(CorruptStoreError);
                try {
                    new LocalLedgerStore(dir);
                } catch (err) {
                    expect(err).toBeInstanceOf(CorruptStoreError);
                    expect((err as CorruptStoreError).filePath).toBe(filePath);
                    expect((err as Error).message).toContain(filePath);
                }
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });

        it('LocalLedgerStore throws CorruptStoreError on corrupt receipts.json', () => {
            const dir = mkdtempSync(join(tmpdir(), 'wa3-tests-r005-lr-'));
            mkdirSync(dir, { recursive: true });
            // events.json must load cleanly so the ledger reaches receipts.
            writeFileSync(join(dir, 'events.json'), '[]', 'utf-8');
            const filePath = join(dir, 'receipts.json');
            writeFileSync(filePath, 'completely invalid', 'utf-8');

            try {
                expect(() => new LocalLedgerStore(dir)).toThrow(CorruptStoreError);
                try {
                    new LocalLedgerStore(dir);
                } catch (err) {
                    expect(err).toBeInstanceOf(CorruptStoreError);
                    expect((err as CorruptStoreError).filePath).toBe(filePath);
                    expect((err as Error).message).toContain(filePath);
                }
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });

        it('LocalLedgerStore throws CorruptStoreError when events.json is JSON but not an array', () => {
            // Shape validation: the Array.isArray check is part of the
            // file-format contract. A regression that drops it would let
            // a malformed-but-parseable file pass the loader silently.
            const dir = mkdtempSync(join(tmpdir(), 'wa3-tests-r005-l-shape-'));
            mkdirSync(dir, { recursive: true });
            const filePath = join(dir, 'events.json');
            writeFileSync(filePath, '{"not": "an array"}', 'utf-8');

            try {
                expect(() => new LocalLedgerStore(dir)).toThrow(CorruptStoreError);
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });

        it('LocalArtifactStore throws CorruptStoreError on corrupt artifacts.json', () => {
            const dir = mkdtempSync(join(tmpdir(), 'wa3-tests-r005-a-'));
            mkdirSync(dir, { recursive: true });
            const filePath = join(dir, 'artifacts.json');
            writeFileSync(filePath, 'NOT JSON', 'utf-8');

            try {
                expect(() => new LocalArtifactStore(dir)).toThrow(CorruptStoreError);
                try {
                    new LocalArtifactStore(dir);
                } catch (err) {
                    expect(err).toBeInstanceOf(CorruptStoreError);
                    expect((err as CorruptStoreError).filePath).toBe(filePath);
                    expect((err as Error).message).toContain(filePath);
                }
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });

        it('LocalArtifactStore throws CorruptStoreError when artifacts.json is JSON but not an array', () => {
            const dir = mkdtempSync(join(tmpdir(), 'wa3-tests-r005-a-shape-'));
            mkdirSync(dir, { recursive: true });
            const filePath = join(dir, 'artifacts.json');
            writeFileSync(filePath, '"a string, not an array"', 'utf-8');

            try {
                expect(() => new LocalArtifactStore(dir)).toThrow(CorruptStoreError);
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });
    });

    // ─── TESTS-R2-003 — cluster_resolve sanitized artifact output ───────
    //
    // FULL INVARIANT: cluster_resolve on an artifact URI returns
    //   1. `_meta.ownerStore === 'artifact'`
    //   2. `store === 'artifact'`
    //   3. `_sourceType === 'owner-truth'`
    //   4. `object.storagePath === undefined` (no absolute filesystem path)
    //   5. `object.content === undefined` AND `object.rawContent === undefined`
    //      (no raw content escape hatch)
    //   6. `object._sourceType === 'owner-truth'`
    //   7. `object._contentPolicy` non-empty and references DATA / instructions
    //   8. non-sensitive artifact fields (id, filename, contentHash, sizeBytes,
    //      version, owner, ingestedAt) ARE present.
    //
    // HALF THAT WAS MISSING: existing wave6-proof Proof 6 only exercises the
    // ERROR path (resolve on a nonexistent URI). A regression that emitted
    // raw Artifact objects (with `storagePath`) for valid resolves would not
    // be caught.
    //
    // CROSS-AGENT DEPENDENCY: this test depends on the Surface agent's
    // SURFACE-R2-003 fix being landed (the SDK + MCP now sanitize all five
    // store types, not just artifact + canonical). Pre-fix this leg would
    // already pass for artifact since artifact was one of the two covered;
    // post-fix it remains an always-on canary that the artifact path is
    // never regressed.

    describe('TESTS-R2-003 — cluster_resolve on artifact URI returns sanitized output', () => {
        it('positive path: cluster_resolve returns sanitized artifact (storagePath gone, content opaque, markers attached)', async () => {
            // Build a self-contained cluster, ingest an artifact, then call
            // cluster_resolve via the MCP boundary.
            const dir = mkdtempSync(join(tmpdir(), 'wa3-tests-r003-'));
            const clusterDir = join(dir, '.db-cluster');
            mkdirSync(clusterDir, { recursive: true });
            const sdk = new ClusterSDK({ clusterDir });

            // Seed an artifact through the full lifecycle.
            const cmd = await sdk.proposeMutation({
                verb: 'ingest_artifact',
                targetStore: 'artifact',
                payload: (() => {
                    // Wave A4 KERNEL-B-007: Buffer + contentHash side-channel.
                    const buf = Buffer.from('# evidence body — TESTS-R2-003 canary', 'utf-8');
                    return {
                        filename: 'r2-003-evidence.md',
                        content: buf,
                        contentHash: createHash('sha256').update(buf).digest('hex'),
                        mediaType: 'text/markdown',
                    };
                })(),
                proposedBy: 'setup',
            });
            await sdk.validateMutation(cmd.id);
            await sdk.approveMutation(cmd.id, 'setup-approver');
            const commitResult = await sdk.commitMutation(cmd.id, 'setup');
            expect(commitResult.command.status).toBe('committed');

            // Discover the artifact id via find_sources (MCP boundary).
            const found = await handleTool('cluster_find_sources', { query: 'r2-003-evidence' }, sdk) as any;
            expect(found.resolvedArtifacts.length).toBeGreaterThan(0);
            const artifact = found.resolvedArtifacts[0];
            expect(artifact.id).toBeTruthy();

            // Now resolve via cluster_resolve.
            const uri = `cluster://artifact/${artifact.id}`;
            const resolved = await handleTool('cluster_resolve', { uri }, sdk) as any;

            // Legs 1 + 2: _meta + store header.
            expect(resolved._meta.operation).toBe('read');
            expect(resolved._meta.writesCluster).toBe(false);
            expect(resolved._meta.ownerStore).toBe('artifact');
            expect(resolved._meta.uri).toBe(uri);
            expect(resolved.store).toBe('artifact');

            // Leg 3: top-level _sourceType marker.
            expect(resolved._sourceType).toBe('owner-truth');

            // Leg 4: storagePath MUST be absent.
            expect(resolved.object.storagePath).toBeUndefined();

            // Leg 5: no raw content fields.
            expect(resolved.object.content).toBeUndefined();
            expect(resolved.object.rawContent).toBeUndefined();

            // Leg 6: object-level _sourceType marker.
            expect(resolved.object._sourceType).toBe('owner-truth');

            // Leg 7: _contentPolicy carries the DATA/instructions notice.
            expect(typeof resolved.object._contentPolicy).toBe('string');
            expect(resolved.object._contentPolicy).toContain('DATA');
            expect(resolved.object._contentPolicy).toContain('not instructions');

            // Leg 8: non-sensitive artifact fields present.
            expect(resolved.object.id).toBe(artifact.id);
            expect(resolved.object.filename).toBe('r2-003-evidence.md');
            expect(resolved.object.contentHash).toMatch(/^[a-f0-9]{64}$/);
            expect(typeof resolved.object.sizeBytes).toBe('number');
            expect(resolved.object.sizeBytes).toBeGreaterThan(0);
            expect(resolved.object.owner).toBe('artifact');
            expect(resolved.object.ingestedAt).toBeTruthy();
            expect(typeof resolved.object.version).toBe('number');

            rmSync(dir, { recursive: true, force: true });
        });

        // AGG-001 fix-up — MCP cluster_resolve must sanitize ALL 5 store types,
        // not just artifact. Pre-fix the MCP handler only covered
        // artifact + canonical; ledger/index/receipt URIs leaked the raw
        // resolver object. These tests pin the symmetric coverage so a
        // future regression that drops any one of the 3 added arms fails
        // an explicit assertion.
        it('cluster_resolve on canonical URI returns sanitized entity', async () => {
            const dir = mkdtempSync(join(tmpdir(), 'wa3-agg001-canonical-'));
            const clusterDir = join(dir, '.db-cluster');
            mkdirSync(clusterDir, { recursive: true });
            const sdk = new ClusterSDK({ clusterDir });

            // Seed an entity via the full lifecycle.
            const cmd = await sdk.proposeMutation({
                verb: 'create_entity',
                targetStore: 'canonical',
                payload: { kind: 'document', name: 'AGG-001 Canonical', attributes: { secret: 'leaky' } },
                proposedBy: 'setup',
            });
            await sdk.validateMutation(cmd.id);
            await sdk.approveMutation(cmd.id, 'approver');
            await sdk.commitMutation(cmd.id, 'committer');

            const found = await sdk.findSources('AGG-001 Canonical');
            expect(found.resolvedEntities.length).toBeGreaterThan(0);
            const entityId = found.resolvedEntities[0].id;

            const uri = `cluster://canonical/${entityId}`;
            const resolved = await handleTool('cluster_resolve', { uri }, sdk) as any;

            expect(resolved._meta.ownerStore).toBe('canonical');
            expect(resolved.store).toBe('canonical');
            expect(resolved.object._sourceType).toBe('owner-truth');

            rmSync(dir, { recursive: true, force: true });
        });

        it('cluster_resolve on receipt URI returns sanitized receipt', async () => {
            const dir = mkdtempSync(join(tmpdir(), 'wa3-agg001-receipt-'));
            const clusterDir = join(dir, '.db-cluster');
            mkdirSync(clusterDir, { recursive: true });
            const sdk = new ClusterSDK({ clusterDir });

            // Commit a mutation so a receipt exists.
            const cmd = await sdk.proposeMutation({
                verb: 'create_entity',
                targetStore: 'canonical',
                payload: { kind: 'thing', name: 'ReceiptCanary', attributes: {} },
                proposedBy: 'setup',
            });
            await sdk.validateMutation(cmd.id);
            await sdk.approveMutation(cmd.id, 'approver');
            const commitResult = await sdk.commitMutation(cmd.id, 'committer');
            const receiptId = commitResult.receipt.id;

            const uri = `cluster://receipt/${receiptId}`;
            const resolved = await handleTool('cluster_resolve', { uri }, sdk) as any;

            expect(resolved._meta.ownerStore).toBe('receipt');
            expect(resolved.store).toBe('receipt');
            // sanitizeReceiptForOutput attaches _sourceType: 'audit-record'.
            expect(resolved.object._sourceType).toBe('audit-record');

            rmSync(dir, { recursive: true, force: true });
        });

        it('cluster_resolve on ledger URI returns sanitized provenance event', async () => {
            const dir = mkdtempSync(join(tmpdir(), 'wa3-agg001-ledger-'));
            const clusterDir = join(dir, '.db-cluster');
            mkdirSync(clusterDir, { recursive: true });
            const sdk = new ClusterSDK({ clusterDir });

            const cmd = await sdk.proposeMutation({
                verb: 'create_entity',
                targetStore: 'canonical',
                payload: { kind: 'thing', name: 'LedgerCanary', attributes: {} },
                proposedBy: 'leaky-actor@example.com',
            });
            await sdk.validateMutation(cmd.id);
            await sdk.approveMutation(cmd.id, 'leaky-approver@example.com');
            await sdk.commitMutation(cmd.id, 'leaky-committer@example.com');

            // Pick any ledger event id from a direct store read.
            const stores = createLocalCluster(clusterDir);
            const events = await stores.ledger.listEvents({ limit: 5 });
            expect(events.length).toBeGreaterThan(0);
            const eventId = events[0].id;

            const uri = `cluster://ledger/${eventId}`;
            const resolved = await handleTool('cluster_resolve', { uri }, sdk) as any;

            expect(resolved._meta.ownerStore).toBe('ledger');
            expect(resolved.store).toBe('ledger');
            // sanitizeProvenanceEventForOutput emits ALL THREE markers:
            // _sourceType, actorId=REDACTED, detail={}.
            expect(resolved.object._sourceType).toBe('audit-record');
            expect(resolved.object.actorId).toBe('[REDACTED]');
            expect(resolved.object.detail).toEqual({});

            rmSync(dir, { recursive: true, force: true });
        });

        it('cluster_resolve on index URI returns sanitized index record', async () => {
            const dir = mkdtempSync(join(tmpdir(), 'wa3-agg001-index-'));
            const clusterDir = join(dir, '.db-cluster');
            mkdirSync(clusterDir, { recursive: true });
            const sdk = new ClusterSDK({ clusterDir });

            // Seed a canonical entity so an index record exists.
            const cmd = await sdk.proposeMutation({
                verb: 'create_entity',
                targetStore: 'canonical',
                payload: { kind: 'doc', name: 'IndexCanary', attributes: { secret: 'mirror' } },
                proposedBy: 'setup',
            });
            await sdk.validateMutation(cmd.id);
            await sdk.approveMutation(cmd.id, 'approver');
            await sdk.commitMutation(cmd.id, 'committer');

            const stores = createLocalCluster(clusterDir);
            const indexList = await stores.index.search({ text: '', limit: 5 });
            expect(indexList.length).toBeGreaterThan(0);
            const indexId = indexList[0].id;

            const uri = `cluster://index/${indexId}`;
            const resolved = await handleTool('cluster_resolve', { uri }, sdk) as any;

            expect(resolved._meta.ownerStore).toBe('index');
            expect(resolved.store).toBe('index');
            // sanitizeIndexRecordForOutput emits _sourceType='derivative',
            // removes metadata, and attaches _metadataPolicy notice.
            expect(resolved.object._sourceType).toBe('derivative');
            expect(resolved.object.metadata).toBeUndefined();
            expect(typeof resolved.object._metadataPolicy).toBe('string');

            rmSync(dir, { recursive: true, force: true });
        });
    });

    // ─── TESTS-R2-004 — restricted-principal precondition assertion ─────
    //
    // FULL INVARIANT: an e2e test that asserts "restricted principal filters
    // to 0 results" must FIRST prove the data being filtered exists. The
    // precondition prevents a false-positive when seeding silently fails:
    //   1. seed via admin path (no policies)
    //   2. assert the seed succeeded — commit.status === 'committed' AND
    //      receipt is well-formed AND the entity is admin-visible via a
    //      fresh admin SDK on the same cluster dir
    //   3. THEN connect a restricted SDK on the same dir and assert the
    //      restricted-principal filter returns 0
    //
    // HALF THAT WAS MISSING: the existing policy-surface
    // "restricted-principal SDK filters reads" test asserts step 3 only.
    // If step 1 silently fails (commit rejected, kernel error swallowed,
    // policies leaking into the seed kernel) then step 3 trivially passes
    // — there's nothing to filter from. The test would catch a regression
    // in policy enforcement only by accident.

    describe('TESTS-R2-004 — restricted SDK e2e asserts seed succeeded before filter assertion', () => {
        it('seeds via admin → asserts seed → filters via restricted (full precondition + assertion chain)', async () => {
            const dir = mkdtempSync(join(tmpdir(), 'wa3-tests-r004-'));
            execSync(`${CLI} init`, { cwd: dir, encoding: 'utf-8' });
            const clusterDir = join(dir, '.db-cluster');

            // Step 1 — admin seeds an entity (raw kernel path, no policies).
            const adminSdk = new ClusterSDK({ clusterDir });
            const proposal = await adminSdk.proposeMutation({
                verb: 'create_entity',
                targetStore: 'canonical',
                payload: { kind: 'document', name: 'R2-004 Restricted Doc', attributes: { secret: 'wave-a3' } },
                proposedBy: 'setup',
            });
            await adminSdk.validateMutation(proposal.id);
            await adminSdk.approveMutation(proposal.id, 'approver');
            const commit = await adminSdk.commitMutation(proposal.id, 'committer');

            // Step 2 — precondition: the seed MUST be visible to admin.
            // Otherwise step 3's "0 results" is a false-positive.
            expect(commit.command.status).toBe('committed');
            expect(commit.receipt).toBeTruthy();
            expect(commit.receipt.commandId).toBe(proposal.id);

            const adminProbe = await adminSdk.findSources('R2-004 Restricted');
            expect(adminProbe.resolvedEntities.length).toBeGreaterThan(0);
            const seededEntity = adminProbe.resolvedEntities.find((e: any) => e.name === 'R2-004 Restricted Doc');
            expect(seededEntity).toBeDefined();
            expect(seededEntity!.kind).toBe('document');

            // ALSO probe via the canonical store directly using a separate
            // raw kernel — defense-in-depth against the admin SDK itself
            // accidentally filtering.
            const directStores = createLocalCluster(clusterDir);
            const directEntities = await directStores.canonical.list();
            expect(directEntities.find((e) => e.name === 'R2-004 Restricted Doc')).toBeDefined();

            // Step 3 — restricted-reader policy denies read_owner_truth.
            const restrictedReaderPolicies: Policy[] = [
                {
                    id: 'restricted-discover',
                    name: 'Restricted Discover',
                    priority: 20,
                    match: { principals: ['restricted-reader'], capabilities: ['discover_existence', 'read_derivative'] },
                    decision: 'allow',
                    reason: 'Discovery only.',
                },
                {
                    id: 'restricted-deny-owner',
                    name: 'Restricted Deny Owner',
                    priority: 10,
                    match: { principals: ['restricted-reader'], capabilities: ['read_owner_truth'] },
                    decision: 'deny',
                    reason: 'Restricted reader cannot read owner truth.',
                },
            ];
            const restricted: Principal = {
                id: 'restricted-r2-004',
                name: 'Restricted',
                roles: ['restricted-reader'],
                trustZone: 'ai-facing',
            };
            const restrictedSdk = new ClusterSDK({
                clusterDir,
                policies: restrictedReaderPolicies,
                principal: restricted,
            });
            expect(restrictedSdk.policyEnforced).toBe(true);

            const restrictedView = await restrictedSdk.findSources('R2-004 Restricted');
            // The entity exists (admin probe proved it) but the restricted
            // principal cannot read owner truth, so resolvedEntities MUST
            // be filtered to 0.
            expect(restrictedView.resolvedEntities).toHaveLength(0);
            // Index records backed by canonical sources also filtered.
            for (const record of restrictedView.indexRecords) {
                expect(record.sourceStore).not.toBe('canonical');
            }

            rmSync(dir, { recursive: true, force: true });
        }, 30_000);
    });

    // ─── TESTS-R2-007 — index-derivation visible at admin surface ───────
    //
    // FULL INVARIANT: the "index is a derivative of canonical" claim must
    // hold at BOTH layers:
    //   1. ADMIN SURFACE — a raw ClusterKernel.findSources call returns
    //      indexRecords whose owner === 'index' and sourceStore === 'canonical'
    //      (the surface contract a recovery script / ops tool depends on).
    //   2. STORE DOCTRINE — a direct stores.index.search call returns the
    //      same shape (the storage-layer invariant that the surface relies on).
    //
    // HALF THAT WAS MISSING: the pre-Wave-A3 test pivoted from a kernel-surface
    // probe (via `adminK._kernel.findSources` — that `_kernel` getter was
    // removed by Wave A2 / KERNEL-R003) to a pure storage probe. The
    // doctrine assertion stayed, but the surface contract was lost. A
    // regression at the kernel's index-resolution code (e.g., always
    // returning [] from findSources) would not be caught by the storage
    // probe.
    //
    // The principled restoration is to construct a fresh raw ClusterKernel
    // against the same stores — exactly what ops/ recovery scripts do
    // before the policy layer is loaded.

    describe('TESTS-R2-007 — index-derivation invariant at admin surface AND storage doctrine', () => {
        it('admin-surface findSources returns index records, AND store search returns same shape', async () => {
            const dir = mkdtempSync(join(tmpdir(), 'wa3-tests-r007-'));
            const stores = createLocalCluster(dir);
            const kernel = new ClusterKernel(stores);

            await kernel.createEntity({
                kind: 'concept',
                name: 'R2-007 Index Derives',
                attributes: { topic: 'wave-a3-tests-r007' },
                actorId: 'admin-1',
            });

            // ── Leg 1: admin surface ────────────────────────────────────
            //
            // A raw ClusterKernel call surfaces the index records that an
            // admin-trusted recovery script / ops tool would see. The
            // policy-enforced kernel applies a default-hidden visibility
            // veto that drops these records unless explicit visibility
            // rules grant existence — so the admin-surface CONTRACT is
            // tested via the raw kernel, mirroring the bypass the deleted
            // `_kernel` getter once provided.
            const surface = await kernel.findSources({ query: 'R2-007 Index Derives' });
            expect(surface.indexRecords.length).toBeGreaterThan(0);
            const surfaceRecord = surface.indexRecords.find((r) => r.text.includes('R2-007 Index Derives'));
            expect(surfaceRecord).toBeDefined();
            expect(surfaceRecord!.owner).toBe('index');
            expect(surfaceRecord!.sourceStore).toBe('canonical');

            // The surface also resolves owner truth from canonical.
            expect(surface.resolvedEntities.length).toBeGreaterThan(0);
            const surfaceEntity = surface.resolvedEntities.find((e) => e.name === 'R2-007 Index Derives');
            expect(surfaceEntity).toBeDefined();
            expect(surfaceEntity!.owner).toBe('canonical');

            // ── Leg 2: store-level doctrine ─────────────────────────────
            const records = await stores.index.search({ text: 'R2-007 Index Derives' });
            expect(records.length).toBeGreaterThan(0);
            expect(records[0].owner).toBe('index');
            expect(records[0].sourceStore).toBe('canonical');

            // ── Cross-leg invariant — surface mirrors storage ───────────
            //
            // Every index record returned at the surface MUST also be
            // present in the storage layer. The surface cannot synthesize
            // records that don't exist in storage.
            for (const surfaceRec of surface.indexRecords) {
                expect(records.find((r) => r.id === surfaceRec.id)).toBeDefined();
            }

            rmSync(dir, { recursive: true, force: true });
        });
    });

    // ─── TESTS-R2-008 — dashboard redaction wiring net ───────────────────
    //
    // FULL INVARIANT: the dashboard's redaction logic must come from the
    // ONE shared `dashboard/lib/apply-redaction.js` module — never from an
    // inline copy in any component. The SURFACE-R010 fix removed the
    // inline `applyRedaction` from `PolicyViewToggle.jsx` and replaced it
    // with a `<script type="module">` import in `index.html` that exposes
    // `window.applyRedaction`. If a regression re-inlines redaction logic,
    // the dashboard UI and `test/dashboard-policy-view.test.ts` start
    // testing different code paths — the "security boundary tests its own
    // mirror" failure mode that TESTS-004 originally closed.
    //
    // HALF THAT WAS MISSING: Wave A2 closed SURFACE-R010 (deleted the inline
    // JSX) but added no failing-on-removal test. JSDOM is not configured
    // (`vitest.config.ts` has no environment override; the dashboard is JSX
    // not TSX), and adding it would require a vitest-config change beyond
    // test-only scope. The principled alternative is a static-source
    // regression net that proves
    //   1. `dashboard/index.html` loads `apply-redaction.js` as the shared
    //      module and exposes it via `window.applyRedaction`,
    //   2. `dashboard/components/PolicyViewToggle.jsx` does NOT redefine
    //      `function applyRedaction(...)` inline anywhere,
    //   3. the exported `applyRedaction` from the shared module actually
    //      redacts a DashboardObject end-to-end (functional canary so a
    //      future regression that empties the function body fails here too,
    //      not only in dashboard-policy-view.test.ts).
    //
    // This is the same confidence shape as a JSDOM render (the rendered
    // output of a component that delegates to `window.applyRedaction` is
    // the redacted DashboardObject) — just inverted: we prove the dashboard
    // CANNOT diverge from the shared function, rather than rendering and
    // observing.

    describe('TESTS-R2-008 — dashboard redaction wiring net', () => {
        const REPO_ROOT = resolve(import.meta.dirname, '..');
        const INDEX_HTML = join(REPO_ROOT, 'dashboard', 'index.html');
        const POLICY_VIEW = join(REPO_ROOT, 'dashboard', 'components', 'PolicyViewToggle.jsx');
        const SHARED_LIB = join(REPO_ROOT, 'dashboard', 'lib', 'apply-redaction.js');

        it('shared apply-redaction module exists at the canonical path', () => {
            expect(existsSync(SHARED_LIB)).toBe(true);
        });

        it('dashboard/index.html imports applyRedaction from the shared module and exposes window.applyRedaction', () => {
            expect(existsSync(INDEX_HTML)).toBe(true);
            const html = readFileSync(INDEX_HTML, 'utf-8');

            // Module import must reference the canonical path.
            expect(html).toMatch(/import\s*{\s*applyRedaction\s*}\s*from\s*['"]\.\/lib\/apply-redaction\.js['"]/);

            // Window-level export must be present so JSX components that
            // do `window.applyRedaction(...)` resolve to the same function
            // the unit tests cover.
            expect(html).toMatch(/window\.applyRedaction\s*=\s*applyRedaction/);
        });

        it('PolicyViewToggle.jsx does NOT redefine applyRedaction inline (SURFACE-R010 stays closed)', () => {
            expect(existsSync(POLICY_VIEW)).toBe(true);
            const jsx = readFileSync(POLICY_VIEW, 'utf-8');

            // No top-level function or const declaration of applyRedaction.
            // The comment block in the file may reference the name, but no
            // declaration is allowed. We grep for the declaration forms
            // explicitly.
            expect(jsx).not.toMatch(/function\s+applyRedaction\s*\(/);
            expect(jsx).not.toMatch(/const\s+applyRedaction\s*=\s*\(/);
            expect(jsx).not.toMatch(/const\s+applyRedaction\s*=\s*function\b/);
            expect(jsx).not.toMatch(/let\s+applyRedaction\s*=/);
        });

        it('shared applyRedaction is functional — redacts full object when ownerStore is not visible', () => {
            // Functional canary: even at static-read level we MUST be able
            // to invoke the shared module and assert real redaction. If a
            // regression empties the function body (returns input unchanged),
            // this leg fails without needing JSDOM.
            const dashObj = {
                type: 'entity',
                ownerStore: 'canonical',
                uri: 'cluster://canonical/abc',
                object: { id: 'abc', kind: 'document', name: 'Secret', attributes: { secret: 'top' }, owner: 'canonical', createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z' },
                provenanceGraph: { nodes: [{ uri: 'x' }], edges: [], warnings: [] },
                receipts: [{ id: 'r1' } as any],
                warnings: [],
            } as unknown as DashboardObject;

            const policyView = {
                principal: 'external-api',
                trustZone: 'external',
                visible: ['index'], // canonical NOT visible
                redacted: [] as string[],
            };

            const redacted = applyRedaction(dashObj, policyView as any) as any;

            // Full-object redaction is the marker-shape from the shared module.
            expect(redacted.object).toEqual({ _redacted: true });
            // Provenance / receipts cleared because the whole owner store is hidden.
            expect(redacted.provenanceGraph.nodes).toEqual([]);
            expect(redacted.provenanceGraph.edges).toEqual([]);
            expect(redacted.provenanceGraph.warnings.length).toBeGreaterThan(0);
            expect(redacted.receipts).toEqual([]);
            // Warning explaining the redaction is present.
            const hasRedactedWarning = redacted.warnings.some(
                (w: any) => w.type === 'redacted' && typeof w.message === 'string' && w.message.includes('redacted'),
            );
            expect(hasRedactedWarning).toBe(true);

            // Source object MUST NOT be mutated (the function returns a deep copy).
            expect((dashObj as any).object.attributes.secret).toBe('top');
        });

        it('shared applyRedaction is functional — field-level redaction replaces named field with [REDACTED]', () => {
            const dashObj = {
                type: 'entity',
                ownerStore: 'canonical',
                uri: 'cluster://canonical/abc',
                object: { id: 'abc', kind: 'document', name: 'Sample', attributes: { topic: 'wave-a3' }, owner: 'canonical', createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z' },
                provenanceGraph: { nodes: [], edges: [], warnings: [] },
                receipts: [],
                warnings: [],
            } as unknown as DashboardObject;

            const policyView = {
                principal: 'observer',
                trustZone: 'external-read',
                visible: ['canonical', 'index'],
                redacted: ['canonical.attributes'],
            };

            const redacted = applyRedaction(dashObj, policyView as any) as any;
            expect(redacted.object.attributes).toBe('[REDACTED]');
            // Other fields untouched.
            expect(redacted.object.name).toBe('Sample');
            expect(redacted.object.kind).toBe('document');
        });
    });
});
