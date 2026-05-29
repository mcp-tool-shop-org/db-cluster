/**
 * Wave S2-A1 Fix-up (Agent A) — ops diagnostics regression net.
 *
 * Two real defects found by adversarial verifiers AFTER the PROV-003/PROV-004
 * tamper-evidence work shipped, plus two cheap verifier-flagged test gaps.
 *
 * DEFECT 1 (HIGH — wave regression): a legitimate `rotate()` archives the head
 *   of the ledger; the FIRST RETAINED active record then legitimately carries a
 *   `prevHash` pointing at an archived (now-absent) predecessor. The pre-fix
 *   `checkIntegrityChain` treated the first stamped record as genesis and flagged
 *   any non-`undefined` `prevHash` as "a record was deleted/reordered", so
 *   `verify()` reported `ledger_integrity_chain = corrupt` on EVERY cluster that
 *   had run a normal rotate. The PROV-006 tests never ran `verify` after `rotate`,
 *   so it shipped. Fix: relax the genesis rule — verify each record's own
 *   `integrityHash` recomputes AND that consecutive chaining holds for every
 *   adjacent pair within the active file; do NOT require the first active
 *   record's `prevHash` to be `undefined`. Internal edits, reorders within the
 *   active file, and per-record hash tampering REMAIN detected.
 *
 * DEFECT 2 (HIGH — in-scope miss): PROV-003's scope named `doctor`, but only
 *   `verify`/`provenance-check`/`receipt-check` got the integrity checks.
 *   `doctor()` ran reachability/index/orphan checks only and reported `healthy`
 *   on a tampered store that `verify()` calls `corrupt`. Fix: make `doctor()`
 *   integrity-aware via the SHARED check bodies extracted to
 *   `src/ops/integrity-checks.ts` — a tampered store → NON-healthy.
 *
 * V1-103 — the `command_receipt_bijection` `duplicatedCommands` arm had no test;
 *   plant TWO receipts sharing one committed command's id → bijection corrupt.
 * V1-104 — `backup()` reads `getContent` unguarded; on a tampered blob the
 *   hardened adapter throws, aborting the backup. Pin that contract (this test
 *   does NOT modify backup.ts).
 *
 * Throwaway temp dirs only — NEVER the repo's `.db-cluster/`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLocalCluster } from '../src/adapters/local/index.js';
import { ClusterKernel } from '../src/kernel/cluster-kernel.js';
import { CommandQueue } from '../src/kernel/command-queue.js';
import type { ClusterStores } from '../src/contracts/index.js';
import type { ProvenanceEvent } from '../src/types/provenance-event.js';
import type { Receipt } from '../src/types/receipt.js';
import { computeIntegrityHash } from '../src/types/integrity.js';
import { verify } from '../src/ops/verify.js';
import { doctor } from '../src/ops/doctor.js';
import { backup } from '../src/ops/backup.js';
import type { ClusterHealth } from '../src/types/health.js';

/** A status is "non-healthy" if the overall cluster health is not `healthy`. */
function isNonHealthy(health: ClusterHealth): boolean {
    return health.status !== 'healthy';
}

/** Find the named check (if present) in a ClusterHealth report. */
function findCheck(health: ClusterHealth, name: string) {
    return health.checks.find((c) => c.name === name);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Wave S2-A1 fix-up ops regression — Defect 1 / Defect 2 / V1-103 / V1-104', () => {
    let cluster: ClusterStores;
    let kernel: ClusterKernel;
    let TEST_DIR: string;

    beforeEach(() => {
        TEST_DIR = mkdtempSync(join(tmpdir(), 'db-cluster-s2a1-fixup-'));
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

    /** Build a small, healthy cluster: one entity, one text artifact. */
    async function seedHealthyCluster() {
        await kernel.createEntity({
            kind: 'doc',
            name: 'Alpha',
            attributes: { team: 'eng' },
            actorId: 'u',
        });
        const ing = await kernel.ingestArtifact({
            filename: 'notes.md',
            content: Buffer.from('# Heading\n\nsome searchable body text here'),
            mimeType: 'text/markdown',
            actorId: 'u',
        });
        return ing;
    }

    function artifactContentDir(): string {
        return join(TEST_DIR, 'artifact', 'content');
    }
    function eventsPath(): string {
        return join(TEST_DIR, 'ledger', 'events.json');
    }
    function receiptsPath(): string {
        return join(TEST_DIR, 'ledger', 'receipts.json');
    }

    // =====================================================================
    // DEFECT 1 — rotate() must not make verify() falsely report corrupt
    // =====================================================================

    /**
     * Seed a multi-record ledger then rotate the EVENTS-chain HEAD into the
     * archive so the first RETAINED active event legitimately carries a prevHash
     * pointing at an archived (absent) predecessor — the exact Defect 1 trigger.
     *
     * Ordering is deliberate so rotation isolates Defect 1 (the ledger-chain
     * false positive) WITHOUT perturbing the other invariants:
     *   1. Two raw, NON-command-bearing events are appended FIRST (oldest). They
     *      have no receipts and no committed commands.
     *   2. THEN the cluster is seeded via the kernel — createEntity +
     *      ingestArtifact — producing NEWER events AND their receipts/commands.
     *   3. Rotate at a boundary BETWEEN the raw head and the kernel work: the two
     *      raw events archive; every kernel event + ALL receipts are retained, so
     *      the command↔receipt bijection and the orphan checks stay intact and
     *      the cluster is genuinely HEALTHY apart from the (now-fixed) chain rule.
     *
     * The retained events set has >= 2 records (the kernel produces several), so
     * the interior-edit and adjacent-reorder variants have an adjacent pair to
     * break.
     */
    async function seedThenRotateHead(): Promise<void> {
        // (1) Raw non-command events FIRST (these become the archived head). The
        // 5ms sleeps guarantee distinct ISO timestamps (proven pattern from
        // wave-b1-fixup-regression.test.ts).
        await cluster.ledger.append({
            action: 'cluster_note',
            subjectId: 'raw-head-1',
            subjectStore: 'ledger',
            actorId: 'u',
            detail: {},
        });
        await sleep(5);
        await cluster.ledger.append({
            action: 'cluster_note',
            subjectId: 'raw-head-2',
            subjectStore: 'ledger',
            actorId: 'u',
            detail: {},
        });
        await sleep(5);
        // (2) Kernel work AFTER, with a clean timestamp boundary. Capture the
        // boundary just before so every kernel event/receipt is strictly newer.
        const boundary = new Date().toISOString();
        await sleep(5);
        await seedHealthyCluster();
        // (3) Rotate: archive everything strictly older than the boundary (the
        // two raw events) and retain all kernel events + ALL receipts.
        const result = await cluster.ledger.rotate(boundary);
        expect(result.archived).toBe(2);
        expect(result.retained).toBeGreaterThanOrEqual(2);
    }

    it('Defect 1 — verify() is healthy after a legitimate rotate of the ledger head [ledger_integrity_chain]', async () => {
        await seedThenRotateHead();

        // Re-open from disk so the ledger reloads the rotated active files (the
        // retained head carries a non-undefined prevHash on disk).
        const reopened = createLocalCluster(TEST_DIR);
        const cq = new CommandQueue(TEST_DIR);
        const health = await verify(reopened, { commandQueue: cq });

        // FAILS at HEAD: pre-fix the first retained record's non-undefined
        // prevHash was flagged as genesis-violation → corrupt.
        const chain = findCheck(health, 'ledger_integrity_chain');
        expect(chain).toBeTruthy();
        expect(
            chain!.status,
            `ledger_integrity_chain=${chain!.status}: ${chain!.message}\n${chain!.details ?? ''}`,
        ).toBe('healthy');
        expect(health.status).toBe('healthy');
    });

    it('Defect 1 — an internal hand-edit AFTER rotate still makes ledger_integrity_chain corrupt', async () => {
        await seedThenRotateHead();

        // Re-stamp a valid chain over the RETAINED records (so prevHash links are
        // mutually consistent within the active file, as they are on disk), then
        // hand-edit a NON-head record's field without re-stamping its hash.
        const lines = readFileSync(eventsPath(), 'utf-8').split('\n').filter((l) => l.trim());
        const events: ProvenanceEvent[] = lines.map((l) => JSON.parse(l));
        expect(events.length).toBeGreaterThanOrEqual(2);
        let prev: string | undefined = events[0].prevHash; // preserve the head's archived-predecessor link
        for (let i = 0; i < events.length; i++) {
            if (i > 0) events[i].prevHash = prev;
            events[i].integrityHash = computeIntegrityHash(events[i] as unknown as Record<string, unknown>);
            prev = events[i].integrityHash;
        }
        // Tamper the LAST record's content, leave its now-stale hash untouched.
        events[events.length - 1].actorId = 'attacker';
        writeFileSync(eventsPath(), events.map((e) => JSON.stringify(e)).join('\n') + '\n');

        const reopened = createLocalCluster(TEST_DIR);
        const cq = new CommandQueue(TEST_DIR);
        const health = await verify(reopened, { commandQueue: cq });

        expect(isNonHealthy(health)).toBe(true);
        const chain = findCheck(health, 'ledger_integrity_chain');
        expect(chain!.status).not.toBe('healthy');
        expect(chain!.severity).toBe('error');
    });

    it('Defect 1 — an adjacent-pair chain break (reorder) within the active file still makes ledger_integrity_chain corrupt', async () => {
        await seedThenRotateHead();

        const lines = readFileSync(eventsPath(), 'utf-8').split('\n').filter((l) => l.trim());
        const events: ProvenanceEvent[] = lines.map((l) => JSON.parse(l));
        expect(events.length).toBeGreaterThanOrEqual(2);
        // Stamp a valid chain over the retained set, preserving the head's
        // archived-predecessor prevHash so ONLY the deliberate break below is
        // the violation.
        let prev: string | undefined = events[0].prevHash;
        for (let i = 0; i < events.length; i++) {
            if (i > 0) events[i].prevHash = prev;
            events[i].integrityHash = computeIntegrityHash(events[i] as unknown as Record<string, unknown>);
            prev = events[i].integrityHash;
        }
        // Reorder two interior/adjacent records: their self-hashes stay valid but
        // the prevHash links no longer agree with the new physical order.
        [events[events.length - 2], events[events.length - 1]] = [
            events[events.length - 1],
            events[events.length - 2],
        ];
        writeFileSync(eventsPath(), events.map((e) => JSON.stringify(e)).join('\n') + '\n');

        const reopened = createLocalCluster(TEST_DIR);
        const cq = new CommandQueue(TEST_DIR);
        const health = await verify(reopened, { commandQueue: cq });

        expect(isNonHealthy(health)).toBe(true);
        const chain = findCheck(health, 'ledger_integrity_chain');
        expect(chain!.status).not.toBe('healthy');
    });

    // =====================================================================
    // DEFECT 2 — doctor() must be integrity-aware
    // =====================================================================

    it('Defect 2 — doctor() reports healthy on a clean cluster', async () => {
        await seedHealthyCluster();
        const cq = new CommandQueue(TEST_DIR);
        const health = await doctor(cluster, { dataDir: TEST_DIR, commandQueue: cq });
        expect(health.status).toBe('healthy');
        // The integrity checks must be present and healthy on a clean store.
        expect(findCheck(health, 'artifact_content_integrity')?.status).toBe('healthy');
        expect(findCheck(health, 'ledger_integrity_chain')?.status).toBe('healthy');
    });

    it('Defect 2 — a tampered artifact blob makes doctor() NON-healthy [artifact_content_integrity]', async () => {
        await seedHealthyCluster();

        const dir = artifactContentDir();
        const files = readdirSync(dir).filter((f) => /^[a-f0-9]{64}$/.test(f));
        expect(files.length).toBeGreaterThan(0);
        writeFileSync(join(dir, files[0]), Buffer.from('TAMPERED — different bytes entirely'));

        // FAILS at HEAD: doctor() had no content-integrity check → reported healthy.
        const reopened = createLocalCluster(TEST_DIR);
        const cq = new CommandQueue(TEST_DIR);
        const health = await doctor(reopened, { dataDir: TEST_DIR, commandQueue: cq });

        expect(isNonHealthy(health)).toBe(true);
        const check = findCheck(health, 'artifact_content_integrity');
        expect(check).toBeTruthy();
        expect(check!.status).not.toBe('healthy');
        expect(check!.severity).toBe('error');
    });

    it('Defect 2 — a hand-edited ledger record makes doctor() NON-healthy [ledger_integrity_chain]', async () => {
        await seedHealthyCluster();

        // Stamp a valid chain, then break one record's content without re-stamping.
        const lines = readFileSync(eventsPath(), 'utf-8').split('\n').filter((l) => l.trim());
        const events: ProvenanceEvent[] = lines.map((l) => JSON.parse(l));
        let prev: string | undefined;
        for (const e of events) {
            e.prevHash = prev;
            e.integrityHash = computeIntegrityHash(e as unknown as Record<string, unknown>);
            prev = e.integrityHash;
        }
        events[0].actorId = 'attacker';
        writeFileSync(eventsPath(), events.map((e) => JSON.stringify(e)).join('\n') + '\n');

        // FAILS at HEAD: doctor() had no ledger-chain check → reported healthy.
        const reopened = createLocalCluster(TEST_DIR);
        const cq = new CommandQueue(TEST_DIR);
        const health = await doctor(reopened, { dataDir: TEST_DIR, commandQueue: cq });

        expect(isNonHealthy(health)).toBe(true);
        const check = findCheck(health, 'ledger_integrity_chain');
        expect(check).toBeTruthy();
        expect(check!.status).not.toBe('healthy');
        expect(check!.severity).toBe('error');
    });

    it('Defect 2 — doctor() preserves its existing checks (reachability + index_populated) alongside integrity', async () => {
        await seedHealthyCluster();
        const cq = new CommandQueue(TEST_DIR);
        const health = await doctor(cluster, { dataDir: TEST_DIR, commandQueue: cq });
        // Existing doctor checks (ClusterHealth output shape preserved).
        for (const name of [
            'canonical_reachable',
            'artifact_reachable',
            'index_reachable',
            'ledger_reachable',
            'index_populated',
            'policy_defaults',
            'no_orphaned_mutations',
            'no_orphan_staging',
        ]) {
            expect(findCheck(health, name), `missing existing doctor check: ${name}`).toBeTruthy();
        }
        // And the new integrity checks were added.
        expect(findCheck(health, 'artifact_content_integrity')).toBeTruthy();
        expect(findCheck(health, 'ledger_integrity_chain')).toBeTruthy();
    });

    // =====================================================================
    // V1-103 — bijection duplicatedCommands arm
    // =====================================================================

    it('V1-103 — TWO receipts sharing one committed command id → command_receipt_bijection corrupt', async () => {
        await seedHealthyCluster();

        // Register a committed command in the queue.
        const cqSetup = new CommandQueue(TEST_DIR);
        const dupCmdId = 'committed-with-two-receipts';
        cqSetup.save({
            id: dupCmdId,
            verb: 'create_entity',
            targetStore: 'canonical',
            payload: { kind: 'x', name: 'y', attributes: {} },
            proposedAt: new Date().toISOString(),
            proposedBy: 'u',
            status: 'committed',
            committedAt: new Date().toISOString(),
            committedBy: 'u',
        });

        // Plant TWO receipts that both reference that one committed command.
        const mkReceipt = (id: string): Receipt => {
            const r: Receipt = {
                id,
                commandId: dupCmdId,
                committedAt: new Date().toISOString(),
                resultSummary: 'dup',
                affectedIds: [],
                provenanceEventId: 'evt',
                integrityHash: '',
            };
            r.integrityHash = computeIntegrityHash(r as unknown as Record<string, unknown>);
            return r;
        };
        const existing = readFileSync(receiptsPath(), 'utf-8');
        writeFileSync(
            receiptsPath(),
            existing +
                JSON.stringify(mkReceipt('dup-receipt-1')) +
                '\n' +
                JSON.stringify(mkReceipt('dup-receipt-2')) +
                '\n',
        );

        const reopened = createLocalCluster(TEST_DIR);
        const cq = new CommandQueue(TEST_DIR);
        const health = await verify(reopened, { commandQueue: cq });

        expect(isNonHealthy(health)).toBe(true);
        const check = findCheck(health, 'command_receipt_bijection');
        expect(check).toBeTruthy();
        expect(check!.status).not.toBe('healthy');
        // The duplicated-command arm specifically fired ("more than one receipt").
        expect(check!.message.toLowerCase()).toContain('more than one receipt');
    });

    // =====================================================================
    // V1-104 — backup() throws on a tampered blob (PINNED contract; backup.ts
    // is NOT edited by this agent).
    // =====================================================================

    it('V1-104 — backup() rejects with the integrity error when an artifact blob is tampered [pinned contract]', async () => {
        await seedHealthyCluster();

        const dir = artifactContentDir();
        const files = readdirSync(dir).filter((f) => /^[a-f0-9]{64}$/.test(f));
        expect(files.length).toBeGreaterThan(0);
        writeFileSync(join(dir, files[0]), Buffer.from('POISONED backup blob'));

        // Re-open so the hardened getContent re-reads the tampered bytes.
        const reopened = createLocalCluster(TEST_DIR);

        // CONTRACT AS SHIPPED: backup() calls getContent() unguarded, so the
        // hardened adapter's verify-on-read throws and the whole backup aborts
        // (fail-closed). This test PINS that behavior; it does not assert which
        // contract is "better" (graceful degradation vs fail-closed) — see the
        // coordinator note in the agent report.
        await expect(backup(reopened, { includeContent: true })).rejects.toThrow();
    });
});
