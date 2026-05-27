import type { Entity } from '../types/entity.js';

/**
 * CanonicalStore contract.
 * Owns: durable entities, IDs, stable business state.
 * Must support: create, get, update (through commands only), list, existence checks.
 */
export interface CanonicalStore {
    get(id: string): Promise<Entity | null>;
    list(filter?: EntityFilter): Promise<Entity[]>;
    exists(id: string): Promise<boolean>;
    create(entity: Omit<Entity, 'id' | 'createdAt' | 'updatedAt' | 'owner'>): Promise<Entity>;
    update(id: string, patch: Partial<Pick<Entity, 'name' | 'attributes'>>): Promise<Entity>;
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
     */
    importSnapshot(entity: Entity): Promise<Entity>;
}

export interface EntityFilter {
    kind?: string;
    nameContains?: string;
    limit?: number;
}
