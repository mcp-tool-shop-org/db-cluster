/**
 * Wave S2-A1 (Protocol-v2 amend) — Kernel regression nets.
 *
 * Fix Agent 4 domain: kernel commit / receipt / provenance. Each test
 * encodes a FULL invariant (FAIL at HEAD → PASS once the wave lands) so a
 * future regression that re-opens the hole fails loudly in CI.
 *
 * Findings covered:
 *
 *  - PROV-002 (HIGH): the `update_entity` commit arm now APPENDS version N+1
 *    (prior retained). Before calling `canonical.update` the arm fetches the
 *    current latest (version N) so the `mutation_committed` provenance event's
 *    `detail.previous` can carry a snapshot of the displaced version
 *    ({ entityId, version, name, attributes }). The event also sets
 *    `parentEventId` lineage so the version chain is walkable, and
 *    `getVersion(entityId, N)` reconstructs pre-mutation truth.
 *
 *  - PROV-005 (MEDIUM): command↔receipt bijection at commit. A receipt is
 *    minted ONLY for a command in `committed` status, and a committed command
 *    gets EXACTLY ONE receipt (no double-receipt on retry/replay). Both
 *    directions resolve: every committed command has a receipt, and every
 *    receipt's commandId resolves to a committed command.
 *
 *  - PROV-004 (HIGH): a committed mutation's receipt + provenance event come
 *    back with a valid `integrityHash` that verifies via the shared helper
 *    `computeIntegrityHash` from `src/types/integrity.ts`.
 *
 * NOTE (coordinator gate): the local adapters (Agent 2) land concurrently.
 * Assertions that exercise the versioned canonical store (`getVersion` /
 * `listVersions`) and the ledger integrity stamping (`integrityHash`) are
 * marked inline — they FAIL at HEAD until those adapter changes land and PASS
 * under the authoritative coordinator gate. The kernel-owned assertions
 * (`detail.previous`, lineage, bijection) hold against the contract regardless.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalCluster } from '../src/adapters/local/index.js';
import { ClusterKernel } from '../src/kernel/cluster-kernel.js';
import { CommandAlreadyTerminalError } from '../src/kernel/errors.js';
import { computeIntegrityHash } from '../src/types/integrity.js';
import type { ProvenanceEvent } from '../src/types/provenance-event.js';

function freshDir(prefix: string): string {
    return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * Drive a fresh entity through propose → validate → commit of an
 * `update_entity` mutation, returning the kernel, the seeded entity, the
 * commit result, and the `mutation_committed` event for that update.
 */
async function commitAnUpdate(
    dir: string,
    patch: { name?: string; attributes?: Record<string, unknown> },
) {
    const stores = createLocalCluster(dir);
    const kernel = new ClusterKernel(stores, { dataDir: dir });

    // Seed version 1 through the kernel (receipt emitted).
    const { entity } = await kernel.createEntity({
        kind: 'thesis',
        name: 'Original',
        attributes: { confidence: 'low', rev: 1 },
        actorId: 'seed:1',
    });

    // Propose → validate → commit an update_entity.
    const cmd = await kernel.proposeMutation({
        verb: 'update_entity',
        targetStore: 'canonical',
        payload: { entityId: entity.id, patch },
        proposedBy: 'editor:1',
    });
    await kernel.validateMutation(cmd.id);
    const result = await kernel.commitMutation(cmd.id, 'editor:1');

    // Find the mutation_committed event for this update.
    const events = await stores.ledger.listEvents({ subjectId: entity.id });
    const mutationCommitted = events.find((e) => e.action === 'mutation_committed');

    return { stores, kernel, entity, cmd, result, mutationCommitted };
}

describe('Wave S2-A1 — Kernel regression nets (Fix Agent 4)', () => {
    // ─── PROV-002: displaced prior version + lineage on update_entity ─────────

    describe('PROV-002 — update_entity records displaced prior version + lineage', () => {
        it('mutation_committed detail.previous carries the prior version name + attributes', async () => {
            const dir = freshDir('s2a1-prov002-prev-');
            try {
                const { mutationCommitted, entity } = await commitAnUpdate(dir, {
                    name: 'Revised',
                    attributes: { confidence: 'high', rev: 2 },
                });

                expect(
                    mutationCommitted,
                    'a mutation_committed event must exist for the updated entity',
                ).toBeDefined();

                const previous = mutationCommitted!.detail.previous as
                    | { entityId?: string; version?: number; name?: string; attributes?: Record<string, unknown> }
                    | undefined;

                expect(
                    previous,
                    'detail.previous must snapshot the displaced version so pre-mutation truth is reconstructable',
                ).toBeDefined();
                expect(previous!.entityId).toBe(entity.id);
                // Prior truth: the values BEFORE the update (version 1).
                expect(previous!.name).toBe('Original');
                expect(previous!.attributes).toEqual({ confidence: 'low', rev: 1 });
                // Prior version number must be the displaced version (N), i.e. 1.
                // (Awaits Agent 2 versioned canonical store for the stamped value.)
                expect(previous!.version).toBe(1);
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });

        it('getVersion(entityId, priorN) reconstructs pre-mutation truth; latest is the new version', async () => {
            const dir = freshDir('s2a1-prov002-getver-');
            try {
                const { stores, entity } = await commitAnUpdate(dir, {
                    name: 'Revised',
                    attributes: { confidence: 'high', rev: 2 },
                });

                // Latest (get) returns the new truth.
                const latest = await stores.canonical.get(entity.id);
                expect(latest).not.toBeNull();
                expect(latest!.name).toBe('Revised');
                expect(latest!.attributes).toEqual({ confidence: 'high', rev: 2 });

                // Prior version is RECOVERABLE — pre-mutation truth not destroyed.
                // (Awaits Agent 2 versioned canonical store.)
                const versions = await stores.canonical.listVersions(entity.id);
                expect(
                    versions.length,
                    'both the original and the updated version must be retained',
                ).toBe(2);

                const priorN = latest!.version - 1;
                const prior = await stores.canonical.getVersion(entity.id, priorN);
                expect(prior, 'prior version must be reconstructable via getVersion').not.toBeNull();
                expect(prior!.name).toBe('Original');
                expect(prior!.attributes).toEqual({ confidence: 'low', rev: 1 });
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });

        it('mutation_committed sets parentEventId lineage so the version chain is walkable via trace', async () => {
            const dir = freshDir('s2a1-prov002-lineage-');
            try {
                const { stores, kernel, entity, mutationCommitted } = await commitAnUpdate(dir, {
                    name: 'Revised',
                    attributes: { confidence: 'high', rev: 2 },
                });

                expect(mutationCommitted).toBeDefined();
                // Lineage: the commit event chains back to the entity's creation
                // (or a prior subject event) so the version chain is walkable.
                expect(
                    mutationCommitted!.parentEventId,
                    'mutation_committed must set parentEventId so the version chain is walkable',
                ).toBeDefined();

                // The parent must resolve to a real prior event for this subject.
                const parent = await stores.ledger.getEvent(mutationCommitted!.parentEventId!);
                expect(parent, 'the lineage parent must resolve to a real ledger event').not.toBeNull();

                // why()/traceProvenance can reach the displaced-version truth:
                // traceProvenance walks the subject's lineage and the prior
                // snapshot is carried on the mutation_committed event it returns.
                const traced = await kernel.traceProvenance(entity.id);
                const tracedCommit = traced.find(
                    (e: ProvenanceEvent) => e.action === 'mutation_committed',
                );
                expect(
                    tracedCommit,
                    'traceProvenance must reach the mutation_committed event carrying prior truth',
                ).toBeDefined();
                expect(
                    (tracedCommit!.detail.previous as { name?: string } | undefined)?.name,
                    'the traced event must still carry the reconstructable prior name',
                ).toBe('Original');
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });
    });

    // ─── PROV-005: command↔receipt bijection at commit ────────────────────────

    describe('PROV-005 — command↔receipt bijection at commit', () => {
        it('a normal commit produces EXACTLY ONE receipt for the committed command; both directions resolve', async () => {
            const dir = freshDir('s2a1-prov005-bijection-');
            try {
                const stores = createLocalCluster(dir);
                const kernel = new ClusterKernel(stores, { dataDir: dir });

                const cmd = await kernel.proposeMutation({
                    verb: 'create_entity',
                    targetStore: 'canonical',
                    payload: { kind: 'Person', name: 'Alice', attributes: {} },
                    proposedBy: 'op:1',
                });
                await kernel.validateMutation(cmd.id);
                const result = await kernel.commitMutation(cmd.id, 'op:1');

                // Forward direction: the committed command has a receipt.
                const receiptsForCmd = await stores.ledger.listReceipts({ commandId: cmd.id });
                expect(
                    receiptsForCmd.length,
                    'a committed command must have exactly one receipt',
                ).toBe(1);
                expect(receiptsForCmd[0].id).toBe(result.receipt.id);

                // Backward direction: the receipt's commandId resolves to a
                // command in `committed` status.
                const resolvedCommand = await kernel.inspectCommand(receiptsForCmd[0].commandId);
                expect(resolvedCommand.status).toBe('committed');
                expect(resolvedCommand.id).toBe(cmd.id);
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });

        it('re-committing a committed command is rejected and does NOT mint a second receipt (no orphan/double receipt)', async () => {
            const dir = freshDir('s2a1-prov005-double-');
            try {
                const stores = createLocalCluster(dir);
                const kernel = new ClusterKernel(stores, { dataDir: dir });

                const cmd = await kernel.proposeMutation({
                    verb: 'create_entity',
                    targetStore: 'canonical',
                    payload: { kind: 'Person', name: 'Bob', attributes: {} },
                    proposedBy: 'op:1',
                });
                await kernel.validateMutation(cmd.id);
                await kernel.commitMutation(cmd.id, 'op:1');

                const before = await stores.ledger.listReceipts({ commandId: cmd.id });
                expect(before.length).toBe(1);

                // Replay/retry: the command is now terminal. Committing again
                // must be rejected on the policed path WITHOUT minting a
                // second receipt for the same command.
                await expect(kernel.commitMutation(cmd.id, 'op:1')).rejects.toBeInstanceOf(
                    CommandAlreadyTerminalError,
                );

                const after = await stores.ledger.listReceipts({ commandId: cmd.id });
                expect(
                    after.length,
                    'a committed command must never receive a second receipt on replay',
                ).toBe(1);
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });

        it('the policed commit path never mints a receipt for a non-committed / unknown command', async () => {
            const dir = freshDir('s2a1-prov005-orphan-');
            try {
                const stores = createLocalCluster(dir);
                const kernel = new ClusterKernel(stores, { dataDir: dir });

                // (1) Non-committed: a freshly PROPOSED command is not committable.
                // commitMutation rejects it (CommandNotValidatedError) BEFORE any
                // mutation/receipt — so no orphan receipt can be minted for it.
                const proposed = await kernel.proposeMutation({
                    verb: 'create_entity',
                    targetStore: 'canonical',
                    payload: { kind: 'Person', name: 'Carol', attributes: {} },
                    proposedBy: 'op:1',
                });
                await expect(kernel.commitMutation(proposed.id, 'op:1')).rejects.toBeTruthy();
                expect(
                    (await stores.ledger.listReceipts({ commandId: proposed.id })).length,
                    'a non-committed command must never receive a receipt',
                ).toBe(0);

                // (2) Unknown: an id that resolves to no command is rejected
                // (CommandNotFoundError) — the policed path cannot mint a receipt
                // for a command that does not exist.
                const unknownId = 'unknown-command-id-0000';
                await expect(kernel.commitMutation(unknownId, 'op:1')).rejects.toBeTruthy();
                expect(
                    (await stores.ledger.listReceipts({ commandId: unknownId })).length,
                    'an unknown command must never receive a receipt',
                ).toBe(0);

                // Whole-ledger invariant: every receipt that DOES exist resolves
                // back to a command in `committed` status (backward bijection).
                const allReceipts = await stores.ledger.listReceipts({ limit: 100000 });
                for (const r of allReceipts) {
                    const cmd = await kernel.inspectCommand(r.commandId);
                    expect(cmd.status).toBe('committed');
                }
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });
    });

    // ─── PROV-004: committed mutation receipt + event carry valid integrityHash ─

    describe('PROV-004 — receipt + event carry a valid integrityHash', () => {
        it("a committed mutation's receipt verifies via the shared computeIntegrityHash helper", async () => {
            const dir = freshDir('s2a1-prov004-receipt-');
            try {
                const stores = createLocalCluster(dir);
                const kernel = new ClusterKernel(stores, { dataDir: dir });

                const cmd = await kernel.proposeMutation({
                    verb: 'create_entity',
                    targetStore: 'canonical',
                    payload: { kind: 'Person', name: 'Dave', attributes: {} },
                    proposedBy: 'op:1',
                });
                await kernel.validateMutation(cmd.id);
                const { receipt } = await kernel.commitMutation(cmd.id, 'op:1');

                // (Awaits Agent 2 ledger integrity stamping.)
                expect(
                    receipt.integrityHash,
                    'a committed receipt must carry an integrityHash',
                ).toBeTruthy();
                expect(typeof receipt.integrityHash).toBe('string');
                // The stored hash must equal a recompute over the record's
                // content (the helper strips the integrityHash field itself).
                const recomputed = computeIntegrityHash(
                    receipt as unknown as Record<string, unknown>,
                );
                expect(
                    receipt.integrityHash,
                    'receipt.integrityHash must equal computeIntegrityHash(receipt)',
                ).toBe(recomputed);
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });

        it("a committed mutation's provenance event verifies via the shared helper", async () => {
            const dir = freshDir('s2a1-prov004-event-');
            try {
                const stores = createLocalCluster(dir);
                const kernel = new ClusterKernel(stores, { dataDir: dir });

                const cmd = await kernel.proposeMutation({
                    verb: 'create_entity',
                    targetStore: 'canonical',
                    payload: { kind: 'Person', name: 'Erin', attributes: {} },
                    proposedBy: 'op:1',
                });
                await kernel.validateMutation(cmd.id);
                await kernel.commitMutation(cmd.id, 'op:1');

                const events = await stores.ledger.listEvents({});
                const committedEvent = events.find((e) => e.action === 'mutation_committed');
                expect(committedEvent).toBeDefined();

                // (Awaits Agent 2 ledger integrity stamping.)
                expect(
                    committedEvent!.integrityHash,
                    'a mutation_committed event must carry an integrityHash',
                ).toBeTruthy();
                const recomputed = computeIntegrityHash(
                    committedEvent! as unknown as Record<string, unknown>,
                );
                expect(committedEvent!.integrityHash).toBe(recomputed);
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });
    });
});
