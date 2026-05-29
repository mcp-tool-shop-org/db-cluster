/**
 * Receipt — proof that a committed command was executed.
 * Emitted by the kernel after every successful mutation. Stored in the ledger.
 */
export interface Receipt {
    id: string;
    commandId: string;
    committedAt: string;
    resultSummary: string;
    affectedIds: string[];
    provenanceEventId: string;
    /**
     * Tamper-evidence hash over this receipt's content (Wave S2-A1, PROV-004).
     * `= computeIntegrityHash(this record)` — see `src/types/integrity.ts`.
     * Stamped by the adapter on `appendReceipt()` (post-spread, like `id`); the
     * record's own `integrityHash` is EXCLUDED from the hashed content.
     */
    integrityHash: string;
    /**
     * Hash-chain link (Wave S2-A1): the `integrityHash` of the receipt written
     * immediately before this one in the same ledger file. Undefined for the
     * first (genesis) receipt in a file. INCLUDED in this record's hashed
     * content, so tampering with the chain order is detectable.
     */
    prevHash?: string;
}
