import type { ClusterStores } from '../contracts/index.js';
import type { ProvenanceEvent } from '../types/provenance-event.js';
import { ProvenanceMissingError } from './errors.js';

/**
 * Record a provenance event in the ledger.
 */
export async function recordProvenance(
    ledger: ClusterStores['ledger'],
    action: string,
    actorId: string,
    subjectId: string,
    subjectStore: ProvenanceEvent['subjectStore'],
    detail: Record<string, unknown>,
    parentEventId?: string,
): Promise<ProvenanceEvent> {
    return ledger.append({
        action,
        actorId,
        subjectId,
        subjectStore,
        detail,
        parentEventId,
    });
}

/**
 * Trace provenance for a subject. Fails honestly if no lineage exists.
 */
export async function traceSubjectProvenance(
    ledger: ClusterStores['ledger'],
    subjectId: string,
): Promise<ProvenanceEvent[]> {
    const events = await ledger.listEvents({ subjectId });
    if (events.length === 0) {
        throw new ProvenanceMissingError(subjectId);
    }

    // For each event, walk the parent chain
    const allTraced: ProvenanceEvent[] = [];
    const seen = new Set<string>();

    for (const event of events) {
        const chain = await ledger.trace(event.id);
        for (const e of chain) {
            if (!seen.has(e.id)) {
                seen.add(e.id);
                allTraced.push(e);
            }
        }
    }

    return allTraced;
}
