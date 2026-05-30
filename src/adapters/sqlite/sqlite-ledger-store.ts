import { randomUUID } from 'node:crypto';
import type { ProvenanceEvent } from '../../types/provenance-event.js';
import type { Receipt } from '../../types/receipt.js';
import type {
    LedgerStore,
    LedgerFilter,
    ReceiptFilter,
    RotateResult,
} from '../../contracts/ledger-store.js';
import {
    LedgerCycleDetectedError,
    LedgerIntegrityError,
    InvalidRotateTimestampError,
    RotateBoundaryInFutureError,
    assertContentMatch,
} from '../local/errors.js';
import { computeIntegrityHash } from '../../types/integrity.js';
import { SqliteDb } from './sqlite-db.js';
import {
    LEDGER_EVENTS_TABLE,
    LEDGER_RECEIPTS_TABLE,
    LEDGER_EVENTS_ARCHIVE_TABLE,
    LEDGER_RECEIPTS_ARCHIVE_TABLE,
} from './schema.js';

/**
 * SQLite ledger store — append-only event + receipt persistence, drop-in
 * substitutable for {@link import('../local/local-ledger-store.js').LocalLedgerStore}.
 *
 * Wave V3 (agent A2). The DB is the source of truth — there is NO in-memory
 * events/receipts array. `prevHash` is read from the current chain tail on each
 * append (`ORDER BY seq DESC LIMIT 1`); the read-tail + INSERT run in ONE
 * transaction so concurrent appends cannot interleave the hash-chain.
 *
 * ─── THE INTEGRITY ROUND-TRIP (the crux) ─────────────────────────────────────
 * Tamper-evidence is cross-adapter verifiable: a record this store writes hashes
 * IDENTICALLY to one LocalLedgerStore writes for the same logical record. That
 * holds because both route through the SINGLE source of truth
 * `computeIntegrityHash` (`src/types/integrity.ts`) over the SAME DOMAIN object:
 *  - The object handed to `computeIntegrityHash` is the domain record with
 *    exactly the fields the local store uses — NO `seq` (storage-only), and
 *    absent optionals (`parentEventId`, `prevHash`) are OMITTED (left
 *    `undefined`), never `null`. `computeIntegrityHash` key-sorts and DROPS
 *    undefined keys, so a genesis record (no prevHash) hashes identically here
 *    and in local.
 *  - `detail` / `affectedIds` round-trip via JSON in the TEXT columns and are
 *    re-hydrated to the same JS values before hashing.
 * Verify-on-read (`getEvent`/`getReceipt`) recomputes the hash on the
 * reconstructed domain record and throws {@link LedgerIntegrityError} on
 * mismatch — a non-throwing non-null return proves the row was not edited.
 *
 * Deliberately NOT ported from local: the crash-recovery marker /
 * `rotate.inprogress` / `recoverInterruptedRotation` machinery. A single SQLite
 * transaction gives the cross-table atomicity that the local store's filesystem
 * marker dance emulated. The transaction IS the atomic rotate.
 *
 * SQL SAFETY: every value bound with `?`; only A3's compile-time table-name
 * constants are interpolated.
 */
export class SqliteLedgerStore implements LedgerStore {
    constructor(private readonly db: SqliteDb) {}

    async append(
        event: Omit<ProvenanceEvent, 'id' | 'timestamp' | 'owner' | 'integrityHash' | 'prevHash'>,
    ): Promise<ProvenanceEvent> {
        // Spread first, then stamp id / timestamp / owner — caller-supplied
        // values for the generated fields cannot win (STORES-B-021 parity).
        const id = randomUUID();
        const timestamp = new Date().toISOString();
        // Read-tail (prevHash) + stamp + INSERT in ONE transaction so concurrent
        // appends cannot interleave the chain. stampEventIntegrity assembles the
        // domain record (prevHash omitted when undefined) and computes the hash.
        return this.db.transaction(() => {
            const full = this.stampEventIntegrity({
                ...event,
                id,
                timestamp,
                owner: 'ledger',
            });
            this.insertEvent(full);
            return full;
        });
    }

    async getEvent(id: string): Promise<ProvenanceEvent | null> {
        const row = this.db.connection
            .prepare(`SELECT * FROM ${LEDGER_EVENTS_TABLE} WHERE id = ?`)
            .get(id) as Record<string, unknown> | undefined;
        if (!row) return null;
        const record = this.rowToEvent(row);
        // Verify-on-read (PROV-004): recompute the hash on the reconstructed
        // domain record and throw on mismatch. computeIntegrityHash strips
        // integrityHash itself, so we pass the full record.
        this.verifyEventIntegrity(record);
        return record;
    }

    async listEvents(filter?: LedgerFilter): Promise<ProvenanceEvent[]> {
        // ORDER BY seq ASC = append order. Filters mirror local exactly. `limit`
        // is the LAST N (local's results.slice(-limit)) — achieved by ordering
        // DESC + LIMIT then reversing back to ascending, so the most-recent N are
        // returned oldest-first. NO verify-on-read (bulk reads return as-stored).
        const where: string[] = [];
        const params: unknown[] = [];
        if (filter?.subjectId) {
            where.push('subject_id = ?');
            params.push(filter.subjectId);
        }
        if (filter?.action) {
            where.push('action = ?');
            params.push(filter.action);
        }
        if (filter?.since) {
            where.push('timestamp >= ?');
            params.push(filter.since);
        }
        const whereSql = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';

        let rows: Record<string, unknown>[];
        if (filter?.limit) {
            rows = this.db.connection
                .prepare(
                    `SELECT * FROM ${LEDGER_EVENTS_TABLE}${whereSql} ORDER BY seq DESC LIMIT ?`,
                )
                .all(...params, filter.limit) as Record<string, unknown>[];
            rows.reverse();
        } else {
            rows = this.db.connection
                .prepare(`SELECT * FROM ${LEDGER_EVENTS_TABLE}${whereSql} ORDER BY seq ASC`)
                .all(...params) as Record<string, unknown>[];
        }
        return rows.map((r) => this.rowToEvent(r));
    }

    async countEvents(filter?: LedgerFilter): Promise<number> {
        // Same WHERE filters as listEvents, NO limit (STORES-B-014: the headline
        // count must not be silently truncated by a sampling limit).
        const where: string[] = [];
        const params: unknown[] = [];
        if (filter?.subjectId) {
            where.push('subject_id = ?');
            params.push(filter.subjectId);
        }
        if (filter?.action) {
            where.push('action = ?');
            params.push(filter.action);
        }
        if (filter?.since) {
            where.push('timestamp >= ?');
            params.push(filter.since);
        }
        const whereSql = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';
        const row = this.db.connection
            .prepare(`SELECT COUNT(*) AS n FROM ${LEDGER_EVENTS_TABLE}${whereSql}`)
            .get(...params) as { n: number };
        return row.n;
    }

    async trace(eventId: string): Promise<ProvenanceEvent[]> {
        // Walk parent_event_id from the start event toward root. Reads ACTIVE
        // events only (archived rows excluded — a parent rotated into the archive
        // truncates the chain, matching local). Cycle-detect with a visited Set;
        // build the diagnosable path exactly as local (chain ids + the revisited
        // id). No integrity verify in trace (parity with local).
        const byId = this.db.connection.prepare(
            `SELECT * FROM ${LEDGER_EVENTS_TABLE} WHERE id = ?`,
        );
        const chain: ProvenanceEvent[] = [];
        const visited = new Set<string>();
        let currentRow = byId.get(eventId) as Record<string, unknown> | undefined;

        while (currentRow) {
            const current = this.rowToEvent(currentRow);
            if (visited.has(current.id)) {
                const path = chain.map((e) => e.id).concat(current.id);
                throw new LedgerCycleDetectedError(path);
            }
            visited.add(current.id);
            chain.push(current);
            if (!current.parentEventId) break;
            currentRow = byId.get(current.parentEventId) as Record<string, unknown> | undefined;
        }
        return chain;
    }

    async appendReceipt(
        receipt: Omit<Receipt, 'id' | 'committedAt' | 'integrityHash' | 'prevHash'>,
    ): Promise<Receipt> {
        // Spread first, stamp id / committedAt last. NO owner field (Receipt has
        // none — adding one would be a kernel-domain change; local omits it too).
        const id = randomUUID();
        const committedAt = new Date().toISOString();
        return this.db.transaction(() => {
            const full = this.stampReceiptIntegrity({
                ...receipt,
                id,
                committedAt,
            });
            this.insertReceipt(full);
            return full;
        });
    }

    async getReceipt(id: string): Promise<Receipt | null> {
        const row = this.db.connection
            .prepare(`SELECT * FROM ${LEDGER_RECEIPTS_TABLE} WHERE id = ?`)
            .get(id) as Record<string, unknown> | undefined;
        if (!row) return null;
        const record = this.rowToReceipt(row);
        this.verifyReceiptIntegrity(record);
        return record;
    }

    async listReceipts(filter?: ReceiptFilter): Promise<Receipt[]> {
        // ORDER BY seq ASC = append order; `limit` = last N (mirror local).
        const where: string[] = [];
        const params: unknown[] = [];
        if (filter?.commandId) {
            where.push('command_id = ?');
            params.push(filter.commandId);
        }
        if (filter?.since) {
            where.push('committed_at >= ?');
            params.push(filter.since);
        }
        const whereSql = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';

        let rows: Record<string, unknown>[];
        if (filter?.limit) {
            rows = this.db.connection
                .prepare(
                    `SELECT * FROM ${LEDGER_RECEIPTS_TABLE}${whereSql} ORDER BY seq DESC LIMIT ?`,
                )
                .all(...params, filter.limit) as Record<string, unknown>[];
            rows.reverse();
        } else {
            rows = this.db.connection
                .prepare(`SELECT * FROM ${LEDGER_RECEIPTS_TABLE}${whereSql} ORDER BY seq ASC`)
                .all(...params) as Record<string, unknown>[];
        }
        return rows.map((r) => this.rowToReceipt(r));
    }

    async importEvent(event: ProvenanceEvent): Promise<ProvenanceEvent> {
        // RESTORE path: PRESERVE the incoming integrityHash + prevHash VERBATIM
        // (re-stamping would defeat cross-backup tamper detection). owner is
        // store identity, restamped to 'ledger' — already 'ledger' on a genuine
        // event, so the committed hash is unaffected.
        const snapshot: ProvenanceEvent = {
            ...event,
            owner: 'ledger',
        };
        // Reconcile integrity FIRST (before the idempotency / conflict check):
        // verify a present hash (tampered backup → LedgerIntegrityError) or
        // compute it when absent (legacy backup). Doing this first means a legacy
        // hash-less re-import yields the SAME computed hash as the stored copy, so
        // assertContentMatch compares equal.
        this.reconcileImportedEventIntegrity(snapshot);
        return this.db.transaction(() => {
            const existingRow = this.db.connection
                .prepare(`SELECT * FROM ${LEDGER_EVENTS_TABLE} WHERE id = ?`)
                .get(snapshot.id) as Record<string, unknown> | undefined;
            if (existingRow) {
                const existing = this.rowToEvent(existingRow);
                // assertContentMatch compares JSON.stringify of each side, which
                // is key-ORDER-sensitive. In the local store both sides are built
                // by the same code path so their key order coincides; here
                // `existing` came from a DB round-trip (rowToEvent order) while
                // `snapshot` carries the caller's key order. Normalize BOTH to one
                // canonical field order so the comparison is content-equality, not
                // key-order-equality — preserving local's "idempotent on equal,
                // conflict on differ" semantics exactly.
                assertContentMatch(
                    'ledger.event',
                    snapshot.id,
                    this.canonicalEventForCompare(existing),
                    this.canonicalEventForCompare(snapshot),
                );
                return existing;
            }
            // INSERT preserving parent_event_id / prev_hash / integrity_hash. seq
            // is freshly assigned — fine, the chain is by prevHash, not seq.
            this.insertEvent(snapshot);
            return snapshot;
        });
    }

    async importReceipt(receipt: Receipt): Promise<Receipt> {
        // Same restore discipline as importEvent; receipts have no owner field.
        const snapshot: Receipt = { ...receipt };
        this.reconcileImportedReceiptIntegrity(snapshot);
        return this.db.transaction(() => {
            const existingRow = this.db.connection
                .prepare(`SELECT * FROM ${LEDGER_RECEIPTS_TABLE} WHERE id = ?`)
                .get(snapshot.id) as Record<string, unknown> | undefined;
            if (existingRow) {
                const existing = this.rowToReceipt(existingRow);
                // Canonical-order both sides before the order-sensitive compare —
                // same rationale as importEvent.
                assertContentMatch(
                    'ledger.receipt',
                    snapshot.id,
                    this.canonicalReceiptForCompare(existing),
                    this.canonicalReceiptForCompare(snapshot),
                );
                return existing;
            }
            this.insertReceipt(snapshot);
            return snapshot;
        });
    }

    async rotate(beforeTimestamp: string): Promise<RotateResult> {
        // Validate exactly like local: reject non-string / unparseable boundary,
        // then reject a future boundary (almost always a typo; archiving
        // "everything up to a future date" silently destroys live state).
        if (typeof beforeTimestamp !== 'string' || Number.isNaN(Date.parse(beforeTimestamp))) {
            throw new InvalidRotateTimestampError(beforeTimestamp);
        }
        const nowIso = new Date().toISOString();
        if (beforeTimestamp > nowIso) {
            throw new RotateBoundaryInFutureError(beforeTimestamp, nowIso);
        }

        const conn = this.db.connection;
        const archiveEventCount = (
            conn
                .prepare(
                    `SELECT COUNT(*) AS n FROM ${LEDGER_EVENTS_TABLE} WHERE timestamp < ?`,
                )
                .get(beforeTimestamp) as { n: number }
        ).n;
        const archiveReceiptCount = (
            conn
                .prepare(
                    `SELECT COUNT(*) AS n FROM ${LEDGER_RECEIPTS_TABLE} WHERE committed_at < ?`,
                )
                .get(beforeTimestamp) as { n: number }
        ).n;

        // Total event count — used for the `retained` figure (local returns the
        // current total as retained on a no-op, and remaining-after-archive
        // otherwise; both reduce to "events still active after this call").
        const totalEvents = (
            conn.prepare(`SELECT COUNT(*) AS n FROM ${LEDGER_EVENTS_TABLE}`).get() as {
                n: number;
            }
        ).n;

        if (archiveEventCount === 0 && archiveReceiptCount === 0) {
            // No-op: return the current event total as retained so callers can
            // distinguish "nothing to archive" from "store empty".
            return { archived: 0, retained: totalEvents };
        }

        // archiveId mirrors local's format: ISO boundary (colons/dots → '-') for
        // Windows-safe filenames + a short random suffix so concurrent rotations
        // on different boundaries never collide.
        const archiveId = `${beforeTimestamp.replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
        const archivedAt = new Date().toISOString();

        // ONE transaction gives the cross-table atomicity the local store's
        // marker dance emulated on the filesystem. The transaction IS the atomic
        // rotate — no recovery marker needed.
        this.db.transaction(() => {
            // INSERT … SELECT copies the matching rows (preserving the original
            // seq value into the plain-INTEGER archive seq column) then DELETE
            // removes them from the active table. Column order is explicit so the
            // archive's archive_id / archived_at land first.
            conn.prepare(
                `INSERT INTO ${LEDGER_EVENTS_ARCHIVE_TABLE} ` +
                    `(archive_id, archived_at, seq, id, timestamp, action, actor_id, ` +
                    `subject_id, subject_store, detail, parent_event_id, owner, ` +
                    `integrity_hash, prev_hash) ` +
                    `SELECT ?, ?, seq, id, timestamp, action, actor_id, subject_id, ` +
                    `subject_store, detail, parent_event_id, owner, integrity_hash, prev_hash ` +
                    `FROM ${LEDGER_EVENTS_TABLE} WHERE timestamp < ?`,
            ).run(archiveId, archivedAt, beforeTimestamp);
            conn.prepare(`DELETE FROM ${LEDGER_EVENTS_TABLE} WHERE timestamp < ?`).run(
                beforeTimestamp,
            );

            conn.prepare(
                `INSERT INTO ${LEDGER_RECEIPTS_ARCHIVE_TABLE} ` +
                    `(archive_id, archived_at, seq, id, command_id, committed_at, ` +
                    `result_summary, affected_ids, provenance_event_id, integrity_hash, prev_hash) ` +
                    `SELECT ?, ?, seq, id, command_id, committed_at, result_summary, ` +
                    `affected_ids, provenance_event_id, integrity_hash, prev_hash ` +
                    `FROM ${LEDGER_RECEIPTS_TABLE} WHERE committed_at < ?`,
            ).run(archiveId, archivedAt, beforeTimestamp);
            conn.prepare(`DELETE FROM ${LEDGER_RECEIPTS_TABLE} WHERE committed_at < ?`).run(
                beforeTimestamp,
            );
        });

        const retained = (
            conn.prepare(`SELECT COUNT(*) AS n FROM ${LEDGER_EVENTS_TABLE}`).get() as {
                n: number;
            }
        ).n;

        return {
            archived: archiveEventCount,
            retained,
            // Synthetic locator (the SQLite analogue of local's archive file
            // path). Set whenever anything was archived (>0).
            archiveFile: `sqlite:${LEDGER_EVENTS_ARCHIVE_TABLE}/${archiveId}`,
        };
    }

    // ---- PROV-004 tamper-evidence helpers -------------------------------
    //
    // ALL stamping routes through computeIntegrityHash (src/types/integrity.ts)
    // — the single source of truth shared with the verifier. NEVER hand-roll a
    // hash here. The object passed to computeIntegrityHash is the DOMAIN record
    // (no `seq`; absent optionals omitted, never null) so a record this store
    // writes hashes identically to one LocalLedgerStore writes.

    /**
     * Stamp `prevHash` + `integrityHash` on an event that carries every field
     * EXCEPT the two tamper-evidence fields. MUST run inside the append
     * transaction so `prevHash` reads the integrity_hash of the CURRENT tail
     * event (`ORDER BY seq DESC LIMIT 1`) — `undefined` for the genesis event.
     * `prevHash` is OMITTED from the assembled record when undefined so the
     * genesis record's serialization (and therefore its hash) matches local's.
     */
    private stampEventIntegrity(
        event: Omit<ProvenanceEvent, 'integrityHash' | 'prevHash'>,
    ): ProvenanceEvent {
        const prevHash = this.tailEventHash();
        const assembled: ProvenanceEvent = {
            ...event,
            // prevHash included ONLY when defined (genesis omits it). Spreading a
            // conditional object keeps the key absent rather than set-to-undefined,
            // though computeIntegrityHash drops undefined keys either way.
            ...(prevHash !== undefined ? { prevHash } : {}),
            integrityHash: '',
        };
        assembled.integrityHash = computeIntegrityHash(
            assembled as unknown as Record<string, unknown>,
        );
        return assembled;
    }

    /** Receipts are a SEPARATE chain from events; same discipline. */
    private stampReceiptIntegrity(
        receipt: Omit<Receipt, 'integrityHash' | 'prevHash'>,
    ): Receipt {
        const prevHash = this.tailReceiptHash();
        const assembled: Receipt = {
            ...receipt,
            ...(prevHash !== undefined ? { prevHash } : {}),
            integrityHash: '',
        };
        assembled.integrityHash = computeIntegrityHash(
            assembled as unknown as Record<string, unknown>,
        );
        return assembled;
    }

    /**
     * Recompute the integrity hash on a reconstructed event and throw
     * {@link LedgerIntegrityError} on mismatch (verify-on-read, PROV-004).
     * computeIntegrityHash strips integrityHash itself before hashing, so we
     * compare against the stored value directly.
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
     * Restore-path integrity reconciliation for an imported event (PROV-004):
     * verify a present hash (a tampered backup throws), compute + set it when
     * absent (legacy backup). The snapshot's `prevHash` is preserved verbatim
     * either way.
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

    // ---- import content-equality normalization --------------------------
    //
    // assertContentMatch (src/adapters/local/errors.ts) compares the two records
    // via JSON.stringify, which is key-ORDER-sensitive. The local store never
    // trips on this because its `existing` and `incoming` are built by the same
    // code path (identical key order). Our `existing` is materialized from a DB
    // row (rowToEvent/rowToReceipt order) while `incoming` carries the caller's
    // key order, so equal content could serialize to DIFFERENT strings and raise
    // a false ImportConflictError. These helpers rebuild each side in ONE fixed
    // field order (absent optionals omitted, matching rowTo* output) so the
    // comparison reduces to true content equality — exactly local's semantics.

    private canonicalEventForCompare(event: ProvenanceEvent): Record<string, unknown> {
        const out: Record<string, unknown> = {
            id: event.id,
            timestamp: event.timestamp,
            action: event.action,
            actorId: event.actorId,
            subjectId: event.subjectId,
            subjectStore: event.subjectStore,
            detail: event.detail,
            owner: event.owner,
            integrityHash: event.integrityHash,
        };
        // Optionals appended in a fixed position, omitted when absent (so a
        // genesis/rootless record on one side never differs from the other by a
        // stray undefined-valued key).
        if (event.parentEventId !== undefined) out.parentEventId = event.parentEventId;
        if (event.prevHash !== undefined) out.prevHash = event.prevHash;
        return out;
    }

    private canonicalReceiptForCompare(receipt: Receipt): Record<string, unknown> {
        const out: Record<string, unknown> = {
            id: receipt.id,
            commandId: receipt.commandId,
            committedAt: receipt.committedAt,
            resultSummary: receipt.resultSummary,
            affectedIds: receipt.affectedIds,
            provenanceEventId: receipt.provenanceEventId,
            integrityHash: receipt.integrityHash,
        };
        if (receipt.prevHash !== undefined) out.prevHash = receipt.prevHash;
        return out;
    }

    // ---- row <-> domain + tail reads ------------------------------------

    /** integrity_hash of the current tail event, or undefined if none. */
    private tailEventHash(): string | undefined {
        const row = this.db.connection
            .prepare(
                `SELECT integrity_hash FROM ${LEDGER_EVENTS_TABLE} ORDER BY seq DESC LIMIT 1`,
            )
            .get() as { integrity_hash: string } | undefined;
        return row ? row.integrity_hash : undefined;
    }

    /** integrity_hash of the current tail receipt, or undefined if none. */
    private tailReceiptHash(): string | undefined {
        const row = this.db.connection
            .prepare(
                `SELECT integrity_hash FROM ${LEDGER_RECEIPTS_TABLE} ORDER BY seq DESC LIMIT 1`,
            )
            .get() as { integrity_hash: string } | undefined;
        return row ? row.integrity_hash : undefined;
    }

    /**
     * INSERT one fully-stamped event. `seq` is omitted so AUTOINCREMENT assigns
     * write order. `detail` is JSON; absent optionals persist as SQL NULL
     * (`parent_event_id` / `prev_hash`). All values bound with `?`.
     */
    private insertEvent(event: ProvenanceEvent): void {
        this.db.connection
            .prepare(
                `INSERT INTO ${LEDGER_EVENTS_TABLE} ` +
                    `(id, timestamp, action, actor_id, subject_id, subject_store, detail, ` +
                    `parent_event_id, owner, integrity_hash, prev_hash) ` +
                    `VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
                event.id,
                event.timestamp,
                event.action,
                event.actorId,
                event.subjectId,
                event.subjectStore,
                JSON.stringify(event.detail),
                event.parentEventId ?? null,
                event.owner,
                event.integrityHash,
                event.prevHash ?? null,
            );
    }

    private insertReceipt(receipt: Receipt): void {
        this.db.connection
            .prepare(
                `INSERT INTO ${LEDGER_RECEIPTS_TABLE} ` +
                    `(id, command_id, committed_at, result_summary, affected_ids, ` +
                    `provenance_event_id, integrity_hash, prev_hash) ` +
                    `VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
                receipt.id,
                receipt.commandId,
                receipt.committedAt,
                receipt.resultSummary,
                JSON.stringify(receipt.affectedIds),
                receipt.provenanceEventId,
                receipt.integrityHash,
                receipt.prevHash ?? null,
            );
    }

    /**
     * Reconstruct a {@link ProvenanceEvent} from a raw `ledger_events` row.
     * Absent optionals are OMITTED (not set to null): `parent_event_id` NULL →
     * `parentEventId` absent; `prev_hash` NULL → `prevHash` absent. This is
     * load-bearing for the round-trip — a `prevHash: null` would serialize
     * differently from an omitted key and break cross-adapter hash equality and
     * verify-on-read. `detail` JSON-parses; `integrityHash` comes from the column.
     */
    private rowToEvent(row: Record<string, unknown>): ProvenanceEvent {
        const event: ProvenanceEvent = {
            id: row.id as string,
            timestamp: row.timestamp as string,
            action: row.action as string,
            actorId: row.actor_id as string,
            subjectId: row.subject_id as string,
            subjectStore: row.subject_store as ProvenanceEvent['subjectStore'],
            detail: JSON.parse((row.detail as string) ?? '{}') as Record<string, unknown>,
            owner: 'ledger',
            integrityHash: row.integrity_hash as string,
        };
        if (row.parent_event_id !== null && row.parent_event_id !== undefined) {
            event.parentEventId = row.parent_event_id as string;
        }
        if (row.prev_hash !== null && row.prev_hash !== undefined) {
            event.prevHash = row.prev_hash as string;
        }
        return event;
    }

    /**
     * Reconstruct a {@link Receipt} from a raw `ledger_receipts` row.
     * `affected_ids` JSON-parses; `prev_hash` NULL → `prevHash` OMITTED (same
     * round-trip rationale as {@link rowToEvent}).
     */
    private rowToReceipt(row: Record<string, unknown>): Receipt {
        const receipt: Receipt = {
            id: row.id as string,
            commandId: row.command_id as string,
            committedAt: row.committed_at as string,
            resultSummary: row.result_summary as string,
            affectedIds: JSON.parse((row.affected_ids as string) ?? '[]') as string[],
            provenanceEventId: row.provenance_event_id as string,
            integrityHash: row.integrity_hash as string,
        };
        if (row.prev_hash !== null && row.prev_hash !== undefined) {
            receipt.prevHash = row.prev_hash as string;
        }
        return receipt;
    }
}
