/**
 * BM25 ranker (RETR-001) — a NEW LAYER ABOVE `IndexStore.search()`.
 *
 * `search()` keeps its candidate-match semantics and return shape. This module
 * is a pure, dependency-free relevance function that *ranks* candidates the
 * store returned. It reuses `tokenizer.ts` (the same `tokenize` + `STOP_WORDS`
 * machinery used at indexing time) so query-time and index-time text are
 * normalized identically. ZERO new dependencies — no FTS5, no SQLite, no native
 * module.
 *
 * Scoring is Okapi BM25 with the Lucene/BM25+ idf form
 * (`ln(1 + (N - df + 0.5)/(df + 0.5))`), which is always ≥ 0 — so scores are
 * non-negative, finite, and bounded above by `Σ idf·(k1+1)` (term-frequency
 * saturates). A document that contains no query term scores exactly 0. The
 * ranker NEVER drops records — it returns every input record, scored and
 * sorted. The retrieval planner ranks the candidates `search()` already matched
 * (recall stays `search()`'s job) and does NOT filter on score, so a
 * metadata-only match (BM25 text score 0) survives, ranked last. Ranking is a
 * pure overlay on `search()`'s recall, never a filter on it.
 */
import { tokenize, STOP_WORDS } from './tokenizer.js';

/** A record paired with its BM25 relevance score. */
export interface RankedRecord<T> {
    record: T;
    /** BM25 score. ≥ 0; 0 means no query term occurs in the record's text. */
    score: number;
}

export interface BM25Options {
    /**
     * Term-frequency saturation parameter. Higher → raw term frequency matters
     * more before saturating. Default 1.5 (Lucene's default).
     */
    k1?: number;
    /**
     * Document-length normalization. 0 = no normalization, 1 = full. Default
     * 0.75 (Lucene's default).
     */
    b?: number;
}

const DEFAULT_K1 = 1.5;
const DEFAULT_B = 0.75;

/**
 * Derive content-bearing query terms. Stop words are dropped so common words
 * don't dominate ranking. If the query is empty or made entirely of stop words,
 * fall back to the raw tokens so a degenerate query still ranks deterministically
 * rather than silently matching nothing.
 */
function queryTerms(query: string): string[] {
    // Null-safe: callers may pass an undefined/empty query (e.g. retrieval over
    // a whole corpus); never let it reach tokenize() as undefined.
    const all = tokenize(query ?? '');
    const content = all.filter((t) => !STOP_WORDS.has(t));
    return content.length > 0 ? content : all;
}

/**
 * Rank `records` against `query` by BM25, highest score first.
 *
 * Pure function: no I/O, no mutation of inputs. Every input record appears
 * exactly once in the output (same reference), so the caller can read scores
 * and still resolve owner truth from the original record. Ties break on
 * original input order (stable, engine-independent).
 *
 * @param query   The free-text query.
 * @param records Candidate records, each carrying a `text` payload to score.
 * @param options BM25 `k1` / `b` overrides.
 * @returns       Records paired with scores, sorted by score descending.
 */
export function rankByBM25<T extends { text: string }>(
    query: string,
    records: readonly T[],
    options?: BM25Options,
): RankedRecord<T>[] {
    if (records.length === 0) return [];

    const k1 = options?.k1 ?? DEFAULT_K1;
    const b = options?.b ?? DEFAULT_B;

    const uniqueTerms = Array.from(new Set(queryTerms(query)));

    // Tokenize each document once; derive lengths + per-doc term frequencies.
    const docTokens: string[][] = records.map((r) => tokenize(r.text));
    const docLengths: number[] = docTokens.map((toks) => toks.length);
    const N = records.length;
    const avgdl = docLengths.reduce((a, n) => a + n, 0) / N;

    const wanted = new Set(uniqueTerms);
    const tfMaps: Map<string, number>[] = docTokens.map((toks) => {
        const tf = new Map<string, number>();
        if (wanted.size === 0) return tf;
        for (const tok of toks) {
            if (wanted.has(tok)) tf.set(tok, (tf.get(tok) ?? 0) + 1);
        }
        return tf;
    });

    // Document frequency, then BM25 idf (always ≥ 0 → non-negative scores).
    const idf = new Map<string, number>();
    for (const term of uniqueTerms) {
        let dft = 0;
        for (const tf of tfMaps) if ((tf.get(term) ?? 0) > 0) dft++;
        idf.set(term, Math.log(1 + (N - dft + 0.5) / (dft + 0.5)));
    }

    const scored = records.map((record, idx) => {
        const tf = tfMaps[idx];
        // Length-normalization factor, guarded against an all-empty corpus
        // (avgdl === 0) so we never divide by zero / produce NaN.
        const norm = avgdl > 0 ? docLengths[idx] / avgdl : 0;
        let score = 0;
        for (const term of uniqueTerms) {
            const f = tf.get(term) ?? 0;
            if (f === 0) continue;
            const denom = f + k1 * (1 - b + b * norm);
            score += (idf.get(term) ?? 0) * ((f * (k1 + 1)) / denom);
        }
        return { record, score, idx };
    });

    scored.sort((x, y) => y.score - x.score || x.idx - y.idx);
    return scored.map(({ record, score }) => ({ record, score }));
}
