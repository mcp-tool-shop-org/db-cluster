/**
 * Doctor/verify divergence regression — single-store ledger HEAD-truncation.
 *
 * FINDING (Wave S2-A1 follow-up; hardening, not a release blocker): `doctor()`
 * and `verify()` diverged on an events-only ledger head-truncation. `verify()`
 * reported the cluster NON-healthy; `doctor()` — the operator's FIRST-LINE
 * command — reported `healthy`, missing it entirely.
 *
 * Mechanism:
 *  - `ledger_integrity_chain` (shared by both surfaces) has a documented,
 *    ACCEPTED blind spot for head-truncation: the genesis-prevHash rule was
 *    relaxed in Wave S2-A1 (Defect 1) so a legitimate `rotate()` — whose first
 *    retained record points at an archived predecessor — does not false-positive.
 *    A deleted chain HEAD is therefore indistinguishable from a rotation, so the
 *    chain check stays `healthy` on a head-truncation.
 *  - `verify()` compensated because it ALSO ran the cross-store reference checks
 *    `provenance_references_valid` + `receipts_provenance_valid`. Deleting the
 *    oldest events.json line leaves a SURVIVING receipt whose `provenanceEventId`
 *    no longer resolves → `receipts_provenance_valid` goes `stale`.
 *  - `doctor()` ran NEITHER cross-store check. Its only ledger signals were the
 *    chain check (blind, per above) and the command↔receipt bijection (which
 *    passes on an events-only truncation — all receipts/commands survive). So
 *    doctor gave a clean bill on a truncated ledger.
 *
 * FIX: the two cross-store checks were re-homed into the shared
 * `src/ops/integrity-checks.ts` and are now run by BOTH `verify()` and
 * `doctor()`. This file pins that doctor() reports NON-healthy on an events-only
 * head-truncation (the existing wave-s2a1-fixup-ops-regression.test.ts did not
 * cover this), and pins the precise mechanism so a future "fix" of the chain
 * blind spot, or a refactor, cannot silently re-open the divergence.
 *
 * NOTE: this exercises the KNOWN-ACCEPTED head-truncation limitation (disclosed
 * in src/types/integrity.ts + SECURITY.md) surfacing as a doctor/verify
 * divergence — NOT a new tamper class. The deeper fix (a persisted chain anchor
 * so `checkIntegrityChain` itself distinguishes truncation from rotation)
 * remains deferred.
 *
 * Throwaway temp dirs only — NEVER the repo's `.db-cluster/`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLocalCluster } from '../src/adapters/local/index.js';
import { ClusterKernel } from '../src/kernel/cluster-kernel.js';
import { CommandQueue } from '../src/kernel/command-queue.js';
import type { ClusterStores } from '../src/contracts/index.js';
import type { ProvenanceEvent } from '../src/types/provenance-event.js';
import type { ClusterHealth } from '../src/types/health.js';
import { verify } from '../src/ops/verify.js';
import { doctor } from '../src/ops/doctor.js';

/** Find the named check (if present) in a ClusterHealth report. */
function findCheck(health: ClusterHealth, name: string) {
    return health.checks.find((c) => c.name === name);
}

/** Distinct ISO timestamps across appends (proven pattern from sibling tests). */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Compact dump of a health report for failure messages. */
function dump(health: ClusterHealth): string {
    return (
        `overall=${health.status}\n` +
        health.checks.map((c) => `  ${c.name}: ${c.status}`).join('\n')
    );
}

describe('doctor/verify divergence — events-only ledger head-truncation', () => {
    let TEST_DIR: string;
    let cluster: ClusterStores;
    let kernel: ClusterKernel;

    beforeEach(() => {
        TEST_DIR = mkdtempSync(join(tmpdir(), 'db-cluster-head-trunc-'));
        cluster = createLocalCluster(TEST_DIR);
        kernel = new ClusterKernel(cluster, { dataDir: TEST_DIR });
    });

    afterEach(() => {
        try {
            rmSync(TEST_DIR, { recursive: true, force: true });
        } catch {
            // best-effort
        }
    });

    function eventsPath(): string {
        return join(TEST_DIR, 'ledger', 'events.json');
    }

    /**
     * Seed `n` entities. Each `createEntity` appends exactly ONE `entity_created`
     * provenance event (recordProvenance → single ledger.append) AND a receipt
     * whose `provenanceEventId` references that event (cluster-kernel.ts). So the
     * FIRST createEntity's event is the oldest line of events.json and IS
     * receipt-referenced — deleting it is the exact head-truncation-with-dangle
     * the finding describes.
     */
    async function seedEntities(n: number): Promise<void> {
        for (let i = 0; i < n; i++) {
            await kernel.createEntity({
                kind: 'doc',
                name: `Entity-${i}`,
                attributes: { i },
                actorId: 'u',
            });
            await sleep(5);
        }
    }

    /**
     * Head-truncation of the EVENTS chain ONLY: delete the FIRST (oldest) line of
     * events.json, leaving receipts.json intact. Returns the deleted event id.
     *
     * Deleting the HEAD (not an interior line) is load-bearing: an interior
     * delete would break an ADJACENT prevHash pair and `ledger_integrity_chain`
     * would catch it directly — a different detection path. Only a head delete
     * lands squarely in the chain check's relaxed-genesis blind spot, which is
     * the scenario under test.
     */
    function truncateEventsHead(): string {
        const lines = readFileSync(eventsPath(), 'utf-8')
            .split('\n')
            .filter((l) => l.trim());
        expect(lines.length).toBeGreaterThanOrEqual(2);
        const deleted: ProvenanceEvent = JSON.parse(lines[0]);
        writeFileSync(eventsPath(), lines.slice(1).join('\n') + '\n');
        return deleted.id;
    }

    it('baseline — verify() catches the truncation via receipts_provenance_valid (chain stays blind)', async () => {
        await seedEntities(3);
        const deletedId = truncateEventsHead();

        // Re-open from disk so the ledger reloads the truncated active file.
        const reopened = createLocalCluster(TEST_DIR);
        const cq = new CommandQueue(TEST_DIR);
        const health = await verify(reopened, { commandQueue: cq });

        expect(health.status, dump(health)).not.toBe('healthy');

        // The cross-store dangle is the signal: a surviving receipt references
        // the deleted (head) event.
        const receipts = findCheck(health, 'receipts_provenance_valid');
        expect(receipts, 'verify() must emit receipts_provenance_valid').toBeTruthy();
        expect(receipts!.status, `deletedEvent=${deletedId}`).toBe('stale');

        // The chain check is BLIND to head-truncation (documented, accepted) —
        // it stays healthy. This is exactly why doctor(), lacking the cross-store
        // check, used to miss the truncation.
        expect(findCheck(health, 'ledger_integrity_chain')?.status).toBe('healthy');
    });

    it('THE FIX — doctor() reports NON-healthy on an events-only head-truncation', async () => {
        await seedEntities(3);
        const deletedId = truncateEventsHead();

        const reopened = createLocalCluster(TEST_DIR);
        const cq = new CommandQueue(TEST_DIR);
        const health = await doctor(reopened, { dataDir: TEST_DIR, commandQueue: cq });

        // FAILS before the fix: doctor() ran neither cross-store check, so its
        // only ledger signals (chain + bijection) both passed → reported healthy.
        expect(
            health.status,
            `doctor() reported a clean bill on a truncated ledger.\ndeletedEvent=${deletedId}\n${dump(health)}`,
        ).not.toBe('healthy');

        // It catches it via the SAME cross-store check verify() uses...
        const receipts = findCheck(health, 'receipts_provenance_valid');
        expect(receipts, 'doctor() must now emit receipts_provenance_valid').toBeTruthy();
        expect(receipts!.status).toBe('stale');
    });

    it('mechanism — doctor() catches it via the cross-store check, NOT the chain or bijection', async () => {
        await seedEntities(3);
        truncateEventsHead();

        const reopened = createLocalCluster(TEST_DIR);
        const cq = new CommandQueue(TEST_DIR);
        const health = await doctor(reopened, { dataDir: TEST_DIR, commandQueue: cq });

        // Pin the precise mechanism so a future change can't silently re-open the
        // divergence by, e.g., "fixing" the chain check the wrong way:
        //  - the chain check's head-truncation blind spot is UNCHANGED (healthy),
        const chain = findCheck(health, 'ledger_integrity_chain');
        expect(chain, dump(health)).toBeTruthy();
        expect(chain!.status, 'chain blind spot should be unchanged').toBe('healthy');
        //  - the bijection passes (all receipts/commands survive an events-only delete),
        expect(findCheck(health, 'command_receipt_bijection')?.status).toBe('healthy');
        //  - the symmetric provenance check is healthy here (surviving events still
        //    reference live canonical subjects; only ONE event was deleted),
        expect(findCheck(health, 'provenance_references_valid')?.status).toBe('healthy');
        //  - so the ONLY non-healthy signal is the receipts cross-store check.
        expect(findCheck(health, 'receipts_provenance_valid')?.status).toBe('stale');
    });

    it('divergence closed — doctor() and verify() now AGREE on the truncated cluster', async () => {
        await seedEntities(3);
        truncateEventsHead();

        const reopened = createLocalCluster(TEST_DIR);
        const cq = new CommandQueue(TEST_DIR);
        const docHealth = await doctor(reopened, { dataDir: TEST_DIR, commandQueue: cq });
        const verHealth = await verify(reopened, { commandQueue: cq });

        expect(docHealth.status, `doctor:\n${dump(docHealth)}`).not.toBe('healthy');
        expect(verHealth.status, `verify:\n${dump(verHealth)}`).not.toBe('healthy');
        // Both surface the same cross-store check at the same status.
        expect(findCheck(docHealth, 'receipts_provenance_valid')?.status).toBe(
            findCheck(verHealth, 'receipts_provenance_valid')?.status,
        );
    });

    it('no false positive — doctor() stays healthy and emits both new checks on a clean cluster', async () => {
        await seedEntities(3);

        const cq = new CommandQueue(TEST_DIR);
        const health = await doctor(cluster, { dataDir: TEST_DIR, commandQueue: cq });

        expect(health.status, dump(health)).toBe('healthy');
        // The two checks were actually added AND are healthy on an intact cluster.
        expect(findCheck(health, 'provenance_references_valid')?.status).toBe('healthy');
        expect(findCheck(health, 'receipts_provenance_valid')?.status).toBe('healthy');
    });
});
