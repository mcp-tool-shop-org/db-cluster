import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Entity } from '../../types/entity.js';
import type { CanonicalStore, EntityFilter } from '../../contracts/canonical-store.js';

/**
 * Local canonical store — file-backed entity persistence.
 * Stores entities as a single JSON file (entities.json).
 * Proves: stable records, create/read/list, controlled update.
 */
export class LocalCanonicalStore implements CanonicalStore {
    private readonly filePath: string;
    private entities: Map<string, Entity>;

    constructor(dataDir: string) {
        mkdirSync(dataDir, { recursive: true });
        this.filePath = join(dataDir, 'entities.json');
        this.entities = this.load();
    }

    async get(id: string): Promise<Entity | null> {
        return this.entities.get(id) ?? null;
    }

    async list(filter?: EntityFilter): Promise<Entity[]> {
        let results = Array.from(this.entities.values());

        if (filter?.kind) {
            results = results.filter((e) => e.kind === filter.kind);
        }
        if (filter?.nameContains) {
            const q = filter.nameContains.toLowerCase();
            results = results.filter((e) => e.name.toLowerCase().includes(q));
        }
        if (filter?.limit) {
            results = results.slice(0, filter.limit);
        }
        return results;
    }

    async exists(id: string): Promise<boolean> {
        return this.entities.has(id);
    }

    async create(
        input: Omit<Entity, 'id' | 'createdAt' | 'updatedAt' | 'owner'>,
    ): Promise<Entity> {
        const now = new Date().toISOString();
        const entity: Entity = {
            id: randomUUID(),
            ...input,
            createdAt: now,
            updatedAt: now,
            owner: 'canonical',
        };
        this.entities.set(entity.id, entity);
        this.persist();
        return entity;
    }

    async update(
        id: string,
        patch: Partial<Pick<Entity, 'name' | 'attributes'>>,
    ): Promise<Entity> {
        const existing = this.entities.get(id);
        if (!existing) {
            throw new Error(`Entity not found: ${id}`);
        }
        const updated: Entity = {
            ...existing,
            ...patch,
            updatedAt: new Date().toISOString(),
        };
        this.entities.set(id, updated);
        this.persist();
        return updated;
    }

    private load(): Map<string, Entity> {
        if (!existsSync(this.filePath)) {
            return new Map();
        }
        const raw = readFileSync(this.filePath, 'utf-8');
        const arr: Entity[] = JSON.parse(raw);
        return new Map(arr.map((e) => [e.id, e]));
    }

    private persist(): void {
        const arr = Array.from(this.entities.values());
        writeFileSync(this.filePath, JSON.stringify(arr, null, 2));
    }
}
