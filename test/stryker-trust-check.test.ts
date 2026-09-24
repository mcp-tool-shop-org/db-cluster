/**
 * scripts/stryker-trust-check.mjs refuses a mutation score that no test
 * produced: a Survived mutant that tests covered but that ran none.
 *
 * With Vitest 5, @stryker-mutator/vitest-runner 10.0.0 selects a mutant's
 * covering tests by a name Vitest no longer matches
 * (stryker-mutator/stryker-js#6210). On 2026-09-24 a full run reported
 * 8.96% with exit code 0 while 1368 of its 1780 survivors had run nothing.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { untrustedSurvivors } from '../scripts/stryker-trust-check.mjs';

const ROOT = resolve(import.meta.dirname, '..');

type Mutant = { id: string; status: string; testsCompleted?: number; coveredBy?: string[] };
const report = (mutants: Mutant[]) => ({ files: { 'src/a.ts': { mutants } } });

describe('stryker-trust-check', () => {
    it('flags a Survived mutant that covering tests never ran', () => {
        expect(
            untrustedSurvivors(report([{ id: '7', status: 'Survived', testsCompleted: 0, coveredBy: ['1', '2'] }])),
        ).toEqual([{ file: 'src/a.ts', id: '7', coveredBy: 2 }]);
    });

    it('accepts survivors that ran tests, uncovered mutants, and kills', () => {
        expect(
            untrustedSurvivors(
                report([
                    { id: '1', status: 'Survived', testsCompleted: 12, coveredBy: ['1'] },
                    { id: '2', status: 'NoCoverage', testsCompleted: 0, coveredBy: [] },
                    { id: '3', status: 'Killed', testsCompleted: 1, coveredBy: ['4'] },
                    { id: '4', status: 'CompileError' },
                ]),
            ),
        ).toEqual([]);
    });

    it('runs after every `npm run test:mutation`, on the JSON report Stryker writes', () => {
        const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
        expect(pkg.scripts['test:mutation']).toBe('stryker run && node scripts/stryker-trust-check.mjs');
        const stryker = JSON.parse(readFileSync(join(ROOT, 'stryker.conf.json'), 'utf8'));
        expect(stryker.reporters).toContain('json');
    });
});
