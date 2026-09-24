/**
 * Which test files cannot run under Stryker, derived from what each file
 * does instead of kept by hand.
 *
 * Stryker's vitest runner runs the suite in a sandbox copy of the repo, with
 * the files listed in stryker.conf.json's `mutate` instrumented, inside
 * worker threads (the runner forces `pool: 'threads'`). A test file cannot
 * run there when it:
 *
 *   - uses the built package, `dist/`: the sandbox has no build, and a
 *     compiled file never contains a mutant, so it could not kill one;
 *   - reads a mutated source file as text other than through
 *     `sourceText()` (test/support/source-text.ts): instrumentation rewrites
 *     the file, and only that helper notices and skips the assertion;
 *   - calls `process.chdir()`: Node refuses it in worker threads.
 *
 * The exclusion list used to be hand-kept. It stopped at Wave A3, the dry run
 * went red, and nothing noticed because no workflow ran it.
 *
 * The scan reads each test file's syntax tree, not its text, so a comment or
 * a test title that mentions `dist/` does not count as using it.
 *
 * Used by vitest.stryker.config.ts; test/stryker-exclusions.test.ts checks
 * that the scan still finds what it exists to find.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import ts from 'typescript';

/** Calls whose first argument is a test or suite title, not a path. */
const TITLE_CALLS = new Set(['describe', 'it', 'test', 'bench', 'suite']);

/** The leftmost identifier of a callee: `it` for `it.skipIf(x)(...)`. */
function calleeRoot(expr) {
    let e = expr;
    for (;;) {
        if (ts.isIdentifier(e)) return e.text;
        if (ts.isPropertyAccessExpression(e)) e = e.expression;
        else if (ts.isCallExpression(e)) e = e.expression;
        else return undefined;
    }
}

/** True when `node` is the title argument of describe()/it()/test(). */
function isTitle(node) {
    const call = node.parent;
    return (
        call !== undefined &&
        ts.isCallExpression(call) &&
        call.arguments[0] === node &&
        TITLE_CALLS.has(calleeRoot(call.expression) ?? '')
    );
}

/** True when `node` sits inside the arguments of a `sourceText(...)` call. */
function insideSourceText(node) {
    for (let p = node.parent; p; p = p.parent) {
        if (ts.isCallExpression(p) && ts.isIdentifier(p.expression) && p.expression.text === 'sourceText') return true;
    }
    return false;
}

/** Every literal string piece in a node: plain strings and template parts. */
function literalTexts(node) {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
    if (ts.isTemplateExpression(node)) return [node.head.text, ...node.templateSpans.map((s) => s.literal.text)];
    return [];
}

/**
 * Scan `test/**` under `root` and return each test file Stryker cannot run,
 * with the reasons, sorted by path. Paths use forward slashes, relative to
 * `root`, in the form vitest's `exclude` accepts.
 *
 * @param {string} root - the repository (or Stryker sandbox) root.
 * @returns {{ file: string, reasons: string[] }[]}
 */
export function strykerExclusions(root) {
    const { mutate } = JSON.parse(readFileSync(join(root, 'stryker.conf.json'), 'utf8'));
    const mutatedNames = new Set(mutate.map((p) => p.split('/').pop()));

    const testFiles = readdirSync(join(root, 'test'), { recursive: true })
        .map((p) => String(p).split(sep).join('/'))
        .filter((p) => p.endsWith('.test.ts'))
        .sort();

    const excluded = [];
    for (const rel of testFiles) {
        const text = readFileSync(join(root, 'test', rel), 'utf8');
        const source = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
        const reasons = new Set();

        const visit = (node) => {
            if (!isTitle(node)) {
                for (const raw of literalTexts(node)) {
                    const s = raw.replace(/\\/g, '/');
                    if (s === 'dist' || s.startsWith('dist/') || s.includes('/dist/') || s.endsWith('/dist')) {
                        reasons.add('uses the built package (dist/)');
                    }
                    const name = s.split('/').pop();
                    if (name && mutatedNames.has(name) && !insideSourceText(node)) {
                        reasons.add(`reads mutated source ${name} as text`);
                    }
                }
            }
            if (
                ts.isCallExpression(node) &&
                ts.isPropertyAccessExpression(node.expression) &&
                ts.isIdentifier(node.expression.expression) &&
                node.expression.expression.text === 'process' &&
                node.expression.name.text === 'chdir'
            ) {
                reasons.add('calls process.chdir()');
            }
            ts.forEachChild(node, visit);
        };
        visit(source);

        if (reasons.size > 0) excluded.push({ file: `test/${rel}`, reasons: [...reasons].sort() });
    }
    return excluded;
}
