import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import type { Entity } from '../../types/entity.js';
import type { CanonicalStore, EntityFilter } from '../../contracts/canonical-store.js';
import { CorruptStoreError, assertContentMatch } from './errors.js';
import { buildRandomTmpPath, cleanupOrphanTmpFiles } from './tmp-cleanup.js';

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
        // STORES-B-001: sweep random-suffix tmp orphans before load. Stale
        // tmp files from a previous crashed process should not survive
        // forever; young ones (within 5min) are kept because a sibling
        // process may still be writing them.
        cleanupOrphanTmpFiles(dirname(this.filePath), basename(this.filePath));
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
     * Idempotent on byte-identical re-import: if an entity with the same id
     * already exists and its content equals the incoming entity (excluding
     * the store-stamped `owner` field), the existing record is returned.
     *
     * Throws ImportConflictError (STORES-B-003) when an entity with the same
     * id exists but its content DIFFERS from the incoming snapshot. Pre-fix
     * the existing record was silently returned, masking tampered backups.
     */
    async importSnapshot(entity: Entity): Promise<Entity> {
        const existing = this.entities.get(entity.id);
        if (existing) {
            // Pre-fix: silently returned existing — tampered backups masked.
            // Post-fix: assert content equality; throw on mismatch.
            assertContentMatch(
                'canonical',
                entity.id,
                existing as unknown as Record<string, unknown>,
                entity as unknown as Record<string, unknown>,
            );
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
        // STORES-B-001: random-suffix tmp path so concurrent persist() calls
        // across two processes never collide. Pre-fix the fixed `.tmp` suffix
        // would let process B truncate process A's tmp file silently.
        const tmpPath = buildRandomTmpPath(this.filePath);
        writeFileSync(tmpPath, JSON.stringify(arr, null, 2));
        renameSync(tmpPath, this.filePath);
    }
}
