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
}

export interface EntityFilter {
    kind?: string;
    nameContains?: string;
    limit?: number;
}
