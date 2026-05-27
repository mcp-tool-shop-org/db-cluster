import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import type { ProvenanceEvent } from '../../types/provenance-event.js';
import type { Receipt } from '../../types/receipt.js';
import type { LedgerStore, LedgerFilter, ReceiptFilter } from '../../contracts/ledger-store.js';
import {
    CorruptStoreError,
    LedgerCycleDetectedError,
    assertContentMatch,
} from './errors.js';
import { buildRandomTmpPath, cleanupOrphanTmpFiles } from './tmp-cleanup.js';

/**
 * Local ledger store — append-only event and receipt persistence.
 * Proves: ordered append, no update/delete, lineage trace via parent chain.
 * Events and receipts are stored in separate ordered arrays.
 *
 * Writes are atomic (tmp + rename). Loads validate JSON shape and throw
 * CorruptStoreError on parse failure rather than silently returning [].
 */
export class LocalLedgerStore implements LedgerStore {
    private readonly eventsPath: string;
    private readonly receiptsPath: string;
    private events: ProvenanceEvent[];
    private receipts: Receipt[];

    constructor(dataDir: string) {
        mkdirSync(dataDir, { recursive: true });
        this.eventsPath = join(dataDir, 'events.json');
        this.receiptsPath = join(dataDir, 'receipts.json');
        // STORES-B-001: sweep orphan random-suffix tmp files for BOTH
        // persistence files (events + receipts share the directory).
        cleanupOrphanTmpFiles(dirname(this.eventsPath), basename(this.eventsPath));
        cleanupOrphanTmpFiles(dirname(this.receiptsPath), basename(this.receiptsPath));
        this.events = this.loadArray<ProvenanceEvent>(this.eventsPath);
        this.receipts = this.loadArray<Receipt>(this.receiptsPath);
    }

    async append(
        event: Omit<ProvenanceEvent, 'id' | 'timestamp' | 'owner'>,
    ): Promise<ProvenanceEvent> {
        const full: ProvenanceEvent = {
            id: randomUUID(),
            timestamp: new Date().toISOString(),
            ...event,
            owner: 'ledger',
        };
        this.events.push(full);
        this.persistEvents();
        return full;
    }

    async getEvent(id: string): Promise<ProvenanceEvent | null> {
        return this.events.find((e) => e.id === id) ?? null;
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

    async appendReceipt(receipt: Omit<Receipt, 'id' | 'committedAt'>): Promise<Receipt> {
        const full: Receipt = {
            id: randomUUID(),
            committedAt: new Date().toISOString(),
            ...receipt,
        };
        this.receipts.push(full);
        this.persistReceipts();
        return full;
    }

    async getReceipt(id: string): Promise<Receipt | null> {
        return this.receipts.find((r) => r.id === id) ?? null;
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
        const existing = this.events.find((e) => e.id === event.id);
        if (existing) {
            assertContentMatch(
                'ledger.event',
                event.id,
                existing as unknown as Record<string, unknown>,
                event as unknown as Record<string, unknown>,
            );
            return existing;
        }
        const snapshot: ProvenanceEvent = {
            ...event,
            owner: 'ledger',
        };
        this.events.push(snapshot);
        this.persistEvents();
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
        const existing = this.receipts.find((r) => r.id === receipt.id);
        if (existing) {
            assertContentMatch(
                'ledger.receipt',
                receipt.id,
                existing as unknown as Record<string, unknown>,
                receipt as unknown as Record<string, unknown>,
            );
            return existing;
        }
        const snapshot: Receipt = { ...receipt };
        this.receipts.push(snapshot);
        this.persistReceipts();
        return snapshot;
    }

    private loadArray<T>(path: string): T[] {
        if (!existsSync(path)) return [];
        let raw: string;
        try {
            raw = readFileSync(path, 'utf-8');
        } catch (err) {
            throw new CorruptStoreError(path, err);
        }
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

    private persistEvents(): void {
        // STORES-B-001: random-suffix tmp path. See note in local-canonical-store.
        const tmpPath = buildRandomTmpPath(this.eventsPath);
        writeFileSync(tmpPath, JSON.stringify(this.events, null, 2));
        renameSync(tmpPath, this.eventsPath);
    }

    private persistReceipts(): void {
        // STORES-B-001: random-suffix tmp path.
        const tmpPath = buildRandomTmpPath(this.receiptsPath);
        writeFileSync(tmpPath, JSON.stringify(this.receipts, null, 2));
        renameSync(tmpPath, this.receiptsPath);
    }
}
