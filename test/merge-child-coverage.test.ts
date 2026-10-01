import { describe, expect, it } from 'vitest';
// @ts-expect-error - plain .mjs script, no type declarations
import { mergeChildHits } from '../scripts/merge-child-coverage.mjs';

const loc = (start: number, end = start) => ({ start: { line: start, column: 0 }, end: { line: end, column: 1 } });

describe('merge-child-coverage', () => {
    it('marks a statement run when a child process executed its line', () => {
        const base = { '/repo/src/cli.ts': { statementMap: { 0: loc(10), 1: loc(20) }, s: { 0: 0, 1: 0 } } };
        const kids = { '/repo/src/cli.ts': { statementMap: { 0: loc(10) }, s: { 0: 3 } } };
        const { coverage, added } = mergeChildHits(base, kids);
        expect(coverage['/repo/src/cli.ts'].s).toEqual({ 0: 1, 1: 0 });
        expect(added).toBe(1);
    });

    it('never adds a line vitest did not count (no comment or blank-line inflation)', () => {
        const base = { '/repo/src/a.ts': { statementMap: { 0: loc(5) }, s: { 0: 0 } } };
        const kids = { '/repo/src/a.ts': { statementMap: { 0: loc(1, 4), 1: loc(6, 9) }, s: { 0: 1, 1: 1 } } };
        const { coverage } = mergeChildHits(base, kids);
        expect(Object.keys(coverage['/repo/src/a.ts'].s)).toEqual(['0']);
        expect(coverage['/repo/src/a.ts'].s[0]).toBe(0);
    });

    it('leaves statements vitest already counted, and ignores files only children saw', () => {
        const base = { '/repo/src/b.ts': { statementMap: { 0: loc(3) }, s: { 0: 7 } } };
        const kids = {
            '/repo/src/b.ts': { statementMap: { 0: loc(3) }, s: { 0: 1 } },
            '/repo/src/only-kids.ts': { statementMap: { 0: loc(1) }, s: { 0: 1 } },
        };
        const { coverage, added } = mergeChildHits(base, kids);
        expect(coverage['/repo/src/b.ts'].s[0]).toBe(7);
        expect(coverage['/repo/src/only-kids.ts']).toBeUndefined();
        expect(added).toBe(0);
    });

    it('matches files across path separators and case (Windows reports)', () => {
        const base = { 'C:\\repo\\src\\c.ts': { statementMap: { 0: loc(2) }, s: { 0: 0 } } };
        const kids = { 'c:/repo/src/c.ts': { statementMap: { 0: loc(2) }, s: { 0: 1 } } };
        expect(mergeChildHits(base, kids).coverage['C:\\repo\\src\\c.ts'].s[0]).toBe(1);
    });

    it('a child statement that ran nowhere adds nothing', () => {
        const base = { '/repo/src/d.ts': { statementMap: { 0: loc(4) }, s: { 0: 0 } } };
        const kids = { '/repo/src/d.ts': { statementMap: { 0: loc(4) }, s: { 0: 0 } } };
        expect(mergeChildHits(base, kids).added).toBe(0);
    });
});
