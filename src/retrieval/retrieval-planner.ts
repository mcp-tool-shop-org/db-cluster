import { randomUUID } from 'node:crypto';
import type { ClusterStores } from '../contracts/index.js';
import type { Entity } from '../types/entity.js';
import type { Artifact } from '../types/artifact.js';
import type { IndexRecord } from '../types/index-record.js';
import type { ProvenanceEvent } from '../types/provenance-event.js';
import type {
    EvidenceBundle,
    ResolvedEvidence,
    FreshnessAssessment,
    MissingContext,
    ConfidenceBoundary,
} from '../types/evidence-bundle.js';
import { formatClusterUri } from '../uri/cluster-uri.js';

export interface RetrievalPlannerOptions {
    /** Maximum index records to consider */
    limit?: number;
}

/**
 * RetrievalPlanner — assembles an EvidenceBundle from a query.
 *
 * The planner:
 * 1. Queries the index for candidates
 * 2. Resolves each candidate to its owner store (canonical or artifact truth)
 * 3. Attaches provenance for each resolved object
 * 4. Classifies freshness and detects staleness
 * 5. Reports missing context and confidence boundaries
 *
 * The output is a structured EvidenceBundle, not a list of hits.
 */
export class RetrievalPlanner {
    constructor(private readonly stores: ClusterStores) {}

    async plan(query: string, options?: RetrievalPlannerOptions): Promise<EvidenceBundle> {
        const limit = options?.limit ?? 20;

        // 1. Query index for candidates
        const indexRecords = await this.stores.index.search({ text: query, limit });

        // 2. Resolve each candidate to owner store
        const resolvedEntities: ResolvedEvidence<Entity>[] = [];
        const resolvedArtifacts: ResolvedEvidence<Artifact>[] = [];
        const missingContext: MissingContext[] = [];
        const allProvenanceEvents: ProvenanceEvent[] = [];

        for (const record of indexRecords) {
            if (record.sourceStore === 'canonical') {
                const entity = await this.stores.canonical.get(record.sourceId);
                if (entity) {
                    // Attach provenance
                    const events = await this.getProvenanceForSubject(record.sourceId);
                    allProvenanceEvents.push(...events);

                    // Check staleness
                    const expectedText = `${entity.kind}: ${entity.name}`;
                    const indexStale = record.text !== expectedText;

                    resolvedEntities.push({
                        object: entity,
                        uri: formatClusterUri('canonical', entity.id),
                        ownerStore: 'canonical',
                        indexStale,
                        provenanceEventIds: events.map((e) => e.id),
                    });
                } else {
                    missingContext.push({
                        description: `Index record references entity ${record.sourceId} but it no longer exists in canonical store`,
                        store: 'canonical',
                        expectedId: record.sourceId,
                        impact: 'high',
                    });
                }
            } else if (record.sourceStore === 'artifact') {
                const artifact = await this.stores.artifact.get(record.sourceId);
                if (artifact) {
                    const events = await this.getProvenanceForSubject(record.sourceId);
                    allProvenanceEvents.push(...events);

                    resolvedArtifacts.push({
                        object: artifact,
                        uri: formatClusterUri('artifact', artifact.id),
                        ownerStore: 'artifact',
                        indexStale: false, // artifacts are immutable — index cannot be stale for content
                        provenanceEventIds: events.map((e) => e.id),
                    });
                } else {
                    missingContext.push({
                        description: `Index record references artifact ${record.sourceId} but it no longer exists in artifact store`,
                        store: 'artifact',
                        expectedId: record.sourceId,
                        impact: 'high',
                    });
                }
            }
        }

        // 3. Deduplicate provenance events
        const uniqueEvents = this.deduplicateEvents(allProvenanceEvents);

        // 4. Assess freshness
        const freshness = this.assessFreshness(resolvedEntities, resolvedArtifacts, uniqueEvents);

        // 5. Compute confidence boundaries
        const confidenceBoundaries = this.computeConfidence(
            indexRecords,
            resolvedEntities,
            resolvedArtifacts,
            missingContext,
        );

        return {
            id: randomUUID(),
            query,
            assembledAt: new Date().toISOString(),
            resolvedEntities,
            resolvedArtifacts,
            indexRecords,
            provenanceEvents: uniqueEvents,
            freshness,
            missingContext,
            confidenceBoundaries,
        };
    }

    private async getProvenanceForSubject(subjectId: string): Promise<ProvenanceEvent[]> {
        return this.stores.ledger.listEvents({ subjectId });
    }

    private deduplicateEvents(events: ProvenanceEvent[]): ProvenanceEvent[] {
        const seen = new Set<string>();
        const unique: ProvenanceEvent[] = [];
        for (const event of events) {
            if (!seen.has(event.id)) {
                seen.add(event.id);
                unique.push(event);
            }
        }
        return unique;
    }

    private assessFreshness(
        entities: ResolvedEvidence<Entity>[],
        artifacts: ResolvedEvidence<Artifact>[],
        events: ProvenanceEvent[],
    ): FreshnessAssessment {
        const staleCount =
            entities.filter((e) => e.indexStale).length +
            artifacts.filter((a) => a.indexStale).length;

        const allObjects = [
            ...entities.map((e) => e.object),
            ...artifacts.map((a) => a.object),
        ];

        const unprovenanced =
            entities.filter((e) => e.provenanceEventIds.length === 0).length +
            artifacts.filter((a) => a.provenanceEventIds.length === 0).length;

        // Collect timestamps
        const timestamps: string[] = [];
        for (const e of entities) {
            timestamps.push(e.object.createdAt);
            if (e.object.updatedAt) timestamps.push(e.object.updatedAt);
        }
        for (const a of artifacts) {
            timestamps.push(a.object.ingestedAt);
        }
        timestamps.sort();

        return {
            allFresh: staleCount === 0 && unprovenanced === 0,
            staleCount,
            unprovenanced,
            oldestTimestamp: timestamps[0] ?? null,
            newestTimestamp: timestamps[timestamps.length - 1] ?? null,
        };
    }

    private computeConfidence(
        indexRecords: IndexRecord[],
        entities: ResolvedEvidence<Entity>[],
        artifacts: ResolvedEvidence<Artifact>[],
        missing: MissingContext[],
    ): ConfidenceBoundary[] {
        const boundaries: ConfidenceBoundary[] = [];

        // How much of what the index found could actually be resolved?
        const resolvedCount = entities.length + artifacts.length;
        const totalCandidates = indexRecords.length;

        if (totalCandidates === 0) {
            boundaries.push({
                claim: 'No index records matched the query',
                reason: 'Index returned zero candidates',
                level: 'unverified',
            });
        } else if (resolvedCount === totalCandidates && missing.length === 0) {
            boundaries.push({
                claim: 'All index candidates resolved to owner truth',
                reason: 'Every index record pointed to an existing owner-store object',
                level: 'verified',
            });
        } else if (missing.length > 0) {
            boundaries.push({
                claim: 'Some index candidates could not be resolved',
                reason: `${missing.length} index record(s) reference objects that no longer exist`,
                level: 'partial',
            });
        }

        // Staleness boundary
        const staleEntities = entities.filter((e) => e.indexStale);
        if (staleEntities.length > 0) {
            boundaries.push({
                claim: 'Some resolved entities have stale index records',
                reason: `${staleEntities.length} entity index record(s) do not match current canonical state`,
                level: 'partial',
            });
        }

        // Provenance boundary
        const unprovenanced = [...entities, ...artifacts].filter(
            (e) => e.provenanceEventIds.length === 0,
        );
        if (unprovenanced.length > 0) {
            boundaries.push({
                claim: 'Some resolved objects have no provenance trail',
                reason: `${unprovenanced.length} object(s) could not be traced in the ledger`,
                level: 'unverified',
            });
        }

        return boundaries;
    }
}
