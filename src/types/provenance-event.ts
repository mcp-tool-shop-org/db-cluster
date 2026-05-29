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
    /**
     * Tamper-evidence hash over this event's content (Wave S2-A1, PROV-004).
     * `= computeIntegrityHash(this record)` — see `src/types/integrity.ts`.
     * Stamped by the adapter on `append()` (post-spread, like `id` /
     * `timestamp` / `owner`); the record's own `integrityHash` is EXCLUDED from
     * the hashed content. Distinct from `parentEventId`: that is the logical
     * lineage parent (walked by `trace()`); `prevHash` is the physical
     * write-order chain link (walked by `verify()`).
     */
    integrityHash: string;
    /**
     * Hash-chain link (Wave S2-A1): the `integrityHash` of the event written
     * immediately before this one in the same ledger file. Undefined for the
     * first (genesis) event in a file. INCLUDED in this record's hashed
     * content, so tampering with the chain order is detectable.
     */
    prevHash?: string;
}
