/**
 * Parallel ingest adapter — imports repo-knowledge memory into db-cluster
 * without modifying the source files.
 *
 * This adapter:
 * - Reads repo-knowledge memory files (markdown, JSON)
 * - Creates artifacts for each source file
 * - Creates canonical entities for repos, projects, facts, decisions
 * - Links entities to source artifacts
 * - Records provenance for the sync run
 * - Emits receipts for every operation
 * - Never writes back to repo-knowledge
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import type { ClusterKernel } from '../../kernel/cluster-kernel.js';
import { mapToEntityKind, mapToArtifactKind, type RepoKnowledgeEntityKind } from './mapping.js';

export interface IngestSource {
    /** Absolute path to the file */
    path: string;
    /** Override entity kind (otherwise inferred from filename) */
    entityKind?: RepoKnowledgeEntityKind;
    /** Additional attributes to attach to the entity */
    attributes?: Record<string, unknown>;
}

export interface IngestOptions {
    /** Repo name for the top-level repo entity */
    repoName: string;
    /** Project name if this is project-specific memory */
    projectName?: string;
    /** Actor performing the ingest */
    actorId: string;
    /** Optional tags to attach */
    tags?: string[];
}

export interface IngestResult {
    /** IDs of created artifacts */
    artifactIds: string[];
    /** IDs of created entities */
    entityIds: string[];
    /** ID of the repo entity */
    repoEntityId: string;
    /** ID of the project entity (if projectName provided) */
    projectEntityId?: string;
    /** Number of provenance links created */
    provenanceLinks: number;
    /** Number of receipts emitted */
    receipts: number;
    /** Files that were skipped */
    skipped: string[];
    /** Sync run timestamp */
    syncedAt: string;
}

/**
 * Ingest repo-knowledge memory files into db-cluster.
 * Creates a parallel truth substrate without modifying source files.
 */
export async function ingestRepoKnowledge(
    kernel: ClusterKernel,
    sources: IngestSource[],
    options: IngestOptions,
): Promise<IngestResult> {
    const result: IngestResult = {
        artifactIds: [],
        entityIds: [],
        repoEntityId: '',
        provenanceLinks: 0,
        receipts: 0,
        skipped: [],
        syncedAt: new Date().toISOString(),
    };

    // 1. Create repo entity
    const { entity: repoEntity } = await kernel.createEntity({
        kind: 'repo',
        name: options.repoName,
        attributes: {
            tags: options.tags ?? [],
            syncedAt: result.syncedAt,
        },
        actorId: options.actorId,
    });
    result.repoEntityId = repoEntity.id;
    result.entityIds.push(repoEntity.id);
    result.receipts++;

    // 2. Create project entity if specified
    if (options.projectName) {
        const { entity: projectEntity } = await kernel.createEntity({
            kind: 'project',
            name: options.projectName,
            attributes: {
                repo: options.repoName,
                tags: options.tags ?? [],
            },
            actorId: options.actorId,
        });
        result.projectEntityId = projectEntity.id;
        result.entityIds.push(projectEntity.id);
        result.receipts++;
    }

    // 3. Ingest each source file
    for (const source of sources) {
        if (!existsSync(source.path)) {
            result.skipped.push(source.path);
            continue;
        }

        const stat = statSync(source.path);
        if (!stat.isFile()) {
            result.skipped.push(source.path);
            continue;
        }

        const filename = basename(source.path);
        const content = readFileSync(source.path);

        // Ingest as artifact
        const { artifact } = await kernel.ingestArtifact({
            filename,
            content,
            mimeType: getMimeType(filename),
            actorId: options.actorId,
        });
        result.artifactIds.push(artifact.id);
        result.receipts++;

        // Create entity for this source
        const entityKind = source.entityKind ?? inferEntityKind(filename, content.toString('utf-8'));
        if (entityKind) {
            const { entity } = await kernel.createEntity({
                kind: entityKind,
                name: filename.replace(extname(filename), ''),
                attributes: {
                    sourceFile: filename,
                    artifactKind: mapToArtifactKind(filename),
                    ...(source.attributes ?? {}),
                },
                actorId: options.actorId,
            });
            result.entityIds.push(entity.id);
            result.receipts++;

            // Link entity to artifact
            await kernel.linkEvidence({
                artifactId: artifact.id,
                entityId: entity.id,
                actorId: options.actorId,
            });
            result.provenanceLinks++;
            result.receipts++;

            // Link to repo entity
            await kernel.linkEvidence({
                artifactId: artifact.id,
                entityId: repoEntity.id,
                actorId: options.actorId,
            });
            result.provenanceLinks++;
            result.receipts++;
        }
    }

    return result;
}

/**
 * Extract facts from markdown content and create fact entities.
 */
export async function extractFacts(
    kernel: ClusterKernel,
    artifactId: string,
    content: string,
    options: { actorId: string; repoEntityId: string },
): Promise<string[]> {
    const factIds: string[] = [];

    // Extract headings as potential fact markers
    const lines = content.split('\n');
    for (const line of lines) {
        const headingMatch = line.match(/^#{1,3}\s+(.+)/);
        if (headingMatch) {
            const factName = headingMatch[1].trim();
            if (factName.length > 3 && factName.length < 200) {
                const { entity } = await kernel.createEntity({
                    kind: 'fact',
                    name: factName,
                    attributes: {
                        sourceArtifact: artifactId,
                        extractedFrom: 'heading',
                    },
                    actorId: options.actorId,
                });
                factIds.push(entity.id);

                // Link fact to source artifact
                await kernel.linkEvidence({
                    artifactId,
                    entityId: entity.id,
                    actorId: options.actorId,
                });
            }
        }
    }

    return factIds;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function getMimeType(filename: string): string {
    const ext = extname(filename).toLowerCase();
    switch (ext) {
        case '.md': return 'text/markdown';
        case '.json': return 'application/json';
        case '.ts': return 'text/typescript';
        case '.js': return 'text/javascript';
        case '.txt': return 'text/plain';
        case '.yaml':
        case '.yml': return 'text/yaml';
        default: return 'application/octet-stream';
    }
}

function inferEntityKind(filename: string, content: string): RepoKnowledgeEntityKind | undefined {
    const lower = filename.toLowerCase();
    if (lower.includes('readme')) return 'source';
    if (lower.includes('changelog')) return 'source';
    if (lower.includes('closeout')) return 'phase';
    if (lower.includes('finding')) return 'finding';
    if (lower.includes('decision')) return 'decision';
    if (lower.includes('phase')) return 'phase';

    // Check content for clues
    if (content.includes('## Status') || content.includes('## Phase')) return 'project';
    if (content.includes('## Finding') || content.includes('## Observation')) return 'finding';
    if (content.includes('## Decision') || content.includes('## Verdict')) return 'decision';

    return 'fact';
}
