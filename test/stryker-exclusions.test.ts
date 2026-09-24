/**
 * The Stryker exclusion rule still finds what it exists to find, and the
 * mutation config still uses it.
 *
 * `npm run test:mutation` runs in no pull-request workflow. Its hand-kept
 * exclusion list stopped at Wave A3 and the dry run failed for months without
 * anyone noticing. scripts/stryker-exclusions.mjs replaced the list with a
 * rule; this file is the cheap guard that runs with every `npm test`, and the
 * Release Gate workflow runs the dry run itself on each push to main.
 *
 * The synthetic cases live in test/fixtures/stryker-rule/ as .txt files, so
 * this file's own source never trips the rule it tests.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { strykerExclusions } from '../scripts/stryker-exclusions.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const FIXTURES = join(ROOT, 'test', 'fixtures', 'stryker-rule');

describe('the rule, on synthetic test files', () => {
    let root: string;

    beforeAll(() => {
        // A throwaway repo: one mutated file, and each fixture as a test file,
        // one of them nested to prove the scan recurses.
        root = mkdtempSync(join(tmpdir(), 'stryker-rule-'));
        writeFileSync(join(root, 'stryker.conf.json'), JSON.stringify({ mutate: ['src/kernel/target.ts'] }));
        mkdirSync(join(root, 'test', 'nested'), { recursive: true });
        for (const name of readdirSync(FIXTURES)) {
            const dest = name === 'spawns-dist.txt' ? join('nested', 'spawns-dist') : name.replace(/\.txt$/, '');
            copyFileSync(join(FIXTURES, name), join(root, 'test', `${dest}.test.ts`));
        }
        // Not a test file: the rule must not scan it.
        copyFileSync(join(FIXTURES, 'imports-dist.txt'), join(root, 'test', 'helper.ts'));
    });

    afterAll(() => {
        rmSync(root, { recursive: true, force: true });
    });

    it('excludes exactly the files that cannot run under Stryker, with their reasons', () => {
        expect(strykerExclusions(root)).toEqual([
            { file: 'test/backslash-read.test.ts', reasons: ['reads mutated source target.ts as text'] },
            { file: 'test/chdir.test.ts', reasons: ['calls process.chdir()'] },
            { file: 'test/imports-dist.test.ts', reasons: ['uses the built package (dist/)'] },
            { file: 'test/nested/spawns-dist.test.ts', reasons: ['uses the built package (dist/)'] },
            { file: 'test/raw-read.test.ts', reasons: ['reads mutated source target.ts as text'] },
            { file: 'test/template-read.test.ts', reasons: ['reads mutated source target.ts as text'] },
        ]);
        // Kept: a read through sourceText(), a mention in a comment or a
        // title, and a text read of a file Stryker does not mutate.
    });
});

describe('the rule, on this repository', () => {
    const excluded = strykerExclusions(ROOT);
    const reasonsOf = (file: string) => excluded.find((e) => e.file === file)?.reasons ?? [];

    it('still finds a known member of each kind it excludes', () => {
        // A scan that silently finds nothing would pass every other check.
        expect(reasonsOf('test/backend-env-surfaces.test.ts')).toContain('uses the built package (dist/)');
        expect(reasonsOf('test/wave-s2a2-surfaces-regression.test.ts')).toContain('calls process.chdir()');
    });

    it('excludes no file for a raw source-text read alone', () => {
        // Such a file loses every other test it has from the mutation run.
        // Read the source with sourceText() (test/support/source-text.ts)
        // instead: only that assertion is skipped under Stryker.
        const textReadOnly = excluded.filter((e) => e.reasons.every((r) => r.startsWith('reads mutated source')));
        expect(textReadOnly).toEqual([]);
    });

    it('is what the mutation config uses', () => {
        const stryker = JSON.parse(readFileSync(join(ROOT, 'stryker.conf.json'), 'utf8'));
        expect(stryker.testRunner).toBe('vitest');
        expect(stryker.vitest.configFile).toBe('vitest.stryker.config.ts');
        const config = readFileSync(join(ROOT, 'vitest.stryker.config.ts'), 'utf8');
        expect(config).toMatch(/exclude:\s*strykerExclusions\(root\)/);
    });
});
