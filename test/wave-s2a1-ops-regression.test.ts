/**
 * Wave S2-A1 (Protocol-v2 amend) — Ops diagnostics regression net.
 *
 * Fix Agent 5 domain: ops/verify + ops/provenance-check + ops/receipt-check +
 * ops/rebuild + indexing/content-indexer. Each test encodes a FULL invariant
 * that FAILED at HEAD (existence-only checks PASSED on corruption) and PASSES
 * after the hardening lands.
 *
 * Findings under test:
 *   PROV-003 — verify/provenance-check/receipt-check must report NON-healthy on
 *              a corrupted store. Four corruption families:
 *                (a) tampered artifact blob on disk
 *                (b) hand-edited persisted ledger record (receipt + event)
 *                (c) ledger prevHash chain break / reorder
 *                (d) orphan receipt (commandId resolves to no committed command)
 *                    + receipt-less committed command
 *                (e) canonical version-chain gap
 *   PROV-001 — rebuild() + content-indexer must surface a ContentReadIntegrityError
 *              (or otherwise refuse to index poisoned content) instead of
 *              silently indexing a tampered blob.
 *
 * Design note on adapter timing (Agent 2 lands concurrently): the verify
 * checks recompute integrity INDEPENDENTLY (sha256 of artifact bytes,
 * computeIntegrityHash of ledger records via the SHARED helper) rather than
 * relying solely on the adapter throwing. That keeps verify correct AND makes
 * these tests deterministic against the on-disk state regardless of whether
 * the adapter's verify-on-read throw has landed yet. The ledger-tamper cases
 * therefore STAMP a valid integrityHash first (exactly as Agent 2's writer
 * does, via the same helper) and then break a field — proving the verifier,
 * not the writer.
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
import { checkProvenance } from '../src/ops/provenance-check.js';
import { checkReceipts } from '../src/ops/receipt-check.js';
import { rebuildIndex } from '../src/ops/rebuild.js';
import { indexArtifactContent } from '../src/indexing/content-indexer.js';
import type { ClusterHealth } from '../src/types/health.js';

/** A status is "non-healthy" if the overall cluster health is not `healthy`. */
function isNonHealthy(health: ClusterHealth): boolean {
    return health.status !== 'healthy';
}

/** Find the named check (if present) in a ClusterHealth report. */
function findCheck(health: ClusterHealth, name: string) {
    return health.checks.find((c) => c.name === name);
}

describe('Wave S2-A1 ops regression — PROV-003 / PROV-001', () => {
    let cluster: ClusterStores;
    let kernel: ClusterKernel;
    let TEST_DIR: string;

    beforeEach(() => {
        TEST_DIR = mkdtempSync(join(tmpdir(), 'db-cluster-s2a1-ops-'));
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

    /** Path to the artifact content directory for direct on-disk tampering. */
    function artifactContentDir(): string {
        return join(TEST_DIR, 'artifact', 'content');
    }

    function eventsPath(): string {
        return join(TEST_DIR, 'ledger', 'events.json');
    }
    function receiptsPath(): string {
        return join(TEST_DIR, 'ledger', 'receipts.json');
    }

    // ----- Baseline: a clean cluster verifies healthy ---------------------

    it('PROV-003 baseline — a freshly-seeded cluster reports healthy [verify]', async () => {
        await seedHealthyCluster();
        const cq = new CommandQueue(TEST_DIR);
        const health = await verify(cluster, { commandQueue: cq });
        expect(health.status).toBe('healthy');
        // The new checks must all be present and healthy.
        expect(findCheck(health, 'artifact_content_integrity')?.status).toBe('healthy');
        expect(findCheck(health, 'ledger_integrity_chain')?.status).toBe('healthy');
        expect(findCheck(health, 'command_receipt_bijection')?.status).toBe('healthy');
        expect(findCheck(health, 'canonical_lineage_intact')?.status).toBe('healthy');
    });

    // ----- (a) tampered artifact blob on disk -----------------------------

    it('PROV-003 (a) — a tampered artifact blob makes verify NON-healthy [artifact_content_integrity]', async () => {
        await seedHealthyCluster();

        // Tamper the on-disk content file: flip its bytes so sha256 no longer
        // matches the metadata contentHash. The filename is the hash; we just
        // overwrite the single content file in the dir.
        const dir = artifactContentDir();
        const files = readdirSync(dir).filter((f) => /^[a-f0-9]{64}$/.test(f));
        expect(files.length).toBeGreaterThan(0);
        writeFileSync(join(dir, files[0]), Buffer.from('TAMPERED — different bytes entirely'));

        const cq = new CommandQueue(TEST_DIR);
        const health = await verify(cluster, { commandQueue: cq });

        expect(isNonHealthy(health)).toBe(true);
        const check = findCheck(health, 'artifact_content_integrity');
        expect(check).toBeTruthy();
        expect(check!.status).not.toBe('healthy');
        expect(check!.severity).toBe('error');
        expect(check!.message.length).toBeGreaterThan(0);
    });

    // ----- (b) hand-edited persisted ledger record -----------------------

    it('PROV-003 (b) — a hand-edited receipt makes verify NON-healthy [ledger_integrity_chain]', async () => {
        await seedHealthyCluster();

        // Read the NDJSON receipts, STAMP a valid integrityHash on each (as the
        // Agent-2 writer does via the shared helper), chain them, then break one
        // field WITHOUT recomputing its hash — simulating an on-disk hand edit.
        const lines = readFileSync(receiptsPath(), 'utf-8').split('\n').filter((l) => l.trim());
        const receipts: Receipt[] = lines.map((l) => JSON.parse(l));
        let prev: string | undefined;
        for (const r of receipts) {
            r.prevHash = prev;
            r.integrityHash = computeIntegrityHash(r as unknown as Record<string, unknown>);
            prev = r.integrityHash;
        }
        // Hand-edit: change resultSummary on the first receipt, leave its
        // (now-stale) integrityHash untouched. Recomputing would no longer match.
        receipts[0].resultSummary = 'TAMPERED summary';
        writeFileSync(
            receiptsPath(),
            receipts.map((r) => JSON.stringify(r)).join('\n') + '\n',
        );

        // Fresh stores so the ledger re-loads the tampered file from disk.
        const tamperedCluster = createLocalCluster(TEST_DIR);
        const cq = new CommandQueue(TEST_DIR);
        const health = await verify(tamperedCluster, { commandQueue: cq });

        expect(isNonHealthy(health)).toBe(true);
        const check = findCheck(health, 'ledger_integrity_chain');
        expect(check).toBeTruthy();
        expect(check!.status).not.toBe('healthy');
        expect(check!.severity).toBe('error');
    });

    it('PROV-003 (b) — a hand-edited event makes verify NON-healthy [ledger_integrity_chain]', async () => {
        await seedHealthyCluster();

        const lines = readFileSync(eventsPath(), 'utf-8').split('\n').filter((l) => l.trim());
        const events: ProvenanceEvent[] = lines.map((l) => JSON.parse(l));
        let prev: string | undefined;
        for (const e of events) {
            e.prevHash = prev;
            e.integrityHash = computeIntegrityHash(e as unknown as Record<string, unknown>);
            prev = e.integrityHash;
        }
        // Hand-edit the actorId on the first event without re-stamping its hash.
        events[0].actorId = 'attacker';
        writeFileSync(
            eventsPath(),
            events.map((e) => JSON.stringify(e)).join('\n') + '\n',
        );

        const tamperedCluster = createLocalCluster(TEST_DIR);
        const cq = new CommandQueue(TEST_DIR);
        const health = await verify(tamperedCluster, { commandQueue: cq });

        expect(isNonHealthy(health)).toBe(true);
        const check = findCheck(health, 'ledger_integrity_chain');
        expect(check!.status).not.toBe('healthy');
    });

    it('PROV-003 (b) — checkProvenance reports NON-healthy on a hand-edited event', async () => {
        await seedHealthyCluster();

        const lines = readFileSync(eventsPath(), 'utf-8').split('\n').filter((l) => l.trim());
        const events: ProvenanceEvent[] = lines.map((l) => JSON.parse(l));
        let prev: string | undefined;
        for (const e of events) {
            e.prevHash = prev;
            e.integrityHash = computeIntegrityHash(e as unknown as Record<string, unknown>);
            prev = e.integrityHash;
        }
        events[0].detail = { ...events[0].detail, injected: 'evil' };
        writeFileSync(
            eventsPath(),
            events.map((e) => JSON.stringify(e)).join('\n') + '\n',
        );

        const tamperedCluster = createLocalCluster(TEST_DIR);
        const result = await checkProvenance(tamperedCluster);
        const bad = result.checks.find((c) => c.status !== 'healthy');
        expect(bad).toBeTruthy();
    });

    it('PROV-003 (b) — checkReceipts reports NON-healthy on a hand-edited receipt', async () => {
        await seedHealthyCluster();

        const lines = readFileSync(receiptsPath(), 'utf-8').split('\n').filter((l) => l.trim());
        const receipts: Receipt[] = lines.map((l) => JSON.parse(l));
        let prev: string | undefined;
        for (const r of receipts) {
            r.prevHash = prev;
            r.integrityHash = computeIntegrityHash(r as unknown as Record<string, unknown>);
            prev = r.integrityHash;
        }
        receipts[0].affectedIds = ['injected-id'];
        writeFileSync(
            receiptsPath(),
            receipts.map((r) => JSON.stringify(r)).join('\n') + '\n',
        );

        const tamperedCluster = createLocalCluster(TEST_DIR);
        const result = await checkReceipts(tamperedCluster);
        const bad = result.checks.find((c) => c.status !== 'healthy');
        expect(bad).toBeTruthy();
    });

    // ----- (c) prevHash chain break / reorder -----------------------------

    it('PROV-003 (c) — a reordered ledger chain makes verify NON-healthy [ledger_integrity_chain]', async () => {
        await seedHealthyCluster();
        // Need at least 2 events to reorder; seed produces several.
        const lines = readFileSync(eventsPath(), 'utf-8').split('\n').filter((l) => l.trim());
        const events: ProvenanceEvent[] = lines.map((l) => JSON.parse(l));
        expect(events.length).toBeGreaterThanOrEqual(2);
        // Stamp a VALID chain first.
        let prev: string | undefined;
        for (const e of events) {
            e.prevHash = prev;
            e.integrityHash = computeIntegrityHash(e as unknown as Record<string, unknown>);
            prev = e.integrityHash;
        }
        // Reorder: swap the first two records. Each record's integrityHash is
        // still self-consistent, but the prevHash links no longer agree with
        // the new physical order — the chain walk must catch the break.
        [events[0], events[1]] = [events[1], events[0]];
        writeFileSync(
            eventsPath(),
            events.map((e) => JSON.stringify(e)).join('\n') + '\n',
        );

        const tamperedCluster = createLocalCluster(TEST_DIR);
        const cq = new CommandQueue(TEST_DIR);
        const health = await verify(tamperedCluster, { commandQueue: cq });

        expect(isNonHealthy(health)).toBe(true);
        const check = findCheck(health, 'ledger_integrity_chain');
        expect(check!.status).not.toBe('healthy');
    });

    // ----- (d) orphan receipt + receipt-less committed command ------------

    it('PROV-003 (d) — an orphan receipt (no committed command) makes verify NON-healthy [command_receipt_bijection]', async () => {
        await seedHealthyCluster();

        // Append a receipt whose commandId resolves to no command in the queue.
        const orphan: Receipt = {
            id: 'orphan-receipt-1',
            commandId: 'does-not-exist-command-id',
            committedAt: new Date().toISOString(),
            resultSummary: 'orphan',
            affectedIds: [],
            provenanceEventId: 'nope',
            integrityHash: 'x',
        };
        // Stamp a real integrityHash so the integrity check passes and we
        // isolate the bijection failure.
        orphan.integrityHash = computeIntegrityHash(orphan as unknown as Record<string, unknown>);
        const existing = readFileSync(receiptsPath(), 'utf-8');
        writeFileSync(receiptsPath(), existing + JSON.stringify(orphan) + '\n');

        const tamperedCluster = createLocalCluster(TEST_DIR);
        const cq = new CommandQueue(TEST_DIR);
        const health = await verify(tamperedCluster, { commandQueue: cq });

        expect(isNonHealthy(health)).toBe(true);
        const check = findCheck(health, 'command_receipt_bijection');
        expect(check).toBeTruthy();
        expect(check!.status).not.toBe('healthy');
    });

    it('PROV-003 (d) — a committed command with no receipt makes verify NON-healthy [command_receipt_bijection]', async () => {
        await seedHealthyCluster();

        // Inject a committed command into the queue that has no matching receipt.
        const cq = new CommandQueue(TEST_DIR);
        cq.save({
            id: 'committed-without-receipt',
            verb: 'create_entity',
            targetStore: 'canonical',
            payload: { kind: 'x', name: 'y', attributes: {} },
            proposedAt: new Date().toISOString(),
            proposedBy: 'u',
            status: 'committed',
            committedAt: new Date().toISOString(),
            committedBy: 'u',
        });

        const freshCluster = createLocalCluster(TEST_DIR);
        const cq2 = new CommandQueue(TEST_DIR);
        const health = await verify(freshCluster, { commandQueue: cq2 });

        expect(isNonHealthy(health)).toBe(true);
        const check = findCheck(health, 'command_receipt_bijection');
        expect(check!.status).not.toBe('healthy');
    });

    // ----- (e) canonical version-chain gap --------------------------------

    it('PROV-003 (e) — a dropped canonical version makes verify NON-healthy [canonical_lineage_intact]', async () => {
        const { entity } = await kernel.createEntity({
            kind: 'doc',
            name: 'Versioned',
            attributes: { rev: 1 },
            actorId: 'u',
        });
        // Append versions 2 and 3 via update.
        await cluster.canonical.update(entity.id, { attributes: { rev: 2 } });
        await cluster.canonical.update(entity.id, { attributes: { rev: 3 } });

        // Confirm a clean 1,2,3 chain verifies healthy first.
        let cq = new CommandQueue(TEST_DIR);
        let health = await verify(cluster, { commandQueue: cq });
        expect(findCheck(health, 'canonical_lineage_intact')?.status).toBe('healthy');

        // Now drop version 2 from the on-disk canonical store, leaving a
        // 1,_,3 gap. The canonical persistence file is canonical/entities.json.
        const canonPath = join(TEST_DIR, 'canonical', 'entities.json');
        const raw = JSON.parse(readFileSync(canonPath, 'utf-8')) as Array<Record<string, unknown>>;
        const filtered = raw.filter(
            (e) => !(e.id === entity.id && e.version === 2),
        );
        expect(filtered.length).toBe(raw.length - 1);
        writeFileSync(canonPath, JSON.stringify(filtered, null, 2));

        const tamperedCluster = createLocalCluster(TEST_DIR);
        cq = new CommandQueue(TEST_DIR);
        health = await verify(tamperedCluster, { commandQueue: cq });

        expect(isNonHealthy(health)).toBe(true);
        const check = findCheck(health, 'canonical_lineage_intact');
        expect(check).toBeTruthy();
        expect(check!.status).not.toBe('healthy');
    });

    // ----- PROV-001 — rebuild + content-indexer refuse poisoned content ---

    it('PROV-001 — rebuild surfaces the integrity error instead of indexing a tampered blob [rebuild]', async () => {
        await seedHealthyCluster();

        // Tamper the on-disk content so getContent's hardened path throws.
        const dir = artifactContentDir();
        const files = readdirSync(dir).filter((f) => /^[a-f0-9]{64}$/.test(f));
        writeFileSync(join(dir, files[0]), Buffer.from('POISON'));

        const tamperedCluster = createLocalCluster(TEST_DIR);
        const result = await rebuildIndex(tamperedCluster);

        // The rebuild must NOT silently succeed by indexing the poisoned blob.
        // It surfaces the integrity failure via the errors[] channel and does
        // NOT stage the tampered artifact's content as a healthy index record.
        expect(result.errors.length).toBeGreaterThan(0);
        const surfaced = result.errors.join('\n').toLowerCase();
        expect(
            surfaced.includes('integrity') ||
                surfaced.includes('hash') ||
                surfaced.includes('tamper') ||
                surfaced.includes('content'),
        ).toBe(true);
    });

    it('PROV-001 — content-indexer surfaces the integrity error on a tampered blob [content-indexer]', async () => {
        await seedHealthyCluster();

        const dir = artifactContentDir();
        const files = readdirSync(dir).filter((f) => /^[a-f0-9]{64}$/.test(f));
        writeFileSync(join(dir, files[0]), Buffer.from('POISON-2'));

        const tamperedCluster = createLocalCluster(TEST_DIR);
        const result = await indexArtifactContent(tamperedCluster);

        // The tampered artifact must surface as an error, not a clean index.
        expect(result.errors.length).toBeGreaterThan(0);
    });
});
