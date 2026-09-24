#!/usr/bin/env node
/**
 * Refuse a mutation score that no test produced.
 *
 * Stryker reports a mutant as Survived when the tests it ran all passed,
 * including when it ran none. With Vitest 5, @stryker-mutator/vitest-runner
 * 10.0.0 filters a mutant's covering tests by a name Vitest no longer
 * matches (stryker-mutator/stryker-js#6210), so most covered mutants run zero
 * tests and "survive". On 2026-09-24 that turned a real score into 8.96%,
 * printed like any other and with exit code 0.
 *
 * This runs after `stryker run` (npm run test:mutation). It reads the JSON
 * report and exits 1 when a Survived mutant had covering tests but ran none.
 *
 * Usage: node scripts/stryker-trust-check.mjs [reports/mutation/mutation.json]
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * Survived mutants that tests covered but that ran no test.
 *
 * @param {{ files: Record<string, { mutants: Array<{ id: string, status: string, testsCompleted?: number, coveredBy?: string[] }> }> }} report
 * @returns {{ file: string, id: string, coveredBy: number }[]}
 */
export function untrustedSurvivors(report) {
    const out = [];
    for (const [file, { mutants }] of Object.entries(report.files)) {
        for (const m of mutants) {
            if (m.status === 'Survived' && (m.coveredBy?.length ?? 0) > 0 && m.testsCompleted === 0) {
                out.push({ file, id: m.id, coveredBy: m.coveredBy.length });
            }
        }
    }
    return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    const path = process.argv[2] ?? 'reports/mutation/mutation.json';
    const report = JSON.parse(readFileSync(path, 'utf8'));
    const bad = untrustedSurvivors(report);
    const survived = Object.values(report.files).flatMap((f) => f.mutants).filter((m) => m.status === 'Survived').length;
    if (bad.length > 0) {
        console.error(
            `stryker-trust-check: ${bad.length} of ${survived} Survived mutants had covering tests but ran none. ` +
                'The mutation score above is not valid.\n' +
                'Known cause: Vitest 5 with @stryker-mutator/vitest-runner 10.0.0 (stryker-mutator/stryker-js#6210). ' +
                'Measure with a runner that has the fix, or with Vitest 4.1.x.',
        );
        process.exit(1);
    }
    console.log(`stryker-trust-check: every Survived mutant ran its covering tests (${survived} survivors).`);
}
