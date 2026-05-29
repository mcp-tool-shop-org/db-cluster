/**
 * Canonical entity — a durable, identified business object.
 * Lives in the canonical store. Other stores reference it by ID.
 */
export interface Entity {
    id: string;
    kind: string;
    name: string;
    attributes: Record<string, unknown>;
    /**
     * Version number — integer ≥ 1. The latest version of an entity is the one
     * with the highest `version`. Wave S2-A1: `update()` no longer mutates in
     * place; it appends version N+1 and retains prior versions immutably.
     * `create()` / `importSnapshot()` stamp version=1 for a brand-new entity.
     */
    version: number;
    createdAt: string;
    updatedAt: string;
    owner: 'canonical';
}
