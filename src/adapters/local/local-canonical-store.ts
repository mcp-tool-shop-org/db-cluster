import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import type { Entity } from '../../types/entity.js';
import type { CanonicalStore, EntityFilter } from '../../contracts/canonical-store.js';
import { CorruptStoreError, assertContentMatch } from './errors.js';
import { buildRandomTmpPath, cleanupOrphanTmpFiles } from './tmp-cleanup.js';

/**
 * Local canonical store — file-backed entity persistence.
 *
 * Wave S2-A1 (PROV-002): entities are now MULTI-VERSION and append-only.
 * `update()` no longer mutates in place — it appends version N+1 and retains
 * every prior version immutably. The in-memory model is therefore
 * `Map<id, Entity[]>` where the array is ascending by `version`; the LATEST
 * version is the last element. `get()` / `list()` return the latest; the full
 * history is reachable via `listVersions()` / `getVersion()`.
 *
 * On-disk format: a single flat JSON array of ALL versions of ALL entities
 * (every Entity carries its own `id` + `version`, so the grouping is
 * reconstructed on load). This keeps the persisted shape a plain `Entity[]`
 * (back-compatible with the corrupt-store JSON-array detection) — load groups
 * by `id` and sorts each group by `version` ascending. A legacy backup whose
 * entities predate the `version` field is tolerated: a missing `version` is
 * treated as 1 on load.
 *
 * Writes are atomic: serialize to a sibling random-suffix `.tmp` then
 * `renameSync` over the real path. Crash mid-write leaves the previous good
 * file intact. Reads fail loudly with a typed CorruptStoreError if JSON.parse
 * fails.
 */
export class LocalCanonicalStore implements CanonicalStore {
    private readonly filePath: string;
    /** id → versions ascending by `version` (last element is the latest). */
    private entities: Map<string, Entity[]>;

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

    /** The latest (highest-version) entity for an id, or undefined. */
    private latest(id: string): Entity | undefined {
        const versions = this.entities.get(id);
        if (!versions || versions.length === 0) return undefined;
        return versions[versions.length - 1];
    }

    async get(id: string): Promise<Entity | null> {
        // PROV-002: returns the LATEST version (highest `version`).
        return this.latest(id) ?? null;
    }

    async list(filter?: EntityFilter): Promise<Entity[]> {
        // PROV-002: one row per entity — the latest version of each.
        let results: Entity[] = [];
        for (const versions of this.entities.values()) {
            if (versions.length === 0) continue;
            results.push(versions[versions.length - 1]);
        }

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
        // True if ANY version exists.
        const versions = this.entities.get(id);
        return !!versions && versions.length > 0;
    }

    async create(
        input: Omit<Entity, 'id' | 'version' | 'createdAt' | 'updatedAt' | 'owner'>,
    ): Promise<Entity> {
        const now = new Date().toISOString();
        // PROV-002: a freshly created entity is its own first version.
        // Spread first, then stamp generated fields — caller-supplied
        // id/version/owner (via a raw cast) cannot override the store stamps.
        const entity: Entity = {
            ...input,
            id: randomUUID(),
            version: 1,
            createdAt: now,
            updatedAt: now,
            owner: 'canonical',
        };
        this.entities.set(entity.id, [entity]);
        this.persist();
        return entity;
    }

    async update(
        id: string,
        patch: Partial<Pick<Entity, 'name' | 'attributes'>>,
    ): Promise<Entity> {
        const versions = this.entities.get(id);
        const current = versions && versions.length > 0 ? versions[versions.length - 1] : undefined;
        if (!current) {
            throw new Error(`Entity not found: ${id}`);
        }
        // PROV-002 APPEND-A-VERSION: build version N+1 from the current latest,
        // applying the patch. Prior versions are retained immutably — nothing
        // is mutated or deleted. id / kind / createdAt / owner carry forward;
        // version increments; updatedAt is restamped.
        const next: Entity = {
            ...current,
            ...patch,
            version: current.version + 1,
            updatedAt: new Date().toISOString(),
        };
        versions!.push(next);
        this.persist();
        return next;
    }

    async listVersions(id: string): Promise<Entity[]> {
        // PROV-002: every retained version, ascending by `version`. The stored
        // array is already maintained ascending; return a defensive copy so
        // callers can't mutate the in-memory history.
        const versions = this.entities.get(id);
        return versions ? [...versions] : [];
    }

    async getVersion(id: string, version: number): Promise<Entity | null> {
        const versions = this.entities.get(id);
        if (!versions) return null;
        return versions.find((e) => e.version === version) ?? null;
    }

    /**
     * Import a full entity snapshot preserving the original id, version,
     * createdAt, updatedAt. Used by restore to recreate entities exactly as
     * backed up so that provenance events that cite the original subjectId
     * still resolve (STORES-001).
     *
     * PROV-002: preserves the incoming `version` (defaulting to 1 when absent —
     * a legacy pre-Wave-S2-A1 backup). Each (id, version) pair is its own
     * immutable record: importing several versions of the same id rebuilds the
     * version history. The store keeps each id's version array sorted ascending.
     *
     * Idempotent on byte-identical re-import: if the SAME (id, version) already
     * exists and its content equals the incoming snapshot (excluding the
     * store-stamped `owner` field), the existing record is returned.
     *
     * Throws ImportConflictError (STORES-B-003) when a record with the same
     * (id, version) exists but its content DIFFERS from the incoming snapshot.
     */
    async importSnapshot(entity: Entity): Promise<Entity> {
        // Preserve incoming version; default to 1 for a legacy backup that
        // predates the version field.
        const incomingVersion =
            typeof entity.version === 'number' && Number.isFinite(entity.version)
                ? entity.version
                : 1;
        const snapshot: Entity = {
            ...entity,
            version: incomingVersion,
            owner: 'canonical',
        };

        const versions = this.entities.get(entity.id);
        if (versions) {
            const existing = versions.find((e) => e.version === incomingVersion);
            if (existing) {
                // Same (id, version) already present — assert content equality
                // (tampered-backup detection); idempotent on a true match.
                assertContentMatch(
                    'canonical',
                    `${entity.id}@${incomingVersion}`,
                    existing as unknown as Record<string, unknown>,
                    snapshot as unknown as Record<string, unknown>,
                );
                return existing;
            }
            // New version of a known entity: insert keeping the array ascending.
            versions.push(snapshot);
            versions.sort((a, b) => a.version - b.version);
            this.persist();
            return snapshot;
        }

        this.entities.set(snapshot.id, [snapshot]);
        this.persist();
        return snapshot;
    }

    private load(): Map<string, Entity[]> {
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
            // PROV-002: the flat array holds every version of every entity.
            // Group by id and sort each group ascending by version. A legacy
            // record without a `version` field is normalised to version 1.
            const grouped = new Map<string, Entity[]>();
            for (const e of arr) {
                const normalised: Entity =
                    typeof e.version === 'number' && Number.isFinite(e.version)
                        ? e
                        : { ...e, version: 1 };
                const bucket = grouped.get(normalised.id);
                if (bucket) {
                    bucket.push(normalised);
                } else {
                    grouped.set(normalised.id, [normalised]);
                }
            }
            for (const bucket of grouped.values()) {
                bucket.sort((a, b) => a.version - b.version);
            }
            return grouped;
        } catch (err) {
            throw new CorruptStoreError(this.filePath, err);
        }
    }

    private persist(): void {
        // PROV-002: flatten ALL versions of ALL entities into one array so the
        // full history is durable. Order within the file is not load-bearing
        // (load re-sorts each id's versions), but we emit each entity's
        // versions contiguously and ascending for human readability.
        const arr: Entity[] = [];
        for (const versions of this.entities.values()) {
            for (const e of versions) arr.push(e);
        }
        // STORES-B-001: random-suffix tmp path so concurrent persist() calls
        // across two processes never collide. Pre-fix the fixed `.tmp` suffix
        // would let process B truncate process A's tmp file silently.
        const tmpPath = buildRandomTmpPath(this.filePath);
        writeFileSync(tmpPath, JSON.stringify(arr, null, 2));
        renameSync(tmpPath, this.filePath);
    }
}
