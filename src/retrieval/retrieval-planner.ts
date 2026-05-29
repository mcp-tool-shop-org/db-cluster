import { randomUUID, createHash } from 'node:crypto';
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
import { rankByBM25 } from '../indexing/bm25.js';
import { tokenize } from '../indexing/tokenizer.js';

const SNIPPET_RADIUS = 120;

export interface RetrievalPlannerOptions {
    /** Maximum resolved candidates to return, after ranking. */
    limit?: number;
    /**
     * Number of RANKED candidates to skip before applying `limit` (RETR-005).
     * Pagination happens AFTER ranking, so this offsets by relevance order, not
     * insertion order. Absent / 0 / negative ≡ no skip.
     */
    offset?: number;
}

/**
 * Extract a ~240-char window of `content` centered on the first query-term
 * match (RETR-004). Falls back to a leading excerpt when no query term occurs
 * in the raw content. Pure string work — no I/O; the caller has already passed
 * the bytes through the integrity-checked getContent path.
 */
function extractSnippet(content: string, query: string): string | undefined {
    const normalized = content.replace(/\s+/g, ' ').trim();
    if (!normalized) return undefined;
    const lower = normalized.toLowerCase();
    let pos = -1;
    for (const term of tokenize(query ?? '')) {
        const i = lower.indexOf(term);
        if (i !== -1 && (pos === -1 || i < pos)) pos = i;
    }
    if (pos === -1) {
        return normalized.length > SNIPPET_RADIUS * 2
            ? normalized.slice(0, SNIPPET_RADIUS * 2) + '…'
            : normalized;
    }
    const start = Math.max(0, pos - SNIPPET_RADIUS);
    const end = Math.min(normalized.length, pos + SNIPPET_RADIUS);
    let snippet = normalized.slice(start, end);
    if (start > 0) snippet = '…' + snippet;
    if (end < normalized.length) snippet = snippet + '…';
    return snippet;
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
    constructor(private readonly stores: ClusterStores) { }

    async plan(query: string, options?: RetrievalPlannerOptions): Promise<EvidenceBundle> {
        const limit = options?.limit ?? 20;
        const offset = Math.max(0, options?.offset ?? 0);

        // 1. Get candidates from search() — UNCHANGED candidate-match semantics
        //    (substring over text/metadata). We do NOT pass limit/offset here:
        //    those paginate the RANKED result below, not the candidate set, so
        //    ranking sees every matching candidate. This is the literal
        //    `search -> rank -> paginate` contract; recall is identical to
        //    pre-wave (no records gained or lost) — only the ORDER changes.
        const candidates = await this.stores.index.search({ text: query });

        // 2. Rank candidates by BM25 relevance (RETR-001). Candidates that match
        //    only via metadata (BM25 text score 0) are RETAINED, ranked last:
        //    ranking is an overlay on search()'s recall, never a filter on it.
        const ranked = rankByBM25(query, candidates);

        // 3. Paginate the RANKED list (RETR-005). indexRecords is this page.
        const page = ranked.slice(offset, offset + limit);
        const indexRecords: IndexRecord[] = page.map((r) => r.record);

        // 4. Resolve each candidate to owner store
        const resolvedEntities: ResolvedEvidence<Entity>[] = [];
        const resolvedArtifacts: ResolvedEvidence<Artifact>[] = [];
        const missingContext: MissingContext[] = [];
        const allProvenanceEvents: ProvenanceEvent[] = [];

        for (const { record, score } of page) {
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
                        score,
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
                    const snippet = await this.buildSnippet(artifact, query);

                    resolvedArtifacts.push({
                        object: artifact,
                        uri: formatClusterUri('artifact', artifact.id),
                        ownerStore: 'artifact',
                        indexStale: false, // artifacts are immutable — index cannot be stale for content
                        provenanceEventIds: events.map((e) => e.id),
                        score,
                        snippet,
                    });
                } else {
                    missingContext.push({
                        description: `Index record references artifact ${record.sourceId} but it no longer exists in artifact store`,
                        store: 'artifact',
                        expectedId: record.sourceId,
                        impact: 'high',
                    });
                }
            } else {
                // RETR-006: any sourceStore the planner does not resolve to owner
                // truth (today 'ledger'; tomorrow a new store) must surface as
                // MissingContext rather than silently vanishing from the bundle.
                missingContext.push({
                    description: `Index record references ${record.sourceStore} source ${record.sourceId}, which the retrieval planner does not resolve to owner truth`,
                    store: record.sourceStore,
                    expectedId: record.sourceId,
                    impact: 'medium',
                });
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

    /**
     * Build a short content snippet for an artifact (RETR-004).
     *
     * Reads bytes ONLY through the integrity-checked `getContent` (PROV-001):
     * the hardened adapter re-hashes on read and THROWS on mismatch. As defense
     * in depth (mirroring content-indexer.ts) we re-hash the returned bytes
     * against the recorded `contentHash` and refuse to snippet on mismatch.
     * Either failure → `undefined`: tampered or unreadable content is NEVER
     * surfaced as a snippet, and no raw artifact read bypasses the integrity
     * gate. Non-text artifacts also yield `undefined`.
     */
    private async buildSnippet(artifact: Artifact, query: string): Promise<string | undefined> {
        let buf: Buffer | null;
        try {
            buf = await this.stores.artifact.getContent(artifact.id);
        } catch {
            return undefined; // integrity throw (ContentReadIntegrityError) — never surface
        }
        if (!buf) return undefined;
        // Defense in depth: refuse content whose bytes don't hash to the record.
        const actualHash = createHash('sha256').update(buf).digest('hex');
        if (actualHash !== artifact.contentHash) return undefined;
        if (!this.isTextArtifact(artifact)) return undefined;
        return extractSnippet(buf.toString('utf-8'), query);
    }

    private isTextArtifact(artifact: Artifact): boolean {
        // Null-safe: some artifacts are ingested with an undefined mimeType
        // (e.g. command payloads carrying `mediaType` rather than `mimeType`),
        // so never assume these fields are present at runtime.
        const mime = artifact.mimeType ?? '';
        const name = artifact.filename ?? '';
        return mime.startsWith('text/') || name.endsWith('.md') || name.endsWith('.txt');
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
