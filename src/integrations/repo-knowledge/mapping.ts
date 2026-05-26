/**
 * Repo-knowledge → db-cluster mapping.
 *
 * Maps repo-knowledge concepts into cluster truth stores without
 * flattening their meaning or changing repo-knowledge schema.
 */

// ─── Entity kinds (canonical store) ─────────────────────────────────────────

export const ENTITY_KINDS = [
    'repo',
    'project',
    'fact',
    'decision',
    'finding',
    'task',
    'phase',
    'milestone',
    'source',
    'sync_run',
] as const;

export type RepoKnowledgeEntityKind = (typeof ENTITY_KINDS)[number];

// ─── Artifact kinds (artifact store) ────────────────────────────────────────

export const ARTIFACT_KINDS = [
    'memory_doc',
    'readme',
    'changelog',
    'source_file',
    'run_log',
    'closeout_doc',
    'repo_note',
] as const;

export type RepoKnowledgeArtifactKind = (typeof ARTIFACT_KINDS)[number];

// ─── Provenance edge types (ledger store) ───────────────────────────────────

export const PROVENANCE_EDGES = [
    'fact_extracted_from',
    'decision_supported_by',
    'repo_described_by',
    'sync_created',
    'fact_updated_by',
    'finding_observed_in',
    'memory_backed_by',
] as const;

export type RepoKnowledgeProvenanceEdge = (typeof PROVENANCE_EDGES)[number];

// ─── Concept mapping table ──────────────────────────────────────────────────

export interface ConceptMapping {
    repoKnowledgeConcept: string;
    dbClusterStore: 'canonical' | 'artifact' | 'index' | 'ledger';
    dbClusterType: string;
    notes: string;
}

export const CONCEPT_MAPPINGS: ConceptMapping[] = [
    { repoKnowledgeConcept: 'repo', dbClusterStore: 'canonical', dbClusterType: 'entity(repo)', notes: 'Top-level repo identity' },
    { repoKnowledgeConcept: 'project', dbClusterStore: 'canonical', dbClusterType: 'entity(project)', notes: 'Project within repo' },
    { repoKnowledgeConcept: 'fact', dbClusterStore: 'canonical', dbClusterType: 'entity(fact)', notes: 'Extracted or stated knowledge' },
    { repoKnowledgeConcept: 'decision note', dbClusterStore: 'canonical', dbClusterType: 'entity(decision)', notes: 'Recorded design/product decision' },
    { repoKnowledgeConcept: 'source file/doc', dbClusterStore: 'artifact', dbClusterType: 'artifact', notes: 'Raw file ingested as evidence' },
    { repoKnowledgeConcept: 'sync run', dbClusterStore: 'ledger', dbClusterType: 'provenance_event', notes: 'When knowledge was synced' },
    { repoKnowledgeConcept: 'fact extraction', dbClusterStore: 'ledger', dbClusterType: 'provenance_event', notes: 'Edge: fact_extracted_from artifact' },
    { repoKnowledgeConcept: 'tags/topics', dbClusterStore: 'canonical', dbClusterType: 'entity.attributes + index', notes: 'Stored as attributes, projected into index' },
    { repoKnowledgeConcept: 'stale fact', dbClusterStore: 'index', dbClusterType: 'stale_warning', notes: 'Freshness check against source' },
    { repoKnowledgeConcept: 'memory file', dbClusterStore: 'artifact', dbClusterType: 'artifact(memory_doc)', notes: 'Ingested as source artifact' },
];

// ─── Mapping helpers ────────────────────────────────────────────────────────

/**
 * Determine which entity kind a repo-knowledge concept should become.
 * Returns undefined if the concept doesn't map to a canonical entity.
 */
export function mapToEntityKind(concept: string): RepoKnowledgeEntityKind | undefined {
    const normalized = concept.toLowerCase().replace(/[^a-z_]/g, '_');
    if (ENTITY_KINDS.includes(normalized as RepoKnowledgeEntityKind)) {
        return normalized as RepoKnowledgeEntityKind;
    }
    // Fuzzy matches
    if (normalized.includes('repo')) return 'repo';
    if (normalized.includes('project')) return 'project';
    if (normalized.includes('fact') || normalized.includes('knowledge')) return 'fact';
    if (normalized.includes('decision')) return 'decision';
    if (normalized.includes('finding')) return 'finding';
    if (normalized.includes('task')) return 'task';
    if (normalized.includes('phase')) return 'phase';
    if (normalized.includes('milestone')) return 'milestone';
    if (normalized.includes('source') || normalized.includes('file')) return 'source';
    if (normalized.includes('sync') || normalized.includes('run')) return 'sync_run';
    return undefined;
}

/**
 * Determine artifact kind from filename/path.
 */
export function mapToArtifactKind(filename: string): RepoKnowledgeArtifactKind {
    const lower = filename.toLowerCase();
    if (lower.includes('readme')) return 'readme';
    if (lower.includes('changelog')) return 'changelog';
    if (lower.includes('closeout')) return 'closeout_doc';
    if (lower.endsWith('.log') || lower.includes('run-log')) return 'run_log';
    if (lower.includes('repo') && lower.includes('note')) return 'repo_note';
    if (lower.endsWith('.md') && (lower.includes('memory') || lower.includes('note'))) return 'memory_doc';
    if (lower.includes('note')) return 'repo_note';
    return 'source_file';
}

/**
 * Determine the provenance edge type for a relationship between entities/artifacts.
 */
export function mapProvenanceEdge(
    sourceKind: string,
    targetKind: string,
    relationship: string,
): RepoKnowledgeProvenanceEdge {
    const rel = relationship.toLowerCase();

    if (rel.includes('extract') || rel.includes('parsed_from')) return 'fact_extracted_from';
    if (rel.includes('support') || rel.includes('evidence')) return 'decision_supported_by';
    if (rel.includes('describe') || rel.includes('documents')) return 'repo_described_by';
    if (rel.includes('sync') || rel.includes('created_by_sync')) return 'sync_created';
    if (rel.includes('update') || rel.includes('modified_by')) return 'fact_updated_by';
    if (rel.includes('observ') || rel.includes('found_in')) return 'finding_observed_in';
    if (rel.includes('back') || rel.includes('source')) return 'memory_backed_by';

    // Default heuristics from kinds
    if (sourceKind === 'fact' && targetKind === 'artifact') return 'fact_extracted_from';
    if (sourceKind === 'decision' && targetKind === 'artifact') return 'decision_supported_by';
    if (sourceKind === 'repo' && targetKind === 'artifact') return 'repo_described_by';
    if (sourceKind === 'finding') return 'finding_observed_in';

    return 'memory_backed_by';
}
