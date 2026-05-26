/**
 * ProvenanceEvent — an immutable ledger entry recording an action, link, or mutation.
 * Lives in the event/provenance ledger. Append-only.
 */
export interface ProvenanceEvent {
    id: string;
    timestamp: string;
    action: string;
    actorId: string;
    subjectId: string;
    subjectStore: 'canonical' | 'artifact' | 'index' | 'ledger';
    detail: Record<string, unknown>;
    parentEventId?: string;
    owner: 'ledger';
}
