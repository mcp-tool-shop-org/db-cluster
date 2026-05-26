import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { IndexRecord } from '../../types/index-record.js';
import type { IndexStore, IndexQuery } from '../../contracts/index-store.js';

/**
 * Local index store — file-backed derivative index.
 * Proves: derivative records, clear/rebuild-ready behavior.
 * This store can be blown away and rebuilt from canonical + artifact + ledger stores.
 */
export class LocalIndexStore implements IndexStore {
    private readonly filePath: string;
    private records: Map<string, IndexRecord>;

    constructor(dataDir: string) {
        mkdirSync(dataDir, { recursive: true });
        this.filePath = join(dataDir, 'index-records.json');
        this.records = this.load();
    }

    async search(query: IndexQuery): Promise<IndexRecord[]> {
        let results = Array.from(this.records.values());

        if (query.sourceStore) {
            results = results.filter((r) => r.sourceStore === query.sourceStore);
        }
        if (query.text) {
            const q = query.text.toLowerCase();
            results = results.filter(
                (r) =>
                    r.text.toLowerCase().includes(q) ||
                    JSON.stringify(r.metadata).toLowerCase().includes(q),
            );
        }
        if (query.metadata) {
            for (const [key, value] of Object.entries(query.metadata)) {
                results = results.filter((r) => r.metadata[key] === value);
            }
        }
        if (query.limit) {
            results = results.slice(0, query.limit);
        }
        return results;
    }

    async get(id: string): Promise<IndexRecord | null> {
        return this.records.get(id) ?? null;
    }

    async index(
        record: Omit<IndexRecord, 'id' | 'indexedAt' | 'owner'>,
    ): Promise<IndexRecord> {
        const full: IndexRecord = {
            id: randomUUID(),
            ...record,
            indexedAt: new Date().toISOString(),
            owner: 'index',
        };
        this.records.set(full.id, full);
        this.persist();
        return full;
    }

    async remove(id: string): Promise<void> {
        this.records.delete(id);
        this.persist();
    }

    async clear(): Promise<void> {
        this.records.clear();
        this.persist();
    }

    async count(): Promise<number> {
        return this.records.size;
    }

    private load(): Map<string, IndexRecord> {
        if (!existsSync(this.filePath)) {
            return new Map();
        }
        const raw = readFileSync(this.filePath, 'utf-8');
        const arr: IndexRecord[] = JSON.parse(raw);
        return new Map(arr.map((r) => [r.id, r]));
    }

    private persist(): void {
        const arr = Array.from(this.records.values());
        writeFileSync(this.filePath, JSON.stringify(arr, null, 2));
    }
}
