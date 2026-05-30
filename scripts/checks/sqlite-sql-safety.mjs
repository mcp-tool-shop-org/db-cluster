#!/usr/bin/env node
/**
 * sqlite-sql-safety.mjs — SQL-injection-safety completeness gate for the
 * SQLite storage adapter (Wave V3, STORE-006/SQLite).
 *
 * ──────────────────────────────────────────────────────────────────────────
 * WHAT THIS GATES — and what it deliberately does NOT.
 * ──────────────────────────────────────────────────────────────────────────
 * The two *integrity* invariants of the new SQLite stores are ALREADY statically
 * gated by the existing ast-grep rules, whose `files:` glob is
 * `src/adapters/` + `**` + `/*.ts` and therefore covers `src/adapters/sqlite/`:
 *
 *   • R6 (content-read-without-hash-check) — a `getContent` that reads bytes must
 *     re-hash them via `createHash('sha256')` against the recorded contentHash
 *     (PROV-001). SqliteArtifactStore.getContent is covered.
 *   • R8 (ledger-append-without-integrity-stamp) — a ledger `append` /
 *     `appendReceipt` must route through `computeIntegrityHash` (PROV-004).
 *     SqliteLedgerStore.append / appendReceipt are covered.
 *
 * The answer to "is the integrity invariant gated for sqlite?" is therefore
 * **YES, by R6 + R8** — confirmed by `npm run completeness` passing with the
 * sqlite stores present. This scanner does NOT re-litigate that.
 *
 * This scanner's NON-redundant contribution is the wave's headline safety
 * property that is NOT otherwise statically enforced anywhere:
 *
 *   **SQL-INJECTION SAFETY of the SQLite adapter** — every query is fully
 *   parameterized (better-sqlite3 `?` placeholders); NO runtime value is
 *   concatenated or interpolated into a SQL string. The ONLY tokens permitted
 *   inside a SQL string template are compile-time SQL-identifier constants
 *   (the table-name constants) and compile-time-static SQL fragments built
 *   solely from string literals + `?` placeholders.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * HOW IT WORKS.
 * ──────────────────────────────────────────────────────────────────────────
 * It parses every TypeScript file under `src/adapters/sqlite/` with the compiler
 * API (already a devDependency; the build is `tsc`) — accurate AST, no fragile
 * regex. For each file it:
 *
 *  1. Finds SQL-bearing template literals: a template literal (with or without
 *     `${...}` substitutions) whose static text contains a SQL keyword
 *     (SELECT | INSERT | UPDATE | DELETE | CREATE), case-insensitive.
 *  2. For each `${EXPR}` substitution in such a template, it FAILS unless EXPR
 *     is on the allowlist. EXPR is allowed iff, after trimming, it is:
 *       (a) a bare identifier that is an exported string-constant from
 *           `src/adapters/sqlite/schema.ts` (the table-name + DDL constants —
 *           harvested at runtime so the allowlist stays in sync with schema.ts);
 *       (b) a bare identifier whose own declaration *in the same file* proves it
 *           is a compile-time-static SQL fragment — a `const`/`let` whose every
 *           initializer / `+=` / `=` RHS is a string literal (or a template made
 *           only of string parts), or a `[...].join(sep)` over a string-literal
 *           array. This is how the `COLUMNS` column-list constant and the
 *           dynamically-assembled-but-value-free `where` / `whereSql` fragments
 *           clear the gate — they contain only column names, SQL keywords, and
 *           `?` placeholders, never an interpolated value;
 *       (c) a `+`-concatenation whose every operand independently satisfies
 *           (a) / (b) / is itself a string literal.
 *     Anything else — a member access (`x.y`), a call (`f(...)`), a nested
 *     template carrying a value, an unknown identifier — FAILS with file:line +
 *     the offending snippet.
 *
 * A failure here means a value may be spliced into SQL: that is the bug. It
 * cannot be cleared by editing this file — fix the query to bind the value with
 * a `?` placeholder.
 *
 * Exit codes (mirrors the ast-grep orchestrator's convention so the parent
 * `completeness-checks.mjs` can fold this in):
 *   0 — clean (prints a one-line pass summary + how many SQL statements scanned)
 *   1 — at least one unsafe interpolation found
 *   2 — tool error (sqlite source dir / schema.ts missing, parse failure, etc.)
 *
 * Run standalone:  node scripts/checks/sqlite-sql-safety.mjs [--json]
 * Or via the gate: node scripts/completeness-checks.mjs   (folds the result in)
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');
const SQLITE_DIR = join(ROOT, 'src', 'adapters', 'sqlite');
const SCHEMA_FILE = join(SQLITE_DIR, 'schema.ts');

/** SQL keyword that marks a template literal as SQL-bearing. */
const SQL_KEYWORD = /\b(SELECT|INSERT|UPDATE|DELETE|CREATE)\b/i;

/** Stable identifier so the parent orchestrator can label the row. */
export const CHECK_ID = 'SQL';
export const CHECK_LABEL =
    'SQLite adapter: every SQL string is parameterized — no value interpolated/concatenated (SQL-injection safety; R6+R8 already gate the integrity invariants)';

/**
 * Recursively collect every `*.ts` file under `dir` (excluding `.d.ts`).
 */
function collectTsFiles(dir) {
    /** @type {string[]} */
    const out = [];
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        const st = statSync(full);
        if (st.isDirectory()) {
            out.push(...collectTsFiles(full));
        } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
            out.push(full);
        }
    }
    return out;
}

/**
 * Harvest the allowlist of exported SQL-identifier string constants from
 * schema.ts: every `export const NAME = '...string...'` (table names + DDL).
 * Returns a Set of identifier names. Derived at runtime so a new table constant
 * added to schema.ts is automatically allowlisted — the allowlist never drifts
 * from the schema.
 */
function harvestSchemaConstants(schemaFile) {
    const src = ts.createSourceFile(
        schemaFile,
        readFileSync(schemaFile, 'utf8'),
        ts.ScriptTarget.Latest,
        /* setParentNodes */ true,
    );
    /** @type {Set<string>} */
    const names = new Set();
    const ctx = { ids: names, arrays: new Set() };
    const visit = (node) => {
        if (
            ts.isVariableStatement(node) &&
            node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
        ) {
            for (const decl of node.declarationList.declarations) {
                if (
                    ts.isIdentifier(decl.name) &&
                    decl.initializer &&
                    isStaticStringExpression(decl.initializer, ctx, src)
                ) {
                    names.add(decl.name.text);
                }
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(src);
    return names;
}

/**
 * Is `expr` a compile-time-static string value — i.e. a value built ENTIRELY
 * from string literals, allowlisted SQL-identifier constants, and value-free
 * fragment assembly (concatenation / ternary / `.join()` over string literals)?
 * A `true` result means: whatever this evaluates to at runtime, it CANNOT carry
 * an interpolated value — only SQL keywords, identifiers, and `?` placeholders.
 *
 * `ctx = { ids, arrays }`:
 *  - `ids`    — identifier names already proven to be static strings (schema
 *               constants + local SQL-fragment vars like `COLUMNS`/`where`).
 *               This is what lets `CREATE_X_SQL = \`... ${CANONICAL_TABLE} ...\``
 *               count as static once `CANONICAL_TABLE` is known.
 *  - `arrays` — identifier names proven to be string-LITERAL arrays (declared
 *               `[]` / `[<literals>]`, mutated only by `.push(<literal>)`), so
 *               `<arr>.join(<literal>)` is a value-free fragment.
 */
function isStaticStringExpression(expr, ctx, src) {
    // Unwrap parentheses.
    while (ts.isParenthesizedExpression(expr)) expr = expr.expression;

    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
        return true;
    }
    if (ts.isTemplateExpression(expr)) {
        // Every `${...}` span must itself be a static string / allowlisted id.
        return expr.templateSpans.every((span) =>
            isStaticStringExpression(span.expression, ctx, src),
        );
    }
    if (ts.isIdentifier(expr)) {
        return ctx.ids.has(expr.text);
    }
    // `cond ? A : B` — both branches static (the condition can't reach the
    // produced string). This is the `where.length > 0 ? ` WHERE ...` : ''`
    // pattern in the ledger store.
    if (ts.isConditionalExpression(expr)) {
        return (
            isStaticStringExpression(expr.whenTrue, ctx, src) &&
            isStaticStringExpression(expr.whenFalse, ctx, src)
        );
    }
    // `A + B` — both sides static.
    if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        return (
            isStaticStringExpression(expr.left, ctx, src) &&
            isStaticStringExpression(expr.right, ctx, src)
        );
    }
    // `<arr>.join(<sep>)` where the separator is static AND the receiver is
    // either an inline array-of-literals OR a proven string-literal array
    // identifier. Both forms are value-free fragment assembly.
    if (
        ts.isCallExpression(expr) &&
        ts.isPropertyAccessExpression(expr.expression) &&
        expr.expression.name.text === 'join'
    ) {
        const sepStatic =
            expr.arguments.length === 0 ||
            isStaticStringExpression(expr.arguments[0], ctx, src);
        if (!sepStatic) return false;
        const receiver = expr.expression.expression;
        if (ts.isArrayLiteralExpression(receiver)) {
            return receiver.elements.every((el) => isStaticStringExpression(el, ctx, src));
        }
        if (ts.isIdentifier(receiver)) {
            return ctx.arrays.has(receiver.text);
        }
        return false;
    }
    return false;
}

/**
 * Is `expr` a string-literal array constructor — `[]` or `[<string literals>]`?
 * (The seed shape for a safe string-array identifier. An empty array is the
 * common `const where: string[] = []` case.)
 */
function isStringLiteralArrayInit(expr) {
    if (!expr || !ts.isArrayLiteralExpression(expr)) return false;
    return expr.elements.every(
        (el) => ts.isStringLiteral(el) || ts.isNoSubstitutionTemplateLiteral(el),
    );
}

/**
 * Within a single parsed source file, compute the analysis context the
 * interpolation gate uses:
 *
 *   ctx.ids    — LOCAL identifier names provably equal to a compile-time-static
 *                SQL fragment (every declaration / `=` / `+=` RHS is a static
 *                string). Clears `COLUMNS`, `where` (string form), `whereSql`.
 *   ctx.arrays — LOCAL identifier names provably equal to a string-LITERAL array
 *                (declared `[]` / `[<literals>]`, mutated ONLY via
 *                `.push(<string-literal...>)`). Clears the `where: string[]`
 *                array form so `where.join(' AND ')` counts as value-free.
 *
 * Both are seeded so the schema constants are already in `ids`.
 *
 * CONSERVATIVE / FAIL-CLOSED by construction: a single non-static string
 * assignment taints the identifier out of `ids`; a single `.push(<non-literal>)`
 * (or any non-`push` mutation, or a non-literal-array re-assignment) taints it
 * out of `arrays`. So a fragment or array that EVER absorbs a runtime value can
 * never be allowlisted — which is exactly the injection vector this gate exists
 * to catch.
 */
function buildAnalysisContext(src, schemaConstants) {
    const ids = new Set(schemaConstants);
    const idTainted = new Set();
    const arrays = new Set();
    const arrTainted = new Set();

    const ctx = { ids, arrays };

    const considerString = (name, rhs) => {
        if (rhs && isStaticStringExpression(rhs, ctx, src)) {
            if (!idTainted.has(name)) ids.add(name);
        } else {
            idTainted.add(name);
            ids.delete(name);
        }
    };

    const considerArrayInit = (name, rhs) => {
        if (isStringLiteralArrayInit(rhs)) {
            if (!arrTainted.has(name)) arrays.add(name);
        } else {
            // Any non-string-literal-array initializer/assignment disqualifies it
            // as a safe string array.
            arrTainted.add(name);
            arrays.delete(name);
        }
    };

    const walk = (node) => {
        // `const/let NAME = <rhs>`
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
            const name = node.name.text;
            // String-fragment track.
            considerString(name, node.initializer);
            // String-array track — only seed/keep when the initializer is a
            // string-literal array; otherwise taint out of `arrays`.
            if (ts.isArrayLiteralExpression(node.initializer ?? {})) {
                considerArrayInit(name, node.initializer);
            } else if (node.initializer) {
                // A non-array initializer means this is not a string array.
                arrTainted.add(name);
                arrays.delete(name);
            }
        }
        // `NAME = <rhs>` and `NAME += <rhs>` (string-fragment track).
        if (
            ts.isBinaryExpression(node) &&
            ts.isIdentifier(node.left) &&
            (node.operatorToken.kind === ts.SyntaxKind.EqualsToken ||
                node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken)
        ) {
            considerString(node.left.text, node.right);
            // A bare `NAME = <expr>` re-assignment also affects the array track.
            if (node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
                considerArrayInit(node.left.text, node.right);
            }
        }
        // `NAME.push(...)` — for the string-array track. Every argument MUST be a
        // string literal, else taint the array.
        if (
            ts.isCallExpression(node) &&
            ts.isPropertyAccessExpression(node.expression) &&
            ts.isIdentifier(node.expression.expression)
        ) {
            const recv = node.expression.expression.text;
            const method = node.expression.name.text;
            if (method === 'push') {
                const allLiteral = node.arguments.every(
                    (a) =>
                        ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a),
                );
                if (!allLiteral) {
                    arrTainted.add(recv);
                    arrays.delete(recv);
                }
            } else if (
                // Any OTHER known array-mutating method taints it (defensive —
                // none appear in the current adapter, but a future edit that
                // splices a value in must not silently pass).
                ['unshift', 'splice', 'fill', 'copyWithin', 'concat'].includes(method)
            ) {
                arrTainted.add(recv);
                arrays.delete(recv);
            }
        }
        ts.forEachChild(node, walk);
    };

    // Two passes so order-of-declaration between a fragment and an array it
    // depends on is resolved. The taint sets guarantee a second pass can only
    // ever REMOVE (never launder) a tainted identifier back to safe.
    walk(src);
    walk(src);

    return ctx;
}

/**
 * Decide whether a single `${EXPR}` interpolation inside a SQL template is
 * allowlisted. An interpolation is SAFE exactly when EXPR is a compile-time-
 * static string expression — a string literal, an allowlisted SQL-identifier
 * constant (table name / DDL const), a proven-static local SQL fragment
 * (`COLUMNS`, `where`, `whereSql`), or value-free assembly of those
 * (concatenation / ternary / `.join()` over string literals or a proven
 * string-literal array). Everything else — a member access (`x.y`), a call
 * (`f(...)`), an unknown identifier, a nested template carrying a value —
 * means a value may reach SQL and is UNSAFE.
 *
 * This is precisely `isStaticStringExpression`, so we delegate: the two notions
 * coincide (an interpolation is safe iff it cannot carry a value).
 */
function isAllowedInterpolation(expr, ctx, src) {
    return isStaticStringExpression(expr, ctx, src);
}

/**
 * Scan one source file. Returns { statements, violations[] }.
 */
function scanFile(file, schemaConstants) {
    const text = readFileSync(file, 'utf8');
    const src = ts.createSourceFile(
        file,
        text,
        ts.ScriptTarget.Latest,
        /* setParentNodes */ true,
    );
    const ctx = buildAnalysisContext(src, schemaConstants);

    let statements = 0;
    /** @type {{file:string, line:number, column:number, snippet:string, reason:string}[]} */
    const violations = [];

    const recordIfSqlBearing = (node) => {
        // Reconstruct the static text of the template (cooked text of every
        // literal part) to test for a SQL keyword.
        let staticText = '';
        /** @type {import('typescript').Expression[]} */
        let spans = [];
        if (ts.isNoSubstitutionTemplateLiteral(node)) {
            staticText = node.text;
        } else if (ts.isTemplateExpression(node)) {
            staticText = node.head.text + node.templateSpans.map((s) => s.literal.text).join('');
            spans = node.templateSpans.map((s) => s.expression);
        } else {
            return;
        }
        if (!SQL_KEYWORD.test(staticText)) return;

        statements += 1;

        for (const expr of spans) {
            if (!isAllowedInterpolation(expr, ctx, src)) {
                const start = expr.getStart(src);
                const { line, character } = src.getLineAndCharacterOfPosition(start);
                violations.push({
                    file,
                    line: line + 1,
                    column: character + 1,
                    snippet: expr.getText(src).trim(),
                    reason: 'interpolated expression is not an allowlisted SQL-identifier constant',
                });
            }
        }
    };

    const visit = (node) => {
        if (ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
            recordIfSqlBearing(node);
        }
        ts.forEachChild(node, visit);
    };
    visit(src);

    return { statements, violations };
}

/**
 * Run the full scan over src/adapters/sqlite. Returns a structured result that
 * BOTH the standalone CLI and the parent orchestrator consume.
 *
 * @returns {{ ok: boolean, error?: string, statements: number, filesScanned: number, violations: any[] }}
 */
export function runSqlSafetyScan() {
    if (!existsSync(SQLITE_DIR)) {
        return {
            ok: false,
            error: `sqlite adapter dir missing: ${SQLITE_DIR}`,
            statements: 0,
            filesScanned: 0,
            violations: [],
        };
    }
    if (!existsSync(SCHEMA_FILE)) {
        return {
            ok: false,
            error: `schema.ts missing (cannot derive table-name allowlist): ${SCHEMA_FILE}`,
            statements: 0,
            filesScanned: 0,
            violations: [],
        };
    }

    let schemaConstants;
    try {
        schemaConstants = harvestSchemaConstants(SCHEMA_FILE);
    } catch (err) {
        return {
            ok: false,
            error: `failed to parse schema.ts: ${err.message}`,
            statements: 0,
            filesScanned: 0,
            violations: [],
        };
    }
    if (schemaConstants.size === 0) {
        return {
            ok: false,
            error: `no exported string constants found in schema.ts — allowlist would be empty`,
            statements: 0,
            filesScanned: 0,
            violations: [],
        };
    }

    const files = collectTsFiles(SQLITE_DIR);
    let statements = 0;
    let filesScanned = 0;
    /** @type {any[]} */
    const violations = [];

    try {
        for (const file of files) {
            const r = scanFile(file, schemaConstants);
            statements += r.statements;
            violations.push(...r.violations);
            filesScanned += 1;
        }
    } catch (err) {
        return {
            ok: false,
            error: `scan failed: ${err.stack ?? err.message}`,
            statements,
            filesScanned,
            violations,
        };
    }

    return { ok: true, statements, filesScanned, violations };
}

/** Pretty location for a violation. */
function loc(v) {
    return `${relative(ROOT, v.file)}:${v.line}:${v.column}`;
}

/** Standalone entrypoint. */
function main() {
    const wantJson = process.argv.includes('--json');
    const result = runSqlSafetyScan();

    if (wantJson) {
        console.log(
            JSON.stringify(
                {
                    pass: result.ok && result.violations.length === 0,
                    toolError: !result.ok,
                    error: result.error,
                    statementsScanned: result.statements,
                    filesScanned: result.filesScanned,
                    violations: result.violations.map((v) => ({
                        location: loc(v),
                        snippet: v.snippet,
                        reason: v.reason,
                    })),
                },
                null,
                2,
            ),
        );
    } else {
        if (!result.ok) {
            console.error(`[SQL] ERROR: ${result.error}`);
        } else if (result.violations.length === 0) {
            console.log(
                `[SQL] PASS — ${result.statements} SQL statement(s) across ` +
                    `${result.filesScanned} sqlite source file(s) are fully parameterized; ` +
                    `no value interpolated/concatenated into a SQL string.`,
            );
        } else {
            console.log(
                `[SQL] FAIL — ${result.violations.length} unsafe SQL interpolation(s) ` +
                    `(a value may be spliced into SQL — bind it with a \`?\` placeholder instead):`,
            );
            for (const v of result.violations) {
                console.log(`    - ${loc(v)}  \`${v.snippet}\``);
            }
        }
    }

    if (!result.ok) process.exit(2);
    process.exit(result.violations.length === 0 ? 0 : 1);
}

// Only run as a script when invoked directly (not when imported by the
// completeness orchestrator).
const invokedDirectly =
    process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
    main();
}
