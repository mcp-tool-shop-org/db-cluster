/**
 * Canonical entity — a durable, identified business object.
 * Lives in the canonical store. Other stores reference it by ID.
 */
export interface Entity {
    id: string;
    kind: string;
    name: string;
    attributes: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
    owner: 'canonical';
}
