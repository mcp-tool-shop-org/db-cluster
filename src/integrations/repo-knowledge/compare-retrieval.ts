/**
 * Retrieval comparison — compares repo-knowledge search results against
 * db-cluster evidence bundles.
 *
 * This does not require db-cluster to "answer better" in prose.
 * It requires better evidence structure: provenance, ownership, freshness.
 */

import type { ClusterKernel } from '../../kernel/cluster-kernel.js';
import type { EvidenceBundle } from '../../types/evidence-bundle.js';

export interface ComparisonQuery {
    /** Natural language query */
    query: string;
    /** Optional expected answer for scoring */
    expectedAnswer?: string;
}

export interface RepoKnowledgeResult {
    /** Search hits from repo-knowledge (text matches) */
    hits: string[];
    /** Whether a direct answer was found */
    answered: boolean;
}

export interface ComparisonResult {
    query: string;
    /** db-cluster evidence bundle */
    bundle: EvidenceBundle;
    /** Whether the bundle resolves to owner truth */
    resolvesToOwnerTruth: boolean;
    /** Whether provenance backing exists */
    hasProvenanceBacking: boolean;
    /** Whether freshness is visible */
    freshnessVisible: boolean;
    /** Whether missing context is surfaced */
    missingContextSurfaced: boolean;
    /** Number of supporting artifacts */
    supportingArtifacts: number;
    /** Number of provenance events in trace */
    provenanceEvents: number;
    /** Confidence boundaries from bundle */
    confidenceBoundaries: string[];
}

export interface ComparisonReport {
    queries: ComparisonResult[];
    summary: {
        totalQueries: number;
        resolvedToOwnerTruth: number;
        hadProvenanceBacking: number;
        hadFreshnessVisibility: number;
        surfacedMissingContext: number;
        averageSupportingArtifacts: number;
        averageProvenanceEvents: number;
    };
}

/**
 * Run a retrieval comparison for a single query.
 */
export async function compareRetrieval(
    kernel: ClusterKernel,
    query: ComparisonQuery,
): Promise<ComparisonResult> {
    // Get db-cluster evidence bundle
    const bundle = await kernel.retrieveBundle(query.query);

    // Trace provenance for resolved entities
    let provenanceEvents = 0;
    for (const resolved of bundle.resolvedEntities) {
        const events = await kernel.traceProvenance(resolved.object.id);
        provenanceEvents += events.length;
    }

    // Analyze bundle quality
    const resolvesToOwnerTruth = bundle.resolvedEntities.length > 0 &&
        bundle.resolvedEntities.every((r) => r.object.owner === 'canonical');

    const hasProvenanceBacking = provenanceEvents > 0;

    const freshnessVisible = bundle.resolvedEntities.every(
        (r) => 'indexStale' in r,
    );

    const missingContextSurfaced = bundle.resolvedEntities.length === 0 ||
        bundle.confidenceBoundaries.length > 0;

    const supportingArtifacts = bundle.resolvedArtifacts?.length ?? 0;

    const confidenceBoundaries = bundle.confidenceBoundaries.map(
        (b) => `${b.level}: ${b.claim}`,
    );

    return {
        query: query.query,
        bundle,
        resolvesToOwnerTruth,
        hasProvenanceBacking,
        freshnessVisible,
        missingContextSurfaced,
        supportingArtifacts,
        provenanceEvents,
        confidenceBoundaries,
    };
}

/**
 * Run a full comparison report across multiple queries.
 */
export async function generateComparisonReport(
    kernel: ClusterKernel,
    queries: ComparisonQuery[],
): Promise<ComparisonReport> {
    const results: ComparisonResult[] = [];

    for (const query of queries) {
        const result = await compareRetrieval(kernel, query);
        results.push(result);
    }

    const totalQueries = results.length;
    const resolvedToOwnerTruth = results.filter((r) => r.resolvesToOwnerTruth).length;
    const hadProvenanceBacking = results.filter((r) => r.hasProvenanceBacking).length;
    const hadFreshnessVisibility = results.filter((r) => r.freshnessVisible).length;
    const surfacedMissingContext = results.filter((r) => r.missingContextSurfaced).length;
    const averageSupportingArtifacts = totalQueries > 0
        ? results.reduce((sum, r) => sum + r.supportingArtifacts, 0) / totalQueries
        : 0;
    const averageProvenanceEvents = totalQueries > 0
        ? results.reduce((sum, r) => sum + r.provenanceEvents, 0) / totalQueries
        : 0;

    return {
        queries: results,
        summary: {
            totalQueries,
            resolvedToOwnerTruth,
            hadProvenanceBacking,
            hadFreshnessVisibility,
            surfacedMissingContext,
            averageSupportingArtifacts,
            averageProvenanceEvents,
        },
    };
}
