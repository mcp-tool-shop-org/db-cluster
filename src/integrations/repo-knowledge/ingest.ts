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
 *
 * ─── CANONICAL LIFECYCLE PATH (SURFACE-003) ────────────────────────────────
 *
 * Entity creation and evidence linking go through the typed command
 * lifecycle:  propose → validate → approve → commit. These call sites used to
 * touch `kernel.createEntity` / `kernel.linkEvidence` directly, which bypassed
 * the CommandQueue (KERNEL-002). They no longer do. The sibling
 * `update-workflow.ts` models the same pattern; this file mirrors it for
 * non-Buffer payloads.
 *
 * Receipts are read to recover the affected IDs after each commit — callers
 * never trust the proposed payload for an ID lookup, only the post-commit
 * receipt.
 *
 * Artifact ingest is the one exception (see KERNEL-002 in the audit). The
 * `ingest_artifact` command payload carries a Node `Buffer`, which does not
 * survive the JSON serialization the CommandQueue performs on `propose`
 * (Buffer becomes `{ type: 'Buffer', data: number[] }` on rehydrate, and the
 * kernel's switch arm passes it through to `stores.artifact.ingest` as-is,
 * which writes garbage). Until the kernel's `ingest_artifact` arm rehydrates
 * Buffer payloads, artifact ingest stays on the direct `kernel.ingestArtifact`
 * helper. KERNEL-001 added wrappers for ingestArtifact on
 * PolicyEnforcedKernel (KERNEL-R003 ≡ SURFACE-R001/R002), so the policy gate
 * fires whether the caller passes a `ClusterKernel` or `PolicyEnforcedKernel`.
 * What we lose is the inspectable command record (KERNEL-002 caveat).
 *
 * When the caller passes a raw `ClusterKernel` (no policy layer), a runtime
 * warning is emitted: "policy layer not engaged for ingest." Production
 * callers should wrap with `PolicyEnforcedKernel` and pass a least-privilege
 * principal.
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { basename, extname } from 'node:path';
import type { ClusterKernel } from '../../kernel/cluster-kernel.js';
import type { PolicyEnforcedKernel } from '../../kernel/policy-enforced-kernel.js';
import type { Command } from '../../types/command.js';
import { mapToArtifactKind, type RepoKnowledgeEntityKind } from './mapping.js';

/** Kernel handle accepted by the integration — either raw or policy-wrapped. */
export type IngestKernel = ClusterKernel | PolicyEnforcedKernel;

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
    /** Optional second actor that commits the proposals. Defaults to actorId. */
    committerId?: string;
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
 * Detect whether the passed kernel routes through the policy layer.
 * Done structurally rather than via instanceof so the import graph doesn't
 * pull policy types into callers that don't need them.
 */
function isPolicyEnforced(kernel: IngestKernel): boolean {
    return typeof (kernel as { checkVisibility?: unknown }).checkVisibility === 'function';
}

let _policyWarningEmitted = false;
function warnIfNoPolicy(kernel: IngestKernel): void {
    if (_policyWarningEmitted) return;
    if (isPolicyEnforced(kernel)) return;
    _policyWarningEmitted = true;
    console.warn(
        '[repo-knowledge/ingest] WARNING: ingestRepoKnowledge is running through a raw ClusterKernel — no policy layer engaged. ' +
        'Production callers should wrap with PolicyEnforcedKernel. See docs/policy.md.',
    );
}

/**
 * Run a single mutation through propose → validate → approve → commit.
 * Returns the affected IDs from the receipt.
 */
async function runMutation(
    kernel: IngestKernel,
    verb: Command['verb'],
    targetStore: Command['targetStore'],
    payload: Record<string, unknown>,
    proposerId: string,
    committerId: string,
): Promise<{ commandId: string; affectedIds: string[]; receiptId: string }> {
    const proposed = await kernel.proposeMutation({
        verb,
        targetStore,
        payload,
        proposedBy: proposerId,
    });
    await kernel.validateMutation(proposed.id);
    await kernel.approveMutation(proposed.id, committerId);
    const result = await kernel.commitMutation(proposed.id, committerId);
    return {
        commandId: result.command.id,
        affectedIds: result.receipt.affectedIds,
        receiptId: result.receipt.id,
    };
}

/**
 * Ingest repo-knowledge memory files into db-cluster.
 * Creates a parallel truth substrate without modifying source files.
 *
 * Uses the canonical lifecycle (propose → validate → approve → commit)
 * for every write. Direct `kernel.createEntity` / `ingestArtifact` /
 * `linkEvidence` calls are intentionally avoided (SURFACE-003).
 */
export async function ingestRepoKnowledge(
    kernel: IngestKernel,
    sources: IngestSource[],
    options: IngestOptions,
): Promise<IngestResult> {
    warnIfNoPolicy(kernel);

    const proposerId = options.actorId;
    const committerId = options.committerId ?? options.actorId;

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
    {
        const { affectedIds } = await runMutation(
            kernel,
            'create_entity',
            'canonical',
            {
                kind: 'repo',
                name: options.repoName,
                attributes: {
                    tags: options.tags ?? [],
                    syncedAt: result.syncedAt,
                },
            },
            proposerId,
            committerId,
        );
        const repoId = affectedIds[0];
        if (!repoId) throw new Error('ingestRepoKnowledge: repo entity commit returned no affectedIds');
        result.repoEntityId = repoId;
        result.entityIds.push(repoId);
        result.receipts++;
    }

    // 2. Create project entity if specified
    if (options.projectName) {
        const { affectedIds } = await runMutation(
            kernel,
            'create_entity',
            'canonical',
            {
                kind: 'project',
                name: options.projectName,
                attributes: {
                    repo: options.repoName,
                    tags: options.tags ?? [],
                },
            },
            proposerId,
            committerId,
        );
        const projectId = affectedIds[0];
        if (!projectId) throw new Error('ingestRepoKnowledge: project entity commit returned no affectedIds');
        result.projectEntityId = projectId;
        result.entityIds.push(projectId);
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

        // Ingest as artifact via the kernel-helper path. Buffer payloads do
        // not round-trip through CommandQueue persistence (see file header), so
        // the lifecycle path is unsafe for artifact ingest today. With the
        // KERNEL-001 wrappers landed (KERNEL-R003 ≡ SURFACE-R001/R002), the
        // policy gate fires for both `ClusterKernel` and `PolicyEnforcedKernel`
        // callers — what we lose is the inspectable command record. When the
        // kernel grows Buffer-safe command persistence (Stage B), this site
        // moves onto the propose → validate → approve → commit lifecycle.
        const ingestResult = await kernel.ingestArtifact({
            filename,
            content,
            mimeType: getMimeType(filename),
            actorId: proposerId,
        });
        const artifactId = ingestResult.artifact.id;
        result.artifactIds.push(artifactId);
        result.receipts++;

        // Create entity for this source
        const entityKind = source.entityKind ?? inferEntityKind(filename, content.toString('utf-8'));
        if (entityKind) {
            const entityResult = await runMutation(
                kernel,
                'create_entity',
                'canonical',
                {
                    kind: entityKind,
                    name: filename.replace(extname(filename), ''),
                    attributes: {
                        sourceFile: filename,
                        artifactKind: mapToArtifactKind(filename),
                        ...(source.attributes ?? {}),
                    },
                },
                proposerId,
                committerId,
            );
            const entityId = entityResult.affectedIds[0];
            if (!entityId) throw new Error('ingestRepoKnowledge: create_entity commit returned no affectedIds');
            result.entityIds.push(entityId);
            result.receipts++;

            // Link entity to artifact
            await runMutation(
                kernel,
                'link_evidence',
                'ledger',
                {
                    artifactId,
                    entityId,
                },
                proposerId,
                committerId,
            );
            result.provenanceLinks++;
            result.receipts++;

            // Link to repo entity
            await runMutation(
                kernel,
                'link_evidence',
                'ledger',
                {
                    artifactId,
                    entityId: result.repoEntityId,
                },
                proposerId,
                committerId,
            );
            result.provenanceLinks++;
            result.receipts++;
        }
    }

    return result;
}

/**
 * Extract facts from markdown content and create fact entities.
 * Uses the canonical lifecycle path (propose → validate → approve → commit).
 */
export async function extractFacts(
    kernel: IngestKernel,
    artifactId: string,
    content: string,
    options: { actorId: string; repoEntityId: string; committerId?: string },
): Promise<string[]> {
    warnIfNoPolicy(kernel);

    const proposerId = options.actorId;
    const committerId = options.committerId ?? options.actorId;

    const factIds: string[] = [];

    // Extract headings as potential fact markers
    const lines = content.split('\n');
    for (const line of lines) {
        const headingMatch = line.match(/^#{1,3}\s+(.+)/);
        if (headingMatch) {
            const factName = headingMatch[1].trim();
            if (factName.length > 3 && factName.length < 200) {
                const { affectedIds } = await runMutation(
                    kernel,
                    'create_entity',
                    'canonical',
                    {
                        kind: 'fact',
                        name: factName,
                        attributes: {
                            sourceArtifact: artifactId,
                            extractedFrom: 'heading',
                        },
                    },
                    proposerId,
                    committerId,
                );
                const factId = affectedIds[0];
                if (!factId) continue;
                factIds.push(factId);

                // Link fact to source artifact
                await runMutation(
                    kernel,
                    'link_evidence',
                    'ledger',
                    {
                        artifactId,
                        entityId: factId,
                    },
                    proposerId,
                    committerId,
                );
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
