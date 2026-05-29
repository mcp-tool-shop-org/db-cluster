/**
 * Wave V1 — A1 regression: BM25 ranker (RETR-001).
 *
 * The ranker is a NEW LAYER above IndexStore.search(). It is a pure, dependency-free
 * function over the existing tokenizer.ts machinery. These tests pin:
 *  - lexical relevance (multi-term query surfaces the most-relevant record first)
 *  - term-frequency monotonicity (more occurrences → higher score, at equal length)
 *  - bounded, finite, non-negative scores (BM25 saturation)
 *  - stable tiebreak (equal scores preserve input order)
 *  - property: scores finite & ≥ 0 and output is sorted descending for arbitrary input
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { rankByBM25 } from '../src/indexing/bm25.js';

type Doc = { id: string; text: string };

function docs(...pairs: [string, string][]): Doc[] {
    return pairs.map(([id, text]) => ({ id, text }));
}

describe('Wave V1 — BM25 ranker (RETR-001)', () => {
    it('returns an empty array for an empty corpus', () => {
        expect(rankByBM25('anything', [])).toEqual([]);
    });

    it('returns one RankedRecord per input record, preserving the record reference', () => {
        const corpus = docs(['a', 'federated truth'], ['b', 'cooking recipe']);
        const ranked = rankByBM25('federated', corpus);
        expect(ranked).toHaveLength(2);
        const ids = ranked.map((r) => r.record.id).sort();
        expect(ids).toEqual(['a', 'b']);
        // record reference is carried through, not a copy
        expect(ranked.some((r) => r.record === corpus[0])).toBe(true);
    });

    it('scores a matching document > 0 and a non-matching document = 0', () => {
        const corpus = docs(['hit', 'federated truth store'], ['miss', 'cooking recipe onions']);
        const ranked = rankByBM25('federated', corpus);
        const byId = Object.fromEntries(ranked.map((r) => [r.record.id, r.score]));
        expect(byId.hit).toBeGreaterThan(0);
        expect(byId.miss).toBe(0);
    });

    it('multi-term query surfaces the most-relevant record first (lexical relevance)', () => {
        // d1 contains BOTH query terms, d2 only one, d3 none.
        const corpus = docs(
            ['d1', 'the cluster stores federated truth with provenance'],
            ['d2', 'federated database design and architecture notes'],
            ['d3', 'unrelated cooking recipe with onions'],
        );
        const ranked = rankByBM25('federated truth', corpus);
        expect(ranked[0].record.id).toBe('d1'); // both terms → ranks first
        expect(ranked[1].record.id).toBe('d2'); // one term → middle
        expect(ranked[2].record.id).toBe('d3'); // no terms → last
        expect(ranked[2].score).toBe(0);
        // strictly decreasing across the three distinct relevance tiers
        expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
        expect(ranked[1].score).toBeGreaterThan(ranked[2].score);
    });

    it('a document matching both query terms outranks one matching a single term', () => {
        const corpus = docs(['both', 'alpha beta'], ['one', 'alpha gamma']);
        const ranked = rankByBM25('alpha beta', corpus);
        expect(ranked[0].record.id).toBe('both');
        expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
    });

    it('is monotonic in term frequency at equal document length', () => {
        // Both docs are 4 tokens long; docA has the query term twice, docB once.
        const corpus = docs(
            ['A', 'alpha alpha filler gamma'],
            ['B', 'alpha delta filler gamma'],
        );
        const ranked = rankByBM25('alpha', corpus);
        const byId = Object.fromEntries(ranked.map((r) => [r.record.id, r.score]));
        expect(byId.A).toBeGreaterThan(byId.B);
    });

    it('saturates: extreme term frequency cannot exceed the (k1+1) ceiling over tf=1', () => {
        const once = rankByBM25('alpha', docs(['x', 'alpha']));
        const many = rankByBM25('alpha', docs(['x', Array(1000).fill('alpha').join(' ')]));
        // single-doc corpus: length-normalization cancels (dl === avgdl), isolating TF saturation.
        expect(many[0].score).toBeGreaterThan(once[0].score); // monotonic
        // BM25 ceiling is (k1+1)=2.5× the tf=1 contribution; never unbounded.
        expect(many[0].score).toBeLessThanOrEqual(once[0].score * 2.5 + 1e-9);
    });

    it('produces finite, non-negative scores', () => {
        const corpus = docs(['a', 'alpha beta gamma'], ['b', ''], ['c', '!!! ??? ...']);
        for (const r of rankByBM25('alpha', corpus)) {
            expect(Number.isFinite(r.score)).toBe(true);
            expect(r.score).toBeGreaterThanOrEqual(0);
        }
    });

    it('breaks ties by original input order (stable)', () => {
        const corpus = docs(['first', 'alpha beta'], ['second', 'alpha beta']);
        const ranked = rankByBM25('alpha', corpus);
        expect(ranked[0].record.id).toBe('first');
        expect(ranked[1].record.id).toBe('second');
    });

    it('an empty / stopword-only query does not throw and yields finite scores', () => {
        const corpus = docs(['a', 'alpha beta'], ['b', 'gamma delta']);
        expect(() => rankByBM25('', corpus)).not.toThrow();
        for (const r of rankByBM25('the of and', corpus)) {
            expect(Number.isFinite(r.score)).toBe(true);
        }
    });

    it('property: scores are finite & ≥ 0 and output is sorted descending (fast-check)', () => {
        fc.assert(
            fc.property(
                fc.array(fc.string(), { maxLength: 12 }),
                fc.string(),
                (texts, query) => {
                    const corpus = texts.map((t, i) => ({ id: String(i), text: t }));
                    const ranked = rankByBM25(query, corpus);
                    expect(ranked).toHaveLength(corpus.length);
                    for (let i = 0; i < ranked.length; i++) {
                        expect(Number.isFinite(ranked[i].score)).toBe(true);
                        expect(ranked[i].score).toBeGreaterThanOrEqual(0);
                        if (i > 0) {
                            expect(ranked[i - 1].score).toBeGreaterThanOrEqual(ranked[i].score);
                        }
                    }
                    // The top result (if any positive score) must contain a query term.
                    const top = ranked[0];
                    if (top && top.score > 0) {
                        const qTokens = new Set(
                            query.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, ' ').split(/\s+/).filter((t) => t.length > 1),
                        );
                        const topTokens = top.record.text
                            .toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, ' ').split(/\s+/).filter((t) => t.length > 1);
                        expect(topTokens.some((t) => qTokens.has(t))).toBe(true);
                    }
                },
            ),
            { numRuns: 200 },
        );
    });
});
