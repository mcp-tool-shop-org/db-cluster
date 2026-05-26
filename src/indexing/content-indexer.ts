/**
 * Content indexer — extracts meaningful text from artifacts for search.
 * Makes project-memory retrieval find artifacts by content, not just filename.
 */

import type { ClusterStores } from '../contracts/index.js';
import type { Artifact } from '../types/artifact.js';
import { extractHeadings, extractKeyTerms } from './tokenizer.js';

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
            const contentBuf = await stores.artifact.getContent(artifact.id);
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
            errors.push(`Failed to index artifact ${artifact.id}: ${err.message}`);
        }
    }

    return { indexed, errors };
}
