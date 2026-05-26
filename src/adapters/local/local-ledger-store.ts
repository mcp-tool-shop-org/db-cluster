import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ProvenanceEvent } from '../../types/provenance-event.js';
import type { Receipt } from '../../types/receipt.js';
import type { LedgerStore, LedgerFilter, ReceiptFilter } from '../../contracts/ledger-store.js';

/**
 * Local ledger store — append-only event and receipt persistence.
 * Proves: ordered append, no update/delete, lineage trace via parent chain.
 * Events and receipts are stored in separate ordered arrays.
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

    private loadArray<T>(path: string): T[] {
        if (!existsSync(path)) return [];
        const raw = readFileSync(path, 'utf-8');
        return JSON.parse(raw);
    }

    private persistEvents(): void {
        writeFileSync(this.eventsPath, JSON.stringify(this.events, null, 2));
    }

    private persistReceipts(): void {
        writeFileSync(this.receiptsPath, JSON.stringify(this.receipts, null, 2));
    }
}
