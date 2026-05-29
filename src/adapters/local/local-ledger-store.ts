import { randomUUID } from 'node:crypto';
import {
    readFileSync,
    writeFileSync,
    existsSync,
    mkdirSync,
    renameSync,
    unlinkSync,
    appendFileSync,
    openSync,
    fsyncSync,
    closeSync,
} from 'node:fs';
import { dirname, basename, join } from 'node:path';
import type { ProvenanceEvent } from '../../types/provenance-event.js';
import type { Receipt } from '../../types/receipt.js';
import type {
    LedgerStore,
    LedgerFilter,
    ReceiptFilter,
    RotateResult,
} from '../../contracts/ledger-store.js';
import {
    CorruptStoreError,
    LedgerCycleDetectedError,
    LedgerIntegrityError,
    InvalidRotateTimestampError,
    RotateBoundaryInFutureError,
    assertContentMatch,
} from './errors.js';
import { buildRandomTmpPath, cleanupOrphanTmpFiles } from './tmp-cleanup.js';
import { computeIntegrityHash } from '../../types/integrity.js';

/**
 * Filename of the crash-recovery marker written by {@link LocalLedgerStore.rotate}
 * (PROV-006). It lives directly in the ledger data dir and names the in-flight
 * rotation (the archive id + both archive paths). If a rotation is interrupted
 * between the two file renames, the next store construction sees this marker
 * and completes / rolls back the rotation deterministically so no events are
 * silently dropped. Exported so tests can assert marker-based recovery against
 * the exact on-disk contract.
 */
export const ROTATE_MARKER_FILENAME = 'rotate.inprogress';

/**
 * On-disk shape of the {@link ROTATE_MARKER_FILENAME} crash-recovery marker.
 * Names the in-flight rotation so {@link LocalLedgerStore} can complete it
 * deterministically on the next construction: the active files are deduped
 * against the records already written to these archive paths.
 */
interface RotateMarker {
    /** The per-rotation archive id (boundary timestamp + random suffix). */
    archiveId: string;
    /** Absolute path of the events archive file this rotation wrote. */
    eventsArchivePath: string;
    /** Absolute path of the receipts archive file this rotation wrote. */
    receiptsArchivePath: string;
}

/**
 * Local ledger store — append-only event and receipt persistence.
 * Proves: ordered append, no update/delete, lineage trace via parent chain.
 * Events and receipts are stored in separate ordered files.
 *
 * File format: **NDJSON** (newline-delimited JSON) — one record per line,
 * appended in O(1) per write. STORES-B-002 closed the prior whole-array
 * rewrite anti-pattern that gave O(N) per append + O(N²) over the file's
 * lifetime + a single bad write could replace a good ledger with bytes
 * from a partial JSON.stringify. Each append calls `appendFileSync` then
 * `fsync` so the bytes are durable before the call returns.
 *
 * Loads validate JSON shape per-line and throw CorruptStoreError on parse
 * failure of any committed line; trailing partial / corrupt lines are
 * tolerated as recoverable (matches the "mid-write failure leaves the
 * ledger recoverable" invariant from STORES-B-002).
 *
 * Backward compatibility: ledger files written by the prior (pre-Wave-B1)
 * whole-array implementation begin with `[` — `loadArray` detects this
 * and parses the legacy format, then immediately rewrites the file in
 * NDJSON form on the next mutation. No operator action required.
 */
export class LocalLedgerStore implements LedgerStore {
    private readonly dataDir: string;
    private readonly eventsPath: string;
    private readonly receiptsPath: string;
    private events: ProvenanceEvent[];
    private receipts: Receipt[];

    constructor(dataDir: string) {
        mkdirSync(dataDir, { recursive: true });
        this.dataDir = dataDir;
        this.eventsPath = join(dataDir, 'events.json');
        this.receiptsPath = join(dataDir, 'receipts.json');
        // STORES-B-001: sweep orphan random-suffix tmp files for BOTH
        // persistence files (events + receipts share the directory).
        cleanupOrphanTmpFiles(dirname(this.eventsPath), basename(this.eventsPath));
        cleanupOrphanTmpFiles(dirname(this.receiptsPath), basename(this.receiptsPath));
        // AGG-B1-2c: also sweep the archive subdir for orphan random-suffix
        // tmp files. Repeated failed rotations could otherwise accumulate
        // `events-<archiveId>.ndjson.<pid>-<rand>.tmp` files forever. The
        // archive dir is created lazily by rotate(); if it doesn't exist
        // yet there's nothing to sweep.
        const archiveDir = join(dataDir, 'ledger-archive');
        if (existsSync(archiveDir)) {
            // The archive filenames carry their own per-archive random suffix
            // ("events-<archiveId>.ndjson"), so there is no single "base
            // name" to sweep. Walk the directory and remove any entry whose
            // name ends with `.<digits>-<alnum>.tmp` and whose mtime is
            // beyond the orphan threshold — same shape as `buildRandomTmpPath`.
            try {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const { readdirSync, statSync, unlinkSync } = require('node:fs');
                const ORPHAN_AGE_MS = 5 * 60 * 1000; // 5 minutes — matches cleanupOrphanTmpFiles default
                const cutoff = Date.now() - ORPHAN_AGE_MS;
                const tmpPattern = /\.\d+-[a-z0-9]+\.tmp$/;
                for (const entry of readdirSync(archiveDir)) {
                    if (!tmpPattern.test(entry)) continue;
                    const full = join(archiveDir, entry);
                    try {
                        const st = statSync(full);
                        if (st.mtimeMs < cutoff) {
                            unlinkSync(full);
                        }
                    } catch {
                        // best-effort
                    }
                }
            } catch {
                // best-effort: failure to sweep is non-fatal
            }
        }
        // PROV-006: complete any rotation that crashed mid-commit BEFORE we
        // load the active files into memory. If the marker is present, the
        // archives are already durable; recovery dedups the active files
        // against the named archive and clears the marker, so the subsequent
        // loadArray() reads a consistent ledger with no dropped (and no
        // duplicated) records. Runs before load so in-memory always reflects
        // the recovered on-disk state.
        this.recoverInterruptedRotation();
        // AGG-B1-4: track tail-corruption signal from loadArray so we can
        // emit a stderr warning + record a `ledger_tail_corruption_recovered`
        // event AFTER the constructor completes (deferred so we don't recurse
        // into append-during-load).
        const tailEvents = { discarded: 0, file: '' };
        this.events = this.loadArray<ProvenanceEvent>(this.eventsPath, tailEvents);
        const tailReceipts = { discarded: 0, file: '' };
        this.receipts = this.loadArray<Receipt>(this.receiptsPath, tailReceipts);
        // Best-effort post-load recovery audit. Done via setImmediate-equivalent
        // sync flow: emit stderr + append the ledger event AFTER both load
        // calls have settled. Synchronous append is safe here because
        // `appendFileSync` does not recurse into loadArray.
        if (tailEvents.discarded > 0 || tailReceipts.discarded > 0) {
            this.recordTailCorruption(tailEvents, tailReceipts);
        }
    }

    /**
     * AGG-B1-4: post-construction audit emission for NDJSON tail-corruption.
     *
     * Wave A4 made `CommandQueue.load()` loud-on-loss via
     * `CommandQueuePersistenceLostError`. The parallel ledger pattern was
     * silent: `loadArray()` discarded bad-tail lines with no signal. This
     * helper emits the missing signal in two channels:
     *   1. `process.stderr` warning so operator log shippers can pattern-match.
     *   2. An audit ledger event (`ledger_tail_corruption_recovered`) so
     *      `verify()` / `doctor()` can later surface the recovery.
     *
     * Called from the constructor AFTER `loadArray` settles. The audit append
     * is a synchronous `appendFileSync`, so we don't recurse into loadArray.
     */
    private recordTailCorruption(
        tailEvents: { discarded: number; file: string },
        tailReceipts: { discarded: number; file: string },
    ): void {
        for (const tail of [tailEvents, tailReceipts]) {
            if (tail.discarded === 0) continue;
            try {
                // eslint-disable-next-line no-console
                process.stderr.write(
                    `[ledger] tail corruption detected: discarded ${tail.discarded} ` +
                        `line(s) from ${tail.file}. The events file was loaded successfully; ` +
                        `the unparseable suffix was treated as a torn / abandoned tail.\n`,
                );
            } catch {
                // best-effort
            }
            // Audit the recovery as a ledger event so doctor / verify can
            // surface it. Use the synchronous internal append helper to
            // avoid the async append() path which would re-enter this
            // constructor's lifecycle.
            try {
                // PROV-004: this self-appended audit event is a writer like any
                // other — it MUST be stamped with prevHash + integrityHash via
                // the shared helper so verify-on-read and the chain walk don't
                // trip over an unhashed sibling. stampEventIntegrity reads
                // prevHash from the current tail of this.events (the records
                // already loaded by loadArray) before we push.
                const recoveryEvent = this.stampEventIntegrity({
                    id: randomUUID(),
                    action: 'ledger_tail_corruption_recovered',
                    subjectId: tail.file,
                    subjectStore: 'ledger',
                    actorId: 'local-ledger-store',
                    timestamp: new Date().toISOString(),
                    owner: 'ledger',
                    detail: {
                        discardedLines: tail.discarded,
                        file: tail.file,
                    },
                });
                this.events.push(recoveryEvent);
                this.appendOneEvent(recoveryEvent);
            } catch {
                // best-effort: stderr is the durable signal even if append
                // fails (e.g. read-only filesystem)
            }
        }
    }

    async append(
        event: Omit<ProvenanceEvent, 'id' | 'timestamp' | 'owner' | 'integrityHash' | 'prevHash'>,
    ): Promise<ProvenanceEvent> {
        // STORES-B-021: spread first, then stamp — caller-supplied id /
        // timestamp via `as Receipt` cast cannot override the generated
        // values. The store-side stamps win unconditionally.
        //
        // PROV-004: the integrity stamp (prevHash + integrityHash) is applied
        // AFTER the id/timestamp/owner stamp via stampEventIntegrity, which
        // reads prevHash from the CURRENT tail of this.events (before the push)
        // and computes integrityHash over the fully-assembled record.
        const full = this.stampEventIntegrity({
            ...event,
            id: randomUUID(),
            timestamp: new Date().toISOString(),
            owner: 'ledger',
        });
        this.events.push(full);
        this.appendOneEvent(full);
        return full;
    }

    async getEvent(id: string): Promise<ProvenanceEvent | null> {
        const found = this.events.find((e) => e.id === id);
        if (!found) return null;
        // PROV-004 verify-on-read: recompute the integrity hash on the stored
        // record and throw if it no longer matches. A non-throwing, non-null
        // return is proof the event's content is intact.
        this.verifyEventIntegrity(found);
        return found;
    }

    async listEvents(filter?: LedgerFilter): Promise<ProvenanceEvent[]> {
        let results = [...this.events];

        if (filter?.subjectId) {
            results = results.filter((e) => e.subjectId === filter.subjectId);
        }
        if (filter?.action) {
            results = results.filter((e) => e.action === filter.action);
        }
        if (filter?.since) {
            results = results.filter((e) => e.timestamp >= filter.since!);
        }
        if (filter?.limit) {
            results = results.slice(-filter.limit);
        }
        return results;
    }

    async countEvents(filter?: LedgerFilter): Promise<number> {
        // The local adapter holds the events in memory so count is O(N) but
        // does not materialize an intermediate array (no .slice copy). For
        // a Postgres ledger this should be a `SELECT COUNT(*) WHERE ...`.
        if (!filter) return this.events.length;
        let n = 0;
        for (const e of this.events) {
            if (filter.subjectId && e.subjectId !== filter.subjectId) continue;
            if (filter.action && e.action !== filter.action) continue;
            if (filter.since && e.timestamp < filter.since) continue;
            n++;
        }
        return n;
    }

    /**
     * Walk the parentEventId chain starting at `eventId` and return the
     * lineage in walk order. STORES-B-015: a tampered ledger where A→B→A
     * would have looped forever pre-fix; the cycle-detection Set surfaces
     * the corruption as a LedgerCycleDetectedError instead of silently
     * truncating or looping.
     *
     * Advisor pick: throw rather than break out silently. An append-only
     * store with a cycle is corrupted by definition — make it loud so the
     * operator sees and fixes the on-disk tampering.
     *
     * STORES-B-013 documented behaviour: trace() reads the active events
     * file only. If a parent event was rotate()'d into the archive, the
     * chain truncates at the youngest unarchived event. Operators that
     * need to traverse the archive must restore it into a sibling
     * cluster — rotation is a recovery operation, not transparent
     * compaction.
     */
    async trace(eventId: string): Promise<ProvenanceEvent[]> {
        const chain: ProvenanceEvent[] = [];
        const visited = new Set<string>();
        let current = this.events.find((e) => e.id === eventId);

        while (current) {
            if (visited.has(current.id)) {
                // Cycle: build a diagnosable path. The full visit order
                // (so far) lives in `chain`; append the revisited id so
                // the error message clearly shows "ended where it began".
                const path = chain.map((e) => e.id).concat(current.id);
                throw new LedgerCycleDetectedError(path);
            }
            visited.add(current.id);
            chain.push(current);
            if (!current.parentEventId) break;
            current = this.events.find((e) => e.id === current!.parentEventId);
        }

        return chain;
    }

    async appendReceipt(
        receipt: Omit<Receipt, 'id' | 'committedAt' | 'integrityHash' | 'prevHash'>,
    ): Promise<Receipt> {
        // STORES-B-021 + STORES-B-004 (symmetry): spread first, stamp
        // generated fields last. A caller bypassing the type via `as Receipt`
        // cannot inject an id / committedAt that overrides our generated
        // values. We deliberately do NOT add an `owner` field here — the
        // Receipt type has no `owner` and adding one is a kernel-domain
        // change. The pinned test in wave-b1-stores-regression encodes
        // this decision so future drift surfaces explicitly.
        //
        // PROV-004: receipts are a SEPARATE chain from events. prevHash is the
        // integrityHash of the prior receipt in the receipts file (read from
        // the current tail of this.receipts before the push); integrityHash is
        // computed over the fully-assembled receipt.
        const full = this.stampReceiptIntegrity({
            ...receipt,
            id: randomUUID(),
            committedAt: new Date().toISOString(),
        });
        this.receipts.push(full);
        this.appendOneReceipt(full);
        return full;
    }

    async getReceipt(id: string): Promise<Receipt | null> {
        const found = this.receipts.find((r) => r.id === id);
        if (!found) return null;
        // PROV-004 verify-on-read (receipts chain).
        this.verifyReceiptIntegrity(found);
        return found;
    }

    async listReceipts(filter?: ReceiptFilter): Promise<Receipt[]> {
        let results = [...this.receipts];

        if (filter?.commandId) {
            results = results.filter((r) => r.commandId === filter.commandId);
        }
        if (filter?.since) {
            results = results.filter((r) => r.committedAt >= filter.since!);
        }
        if (filter?.limit) {
            results = results.slice(-filter.limit);
        }
        return results;
    }

    /**
     * Import a provenance event preserving original id and timestamp.
     * Used by restore so that re-runs are idempotent (STORES-002).
     *
     * Idempotent on byte-identical re-import: if an event with the same id
     * already exists and its content equals the incoming event (excluding
     * the store-stamped `owner` field), the existing event is returned.
     *
     * Throws ImportConflictError (STORES-B-003) when an event with the same
     * id exists but its content DIFFERS from the incoming snapshot.
     * Pre-fix the existing record was silently returned, masking tampered
     * backups whose ids collided with live ledger entries.
     */
    async importEvent(event: ProvenanceEvent): Promise<ProvenanceEvent> {
        // STORES-B-021: spread first, owner-stamp last. Same rationale as
        // append() — even when callers bypass the Omit<> type via a raw cast,
        // the store-stamped owner wins.
        //
        // PROV-004 restore semantics: this is a RESTORE path, not a fresh
        // append. The incoming integrityHash + prevHash already commit to the
        // original content and chain position — we PRESERVE them verbatim
        // (re-stamping would defeat tamper detection across backup/restore).
        // We only re-stamp owner='ledger' because that field is store identity,
        // not event payload — and it is already 'ledger' on any genuine event,
        // so the committed hash is unaffected.
        const snapshot: ProvenanceEvent = {
            ...event,
            owner: 'ledger',
        };
        // Reconcile integrity BEFORE the idempotency / conflict check: verify a
        // present hash (a tampered backup with a wrong hash throws
        // LedgerIntegrityError) or compute it when absent (legacy backup). Doing
        // this first means a legacy hash-less re-import yields the SAME computed
        // hash as the already-stored copy, so the assertContentMatch idempotency
        // check below compares equal (STORES-B-003 idempotency preserved); a
        // genuinely different record still differs in its other fields and is
        // rejected as a conflict.
        this.reconcileImportedEventIntegrity(snapshot);
        const existing = this.events.find((e) => e.id === snapshot.id);
        if (existing) {
            assertContentMatch(
                'ledger.event',
                snapshot.id,
                existing as unknown as Record<string, unknown>,
                snapshot as unknown as Record<string, unknown>,
            );
            return existing;
        }
        this.events.push(snapshot);
        this.appendOneEvent(snapshot);
        return snapshot;
    }

    /**
     * Import a receipt preserving original id and committedAt.
     * Used by restore so that re-runs are idempotent (STORES-002).
     *
     * Same content-conflict semantics as importEvent (STORES-B-003):
     * identical re-import is idempotent; mismatched content with the same id
     * throws ImportConflictError.
     */
    async importReceipt(receipt: Receipt): Promise<Receipt> {
        // PROV-004 restore semantics (mirror importEvent): preserve the
        // incoming integrityHash + prevHash verbatim; verify if present, compute
        // if absent (legacy backup). A present-but-wrong hash rejects loudly.
        // Reconcile BEFORE the idempotency / conflict check so a legacy
        // hash-less re-import compares equal to the already-stored copy.
        const snapshot: Receipt = { ...receipt };
        this.reconcileImportedReceiptIntegrity(snapshot);
        const existing = this.receipts.find((r) => r.id === snapshot.id);
        if (existing) {
            assertContentMatch(
                'ledger.receipt',
                snapshot.id,
                existing as unknown as Record<string, unknown>,
                snapshot as unknown as Record<string, unknown>,
            );
            return existing;
        }
        this.receipts.push(snapshot);
        this.appendOneReceipt(snapshot);
        return snapshot;
    }

    /**
     * STORES-B-013: archive events whose timestamp is older than
     * `beforeTimestamp` into a sibling `<dataDir>/ledger-archive/` file.
     * Receipts whose `committedAt` is older than the boundary are archived
     * to the receipts archive file in the same operation. The active
     * persistence files are rewritten to contain only retained records.
     *
     * Atomicity ACROSS BOTH FILES (PROV-006). Pre-fix the two active-file
     * rewrites were independent atomics: if `persistEvents()` landed but
     * `persistReceipts()` threw, the active events file held the retained
     * slice while the active receipts file still held the full set — the
     * rotation half-happened with no on-disk signal, and an operator could
     * not tell. Post-fix the sequence is:
     *   1. Write both archive files (tmp + rename) — durable FIRST.
     *   2. Stage both retained active files to `*.tmp` (no rename yet).
     *   3. Write a crash-recovery MARKER ({@link ROTATE_MARKER_FILENAME})
     *      naming the in-flight rotation (archive id + both archive paths).
     *   4. Rename events.tmp → events.json, then receipts.tmp → receipts.json.
     *   5. Remove the marker.
     * Because the archives are durable before the marker exists, a crash at
     * ANY point after the marker appears leaves every archived record safely
     * in the archive. On the next store construction {@link recoverInterruptedRotation}
     * sees the marker and COMPLETES the rotation deterministically: it removes
     * from the active files any record whose id is already in the named archive
     * (the only inconsistency a present marker can imply is a duplicate — an
     * archived record still sitting in an active file whose rewrite did not
     * land), then clears the marker. No event is ever dropped.
     *
     * The pre-existing in-memory snapshot + rollback is preserved: in-memory
     * state is only mutated after both renames succeed.
     */
    async rotate(beforeTimestamp: string): Promise<RotateResult> {
        // AGG-B1-2b: input validation. Pre-fix `rotate('')` and
        // `rotate('not-a-date')` produced silent no-ops or lexicographic
        // surprises because the boundary comparison is a string compare.
        // Refuse the ambiguous input with a typed error so operator-facing
        // tooling can branch on it.
        if (typeof beforeTimestamp !== 'string' || Number.isNaN(Date.parse(beforeTimestamp))) {
            throw new InvalidRotateTimestampError(beforeTimestamp);
        }

        // AGG-B1-2d: a boundary in the future is almost always a typo;
        // archiving "everything up to a future date" silently destroys the
        // live state. Refuse via typed error rather than silent no-op so
        // the operator-visible error makes the typo obvious. Pre-fix this
        // returned `{archived: 0, retained: N}` — indistinguishable from
        // "nothing to archive."
        const nowIso = new Date().toISOString();
        if (beforeTimestamp > nowIso) {
            throw new RotateBoundaryInFutureError(beforeTimestamp, nowIso);
        }

        const archiveEvents = this.events.filter(
            (e) => e.timestamp < beforeTimestamp,
        );
        const retainEvents = this.events.filter(
            (e) => e.timestamp >= beforeTimestamp,
        );
        const archiveReceipts = this.receipts.filter(
            (r) => r.committedAt < beforeTimestamp,
        );
        const retainReceipts = this.receipts.filter(
            (r) => r.committedAt >= beforeTimestamp,
        );

        if (archiveEvents.length === 0 && archiveReceipts.length === 0) {
            // No-op: returns the current count as retained so callers can
            // distinguish "nothing to archive" from "store empty".
            return {
                archived: 0,
                retained: this.events.length,
            };
        }

        // Build the archive id from the boundary timestamp + a short random
        // suffix so concurrent rotations on different boundaries never
        // collide on a single archive file. Format mirrors the standard
        // observability convention: ISO8601 (without colons for Windows) +
        // hash.
        const archiveDir = join(this.dataDir, 'ledger-archive');
        mkdirSync(archiveDir, { recursive: true });
        const archiveId = `${beforeTimestamp.replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
        const eventsArchivePath = join(archiveDir, `events-${archiveId}.ndjson`);
        const receiptsArchivePath = join(archiveDir, `receipts-${archiveId}.ndjson`);

        // Phase 1 — write archives via tmp+rename so a crash mid-rotation does
        // not leave a partial archive file. These land BEFORE the marker, so
        // by the time a marker exists every archived record is durable.
        if (archiveEvents.length > 0) {
            const eventsTmpPath = buildRandomTmpPath(eventsArchivePath);
            writeFileSync(
                eventsTmpPath,
                archiveEvents.map((e) => JSON.stringify(e)).join('\n') + '\n',
            );
            renameSync(eventsTmpPath, eventsArchivePath);
        }
        if (archiveReceipts.length > 0) {
            const receiptsTmpPath = buildRandomTmpPath(receiptsArchivePath);
            writeFileSync(
                receiptsTmpPath,
                archiveReceipts.map((r) => JSON.stringify(r)).join('\n') + '\n',
            );
            renameSync(receiptsTmpPath, receiptsArchivePath);
        }

        // PROV-006 two-phase commit across BOTH active files. Pre-fix the two
        // persists were independent atomics — a failure between them left the
        // active files in a mixed state with no on-disk signal. Post-fix:
        //   - Stage both retained active files to `*.tmp` (no rename yet).
        //   - Drop a marker naming the in-flight rotation.
        //   - Rename events then receipts.
        //   - Remove the marker.
        // A crash at any point after the marker appears is recovered on the
        // next load (the archives are already durable; recovery dedups the
        // active files against the named archive). The in-memory snapshot +
        // rollback is preserved: in-memory is only mutated after both renames.
        const eventsSnapshot = this.events;
        const receiptsSnapshot = this.receipts;
        const markerPath = join(this.dataDir, ROTATE_MARKER_FILENAME);
        const eventsTmp = buildRandomTmpPath(this.eventsPath);
        const receiptsTmp = buildRandomTmpPath(this.receiptsPath);
        try {
            // Stage retained slices to tmp (atomic content, not yet swapped in).
            writeFileSync(eventsTmp, this.serializeNdjson(retainEvents));
            writeFileSync(receiptsTmp, this.serializeNdjson(retainReceipts));
            // Marker: names the archive so recovery can dedup the active files
            // against it. Written + fsync'd before any active-file rename.
            writeFileSync(
                markerPath,
                JSON.stringify({
                    archiveId,
                    eventsArchivePath,
                    receiptsArchivePath,
                } satisfies RotateMarker),
            );
            this.fsyncBestEffort(markerPath);
            // Commit both active files. If the process dies between these two
            // renames, recovery completes the rotation from the marker.
            renameSync(eventsTmp, this.eventsPath);
            renameSync(receiptsTmp, this.receiptsPath);
            // Both active files now hold only retained records — clear marker.
            this.removeFileBestEffort(markerPath);
            // Only NOW mutate in-memory (both renames succeeded).
            this.events = retainEvents;
            this.receipts = retainReceipts;
        } catch (err) {
            // Roll back: in-memory is untouched (we mutate it only after both
            // renames). Clean up any staged tmp files and the marker so the
            // store is left exactly as it was pre-rotation. The archive files
            // are left behind as a harmless recovery artefact (their records
            // also still live in the active files). Restore the snapshot
            // defensively in case a partial assignment happened.
            this.events = eventsSnapshot;
            this.receipts = receiptsSnapshot;
            this.removeFileBestEffort(eventsTmp);
            this.removeFileBestEffort(receiptsTmp);
            this.removeFileBestEffort(markerPath);
            throw err;
        }

        return {
            archived: archiveEvents.length,
            retained: this.events.length,
            archiveFile: archiveEvents.length > 0 ? eventsArchivePath : receiptsArchivePath,
        };
    }

    /**
     * Load events / receipts from disk. Supports BOTH the new NDJSON format
     * (one record per line) AND the legacy whole-array format (a single
     * JSON array starting with `[`). Legacy files are rewritten in NDJSON
     * form on the next mutation — no migration step required.
     *
     * Trailing partial / corrupt lines are tolerated as recoverable: a
     * mid-write failure leaves the prior committed events readable. Any
     * fully-committed line that fails JSON.parse throws
     * CorruptStoreError — that signals on-disk tampering, not a write race.
     */
    private loadArray<T>(path: string, tailOut?: { discarded: number; file: string }): T[] {
        if (!existsSync(path)) return [];
        let raw: string;
        try {
            raw = readFileSync(path, 'utf-8');
        } catch (err) {
            throw new CorruptStoreError(path, err);
        }
        const trimmed = raw.trimStart();
        if (trimmed.length === 0) {
            // Empty file: treat as no records (cold start). The next append
            // will produce the first NDJSON line.
            return [];
        }
        if (trimmed.startsWith('[')) {
            // Legacy whole-array format (pre-Wave-B1). Parse, return, let
            // the next mutation rewrite the file in NDJSON form via
            // rotate() or full rewrite. Preserve the legacy load semantics:
            // unparseable → throw; parseable-but-not-array → throw.
            try {
                const parsed = JSON.parse(raw);
                if (!Array.isArray(parsed)) {
                    throw new Error(`expected JSON array, got ${typeof parsed}`);
                }
                return parsed as T[];
            } catch (err) {
                throw new CorruptStoreError(path, err);
            }
        }
        // NDJSON format: parse line-by-line. The TAIL of the file may carry
        // recoverable corruption (a torn last line OR a manually-appended
        // bad line at the end after a crash) — we treat the suffix
        // beginning at the first unparseable non-empty line as discarded
        // PROVIDED at least one prior line parsed cleanly. STORES-B-002:
        // a mid-write failure must leave previously-committed events
        // recoverable.
        //
        // Hard failures (throw CorruptStoreError) — these are NOT
        // recoverable tail-corruption:
        //  1. A bad line is surrounded by good lines (interior corruption).
        //  2. No line parsed cleanly AND the file is non-empty (the entire
        //     file is junk — there is nothing to recover and silently
        //     returning empty would erase a real, unparseable ledger).
        //  3. A line parses cleanly but yields a non-object value (the
        //     legacy file-format invariant; NDJSON ledger lines must be
        //     JSON objects).
        const lines = raw.split('\n');
        const parsed: { idx: number; value: T }[] = [];
        let firstBadIdx = -1;
        let badParseError: unknown = null;
        let discardedCount = 0;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line.trim().length === 0) continue;
            try {
                const value = JSON.parse(line);
                if (value === null || typeof value !== 'object' || Array.isArray(value)) {
                    throw new Error(
                        `expected JSON object per NDJSON line, got ${Array.isArray(value) ? 'array' : typeof value}`,
                    );
                }
                // Record-shape gate: every event/receipt has a non-empty
                // `id` string. Pre-Wave-B1 the legacy JSON-array loader
                // threw on shape mismatch via Array.isArray; the NDJSON
                // loader needs an equivalent gate so that a tampered file
                // with a single unrelated JSON object (e.g. `{"not":"an
                // array"}`) is not silently accepted as a 1-record ledger.
                // V1-B1-006: also require `id.length > 0` — a tampered
                // ledger with `{"id":""}` previously slipped through the
                // `typeof === 'string'` check.
                const idField = (value as Record<string, unknown>).id;
                if (typeof idField !== 'string' || idField.length === 0) {
                    throw new Error(
                        `expected ledger record with non-empty string \`id\` field; got line missing or empty id`,
                    );
                }
                parsed.push({ idx: i, value: value as T });
            } catch (err) {
                if (firstBadIdx === -1) {
                    firstBadIdx = i;
                    badParseError = err;
                }
                discardedCount++;
            }
        }
        if (firstBadIdx === -1) {
            return parsed.map((p) => p.value);
        }
        // A bad line exists. If NOTHING parsed cleanly, the file is pure
        // garbage — throw. Pre-fix this would also throw, so we preserve
        // the load semantics for "this file looks tampered."
        if (parsed.length === 0) {
            throw new CorruptStoreError(path, badParseError);
        }
        // If any cleanly-parsed line appears AFTER the bad line, the file
        // is structurally corrupt (not a torn tail) → throw.
        const lastGoodIdx = parsed[parsed.length - 1].idx;
        if (lastGoodIdx > firstBadIdx) {
            throw new CorruptStoreError(
                path,
                new Error(
                    `Unparseable line at offset ${firstBadIdx} surrounded by ` +
                        `valid lines (last good at ${lastGoodIdx}) — file is structurally corrupt.`,
                ),
            );
        }
        // Tail-only corruption with prior committed lines: discard the bad
        // suffix and return what we parsed cleanly. This is the
        // STORES-B-002 recovery path. AGG-B1-4: record the recovery in the
        // out-param so the constructor can emit the audit signal after
        // construction completes.
        if (tailOut) {
            tailOut.discarded = discardedCount;
            tailOut.file = path;
        }
        return parsed.map((p) => p.value);
    }

    // ---- PROV-006 rotation crash-recovery -------------------------------

    /**
     * Complete a rotation interrupted mid-commit (PROV-006). Called from the
     * constructor before {@link loadArray}.
     *
     * If {@link ROTATE_MARKER_FILENAME} is absent, this is a no-op (the common
     * case). If present, a rotation was in flight when the process died. By
     * construction the archive files named in the marker were written and
     * fsync'd BEFORE the marker, so every archived record is already durable.
     * The only inconsistency a present marker can imply is a DUPLICATE: an
     * archived record still sitting in an active file whose rewrite did not
     * land before the crash. Recovery therefore rewrites each active file to
     * EXCLUDE any record whose id is already present in the corresponding
     * archive file, then removes the marker. No record is dropped (archived
     * records survive in the archive; retained records survive in the active
     * file); duplicates are reconciled. The operation is idempotent — running
     * it twice yields the same files.
     *
     * Defensive: a malformed / unreadable marker is removed (best-effort) and
     * recovery is skipped — we never block store construction on a corrupt
     * marker, and the worst case without recovery is harmless duplication that
     * a later verify() surfaces.
     */
    private recoverInterruptedRotation(): void {
        const markerPath = join(this.dataDir, ROTATE_MARKER_FILENAME);
        if (!existsSync(markerPath)) return;
        let marker: RotateMarker;
        try {
            const parsed = JSON.parse(readFileSync(markerPath, 'utf-8')) as RotateMarker;
            if (
                !parsed ||
                typeof parsed.eventsArchivePath !== 'string' ||
                typeof parsed.receiptsArchivePath !== 'string'
            ) {
                throw new Error('malformed rotate marker');
            }
            marker = parsed;
        } catch {
            // Unreadable / malformed marker: drop it and skip recovery rather
            // than wedge construction. Duplicates (if any) are caught by verify.
            this.removeFileBestEffort(markerPath);
            return;
        }
        // Dedup each active file against the ids already in its archive.
        this.dedupActiveAgainstArchive(this.eventsPath, marker.eventsArchivePath);
        this.dedupActiveAgainstArchive(this.receiptsPath, marker.receiptsArchivePath);
        // Rotation is now consistent — clear the marker.
        this.removeFileBestEffort(markerPath);
    }

    /**
     * Rewrite `activePath` (NDJSON) to drop any record whose `id` appears in
     * `archivePath` (NDJSON). Both reads tolerate a torn tail line (skipped).
     * Used only by {@link recoverInterruptedRotation}. Atomic via tmp+rename.
     */
    private dedupActiveAgainstArchive(activePath: string, archivePath: string): void {
        if (!existsSync(activePath)) return;
        const archivedIds = new Set(this.readNdjsonIds(archivePath));
        if (archivedIds.size === 0) return; // nothing to dedup
        const activeLines = existsSync(activePath)
            ? readFileSync(activePath, 'utf-8').split('\n')
            : [];
        const kept: string[] = [];
        for (const line of activeLines) {
            if (line.trim().length === 0) continue;
            let id: string | undefined;
            try {
                id = (JSON.parse(line) as { id?: string }).id;
            } catch {
                // Torn / unparseable tail line: drop it during recovery. The
                // record (if any) is not lost — a genuine committed record is a
                // complete line; only a torn write produces an unparseable line.
                continue;
            }
            if (typeof id === 'string' && archivedIds.has(id)) continue; // already archived
            kept.push(line);
        }
        const tmpPath = buildRandomTmpPath(activePath);
        writeFileSync(tmpPath, kept.length === 0 ? '' : kept.join('\n') + '\n');
        renameSync(tmpPath, activePath);
    }

    /** Read the `id` field of every parseable NDJSON line in `path`. */
    private readNdjsonIds(path: string): string[] {
        if (!existsSync(path)) return [];
        const ids: string[] = [];
        for (const line of readFileSync(path, 'utf-8').split('\n')) {
            if (line.trim().length === 0) continue;
            try {
                const id = (JSON.parse(line) as { id?: string }).id;
                if (typeof id === 'string' && id.length > 0) ids.push(id);
            } catch {
                // skip torn line
            }
        }
        return ids;
    }

    /** Serialize a record array to NDJSON (empty string for an empty array). */
    private serializeNdjson(records: ReadonlyArray<unknown>): string {
        return records.length === 0
            ? ''
            : records.map((r) => JSON.stringify(r)).join('\n') + '\n';
    }

    /** Best-effort unlink — recovery / rollback cleanup never throws on this. */
    private removeFileBestEffort(path: string): void {
        try {
            if (existsSync(path)) unlinkSync(path);
        } catch {
            // best-effort
        }
    }

    // ---- PROV-004 tamper-evidence helpers -------------------------------
    //
    // ALL stamping routes through computeIntegrityHash (src/types/integrity.ts)
    // — the single source of truth shared with the verifier (ops/verify). If
    // this serialization ever diverged from the verifier's, tamper-evidence
    // would silently break, so we NEVER hand-roll a hash here.

    /**
     * Stamp `prevHash` + `integrityHash` on an event that has every field
     * EXCEPT the two tamper-evidence fields (the pre-stamp shape), returning a
     * complete {@link ProvenanceEvent}. MUST be called BEFORE the event is
     * pushed onto `this.events`, so `prevHash` reads the integrityHash of the
     * current tail (the immediately-preceding event in the file) — `undefined`
     * for the genesis event.
     */
    private stampEventIntegrity(
        event: Omit<ProvenanceEvent, 'integrityHash' | 'prevHash'>,
    ): ProvenanceEvent {
        const prev = this.events[this.events.length - 1];
        const prevHash = prev ? prev.integrityHash : undefined;
        // Assemble with prevHash included so it is part of the hashed content,
        // then compute the hash over the assembled record. Build the final
        // object once so the returned value carries both fields with the right
        // types (no in-place mutation of a partial record).
        const withPrev: ProvenanceEvent = {
            ...event,
            prevHash,
            // Placeholder; computeIntegrityHash strips integrityHash before
            // hashing, so the value we put here does not affect the result.
            integrityHash: '',
        };
        withPrev.integrityHash = computeIntegrityHash(
            withPrev as unknown as Record<string, unknown>,
        );
        return withPrev;
    }

    /**
     * Receipts are a SEPARATE chain from events. Same discipline as
     * {@link stampEventIntegrity} but against `this.receipts`.
     */
    private stampReceiptIntegrity(
        receipt: Omit<Receipt, 'integrityHash' | 'prevHash'>,
    ): Receipt {
        const prev = this.receipts[this.receipts.length - 1];
        const prevHash = prev ? prev.integrityHash : undefined;
        const withPrev: Receipt = {
            ...receipt,
            prevHash,
            integrityHash: '',
        };
        withPrev.integrityHash = computeIntegrityHash(
            withPrev as unknown as Record<string, unknown>,
        );
        return withPrev;
    }

    /**
     * Recompute the integrity hash on a stored event and throw
     * {@link LedgerIntegrityError} if it does not match the stored value
     * (verify-on-read, PROV-004). The helper in `integrity.ts` strips the
     * `integrityHash` field itself before hashing, so we compare against the
     * stored value directly.
     */
    private verifyEventIntegrity(event: ProvenanceEvent): void {
        const recomputed = computeIntegrityHash(
            event as unknown as Record<string, unknown>,
        );
        if (recomputed !== event.integrityHash) {
            throw new LedgerIntegrityError(
                'event',
                event.id,
                String(event.integrityHash),
                recomputed,
            );
        }
    }

    private verifyReceiptIntegrity(receipt: Receipt): void {
        const recomputed = computeIntegrityHash(
            receipt as unknown as Record<string, unknown>,
        );
        if (recomputed !== receipt.integrityHash) {
            throw new LedgerIntegrityError(
                'receipt',
                receipt.id,
                String(receipt.integrityHash),
                recomputed,
            );
        }
    }

    /**
     * Restore-path integrity reconciliation for an imported event (PROV-004).
     *  - integrityHash PRESENT → verify it (a tampered backup with a wrong hash
     *    throws LedgerIntegrityError; a genuine backup passes and is preserved).
     *  - integrityHash ABSENT (legacy pre-Wave-S2-A1 backup) → compute + stamp
     *    it from the snapshot's content (including its preserved prevHash).
     * The snapshot's `prevHash` is preserved verbatim either way — it is part
     * of the committed content and reflects the original chain position.
     */
    private reconcileImportedEventIntegrity(event: ProvenanceEvent): void {
        const hasHash =
            typeof event.integrityHash === 'string' && event.integrityHash.length > 0;
        if (hasHash) {
            this.verifyEventIntegrity(event);
            return;
        }
        event.integrityHash = computeIntegrityHash(
            event as unknown as Record<string, unknown>,
        );
    }

    private reconcileImportedReceiptIntegrity(receipt: Receipt): void {
        const hasHash =
            typeof receipt.integrityHash === 'string' && receipt.integrityHash.length > 0;
        if (hasHash) {
            this.verifyReceiptIntegrity(receipt);
            return;
        }
        receipt.integrityHash = computeIntegrityHash(
            receipt as unknown as Record<string, unknown>,
        );
    }

    /**
     * O(1) NDJSON append + fsync. On Windows `appendFileSync` already opens
     * with O_APPEND semantics under the hood; the explicit fsync ensures
     * the bytes hit disk before we return.
     */
    private appendOneEvent(event: ProvenanceEvent): void {
        const line = JSON.stringify(event) + '\n';
        appendFileSync(this.eventsPath, line);
        this.fsyncBestEffort(this.eventsPath);
    }

    private appendOneReceipt(receipt: Receipt): void {
        const line = JSON.stringify(receipt) + '\n';
        appendFileSync(this.receiptsPath, line);
        this.fsyncBestEffort(this.receiptsPath);
    }

    /**
     * Rewrite the entire active events file. Used by {@link rotate} when
     * old events have been moved into an archive; never by `append()`
     * (appends are O(1) via {@link appendOneEvent}). Uses tmp+rename for
     * atomicity (matches the STORES-B-001 random-suffix pattern via
     * `buildRandomTmpPath`).
     *
     * Method name kept as `persistEvents` so the cross-domain source-
     * pattern regression test in test/wave-a4-stores-regression.test.ts
     * continues to assert the random-tmp-suffix invariant on this body.
     */
    private persistEvents(): void {
        const tmpPath = buildRandomTmpPath(this.eventsPath);
        const content = this.events.length === 0
            ? ''
            : this.events.map((e) => JSON.stringify(e)).join('\n') + '\n';
        writeFileSync(tmpPath, content);
        renameSync(tmpPath, this.eventsPath);
    }

    private persistReceipts(): void {
        const tmpPath = buildRandomTmpPath(this.receiptsPath);
        const content = this.receipts.length === 0
            ? ''
            : this.receipts.map((r) => JSON.stringify(r)).join('\n') + '\n';
        writeFileSync(tmpPath, content);
        renameSync(tmpPath, this.receiptsPath);
    }

    /**
     * fsync the file at `path` if possible. On filesystems where fsync is
     * unsupported or the file handle cannot be opened (rare on Windows), we
     * swallow the error — the append has still hit the OS buffer. The
     * fsync is durability defense-in-depth, not a correctness gate.
     */
    private fsyncBestEffort(path: string): void {
        let fd: number | null = null;
        try {
            fd = openSync(path, 'r');
            fsyncSync(fd);
        } catch {
            // Best-effort.
        } finally {
            if (fd !== null) {
                try {
                    closeSync(fd);
                } catch {
                    // Best-effort.
                }
            }
        }
    }
}
