/**
 * Wave V1 — A5 cross-cutting regression: RETR-003 wording retract + completeness gate.
 *
 * These assertions cut across domains and guard the wave-level invariants that
 * no single fix-agent file owns:
 *  - RETR-003: the "full-text/vector" lookup claim is retracted from the primary
 *    (non-translation) source docs once BM25 ranking landed. The "What this is
 *    not → A vector database" non-goal line is CORRECT and must stay.
 *  - The mechanical completeness gates for ranking-consumption + snippet
 *    integrity (R11 / R12) exist AND are registered in the runner (the runner
 *    iterates an explicit RULES array, not a glob — an unregistered rule never
 *    runs).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8');

describe('Wave V1 — cross-cutting (RETR-003 retract + completeness gates)', () => {
    it('RETR-003: the "full-text/vector" claim is retracted from README + the IndexStore contract', () => {
        const readme = read('README.md');
        expect(readme.includes('full-text/vector')).toBe(false);
        // The "What this is not" non-goal line is correct — db-cluster is NOT a
        // vector database — and must remain.
        expect(/##\s*What this is not[\s\S]*vector database/i.test(readme)).toBe(true);

        const contract = read('src/contracts/index-store.ts');
        expect(contract.includes('full-text/vector')).toBe(false);
        // The candidate/ranking boundary is documented at the contract level.
        expect(/ranking/i.test(contract)).toBe(true);
    });

    it('RETR-003: docs/store-contracts.md describes the index lookup as ranked', () => {
        const storeContracts = read('docs/store-contracts.md');
        expect(/full-text \(ranked\)/i.test(storeContracts)).toBe(true);
    });

    it('RETR-001/004: completeness gate rules for ranking + snippet integrity exist and are registered', () => {
        expect(existsSync(join(ROOT, 'scripts/checks/R11-snippet-without-integrity-read.yml'))).toBe(true);
        expect(existsSync(join(ROOT, 'scripts/checks/R12-retrieval-without-ranking.yml'))).toBe(true);
        const runner = read('scripts/completeness-checks.mjs');
        expect(runner.includes('R11-snippet-without-integrity-read.yml')).toBe(true);
        expect(runner.includes('R12-retrieval-without-ranking.yml')).toBe(true);
    });

    it('RETR-003: the IndexRecord.embedding anti-pattern field is left intact (not wired)', () => {
        // The embedding field is an intentional, unused anti-pattern marker
        // (phase13-proof). V1 must NOT wire it — confirm it still exists as an
        // optional field and nothing in the retrieval path references it.
        const indexRecord = read('src/types/index-record.ts');
        expect(/embedding\?:/.test(indexRecord)).toBe(true);
        const planner = read('src/retrieval/retrieval-planner.ts');
        expect(planner.includes('embedding')).toBe(false);
    });
});
