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
}
