/**
 * Basic tokenizer for content-aware indexing.
 * Normalizes text into searchable tokens without requiring embeddings.
 */

/**
 * Normalize text into lowercase tokens, removing punctuation and extra whitespace.
 *
 * Uses Unicode property escapes (`\p{L}`, `\p{N}`) with the `u` flag so non-ASCII
 * content (Latin diacritics like café, CJK, Cyrillic, Arabic, etc.) is preserved
 * rather than stripped to whitespace. The earlier `\w` pattern matched only
 * `[A-Za-z0-9_]` and silently neutered indexing for any non-English content
 * (STORES-004).
 *
 * Replace runs BEFORE toLowerCase so the regex is evaluated against the original
 * text — order is functionally equivalent here because the property escapes are
 * case-insensitive, but lowercasing afterwards keeps token output consistent.
 */
export function tokenize(text: string): string[] {
    return text
        .replace(/[^\p{L}\p{N}\s_-]/gu, ' ')
        .toLowerCase()
        .split(/\s+/)
        .filter((t) => t.length > 1);
}

/**
 * Extract headings from markdown text.
 */
export function extractHeadings(markdown: string): string[] {
    const headingPattern = /^#{1,6}\s+(.+)$/gm;
    const headings: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = headingPattern.exec(markdown)) !== null) {
        headings.push(match[1].trim());
    }
    return headings;
}

/**
 * Extract key terms from text — words that appear meaningful (not stop words).
 */
const STOP_WORDS = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'ought',
    'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
    'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below',
    'between', 'out', 'off', 'over', 'under', 'again', 'further', 'then',
    'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'each',
    'every', 'both', 'few', 'more', 'most', 'other', 'some', 'such', 'no',
    'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very',
    'just', 'because', 'but', 'and', 'or', 'if', 'while', 'this', 'that',
    'these', 'those', 'it', 'its', 'we', 'they', 'them', 'their', 'our',
    'your', 'my', 'his', 'her', 'he', 'she', 'you',
]);

export function extractKeyTerms(text: string, maxTerms = 50): string[] {
    const tokens = tokenize(text);
    const termFreq = new Map<string, number>();
    for (const token of tokens) {
        if (STOP_WORDS.has(token) || token.length < 3) continue;
        termFreq.set(token, (termFreq.get(token) ?? 0) + 1);
    }
    return Array.from(termFreq.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, maxTerms)
        .map(([term]) => term);
}
