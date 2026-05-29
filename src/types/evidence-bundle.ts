/**
 * EvidenceBundle — the structured output of a cluster retrieval operation.
 *
 * Not a list of search hits. A retrieval result that carries:
 * - what truth was resolved
 * - where it lives (owner store)
 * - what provenance supports it
 * - what is stale or missing
 * - what confidence boundaries apply
 */

import type { Entity } from './entity.js';
import type { Artifact } from './artifact.js';
import type { IndexRecord } from './index-record.js';
import type { ProvenanceEvent } from './provenance-event.js';

export interface EvidenceBundle {
    /** Unique bundle ID */
    id: string;
    /** The original query that produced this bundle */
    query: string;
    /** When the bundle was assembled */
    assembledAt: string;

    /** Entities resolved from owner stores (canonical truth) */
    resolvedEntities: ResolvedEvidence<Entity>[];
    /** Artifacts resolved from owner stores (artifact truth) */
    resolvedArtifacts: ResolvedEvidence<Artifact>[];
    /** Index records that matched (derivative — not truth) */
    indexRecords: IndexRecord[];
    /** Provenance events supporting the resolved objects */
    provenanceEvents: ProvenanceEvent[];

    /** Freshness assessment */
    freshness: FreshnessAssessment;
    /** What the cluster could not find or verify */
    missingContext: MissingContext[];
    /** Confidence boundaries — what the bundle can and cannot claim */
    confidenceBoundaries: ConfidenceBoundary[];
}

/**
 * A resolved evidence item — the object plus its resolution metadata.
 */
export interface ResolvedEvidence<T> {
    /** The resolved owner-store object */
    object: T;
    /** The cluster URI for this object */
    uri: string;
    /** Owner store name */
    ownerStore: string;
    /** Whether this object's index record is stale */
    indexStale: boolean;
    /** Provenance event IDs that touch this object */
    provenanceEventIds: string[];
    /**
     * BM25 relevance score for this object against the query (RETR-001/004).
     * Higher = more relevant; always ≥ 0. `resolvedEntities` and
     * `resolvedArtifacts` are each ordered by this score, descending.
     */
    score: number;
    /**
     * Short content excerpt around the first query-term match (RETR-004).
     * Populated ONLY for artifacts and ONLY via the integrity-checked
     * `getContent` path (PROV-001): content that fails the hash check is never
     * surfaced. `undefined` for entities, non-text artifacts, and any content
     * that fails the integrity gate.
     */
    snippet?: string;
}

/**
 * Freshness assessment for the bundle as a whole.
 */
export interface FreshnessAssessment {
    /** Are all resolved objects backed by fresh index records? */
    allFresh: boolean;
    /** Count of stale index records in this bundle */
    staleCount: number;
    /** Count of objects with no provenance trail */
    unprovenanced: number;
    /** Oldest resolved object timestamp */
    oldestTimestamp: string | null;
    /** Newest resolved object timestamp */
    newestTimestamp: string | null;
}

/**
 * Something the cluster could not find or verify during retrieval.
 */
export interface MissingContext {
    /** What was expected but not found */
    description: string;
    /** Where the gap was detected */
    store: string;
    /** The ID that was expected (if known) */
    expectedId?: string;
    /** Why it matters */
    impact: 'low' | 'medium' | 'high';
}

/**
 * A confidence boundary — what the bundle can and cannot claim.
 */
export interface ConfidenceBoundary {
    /** What this boundary constrains */
    claim: string;
    /** Why this boundary exists */
    reason: string;
    /** The constraint level */
    level: 'verified' | 'partial' | 'unverified';
}
