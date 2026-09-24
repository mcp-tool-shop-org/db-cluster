import { readFileSync } from 'node:fs';

/** Identifiers Stryker's instrumenter writes into every file it mutates. */
const INSTRUMENTED = /\bstry(?:NS|MutAct|Cov)_[0-9a-f]+\b/;

/**
 * Read a source file's text for an assertion about the source itself.
 *
 * Stryker runs the suite on an instrumented copy of the files it mutates
 * (stryker.conf.json `mutate`). Their text is Stryker's rewrite, not the
 * code under test, so a text assertion there checks the wrong thing. When
 * the text is instrumented the test is reported as skipped; in every other
 * run, including `npm test`, the text comes back unchanged and the assertion
 * runs in full.
 *
 * scripts/stryker-exclusions.mjs keeps any test file that reads a mutated
 * file some other way out of the mutation run.
 *
 * @param path - the source file to read.
 * @param ctx - the running test's context (vitest passes it to the test fn).
 */
export function sourceText(path: string, ctx: { skip: (note?: string) => never }): string {
    const text = readFileSync(path, 'utf8');
    if (INSTRUMENTED.test(text)) ctx.skip('source text is instrumented by Stryker');
    return text;
}
