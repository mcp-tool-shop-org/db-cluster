/**
 * Command — a typed mutation request that must pass through the kernel.
 * AI proposes commands; the kernel validates and commits them.
 */
export interface Command {
    id: string;
    verb: CommandVerb;
    targetStore: 'canonical' | 'artifact' | 'index' | 'ledger';
    payload: Record<string, unknown>;
    proposedAt: string;
    proposedBy: string;
    status: 'proposed' | 'validated' | 'committed' | 'rejected';
}

export type CommandVerb =
    | 'ingest_artifact'
    | 'create_entity'
    | 'update_entity'
    | 'link_evidence'
    | 'propose_mutation'
    | 'reindex';
