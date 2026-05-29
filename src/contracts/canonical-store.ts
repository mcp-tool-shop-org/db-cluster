import type { Entity } from '../types/entity.js';

/**
 * CanonicalStore contract.
 * Owns: durable entities, IDs, stable business state.
 * Must support: create, get, update (through commands only), list, existence checks.
 */
export interface CanonicalStore {
    /**
     * Fetch a single entity by id, or `null` if absent.
     *
     * Returns the LATEST version (highest `version`) of the entity (Wave
     * S2-A1). Prior versions are retained immutably and are reachable via
     * {@link listVersions} / {@link getVersion}.
     *
     * @param id  Entity id stamped at `create()` / `importSnapshot()` time.
     * @returns   The latest-version entity, or `null` if no entity with that
     *            id exists in the store.
     * @throws    Adapter I/O errors propagate (corrupt store, transient
     *            DB failure, etc.).
     */
    get(id: string): Promise<Entity | null>;

    /**
     * List entities matching the filter.
     *
     * @param filter  Optional filter. `kind` narrows to a specific
     *                entity kind; `nameContains` is a substring match;
     *                `limit` caps the returned count (adapter-specific
     *                default, typically all-records).
     * @returns       Array of matching entities. Empty array if no
     *                matches; never returns `null`.
     */
    list(filter?: EntityFilter): Promise<Entity[]>;

    /**
     * Check whether an entity with the given id exists. Cheaper than
     * `get(id)` followed by null-check on adapters that can answer via
     * a SELECT 1 / membership test.
     *
     * @param id  Entity id.
     * @returns   `true` if present, `false` otherwise.
     */
    exists(id: string): Promise<boolean>;

    /**
     * Create a new entity, stamping `id`, `version`, `createdAt`, `updatedAt`,
     * and `owner='canonical'` at the adapter boundary. Caller-supplied values
     * for those fields are IGNORED (the adapter uses the post-spread stamp
     * pattern from STORES-B-021).
     *
     * Preconditions:
     *  - `entity.kind` and `entity.name` are non-empty strings.
     *
     * Postconditions:
     *  - Returned Entity has `id` (UUID), `version=1` (Wave S2-A1 — a freshly
     *    created entity is its own first version), `createdAt` / `updatedAt`
     *    (ISO-8601), and `owner='canonical'` stamped by the adapter.
     *  - Persistence durable before resolve.
     *
     * @throws  Adapter I/O failures propagate.
     */
    create(entity: Omit<Entity, 'id' | 'version' | 'createdAt' | 'updatedAt' | 'owner'>): Promise<Entity>;

    /**
     * Append a new VERSION of an existing entity (Wave S2-A1 — append, not
     * overwrite). This creates version N+1 from the current latest version,
     * applying `patch` (`name` and/or `attributes`) on top of it. Prior
     * versions are retained IMMUTABLY — nothing is mutated or deleted. The
     * returned Entity is the new latest (highest `version`); a subsequent
     * {@link get} resolves to it.
     *
     * `id`, `kind`, `createdAt`, and `owner` are carried forward unchanged from
     * the latest version; `version` is incremented; `updatedAt` is restamped by
     * the adapter.
     *
     * Preconditions:
     *  - At least one version of `id` exists. A NotFoundError is thrown if not.
     *  - `patch` is a non-empty subset of `{name, attributes}`.
     *
     * Postconditions:
     *  - A new immutable version (latest `version` + 1) is persisted; earlier
     *    versions remain readable via {@link listVersions} / {@link getVersion}.
     *  - Returned Entity is the new latest version with the patched fields and a
     *    fresh `updatedAt`.
     *
     * @param id     Id of the entity to version.
     * @param patch  Partial fields to apply to the new version (name and/or
     *               attributes).
     * @throws       {@link NotFoundError} when `id` doesn't exist;
     *               adapter I/O failures propagate.
     */
    update(id: string, patch: Partial<Pick<Entity, 'name' | 'attributes'>>): Promise<Entity>;

    /**
     * List ALL versions of an entity, ascending by `version` (Wave S2-A1).
     *
     * @param id  Entity id.
     * @returns   Every retained version of the entity, ordered oldest-first
     *            (`version` ascending). Empty array if the id is unknown;
     *            never returns `null`.
     * @throws    Adapter I/O failures propagate.
     */
    listVersions(id: string): Promise<Entity[]>;

    /**
     * Fetch one specific version of an entity (Wave S2-A1).
     *
     * @param id       Entity id.
     * @param version  The exact `version` number to fetch (integer ≥ 1).
     * @returns        The matching version, or `null` if the id is unknown or
     *                 has no such version.
     * @throws         Adapter I/O failures propagate.
     */
    getVersion(id: string, version: number): Promise<Entity | null>;

    /**
     * Import a full entity snapshot preserving the original `id`, `createdAt`,
     * `updatedAt`. Used by backup/restore — STORES-001 / -003 require this so
     * restored entities keep their original IDs (otherwise their provenance
     * chain breaks because events still carry the original subjectId).
     *
     * REQUIRED on the contract (STORES-R2-002): every adapter must
     * implement this. backup.ts::restore() already throws
     * ImportSnapshotNotSupportedError at runtime when the method is
     * missing — promoting it to a contract requirement closes the
     * compile-time gap that let new adapters compile cleanly without it.
     *
     * Preconditions:
     *  - `entity` carries its original `id`, `createdAt`, `updatedAt`
     *    from the source cluster.
     *
     * Postconditions:
     *  - The stored entity preserves all four immutable fields verbatim.
     *
     * @param entity  Full entity snapshot.
     * @returns       The stored Entity.
     * @throws        {@link ImportConflictError} via assertContentMatch
     *                when an entity with the same id exists but the
     *                incoming content differs.
     */
    importSnapshot(entity: Entity): Promise<Entity>;
}

export interface EntityFilter {
    kind?: string;
    nameContains?: string;
    limit?: number;
}
