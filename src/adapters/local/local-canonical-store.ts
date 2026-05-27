import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { Entity } from '../../types/entity.js';
import type { CanonicalStore, EntityFilter } from '../../contracts/canonical-store.js';
import { CorruptStoreError } from './errors.js';

/**
 * Local canonical store — file-backed entity persistence.
 * Stores entities as a single JSON file (entities.json).
 * Proves: stable records, create/read/list, controlled update.
 *
 * Writes are atomic: serialize to a sibling `.tmp` then `renameSync` over the
 * real path. Crash mid-write leaves the previous good file intact.
 * Reads fail loudly with a typed CorruptStoreError if JSON.parse fails.
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

    /**
     * Import a full entity snapshot preserving original id, createdAt, updatedAt.
     * Used by restore to recreate entities exactly as backed up so that
     * provenance events that cite the original subjectId still resolve (STORES-001).
     *
     * Idempotent: if an entity with the same id already exists, the existing
     * record is returned unchanged.
     */
    async importSnapshot(entity: Entity): Promise<Entity> {
        const existing = this.entities.get(entity.id);
        if (existing) {
            return existing;
        }
        const snapshot: Entity = {
            ...entity,
            owner: 'canonical',
        };
        this.entities.set(snapshot.id, snapshot);
        this.persist();
        return snapshot;
    }

    private load(): Map<string, Entity> {
        if (!existsSync(this.filePath)) {
            return new Map();
        }
        let raw: string;
        try {
            raw = readFileSync(this.filePath, 'utf-8');
        } catch (err) {
            throw new CorruptStoreError(this.filePath, err);
        }
        try {
            const arr: Entity[] = JSON.parse(raw);
            if (!Array.isArray(arr)) {
                throw new Error(`expected JSON array, got ${typeof arr}`);
            }
            return new Map(arr.map((e) => [e.id, e]));
        } catch (err) {
            throw new CorruptStoreError(this.filePath, err);
        }
    }

    private persist(): void {
        const arr = Array.from(this.entities.values());
        const tmpPath = `${this.filePath}.tmp`;
        writeFileSync(tmpPath, JSON.stringify(arr, null, 2));
        renameSync(tmpPath, this.filePath);
    }
}
