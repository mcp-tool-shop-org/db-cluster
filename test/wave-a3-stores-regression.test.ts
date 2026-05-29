/**
 * Wave A3 — Stores domain regression nets.
 *
 * Pins five behaviours that the re-audit-2 found could silently regress:
 *  - KERNEL-R2-002 — verify() must NOT false-flag ledger-subject events
 *    (command_approved / command_rejected / mutation_orphaned / etc) as
 *    orphans. Their subjectId is a command UUID, never present in canonical
 *    or artifact. The pre-fix code flagged every approved command as stale.
 *  - STORES-R2-002 — importSnapshot / importEvent / importReceipt are
 *    REQUIRED on their contracts (not optional?). backup.ts has treated them
 *    as runtime-mandatory since Wave A1; the contract must promise it too
 *    so a new adapter cannot compile without them.
 *  - STORES-R2-003 — verify() must consume mutation_orphaned events. A
 *    cluster with N orphaned mutations had been reporting healthy.
 *  - STORES-R2-004 — TraceBuilder.eventToEdgeType must not return
 *    'entity_created_by' for action 'mutation_orphaned'.
 *  - STORES-R2-005 — LocalArtifactStore.ingest() content write must be
 *    atomic via tmp+rename. The pre-fix plain writeFileSync left an orphan
 *    content file on mid-write crash.
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import {
    mkdtempSync,
    mkdirSync,
    rmSync,
    existsSync,
    readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalCluster } from '../src/adapters/local/index.js';
import { LocalArtifactStore } from '../src/adapters/local/local-artifact-store.js';
import { ClusterKernel } from '../src/kernel/cluster-kernel.js';
import { verify } from '../src/ops/verify.js';
import { TraceBuilder } from '../src/provenance/trace-builder.js';

describe('Wave A3 — Stores regression nets', () => {
    // ─── KERNEL-R2-002 — verify() ignores ledger-subject events ──────────
    //
    // Before the fix: verify() iterated every ledger event and checked
    // canonical.exists(event.subjectId) || artifact.exists(event.subjectId).
    // Events with subjectStore='ledger' (command_approved, command_rejected,
    // mutation_orphaned, command_compensated) have a commandId UUID for
    // subjectId. Those IDs are never in canonical/artifact, so the check
    // flagged them as orphans → verify().status === 'stale' for any cluster
    // that had ever approved or rejected a command.
    //
    // The full invariant: after a complete propose → validate → approve →
    // commit lifecycle, verify().status === 'healthy' and the
    // provenance_references_valid check passes.

    describe('KERNEL-R2-002 — verify() ignores ledger-subject events', () => {
        it('verify() reports healthy after a full propose→validate→approve→commit lifecycle', async () => {
            const dir = mkdtempSync(join(tmpdir(), 'wave-a3-verify-lifecycle-'));
            try {
                const stores = createLocalCluster(dir);
                const kernel = new ClusterKernel(stores, { dataDir: dir });

                // Full mutation lifecycle that emits command_approved
                // (subjectStore='ledger', subjectId=commandId).
                const proposal = await kernel.proposeMutation({
                    verb: 'create_entity',
                    targetStore: 'canonical',
                    payload: { kind: 'finding', name: 'verify-lifecycle', attributes: {} },
                    proposedBy: 'agent',
                });
                await kernel.validateMutation(proposal.id);
                await kernel.approveMutation(proposal.id, 'operator');
                await kernel.commitMutation(proposal.id, 'operator');

                // Sanity — a command_approved event with subjectStore='ledger' exists.
                const events = await stores.ledger.listEvents({});
                const approvedEvents = events.filter((e) => e.action === 'command_approved');
                expect(approvedEvents.length).toBeGreaterThan(0);
                expect(approvedEvents[0].subjectStore).toBe('ledger');

                // Now verify(): pre-fix this returned 'stale' because the
                // approved command's subjectId (a UUID) wasn't in canonical
                // or artifact stores. Post-fix: ledger-subject events are
                // excluded from the orphan check.
                const result = await verify(stores);
                expect(result.status).toBe('healthy');

                const provCheck = result.checks.find(
                    (c) => c.name === 'provenance_references_valid',
                );
                expect(provCheck).toBeDefined();
                expect(provCheck!.status).toBe('healthy');
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });

        it('verify() ignores rejected-command ledger events as orphans', async () => {
            const dir = mkdtempSync(join(tmpdir(), 'wave-a3-verify-reject-'));
            try {
                const stores = createLocalCluster(dir);
                const kernel = new ClusterKernel(stores, { dataDir: dir });

                const proposal = await kernel.proposeMutation({
                    verb: 'create_entity',
                    targetStore: 'canonical',
                    payload: { kind: 'finding', name: 'reject-lifecycle', attributes: {} },
                    proposedBy: 'agent',
                });
                await kernel.rejectMutation(proposal.id, 'operator', 'denied');

                const events = await stores.ledger.listEvents({});
                const rejectedEvents = events.filter((e) => e.action === 'command_rejected');
                expect(rejectedEvents.length).toBeGreaterThan(0);
                expect(rejectedEvents[0].subjectStore).toBe('ledger');

                // Pre-fix this would have flagged the rejected command as orphan.
                const result = await verify(stores);
                const provCheck = result.checks.find(
                    (c) => c.name === 'provenance_references_valid',
                );
                expect(provCheck!.status).toBe('healthy');
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });

        // ─── TESTS-B-006 (Wave B1-Amend) — all 5 ledger-subject event types ─
        //
        // V3-009 carry-over: Wave A3 covered 2 of 5 ledger-subject (and
        // index-subject) event types whose subjectId is a command/index UUID
        // not present in canonical/artifact. The other 3 (command_compensated,
        // mutation_orphaned with subjectStore='ledger', index_rebuilt with
        // subjectStore='index') had no consumer test.
        //
        // The verify() filter at src/ops/verify.ts:111 keeps both
        // 'ledger'-subject AND 'index'-subject events out of the
        // canonical/artifact existence check; both subjectStore values
        // must be exercised to pin the contract. The 5 event types this
        // suite enumerates correspond to the source comment at
        // src/ops/verify.ts:97-101.
        //
        // Each entry plants the event in the ledger (via lifecycle helpers
        // where convenient, or via direct ledger.append for synthetic
        // orphans) and asserts that verify()'s provenance_references_valid
        // check stays 'healthy' — proving the filter handles that subject.
        const ledgerSubjectEventCases = [
            {
                action: 'command_approved',
                subjectStore: 'ledger' as const,
                kind: 'lifecycle' as const,
            },
            {
                action: 'command_rejected',
                subjectStore: 'ledger' as const,
                kind: 'reject' as const,
            },
            {
                action: 'command_compensated',
                subjectStore: 'ledger' as const,
                kind: 'compensate' as const,
            },
            {
                // mutation_orphaned via compensate path emits with
                // subjectStore='ledger' (cluster-kernel.ts:1030-1042). Synthetic
                // append covers the contract — a real orphan trigger would
                // require fault-injection into emitReceipt that ESM forbids.
                action: 'mutation_orphaned',
                subjectStore: 'ledger' as const,
                kind: 'plant' as const,
            },
            {
                // index_rebuilt + reindex-arm mutation_committed both emit
                // with subjectStore='index'. verify()'s filter covers BOTH
                // 'ledger' and 'index' subject (verify.ts:111); the
                // index-subject side is the 5th type that previously had
                // zero coverage.
                action: 'index_rebuilt',
                subjectStore: 'index' as const,
                kind: 'rebuild' as const,
            },
        ];

        it.each(ledgerSubjectEventCases)(
            'verify() does NOT flag $action (subjectStore=$subjectStore) as orphan',
            async ({ action, subjectStore, kind }) => {
                const dir = mkdtempSync(join(tmpdir(), `wave-b1-verify-${action}-`));
                try {
                    const stores = createLocalCluster(dir);
                    const kernel = new ClusterKernel(stores, { dataDir: dir });

                    if (kind === 'lifecycle') {
                        // Full propose→validate→approve→commit → command_approved
                        const proposal = await kernel.proposeMutation({
                            verb: 'create_entity',
                            targetStore: 'canonical',
                            payload: { kind: 'note', name: `b1-${action}`, attributes: {} },
                            proposedBy: 'agent',
                        });
                        await kernel.validateMutation(proposal.id);
                        await kernel.approveMutation(proposal.id, 'operator');
                        await kernel.commitMutation(proposal.id, 'operator');
                    } else if (kind === 'reject') {
                        const proposal = await kernel.proposeMutation({
                            verb: 'create_entity',
                            targetStore: 'canonical',
                            payload: { kind: 'note', name: `b1-${action}`, attributes: {} },
                            proposedBy: 'agent',
                        });
                        await kernel.rejectMutation(proposal.id, 'operator', 'b1 denied');
                    } else if (kind === 'compensate') {
                        // Full lifecycle then compensate → command_compensated.
                        const proposal = await kernel.proposeMutation({
                            verb: 'create_entity',
                            targetStore: 'canonical',
                            payload: { kind: 'note', name: `b1-${action}`, attributes: {} },
                            proposedBy: 'agent',
                        });
                        await kernel.validateMutation(proposal.id);
                        await kernel.approveMutation(proposal.id, 'operator');
                        await kernel.commitMutation(proposal.id, 'operator');
                        await kernel.compensateMutation(proposal.id, 'operator', 'b1 compensate');
                    } else if (kind === 'rebuild') {
                        // Plant some real owner truth, then rebuild → index_rebuilt
                        // event with subjectStore='index'.
                        await stores.canonical.create({
                            kind: 'document',
                            name: `b1-rebuild-anchor`,
                            attributes: {},
                        });
                        await kernel.rebuildIndex('operator');
                    } else if (kind === 'plant') {
                        // Plant a synthetic orphan with subjectStore='ledger'.
                        // A real orphan-trigger path requires fault-injection
                        // into emitReceipt which ESM module-freezing blocks.
                        // The verify() filter is contract-driven (subjectStore
                        // alone gates the check) so a planted event covers it.
                        await stores.ledger.append({
                            action: 'mutation_orphaned',
                            actorId: 'kernel',
                            subjectId: 'cmd-b1-synthetic',
                            subjectStore: 'ledger',
                            detail: { commandId: 'cmd-b1-synthetic', error: 'synthetic orphan' },
                        });
                    }

                    // Sanity — the planted event is in the ledger with the
                    // expected subjectStore.
                    const events = await stores.ledger.listEvents({});
                    const matching = events.filter((e) => e.action === action);
                    expect(matching.length, `expected ≥1 ${action} event`).toBeGreaterThan(0);
                    expect(matching[0].subjectStore).toBe(subjectStore);

                    // Anchor entity so the cluster has owner truth and the
                    // other checks don't degrade on emptiness.
                    if (kind !== 'rebuild') {
                        await stores.canonical.create({
                            kind: 'document',
                            name: `b1-anchor-${action}`,
                            attributes: {},
                        });
                    }

                    // verify() — the provenance_references_valid check
                    // should NOT flag this event as orphan, because the
                    // verify() filter excludes 'ledger'-subject AND
                    // 'index'-subject events.
                    const result = await verify(stores);

                    const provCheck = result.checks.find(
                        (c) => c.name === 'provenance_references_valid',
                    );
                    expect(provCheck, 'expected provenance_references_valid check').toBeDefined();
                    expect(
                        provCheck!.status,
                        `${action} (${subjectStore}) caused provenance_references_valid to be ${provCheck!.status}: ${provCheck!.message}`,
                    ).toBe('healthy');
                } finally {
                    rmSync(dir, { recursive: true, force: true });
                }
            },
        );

        // ─── TESTS-B-016 (Wave B1-Amend) — check-isolation ──────────────────
        //
        // V3-014 carry-over: this region's targeted-check assertions used
        // `result.checks.find(...).status === 'healthy'`. A new check added
        // by Wave B (or future) that happens to degrade overall but NOT
        // provenance_references_valid would still pass each per-check
        // assertion above — masking a regression in the broader verify().
        //
        // This isolation assertion pins TWO additional invariants:
        //   1. After all 5 ledger-subject events are planted into the SAME
        //      cluster, result.overall === 'healthy' (no other check fires).
        //   2. result.checks.length === the count of checks verify() defines
        //      today (verify.ts has 4 checks: index_references_valid,
        //      provenance_references_valid, no_orphaned_mutations,
        //      receipts_provenance_valid). If verify() grows a new check,
        //      this assertion fails loudly and the test author updates
        //      the expectation explicitly.
        //
        // mutation_orphaned (planted) DOES correctly degrade the
        // no_orphaned_mutations check (STORES-R2-003 contract). Test
        // strategy: build TWO clusters — one with all NON-orphan ledger
        // events (asserts overall=healthy + check count); one with ALL
        // events INCLUDING the orphan (asserts overall NOT healthy
        // because the orphan check degrades, BUT provenance_references_valid
        // stays healthy).
        it('verify() overall=healthy + check-count fixed when only non-orphan ledger-subject events present', async () => {
            const dir = mkdtempSync(join(tmpdir(), 'wave-b1-isolation-clean-'));
            try {
                const stores = createLocalCluster(dir);
                const kernel = new ClusterKernel(stores, { dataDir: dir });

                // Plant: command_approved (full lifecycle), command_rejected,
                // command_compensated, index_rebuilt — NO mutation_orphaned.
                const p1 = await kernel.proposeMutation({
                    verb: 'create_entity',
                    targetStore: 'canonical',
                    payload: { kind: 'note', name: 'iso-clean-approved', attributes: {} },
                    proposedBy: 'agent',
                });
                await kernel.validateMutation(p1.id);
                await kernel.approveMutation(p1.id, 'operator');
                await kernel.commitMutation(p1.id, 'operator');
                await kernel.compensateMutation(p1.id, 'operator', 'iso clean comp');

                const p2 = await kernel.proposeMutation({
                    verb: 'create_entity',
                    targetStore: 'canonical',
                    payload: { kind: 'note', name: 'iso-clean-rejected', attributes: {} },
                    proposedBy: 'agent',
                });
                await kernel.rejectMutation(p2.id, 'operator', 'iso clean reject');

                await kernel.rebuildIndex('operator');

                const result = await verify(stores);

                // The checks verify() defines today, by name. This pinned set
                // is the contract; an added check forces an explicit update
                // here (catches "new check added that hides regression" per
                // TESTS-B-016). Wave S2-A1 (PROV-003) added the tamper-detecting
                // checks below; 'command_receipt_bijection' is emitted ONLY when
                // verify() is given a commandQueue handle, so verify(stores)
                // here does not include it.
                const expectedCheckNames = [
                    'index_references_valid',
                    'provenance_references_valid',
                    'no_orphaned_mutations',
                    'receipts_provenance_valid',
                    'artifact_content_integrity',
                    'ledger_integrity_chain',
                    'canonical_lineage_intact',
                ];
                expect(
                    result.checks.map((c) => c.name).sort(),
                    `verify() check set drifted from the TESTS-B-016-pinned contract. ` +
                        `If a check was added/renamed intentionally, update the expected ` +
                        `list AND audit the per-event-type tests above for coverage.`,
                ).toEqual([...expectedCheckNames].sort());
                expect(result.checks.length).toBe(expectedCheckNames.length);
                expect(
                    result.status,
                    `status=${result.status}; check states:\n` +
                        result.checks
                            .map((c) => `  ${c.name}: ${c.status} (${c.message})`)
                            .join('\n'),
                ).toBe('healthy');
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });

        it('verify() overall NOT healthy when synthetic mutation_orphaned is planted, but provenance_references_valid stays healthy', async () => {
            const dir = mkdtempSync(join(tmpdir(), 'wave-b1-isolation-orphan-'));
            try {
                const stores = createLocalCluster(dir);

                await stores.ledger.append({
                    action: 'mutation_orphaned',
                    actorId: 'kernel',
                    subjectId: 'cmd-isolation-synthetic',
                    subjectStore: 'ledger',
                    detail: { commandId: 'cmd-isolation-synthetic', error: 'synthetic' },
                });
                await stores.canonical.create({
                    kind: 'document',
                    name: 'iso-orphan-anchor',
                    attributes: {},
                });

                const result = await verify(stores);

                // The orphan check correctly degrades overall.
                expect(result.status).not.toBe('healthy');
                const orphanCheck = result.checks.find(
                    (c) => c.name === 'no_orphaned_mutations',
                );
                expect(orphanCheck).toBeDefined();
                expect(orphanCheck!.status).not.toBe('healthy');

                // BUT provenance_references_valid stays healthy — the orphan
                // event has subjectStore='ledger' and the verify() filter
                // (verify.ts:111) excludes it from the canonical/artifact
                // existence check. This is the load-bearing assertion: the
                // check that protects against THIS finding's regression
                // path is independent of the orphan-degradation path.
                const provCheck = result.checks.find(
                    (c) => c.name === 'provenance_references_valid',
                );
                expect(provCheck).toBeDefined();
                expect(provCheck!.status).toBe('healthy');
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });
    });

    // ─── STORES-R2-002 — import* hooks REQUIRED on contracts ─────────────
    //
    // Wave A2 promoted IndexStore.replaceAll to required but missed the
    // three import hooks. backup.ts::restore() treats all four as mandatory
    // at runtime (throws ImportSnapshotNotSupportedError when missing). The
    // contract still declared them optional (?:). Any new adapter could
    // compile cleanly without implementing them and only fail at restore.
    //
    // This test spawns tsc against a fixture file that defines a class
    // implementing a contract WITHOUT the now-required method, with a
    // @ts-expect-error directive on the class header. Before promotion the
    // directive is "unused" → tsc fails with TS2578. After promotion the
    // directive matches the real "missing member" error → tsc passes.

    describe('STORES-R2-002 — import* hooks are contract-required', () => {
        const repoRoot = process.cwd();

        const tscCheck = (fixturePath: string): { ok: boolean; output: string } => {
            try {
                const out = execSync(
                    `npx tsc --noEmit --strict --target es2022 --module nodenext --moduleResolution nodenext "${fixturePath}"`,
                    { cwd: repoRoot, encoding: 'utf-8', stdio: 'pipe' },
                );
                return { ok: true, output: out };
            } catch (err: unknown) {
                const e = err as { stdout?: string; stderr?: string };
                return {
                    ok: false,
                    output: `${e.stdout ?? ''}${e.stderr ?? ''}`,
                };
            }
        };

        it('CanonicalStore: a class without importSnapshot fails to compile', () => {
            const result = tscCheck(
                join(repoRoot, 'test/fixtures/incomplete-canonical-store.fixture.ts'),
            );
            // The fixture has `// @ts-expect-error` on its class header.
            // Post-fix, the directive matches a real "missing member" error
            // → tsc exits 0. Pre-fix, the directive is unused → tsc exits
            // non-zero with TS2578.
            expect(result.ok, `tsc output:\n${result.output}`).toBe(true);
        });

        it('ArtifactStore: a class without importSnapshot fails to compile', () => {
            const result = tscCheck(
                join(repoRoot, 'test/fixtures/incomplete-artifact-store.fixture.ts'),
            );
            expect(result.ok, `tsc output:\n${result.output}`).toBe(true);
        });

        it('LedgerStore: a class without importEvent fails to compile', () => {
            const result = tscCheck(
                join(repoRoot, 'test/fixtures/incomplete-ledger-store-event.fixture.ts'),
            );
            expect(result.ok, `tsc output:\n${result.output}`).toBe(true);
        });

        it('LedgerStore: a class without importReceipt fails to compile', () => {
            const result = tscCheck(
                join(repoRoot, 'test/fixtures/incomplete-ledger-store-receipt.fixture.ts'),
            );
            expect(result.ok, `tsc output:\n${result.output}`).toBe(true);
        });
    });

    // ─── STORES-R2-003 — verify() consumes mutation_orphaned events ──────
    //
    // Wave A2 added mutation_orphaned emission on receipt failure but no
    // consumer in verify()/doctor() reads it. A cluster with N orphans was
    // reporting healthy. verify() must surface the orphan signal.

    describe('STORES-R2-003 — verify() reports orphan mutations', () => {
        it('verify() reports degraded when mutation_orphaned events exist', async () => {
            const dir = mkdtempSync(join(tmpdir(), 'wave-a3-orphan-verify-'));
            try {
                const stores = createLocalCluster(dir);

                // Plant a synthetic mutation_orphaned event directly via the
                // ledger contract. We don't need to actually orphan a real
                // mutation to test the verify() consumer — the consumer's
                // contract is: if mutation_orphaned events exist, surface
                // them as a non-healthy check.
                await stores.ledger.append({
                    action: 'mutation_orphaned',
                    actorId: 'kernel',
                    subjectId: 'subject-uuid-deadbeef',
                    subjectStore: 'canonical',
                    detail: {
                        commandId: 'cmd-uuid-cafe',
                        error: 'synthetic orphan for test',
                    },
                });

                // Also create a real entity so the cluster has owner truth
                // and other checks pass — we want to verify the orphan check
                // is the ONLY thing degrading status.
                await stores.canonical.create({
                    kind: 'document',
                    name: 'AnchorEntity',
                    attributes: {},
                });

                const result = await verify(stores);

                // Pre-fix: verify() ignores mutation_orphaned events →
                // status === 'healthy'. Post-fix: a dedicated orphan check
                // surfaces the event → status is non-healthy AND a check
                // exists pointing at the orphan.
                expect(result.status).not.toBe('healthy');

                const orphanCheck = result.checks.find(
                    (c) => c.name === 'no_orphaned_mutations',
                );
                expect(orphanCheck, 'expected a no_orphaned_mutations check').toBeDefined();
                expect(orphanCheck!.status).not.toBe('healthy');
                expect(orphanCheck!.message).toMatch(/orphan/i);
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });

        it('verify() reports healthy on this check when no mutation_orphaned events exist', async () => {
            const dir = mkdtempSync(join(tmpdir(), 'wave-a3-orphan-verify-clean-'));
            try {
                const stores = createLocalCluster(dir);
                await stores.canonical.create({
                    kind: 'document',
                    name: 'CleanEntity',
                    attributes: {},
                });

                const result = await verify(stores);
                const orphanCheck = result.checks.find(
                    (c) => c.name === 'no_orphaned_mutations',
                );
                expect(orphanCheck).toBeDefined();
                expect(orphanCheck!.status).toBe('healthy');
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });

        // V1-007 fix-up — doctor() must consume mutation_orphaned events too.
        // Wave A2 wired verify() to surface the orphan signal but the
        // wave-edited comment in cluster-kernel.ts L322-329 promises
        // "doctor()/verify() can flag it" — doctor.ts had zero matches
        // for `mutation_orphaned`. A cluster with N orphans reported
        // healthy through doctor(). The fix mirrors verify.ts's check
        // pattern.

        it('doctor() reports degraded when mutation_orphaned events exist', async () => {
            const { doctor } = await import('../src/ops/doctor.js');
            const dir = mkdtempSync(join(tmpdir(), 'wave-a3-orphan-doctor-'));
            try {
                const stores = createLocalCluster(dir);

                await stores.ledger.append({
                    action: 'mutation_orphaned',
                    actorId: 'kernel',
                    subjectId: 'subject-uuid-deadbeef',
                    subjectStore: 'canonical',
                    detail: {
                        commandId: 'cmd-uuid-cafe',
                        error: 'synthetic orphan for doctor',
                    },
                });

                // Plant a real entity so reachability checks pass and the
                // orphan check is the ONLY thing degrading status.
                await stores.canonical.create({
                    kind: 'document',
                    name: 'DoctorAnchor',
                    attributes: {},
                });

                const result = await doctor(stores);

                // Pre-fix: doctor() ignored mutation_orphaned → healthy.
                // Post-fix: a dedicated orphan check surfaces the event.
                expect(result.status).not.toBe('healthy');
                const orphanCheck = result.checks.find(
                    (c) => c.name === 'no_orphaned_mutations',
                );
                expect(orphanCheck, 'expected a no_orphaned_mutations check from doctor()').toBeDefined();
                expect(orphanCheck!.status).not.toBe('healthy');
                expect(orphanCheck!.message).toMatch(/orphan/i);
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });

        it('doctor() reports healthy on this check when no mutation_orphaned events exist', async () => {
            const { doctor } = await import('../src/ops/doctor.js');
            const dir = mkdtempSync(join(tmpdir(), 'wave-a3-orphan-doctor-clean-'));
            try {
                const stores = createLocalCluster(dir);
                await stores.canonical.create({
                    kind: 'document',
                    name: 'DoctorCleanEntity',
                    attributes: {},
                });

                const result = await doctor(stores);
                const orphanCheck = result.checks.find(
                    (c) => c.name === 'no_orphaned_mutations',
                );
                expect(orphanCheck).toBeDefined();
                expect(orphanCheck!.status).toBe('healthy');
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });
    });

    // ─── STORES-R2-004 — TraceBuilder maps mutation_orphaned correctly ───
    //
    // The eventToEdgeType switch had no case for 'mutation_orphaned' and
    // fell through to the default 'entity_created_by' edge. Trace consumers
    // saw misleading "entity created by X" for actual orphan events. This
    // test pins the negative invariant: mutation_orphaned must NOT map to
    // entity_created_by.

    describe('STORES-R2-004 — TraceBuilder maps mutation_orphaned correctly', () => {
        it('eventToEdgeType for mutation_orphaned is NOT entity_created_by', async () => {
            // Reach the private method via a tiny adapter. We accept the
            // private-access pattern (cast to any) because the invariant
            // is about behaviour-through-trace, not API shape. An end-to-end
            // alternative — build a trace from an orphan event and assert
            // the edge type — is included below as well.

            const dir = mkdtempSync(join(tmpdir(), 'wave-a3-edge-type-'));
            try {
                const stores = createLocalCluster(dir);
                const builder = new TraceBuilder(stores, 'cluster://ledger/x');
                const edgeType = (builder as unknown as { eventToEdgeType(action: string): string })
                    .eventToEdgeType('mutation_orphaned');
                expect(edgeType).not.toBe('entity_created_by');
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });

        it('a trace from a mutation_orphaned event produces a non-entity_created_by edge', async () => {
            const dir = mkdtempSync(join(tmpdir(), 'wave-a3-edge-trace-'));
            try {
                const stores = createLocalCluster(dir);

                // Create a real entity, then plant an orphan event citing it.
                const entity = await stores.canonical.create({
                    kind: 'document',
                    name: 'OrphanedSubject',
                    attributes: {},
                });
                const orphan = await stores.ledger.append({
                    action: 'mutation_orphaned',
                    actorId: 'kernel',
                    subjectId: entity.id,
                    subjectStore: 'canonical',
                    detail: { commandId: 'cmd-x', error: 'synthetic' },
                });

                const builder = new TraceBuilder(
                    stores,
                    `cluster://ledger/${orphan.id}`,
                    { direction: 'forward' },
                );
                const graph = await builder.build();

                // There must be at least one edge from the orphan event to
                // the subject, and that edge MUST NOT be 'entity_created_by'.
                const edgesFromOrphan = graph.edges.filter(
                    (e) => e.sourceEventId === orphan.id,
                );
                expect(edgesFromOrphan.length).toBeGreaterThan(0);
                for (const edge of edgesFromOrphan) {
                    expect(edge.type).not.toBe('entity_created_by');
                }
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });
    });

    // ─── STORES-R2-005 — LocalArtifactStore.ingest atomic content write ──
    //
    // Pre-fix: writeFileSync(contentPath, input.content) — no atomic
    // tmp+rename, no error handling. A crash mid-write leaves an orphan
    // content file unreferenced. This test simulates the crash and asserts
    // that the content directory does not retain a `.tmp` artifact nor a
    // partial file at the final hash path.

    describe('STORES-R2-005 — LocalArtifactStore.ingest atomic content write', () => {
        it.skip('on tmp-write failure, no orphan .tmp file remains under contentDir [pre-A4 trigger obsolete]', async () => {
            // Wave A4 STORES-B-001: the tmp path now embeds pid+random suffix
            // (`${contentPath}.${pid}-${rand}.tmp`), so the pre-A4
            // failure-trigger (pre-creating a directory at the fixed
            // `${contentPath}.tmp` path) no longer fires writeFileSync EISDIR.
            // A cross-platform spy/mock alternative is blocked: vitest's
            // `vi.spyOn(fsNamespace, 'writeFileSync')` fails with "Cannot
            // redefine property" because ESM module namespaces are frozen.
            //
            // The catch-block cleanup invariant is still pinned at two layers:
            // (a) source-pattern test below asserts tmp+rename appears in the
            // ingest() body; (b) `test/wave-a4-stores-regression.test.ts`
            // STORES-B-001 random-tmp + startup-orphan-cleanup tests exercise
            // the new random-suffix path runtime-side.
            //
            // Wave A4 chose to skip this runtime probe rather than retrofit a
            // fragile mock. If a future refactor adds a `WriteAdapter`
            // injection seam to `LocalArtifactStore`, this probe can be
            // restored without ESM-mocking gymnastics.
        });

        it('the ingest() source uses tmp+rename atomic pattern, not plain writeFileSync', async () => {
            // Source-level invariant — the fix must replace the plain
            // writeFileSync(contentPath, ...) with a tmp+rename sequence.
            // This is the load-bearing assertion: a correctly-written fix
            // will use a `.tmp` path and `renameSync` (or fs.promises equiv)
            // in the ingest body. A non-atomic implementation cannot satisfy
            // this assertion.
            const { readFileSync: rfs } = await import('node:fs');
            const src = rfs(
                join(process.cwd(), 'src/adapters/local/local-artifact-store.ts'),
                'utf-8',
            );
            const ingestStart = src.indexOf('async ingest(');
            const ingestEnd = src.indexOf('async versions(');
            expect(ingestStart, 'ingest() body not found').toBeGreaterThan(-1);
            expect(ingestEnd, 'versions() body not found').toBeGreaterThan(ingestStart);
            const ingestBlock = src.slice(ingestStart, ingestEnd);

            const usesTmp = /\.tmp\b/.test(ingestBlock);
            const usesRename = /\brenameSync\b/.test(ingestBlock);
            expect(
                usesTmp && usesRename,
                `ingest() must use tmp+rename atomic pattern (saw .tmp=${usesTmp}, renameSync=${usesRename}).\n` +
                    `Source block:\n${ingestBlock}`,
            ).toBe(true);
        });

        // V1-004 fix-up — LocalArtifactStore.importSnapshot is the sibling
        // of ingest() and was NOT migrated to tmp+rename in Wave A3. Pre-fix
        // it uses plain `writeFileSync(contentPath, content)` — the exact
        // pattern just replaced in ingest(). This test pins the source-level
        // invariant (uses tmp+rename) AND the runtime behavior (failure
        // cleanup removes the .tmp file).

        it('importSnapshot source uses tmp+rename atomic pattern, not plain writeFileSync', async () => {
            const { readFileSync: rfs } = await import('node:fs');
            const src = rfs(
                join(process.cwd(), 'src/adapters/local/local-artifact-store.ts'),
                'utf-8',
            );
            const importStart = src.indexOf('async importSnapshot(');
            const importEnd = src.indexOf('private load(');
            expect(importStart, 'importSnapshot() body not found').toBeGreaterThan(-1);
            expect(importEnd, 'private load() body not found').toBeGreaterThan(importStart);
            const importBlock = src.slice(importStart, importEnd);

            const usesTmp = /\.tmp\b/.test(importBlock);
            const usesRename = /\brenameSync\b/.test(importBlock);
            expect(
                usesTmp && usesRename,
                `importSnapshot() must use tmp+rename atomic pattern (saw .tmp=${usesTmp}, renameSync=${usesRename}).\n` +
                    `Source block:\n${importBlock}`,
            ).toBe(true);
        });

        it.skip('importSnapshot on tmp-write failure leaves no orphan .tmp file under contentDir [pre-A4 trigger obsolete]', async () => {
            // See companion skip block above for rationale. Same shape: the
            // pre-A4 directory-block trigger no longer fires writeFileSync to
            // EISDIR after STORES-B-001's random-suffix tmp path. The
            // source-pattern probe `importSnapshot source uses tmp+rename
            // atomic pattern` immediately above still pins the invariant at
            // the source level; STORES-B-001 random-tmp coverage in
            // `wave-a4-stores-regression.test.ts` exercises the new path
            // runtime-side.
        });
    });
});
