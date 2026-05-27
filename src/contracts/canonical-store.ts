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
     * Optional on the contract because not every adapter must support it
     * today (postgres parity ships in a follow-up wave); but every adapter
     * intended for production use SHOULD implement it. The restore op surfaces
     * an explicit error when this is missing.
     */
    importSnapshot?(entity: Entity): Promise<Entity>;
}

export interface EntityFilter {
    kind?: string;
    nameContains?: string;
    limit?: number;
}
