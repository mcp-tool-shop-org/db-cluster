import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { ProvenanceEvent } from '../../types/provenance-event.js';
import type { Receipt } from '../../types/receipt.js';
import type { LedgerStore, LedgerFilter, ReceiptFilter } from '../../contracts/ledger-store.js';
import { CorruptStoreError } from './errors.js';

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

    async trace(eventId: string): Promise<ProvenanceEvent[]> {
        const chain: ProvenanceEvent[] = [];
        let current = this.events.find((e) => e.id === eventId);

        while (current) {
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
     * Idempotent: if an event with the same id already exists, the existing
     * event is returned and no new copy is appended.
     */
    async importEvent(event: ProvenanceEvent): Promise<ProvenanceEvent> {
        const existing = this.events.find((e) => e.id === event.id);
        if (existing) {
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
     */
    async importReceipt(receipt: Receipt): Promise<Receipt> {
        const existing = this.receipts.find((r) => r.id === receipt.id);
        if (existing) {
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
        const tmpPath = `${this.eventsPath}.tmp`;
        writeFileSync(tmpPath, JSON.stringify(this.events, null, 2));
        renameSync(tmpPath, this.eventsPath);
    }

    private persistReceipts(): void {
        const tmpPath = `${this.receiptsPath}.tmp`;
        writeFileSync(tmpPath, JSON.stringify(this.receipts, null, 2));
        renameSync(tmpPath, this.receiptsPath);
    }
}
