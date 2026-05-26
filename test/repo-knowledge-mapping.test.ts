import { describe, it, expect } from 'vitest';
import {
    ENTITY_KINDS,
    ARTIFACT_KINDS,
    PROVENANCE_EDGES,
    CONCEPT_MAPPINGS,
    mapToEntityKind,
    mapToArtifactKind,
    mapProvenanceEdge,
} from '../src/integrations/repo-knowledge/mapping.js';

describe('Repo-knowledge source mapping', () => {
    describe('entity kinds', () => {
        it('has all required entity kinds', () => {
            const required = ['repo', 'project', 'fact', 'decision', 'finding', 'task', 'phase', 'milestone', 'source', 'sync_run'];
            for (const kind of required) {
                expect(ENTITY_KINDS).toContain(kind);
            }
        });

        it('mapToEntityKind resolves known concepts', () => {
            expect(mapToEntityKind('repo')).toBe('repo');
            expect(mapToEntityKind('project')).toBe('project');
            expect(mapToEntityKind('fact')).toBe('fact');
            expect(mapToEntityKind('decision')).toBe('decision');
            expect(mapToEntityKind('finding')).toBe('finding');
            expect(mapToEntityKind('task')).toBe('task');
            expect(mapToEntityKind('phase')).toBe('phase');
            expect(mapToEntityKind('milestone')).toBe('milestone');
            expect(mapToEntityKind('sync_run')).toBe('sync_run');
        });

        it('mapToEntityKind handles fuzzy matches', () => {
            expect(mapToEntityKind('repository')).toBe('repo');
            expect(mapToEntityKind('project-memory')).toBe('project');
            expect(mapToEntityKind('known-fact')).toBe('fact');
            expect(mapToEntityKind('design decision')).toBe('decision');
            expect(mapToEntityKind('dogfood finding')).toBe('finding');
            expect(mapToEntityKind('sync run record')).toBe('sync_run');
        });

        it('mapToEntityKind returns undefined for unmapped concepts', () => {
            expect(mapToEntityKind('banana')).toBeUndefined();
            expect(mapToEntityKind('')).toBeUndefined();
        });
    });

    describe('artifact kinds', () => {
        it('has all required artifact kinds', () => {
            const required = ['memory_doc', 'readme', 'changelog', 'source_file', 'run_log', 'closeout_doc', 'repo_note'];
            for (const kind of required) {
                expect(ARTIFACT_KINDS).toContain(kind);
            }
        });

        it('mapToArtifactKind classifies files correctly', () => {
            expect(mapToArtifactKind('README.md')).toBe('readme');
            expect(mapToArtifactKind('CHANGELOG.md')).toBe('changelog');
            expect(mapToArtifactKind('docs/phase-12-closeout.md')).toBe('closeout_doc');
            expect(mapToArtifactKind('memory/project-notes.md')).toBe('memory_doc');
            expect(mapToArtifactKind('sync-run-log.log')).toBe('run_log');
            expect(mapToArtifactKind('notes/repo-note.md')).toBe('repo_note');
            expect(mapToArtifactKind('src/kernel/cluster-kernel.ts')).toBe('source_file');
        });
    });

    describe('provenance edges', () => {
        it('has all required provenance edge types', () => {
            const required = [
                'fact_extracted_from',
                'decision_supported_by',
                'repo_described_by',
                'sync_created',
                'fact_updated_by',
                'finding_observed_in',
                'memory_backed_by',
            ];
            for (const edge of required) {
                expect(PROVENANCE_EDGES).toContain(edge);
            }
        });

        it('mapProvenanceEdge selects correct edge from relationship', () => {
            expect(mapProvenanceEdge('fact', 'artifact', 'extracted from')).toBe('fact_extracted_from');
            expect(mapProvenanceEdge('decision', 'artifact', 'supported by evidence')).toBe('decision_supported_by');
            expect(mapProvenanceEdge('repo', 'artifact', 'described by readme')).toBe('repo_described_by');
            expect(mapProvenanceEdge('entity', 'entity', 'created_by_sync')).toBe('sync_created');
            expect(mapProvenanceEdge('fact', 'artifact', 'updated by new source')).toBe('fact_updated_by');
            expect(mapProvenanceEdge('finding', 'artifact', 'observed in dogfood')).toBe('finding_observed_in');
            expect(mapProvenanceEdge('entity', 'artifact', 'backed by memory')).toBe('memory_backed_by');
        });

        it('mapProvenanceEdge uses kind-based heuristics as fallback', () => {
            expect(mapProvenanceEdge('fact', 'artifact', 'unknown')).toBe('fact_extracted_from');
            expect(mapProvenanceEdge('decision', 'artifact', 'unknown')).toBe('decision_supported_by');
            expect(mapProvenanceEdge('repo', 'artifact', 'unknown')).toBe('repo_described_by');
            expect(mapProvenanceEdge('finding', 'artifact', 'unknown')).toBe('finding_observed_in');
        });
    });

    describe('concept mapping table', () => {
        it('has mappings for all core repo-knowledge concepts', () => {
            const concepts = CONCEPT_MAPPINGS.map((m) => m.repoKnowledgeConcept);
            expect(concepts).toContain('repo');
            expect(concepts).toContain('project');
            expect(concepts).toContain('fact');
            expect(concepts).toContain('source file/doc');
            expect(concepts).toContain('sync run');
            expect(concepts).toContain('memory file');
        });

        it('every mapping has valid store assignment', () => {
            const validStores = ['canonical', 'artifact', 'index', 'ledger'];
            for (const mapping of CONCEPT_MAPPINGS) {
                expect(validStores).toContain(mapping.dbClusterStore);
            }
        });

        it('preserves repo/project/fact/source distinctions', () => {
            const repoMapping = CONCEPT_MAPPINGS.find((m) => m.repoKnowledgeConcept === 'repo');
            const factMapping = CONCEPT_MAPPINGS.find((m) => m.repoKnowledgeConcept === 'fact');
            const sourceMapping = CONCEPT_MAPPINGS.find((m) => m.repoKnowledgeConcept === 'source file/doc');

            // Repos and facts are entities in canonical store
            expect(repoMapping!.dbClusterStore).toBe('canonical');
            expect(factMapping!.dbClusterStore).toBe('canonical');

            // Source files are artifacts — different truth shape
            expect(sourceMapping!.dbClusterStore).toBe('artifact');

            // They don't collapse into the same type
            expect(repoMapping!.dbClusterType).not.toBe(sourceMapping!.dbClusterType);
        });
    });
});
