/**
 * Content indexer — extracts meaningful text from artifacts for search.
 * Makes project-memory retrieval find artifacts by content, not just filename.
 */

import { createHash } from 'node:crypto';
import type { ClusterStores } from '../contracts/index.js';
import type { Artifact } from '../types/artifact.js';
import { extractHeadings, extractKeyTerms } from './tokenizer.js';

/**
 * Structurally detect a content-read integrity failure thrown by the hardened
 * `ArtifactStore.getContent` (PROV-001). Matched by `name` / `code` rather than
 * `instanceof` so the indexing layer does NOT take a hard import on the adapter
 * package and recognizes the error regardless of the concrete class
 * (`ContentReadIntegrityError` / `InvalidContentHashError`). Both mean the
 * stored content cannot be trusted — never index it.
 */
function isContentIntegrityError(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    const name = (err as { name?: unknown }).name;
    const code = (err as { code?: unknown }).code;
    if (typeof name === 'string' && /ContentReadIntegrity|InvalidContentHash/i.test(name)) {
        return true;
    }
    if (typeof code === 'string' && /CONTENT_READ_INTEGRITY|INVALID_CONTENT_HASH/i.test(code)) {
        return true;
    }
    return false;
}

export interface ContentIndexResult {
    indexed: number;
    errors: string[];
}

/**
 * Build a rich text representation of an artifact for indexing.
 * Includes filename, headings, and key terms from content.
 */
export function buildArtifactIndexText(artifact: Artifact, content: string): string {
    const parts: string[] = [];

    // Filename (highest weight — appears first)
    parts.push(artifact.filename);

    // Extract headings from markdown
    if (artifact.mimeType === 'text/markdown' || artifact.filename.endsWith('.md')) {
        const headings = extractHeadings(content);
        if (headings.length > 0) {
            parts.push(headings.join(' | '));
        }
    }

    // Key terms from content body
    const terms = extractKeyTerms(content, 30);
    if (terms.length > 0) {
        parts.push(terms.join(' '));
    }

    return parts.join(' ');
}

/**
 * Index all artifacts with content-aware text extraction.
 * Call during rebuild to populate index with rich artifact search text.
 */
export async function indexArtifactContent(stores: ClusterStores): Promise<ContentIndexResult> {
    const artifacts = await stores.artifact.list({});
    const errors: string[] = [];
    let indexed = 0;

    for (const artifact of artifacts) {
        try {
            // PROV-001 (Wave S2-A1): the hardened getContent re-hashes the
            // on-disk bytes vs contentHash and THROWS on mismatch. A throw is
            // caught below and surfaced LOUDLY — the artifact is NOT indexed,
            // so poisoned content can never enter the search index.
            const contentBuf = await stores.artifact.getContent(artifact.id);
            // PROV-001 defense-in-depth: re-hash the returned bytes against the
            // recorded contentHash with an adjacent `createHash('sha256')` check
            // before indexing. A tampered blob is refused even if the adapter
            // has not yet adopted verify-on-read — poisoned content never enters
            // the search index. Throwing routes into the integrity-aware catch.
            if (contentBuf) {
                const actualHash = createHash('sha256').update(contentBuf).digest('hex');
                if (actualHash !== artifact.contentHash) {
                    const integrityError: Error & { code?: string } = new Error(
                        `sha256(on-disk bytes)=${actualHash} != recorded contentHash=${artifact.contentHash}`,
                    );
                    integrityError.name = 'ContentReadIntegrityError';
                    integrityError.code = 'CONTENT_READ_INTEGRITY';
                    throw integrityError;
                }
            }
            let indexText: string;

            if (contentBuf && (artifact.mimeType.startsWith('text/') || artifact.filename.endsWith('.md') || artifact.filename.endsWith('.txt'))) {
                const content = contentBuf.toString('utf-8');
                indexText = buildArtifactIndexText(artifact, content);
            } else {
                // Non-text artifacts: index by filename and version only
                indexText = `${artifact.filename} v${artifact.version}`;
            }

            await stores.index.index({
                sourceId: artifact.id,
                sourceStore: 'artifact',
                text: indexText,
                metadata: {
                    filename: artifact.filename,
                    mimeType: artifact.mimeType,
                    version: artifact.version,
                },
            });
            indexed++;
        } catch (err: any) {
            if (isContentIntegrityError(err)) {
                errors.push(
                    `Refusing to index artifact ${artifact.id} (${artifact.filename}): content integrity ` +
                        `check failed — the on-disk bytes do not hash to the recorded contentHash ` +
                        `(tampered blob). ${err.message ?? ''}`.trim(),
                );
            } else {
                errors.push(`Failed to index artifact ${artifact.id}: ${err.message}`);
            }
        }
    }

    return { indexed, errors };
}
