/**
 * Wave B1-Amend — Stores domain regression nets (Stage B Wave B1 audit closes).
 *
 * Stage B Wave B1 audit findings that this wave closes for the Stores domain:
 *
 *  - STORES-B-002 — `LocalLedgerStore.persistEvents` rewrites the entire
 *    events array on every append: O(N²) total write cost and a single bad
 *    write can replace a good ledger file with truncated bytes. Fix: switch
 *    to NDJSON append-only format where `append()` uses `appendFileSync`
 *    + fsync, and `load()` parses line-by-line; receipts get the same
 *    treatment. Recovery: a mid-write failure leaves events written before
 *    the failure intact on next load.
 *
 *  - STORES-B-004 — `appendReceipt` / `importReceipt` were inconsistent with
 *    `append()` on how they assemble the persisted record. Fix: the
 *    spread-then-stamp ordering (closing STORES-B-021 as a side-effect) is
 *    applied to all three of `append()`, `appendReceipt()`, and the import*
 *    paths so the generated fields are post-spread and stable.
 *
 *  - STORES-B-013 — Ledger rotation/archival hook. The append-only ledger
 *    has no archive contract — long-lived clusters grow events.json
 *    unbounded. Fix: add `rotate(beforeTimestamp)` to the LedgerStore
 *    contract; LocalLedgerStore moves matching events to a sibling
 *    `ledger-archive/events-<archiveId>.ndjson` file and the receipts
 *    likewise. trace() reads the current file only — archived events are
 *    explicitly truncated from new traces; documented and pinned by test.
 *
 *  - STORES-B-014 — `doctor()` / `verify()` orphan-mutation surfacing was
 *    silently `limit: 100`-capped. Fix: add `countEvents(filter)` to the
 *    LedgerStore contract; doctor/verify use the true count for the
 *    headline number and only sample for display.
 *
 *  - STORES-B-018 — `doctor()` hardcoded `'canonical_entities'` table name.
 *    Drift risk vs `src/adapters/postgres/schema.ts::CANONICAL_TABLE`. Fix:
 *    introduce `getRequiredTables()` registry in schema.ts; doctor.ts and
 *    migrations.ts both import it instead of inlining the literal.
 *
 *  - V1-A4-004 (deferred) — `backup()` does not include staging files.
 *    Fix: walk `<dataDir>/pending-content/`, base64-encode each file, store
 *    under `backup.staging`. `restore()` reconstructs the staging area.
 *    Round-trip preservation pinned by test.
 *
 *  - V1-A4-005 (deferred) — `doctor()` / `verify()` lack a `no_orphan_staging`
 *    health check. Fix: walk pending-content/, count files older than 1
 *    hour with no command in the queue referencing their hash; report
 *    degraded with the count and ages.
 *
 * Cross-domain notes (read-only for this agent):
 *  - LedgerStore.rotate + LedgerStore.countEvents are CONTRACT additions.
 *    Surface SDK consumers (`src/sdk/cluster-sdk.ts`, MCP tools) may need
 *    follow-ups; this wave does not touch them.
 *  - Backup format extension: older backups (without `staging`) must keep
 *    restoring cleanly — `restore()` treats `staging` as optional.
 */

import { describe, it, expect } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import {
    mkdtempSync,
    mkdirSync,
    rmSync,
    existsSync,
    readdirSync,
    readFileSync,
    writeFileSync,
    utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LocalLedgerStore } from '../src/adapters/local/local-ledger-store.js';
import { createLocalCluster } from '../src/adapters/local/index.js';
import { ClusterKernel } from '../src/kernel/cluster-kernel.js';
import { CommandQueue } from '../src/kernel/command-queue.js';
import { doctor } from '../src/ops/doctor.js';
import { verify } from '../src/ops/verify.js';
import { backup, restore, type ClusterBackup } from '../src/ops/backup.js';
import { CANONICAL_TABLE, getRequiredTables } from '../src/adapters/postgres/schema.js';
import { checkMigrationStatus } from '../src/ops/migrations.js';
import type { ProvenanceEvent } from '../src/types/provenance-event.js';
import type { Receipt } from '../src/types/receipt.js';

function withTmpDir(prefix: string, body: (dir: string) => Promise<void> | void): () => Promise<void> {
    return async () => {
        const dir = mkdtempSync(join(tmpdir(), `wave-b1-stores-${prefix}-`));
        try {
            await body(dir);
        } finally {
            try {
                rmSync(dir, { recursive: true, force: true });
            } catch {
                // Best-effort.
            }
        }
    };
}

describe('Wave B1-Amend — Stores regression nets', () => {
    // ─── STORES-B-002 — NDJSON append + recoverability ─────────────────
    describe('STORES-B-002 — append-only ledger persistence is sub-linear and recoverable', () => {
        it(
            'append() is sub-linear: per-event cost does not grow with N',
            withTmpDir('b002-perf', async (dir) => {
                const store = new LocalLedgerStore(dir);
                // Warm-up
                for (let i = 0; i < 50; i++) {
                    await store.append({
                        action: 'warm',
                        actorId: 'test',
                        subjectId: `warm-${i}`,
                        subjectStore: 'canonical',
                        detail: {},
                    });
                }
                const sample = async (n: number): Promise<number> => {
                    const start = process.hrtime.bigint();
                    for (let i = 0; i < n; i++) {
                        await store.append({
                            action: 'test',
                            actorId: 'test',
                            subjectId: `subj-${i}`,
                            subjectStore: 'canonical',
                            detail: { idx: i },
                        });
                    }
                    return Number(process.hrtime.bigint() - start) / 1e6 / n; // ms/event
                };

                const small = await sample(200);
                const large = await sample(800);

                // O(N) per append (whole-array rewrite) yields large >> small as the
                // file grows. With NDJSON append the per-event cost is constant ±
                // measurement noise. Allow a generous ceiling so we don't flake on
                // Windows Defender scanning bursts: large must not be 5x slower than
                // small. Pre-fix this comfortably exceeded 10x on N=1000.
                expect(
                    large,
                    `per-event time should be sub-linear (small=${small.toFixed(4)}ms, large=${large.toFixed(4)}ms)`,
                ).toBeLessThan(small * 5 + 0.5);
            }),
        );

        it(
            'mid-write failure leaves the ledger recoverable on next load',
            withTmpDir('b002-recover', async (dir) => {
                const store = new LocalLedgerStore(dir);
                // Append several events; these MUST survive a subsequent failure.
                const survivors: ProvenanceEvent[] = [];
                for (let i = 0; i < 5; i++) {
                    const ev = await store.append({
                        action: 'survives',
                        actorId: 'pre',
                        subjectId: `pre-${i}`,
                        subjectStore: 'canonical',
                        detail: { i },
                    });
                    survivors.push(ev);
                }

                // Simulate a corrupted tail line by appending a garbled line
                // directly to the NDJSON file, then re-opening the store. The
                // first N events must still load.
                const eventsPath = join(dir, 'events.json');
                // The NDJSON store appends raw JSON lines; we corrupt by adding a
                // syntactically broken trailing line.
                const fs = await import('node:fs');
                fs.appendFileSync(eventsPath, '\n{NOT VALID JSON\n');

                const recovered = new LocalLedgerStore(dir);
                const loaded = await recovered.listEvents({});
                // Recover MUST include every committed event before the corruption.
                const loadedIds = new Set(loaded.map((e) => e.id));
                for (const s of survivors) {
                    expect(loadedIds.has(s.id), `event ${s.id} survived corruption`).toBe(true);
                }
            }),
        );

        it(
            'NDJSON format on disk (one event per line)',
            withTmpDir('b002-format', async (dir) => {
                const store = new LocalLedgerStore(dir);
                await store.append({
                    action: 'a',
                    actorId: 'x',
                    subjectId: 's1',
                    subjectStore: 'canonical',
                    detail: {},
                });
                await store.append({
                    action: 'b',
                    actorId: 'x',
                    subjectId: 's2',
                    subjectStore: 'canonical',
                    detail: {},
                });
                const raw = readFileSync(join(dir, 'events.json'), 'utf-8');
                // NDJSON: at least 2 non-empty lines, each parses as a single
                // JSON object. Pre-fix the file was a JSON array (single line
                // starting with `[`).
                const lines = raw.split('\n').filter((l) => l.trim().length > 0);
                expect(lines.length).toBe(2);
                for (const line of lines) {
                    expect(() => JSON.parse(line)).not.toThrow();
                    const parsed = JSON.parse(line);
                    expect(parsed).toHaveProperty('id');
                    expect(parsed).toHaveProperty('owner', 'ledger');
                }
            }),
        );
    });

    // ─── STORES-B-004 — owner stamping + spread order ─────────────────
    describe('STORES-B-004 — receipt stamping is symmetric with event append', () => {
        it(
            'appendReceipt: caller-supplied id/committedAt cannot override generated values',
            withTmpDir('b004-spread', async (dir) => {
                const store = new LocalLedgerStore(dir);
                // Cast through unknown to inject id/committedAt despite the
                // Omit<>: simulates a runtime caller bypassing the contract.
                const sneaky = {
                    id: 'CALLER-ID',
                    committedAt: 'CALLER-TIME',
                    commandId: 'cmd-1',
                    resultSummary: 'ok',
                    affectedIds: [],
                    provenanceEventId: 'ev-1',
                } as unknown as Omit<Receipt, 'id' | 'committedAt'>;
                const r = await store.appendReceipt(sneaky);
                expect(r.id).not.toBe('CALLER-ID');
                expect(r.committedAt).not.toBe('CALLER-TIME');
            }),
        );

        it(
            'append: caller-supplied id/timestamp cannot override generated values',
            withTmpDir('b004-spread-event', async (dir) => {
                const store = new LocalLedgerStore(dir);
                const sneaky = {
                    id: 'CALLER-ID',
                    timestamp: 'CALLER-TIME',
                    action: 'test',
                    actorId: 'x',
                    subjectId: 's',
                    subjectStore: 'canonical',
                    detail: {},
                } as unknown as Omit<ProvenanceEvent, 'id' | 'timestamp' | 'owner'>;
                const ev = await store.append(sneaky);
                expect(ev.id).not.toBe('CALLER-ID');
                expect(ev.timestamp).not.toBe('CALLER-TIME');
                expect(ev.owner).toBe('ledger');
            }),
        );

        // Receipt type does NOT carry `owner`. The audit asks us to decide:
        // either add owner to the type (kernel-domain — read-only here) or
        // keep the asymmetry intentional and pinned. We keep the asymmetry
        // intentional: receipts have a known place in the ledger so an
        // `owner` field would be redundant. The test pins the decision so
        // future drift surfaces here.
        it(
            'Receipt type intentionally does not carry an owner field',
            withTmpDir('b004-owner-decision', async (dir) => {
                const store = new LocalLedgerStore(dir);
                const r = await store.appendReceipt({
                    commandId: 'cmd-1',
                    resultSummary: 'ok',
                    affectedIds: [],
                    provenanceEventId: 'ev-1',
                });
                // No `owner` on the stamped receipt — by design.
                expect((r as unknown as Record<string, unknown>).owner).toBeUndefined();
            }),
        );
    });

    // ─── STORES-B-013 — rotate() contract + behavior ─────────────────
    describe('STORES-B-013 — ledger rotate() archives matching events', () => {
        it(
            'rotate() with a future timestamp throws RotateBoundaryInFutureError',
            withTmpDir('b013-future', async (dir) => {
                // Wave B1-Amend fix-up (AGG-B1-2d): pre-fix this was a
                // silent `{archived: 0, retained: N}` no-op, indistinguishable
                // from "nothing to archive." Post-fix the safeguard throws
                // the typed `RotateBoundaryInFutureError` so the operator
                // intent mismatch surfaces loudly.
                const { RotateBoundaryInFutureError } = await import(
                    '../src/adapters/local/errors.js'
                );
                const store = new LocalLedgerStore(dir);
                await store.append({
                    action: 'k',
                    actorId: 'x',
                    subjectId: 's',
                    subjectStore: 'canonical',
                    detail: {},
                });
                const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
                await expect(store.rotate(future)).rejects.toBeInstanceOf(
                    RotateBoundaryInFutureError,
                );
                // The events file is unchanged and still has 1 event.
                const events = await store.listEvents({});
                expect(events.length).toBe(1);
            }),
        );

        it(
            'rotate() with a past timestamp archives older events and keeps newer ones',
            withTmpDir('b013-past', async (dir) => {
                const store = new LocalLedgerStore(dir);
                // 3 "old" + 3 "new" events. Manually adjust the timestamps of
                // the first three via direct in-memory mutation is not exposed;
                // instead, we append, rotate at a boundary timestamp computed
                // between the third and fourth append.
                for (let i = 0; i < 3; i++) {
                    await store.append({
                        action: 'old',
                        actorId: 'x',
                        subjectId: `old-${i}`,
                        subjectStore: 'canonical',
                        detail: {},
                    });
                }
                // Sleep to ensure timestamp progresses (ISO ms resolution).
                await new Promise((r) => setTimeout(r, 20));
                const boundary = new Date().toISOString();
                await new Promise((r) => setTimeout(r, 20));
                for (let i = 0; i < 3; i++) {
                    await store.append({
                        action: 'new',
                        actorId: 'x',
                        subjectId: `new-${i}`,
                        subjectStore: 'canonical',
                        detail: {},
                    });
                }

                const result = await store.rotate(boundary);
                expect(result.archived).toBe(3);
                expect(result.retained).toBe(3);
                expect(result.archiveFile).toBeDefined();
                expect(existsSync(result.archiveFile as string)).toBe(true);

                // Current ledger has only the 3 "new" events.
                const remaining = await store.listEvents({});
                expect(remaining.length).toBe(3);
                expect(remaining.every((e) => e.action === 'new')).toBe(true);

                // Re-open the store: archive file is not loaded back; only the
                // current events file. Pre-archive events stay archived.
                const reopened = new LocalLedgerStore(dir);
                const reloaded = await reopened.listEvents({});
                expect(reloaded.length).toBe(3);

                // Archive file is parseable as NDJSON (3 lines).
                const archiveRaw = readFileSync(result.archiveFile as string, 'utf-8');
                const lines = archiveRaw.split('\n').filter((l) => l.trim().length > 0);
                expect(lines.length).toBe(3);
                for (const line of lines) {
                    const parsed = JSON.parse(line) as ProvenanceEvent;
                    expect(parsed.action).toBe('old');
                }
            }),
        );

        it(
            'trace() of a chain that included archived events stops at the boundary',
            withTmpDir('b013-trace', async (dir) => {
                const store = new LocalLedgerStore(dir);
                const root = await store.append({
                    action: 'root',
                    actorId: 'x',
                    subjectId: 'root',
                    subjectStore: 'canonical',
                    detail: {},
                });
                await new Promise((r) => setTimeout(r, 20));
                const boundary = new Date().toISOString();
                await new Promise((r) => setTimeout(r, 20));
                const child = await store.append({
                    action: 'child',
                    actorId: 'x',
                    subjectId: 'root',
                    subjectStore: 'canonical',
                    detail: {},
                    parentEventId: root.id,
                });

                await store.rotate(boundary);

                // root is archived; trace from child reaches child but cannot
                // resolve root (it's archived). The chain truncates at child.
                const chain = await store.trace(child.id);
                expect(chain.length).toBe(1);
                expect(chain[0].id).toBe(child.id);
                // Documented behaviour: rotate() truncates parent chains.
            }),
        );
    });

    // ─── STORES-B-014 — countEvents + doctor uses actual count ─────
    describe('STORES-B-014 — orphan count reports actual not sample limit', () => {
        it(
            'LedgerStore.countEvents returns the true count',
            withTmpDir('b014-count', async (dir) => {
                const store = new LocalLedgerStore(dir);
                for (let i = 0; i < 5; i++) {
                    await store.append({
                        action: 'k',
                        actorId: 'x',
                        subjectId: `s-${i}`,
                        subjectStore: 'canonical',
                        detail: {},
                    });
                }
                expect(await store.countEvents()).toBe(5);
                expect(await store.countEvents({ action: 'k' })).toBe(5);
                expect(await store.countEvents({ action: 'absent' })).toBe(0);
            }),
        );

        it(
            'doctor() reports 200 orphans when 200 exist (not capped at 100)',
            withTmpDir('b014-doctor', async (dir) => {
                const cluster = createLocalCluster(dir);
                // Inject 200 orphan-mutation events directly through the ledger.
                for (let i = 0; i < 200; i++) {
                    await cluster.ledger.append({
                        action: 'mutation_orphaned',
                        actorId: 'kernel',
                        subjectId: `orph-${i}`,
                        subjectStore: 'canonical',
                        detail: {},
                    });
                }

                // Spy on listEvents to confirm doctor() does NOT call it for the
                // full 200 — it must use countEvents and only sample for display.
                let listEventsCallMaxLimit = 0;
                const original = cluster.ledger.listEvents.bind(cluster.ledger);
                cluster.ledger.listEvents = async (filter) => {
                    if (filter?.action === 'mutation_orphaned') {
                        listEventsCallMaxLimit = Math.max(
                            listEventsCallMaxLimit,
                            filter?.limit ?? 0,
                        );
                    }
                    return original(filter);
                };

                const health = await doctor(cluster);
                const check = health.checks.find((c) => c.name === 'no_orphaned_mutations');
                expect(check).toBeDefined();
                expect(check!.status).toBe('degraded');
                expect(check!.message).toMatch(/200/);
                // Sample limit should be much smaller than the actual count.
                expect(listEventsCallMaxLimit).toBeLessThanOrEqual(100);
            }),
        );

        it(
            'verify() reports 200 orphans when 200 exist (not capped at 100)',
            withTmpDir('b014-verify', async (dir) => {
                const cluster = createLocalCluster(dir);
                for (let i = 0; i < 200; i++) {
                    await cluster.ledger.append({
                        action: 'mutation_orphaned',
                        actorId: 'kernel',
                        subjectId: `orph-${i}`,
                        subjectStore: 'canonical',
                        detail: {},
                    });
                }
                const health = await verify(cluster);
                const check = health.checks.find((c) => c.name === 'no_orphaned_mutations');
                expect(check).toBeDefined();
                expect(check!.status).toBe('degraded');
                expect(check!.message).toMatch(/200/);
            }),
        );
    });

    // ─── STORES-B-018 — schema registry single source of truth ─────
    describe('STORES-B-018 — required tables registry', () => {
        it('getRequiredTables() exports the canonical-table list', () => {
            const tables = getRequiredTables();
            expect(tables).toContain(CANONICAL_TABLE);
        });

        it('doctor.ts uses CANONICAL_TABLE constant rather than literal', () => {
            const src = readFileSync(
                join(process.cwd(), 'src/ops/doctor.ts'),
                'utf-8',
            );
            // Either import CANONICAL_TABLE or getRequiredTables. The literal
            // 'canonical_entities' must NOT appear in doctor.ts: that is the
            // duplication we are removing.
            expect(/CANONICAL_TABLE|getRequiredTables/.test(src)).toBe(true);
            expect(/'canonical_entities'/.test(src)).toBe(false);
        });

        it('migrations.ts uses CANONICAL_TABLE/getRequiredTables constant rather than literal', () => {
            const src = readFileSync(
                join(process.cwd(), 'src/ops/migrations.ts'),
                'utf-8',
            );
            expect(/CANONICAL_TABLE|getRequiredTables/.test(src)).toBe(true);
            expect(/'canonical_entities'/.test(src)).toBe(false);
        });

        it('checkMigrationStatus reflects schema registry', async () => {
            // Simulate the registry: stub a pool whose query returns the
            // registry-listed tables.
            const stubPool = {
                query: async (_text: string) => ({
                    rows: getRequiredTables().map((name) => ({ table_name: name })),
                }),
            };
            const status = await checkMigrationStatus(stubPool);
            expect(status.migrated).toBe(true);
        });
    });

    // ─── V1-A4-004 (deferred) — backup includes staging ─────────────
    describe('V1-A4-004 — backup includes pending-content staging', () => {
        it(
            'backup roundtrip preserves staged content',
            withTmpDir('a4-004-stage', async (dir) => {
                const cluster = createLocalCluster(dir);
                const kernel = new ClusterKernel(cluster, { dataDir: dir });

                // Propose an ingest_artifact: this writes a pending-content file.
                const content = Buffer.from('hello staging');
                const contentHash = createHash('sha256').update(content).digest('hex');
                await kernel.proposeMutation({
                    verb: 'ingest_artifact',
                    targetStore: 'artifact',
                    payload: {
                        filename: 'hello.txt',
                        content,
                        mimeType: 'text/plain',
                        contentHash,
                    },
                    proposedBy: 'tester',
                });

                // Verify the staging file landed.
                const stagingDir = join(dir, 'pending-content');
                expect(existsSync(join(stagingDir, contentHash))).toBe(true);

                // Snapshot the staging file via backup. Pass dataDir so
                // backup() finds the pending-content/ directory.
                const data = await backup(cluster, { dataDir: dir });
                expect(data.staging).toBeDefined();
                expect(Array.isArray(data.staging)).toBe(true);
                const entry = (data.staging as { contentHash: string; content: string }[])
                    .find((s) => s.contentHash === contentHash);
                expect(entry).toBeDefined();
                expect(Buffer.from(entry!.content, 'base64').toString('utf-8')).toBe('hello staging');

                // Restore into a fresh data dir.
                const dir2 = mkdtempSync(join(tmpdir(), 'wave-b1-stores-a4-004-restore-'));
                try {
                    const cluster2 = createLocalCluster(dir2);
                    const result = await restore(cluster2, data, { dataDir: dir2 });
                    expect(result.staging).toBeDefined();
                    expect(result.staging!.restored).toBe(1);
                    const stagingPath2 = join(dir2, 'pending-content', contentHash);
                    expect(existsSync(stagingPath2)).toBe(true);
                    expect(readFileSync(stagingPath2).toString('utf-8')).toBe('hello staging');
                } finally {
                    rmSync(dir2, { recursive: true, force: true });
                }
            }),
        );

        it(
            'restore tolerates older backups without staging field',
            withTmpDir('a4-004-old', async (dir) => {
                const cluster = createLocalCluster(dir);
                const oldFormat: ClusterBackup = {
                    version: 1,
                    createdAt: new Date().toISOString(),
                    entities: [],
                    artifacts: [],
                    events: [],
                    receipts: [],
                };
                // Should not throw.
                const result = await restore(cluster, oldFormat);
                expect(result.entities.created).toBe(0);
            }),
        );
    });

    // ─── V1-A4-005 (deferred) — no_orphan_staging check ─────────────
    describe('V1-A4-005 — no_orphan_staging health check', () => {
        it(
            'A staging file older than 1 hour with no referencing command surfaces as degraded',
            withTmpDir('a4-005-degraded', async (dir) => {
                const cluster = createLocalCluster(dir);
                // Manually create a staging dir + write an orphan file aged 2h.
                const stagingDir = join(dir, 'pending-content');
                mkdirSync(stagingDir, { recursive: true });
                const orphanHash = 'a'.repeat(64);
                const orphanPath = join(stagingDir, orphanHash);
                writeFileSync(orphanPath, Buffer.from('orphan content'));
                const twoHoursAgoSec = Math.floor(Date.now() / 1000) - 2 * 60 * 60;
                utimesSync(orphanPath, twoHoursAgoSec, twoHoursAgoSec);

                const health = await doctor(cluster, { dataDir: dir });
                const check = health.checks.find((c) => c.name === 'no_orphan_staging');
                expect(check).toBeDefined();
                expect(check!.status).toBe('degraded');
                expect(check!.message).toMatch(/1/);
            }),
        );

        it(
            'A staging file matching a pending command does NOT degrade',
            withTmpDir('a4-005-clean', async (dir) => {
                const cluster = createLocalCluster(dir);
                const kernel = new ClusterKernel(cluster, { dataDir: dir });

                // Propose ingest_artifact — staging file matches a pending command.
                const content = Buffer.from('linked content');
                const contentHash = createHash('sha256').update(content).digest('hex');
                await kernel.proposeMutation({
                    verb: 'ingest_artifact',
                    targetStore: 'artifact',
                    payload: {
                        filename: 'linked.txt',
                        content,
                        mimeType: 'text/plain',
                        contentHash,
                    },
                    proposedBy: 'tester',
                });
                // Make the file appear old enough that it would degrade if orphan.
                const stagingPath = join(dir, 'pending-content', contentHash);
                const twoHoursAgoSec = Math.floor(Date.now() / 1000) - 2 * 60 * 60;
                utimesSync(stagingPath, twoHoursAgoSec, twoHoursAgoSec);

                // doctor accepts any `{ list(): Command[] }` shape. The
                // kernel's persistent command queue lives at the same
                // dataDir; we can reopen it directly via CommandQueue
                // because list() reads fresh from disk on every call.
                const commandQueue = new CommandQueue(dir);
                const health = await doctor(cluster, { dataDir: dir, commandQueue });
                const check = health.checks.find((c) => c.name === 'no_orphan_staging');
                expect(check).toBeDefined();
                expect(check!.status).toBe('healthy');
            }),
        );

        it(
            'A young staging file (under 1 hour) does NOT degrade even if not referenced',
            withTmpDir('a4-005-young', async (dir) => {
                const cluster = createLocalCluster(dir);
                // Young orphan file — within 1h grace.
                const stagingDir = join(dir, 'pending-content');
                mkdirSync(stagingDir, { recursive: true });
                writeFileSync(join(stagingDir, 'b'.repeat(64)), Buffer.from('young orphan'));

                const health = await doctor(cluster, { dataDir: dir });
                const check = health.checks.find((c) => c.name === 'no_orphan_staging');
                expect(check).toBeDefined();
                expect(check!.status).toBe('healthy');
            }),
        );
    });
});
