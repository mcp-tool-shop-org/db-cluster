/**
 * STORES-R2-002 negative type test fixture.
 *
 * This fixture defines a class that claims to implement CanonicalStore but
 * omits the `importSnapshot` method. After the Wave A3 contract promotion
 * (importSnapshot becomes required), `implements CanonicalStore` here must
 * fail to compile with a "missing member" error — and the `@ts-expect-error`
 * directive below silences exactly that error.
 *
 * Pre-fix (importSnapshot optional): no error, directive is unused, tsc
 * fails with TS2578.
 *
 * Post-fix (importSnapshot required): real error, directive matches, tsc
 * exits cleanly.
 */

import type { CanonicalStore, EntityFilter } from '../../src/contracts/canonical-store.js';
import type { Entity } from '../../src/types/entity.js';

// @ts-expect-error — class deliberately omits required `importSnapshot`.
export class IncompleteCanonicalStore implements CanonicalStore {
    async get(_id: string): Promise<Entity | null> { return null; }
    async list(_filter?: EntityFilter): Promise<Entity[]> { return []; }
    async exists(_id: string): Promise<boolean> { return false; }
    async create(
        _entity: Omit<Entity, 'id' | 'createdAt' | 'updatedAt' | 'owner'>,
    ): Promise<Entity> {
        throw new Error('not implemented');
    }
    async update(
        _id: string,
        _patch: Partial<Pick<Entity, 'name' | 'attributes'>>,
    ): Promise<Entity> {
        throw new Error('not implemented');
    }
}
