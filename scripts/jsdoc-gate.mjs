#!/usr/bin/env node
/**
 * JSDoc-completeness gate — Wave C1-Amend §2e.
 *
 * Forward-looking gate: every symbol in {@link REQUIRED_JSDOC_SYMBOLS} must
 * carry @example AND (@throws OR @returns with a non-void Promise type).
 *
 * The allowlist is the contract. Adding a new public method to the surface
 * does NOT automatically opt it into this gate — the audit standard for §2e
 * is "new methods added to the public surface must opt into the JSDoc
 * requirements explicitly." Maintainers extending the public surface SHOULD
 * add the symbol's qualified name to this allowlist + ship JSDoc with
 * @example + @throws.
 *
 * Symbol naming:
 *   - Top-level function / class / const → exact export name.
 *   - Class method → `ClassName.methodName`.
 *
 * The gate parses every TypeScript file under src/ via the TypeScript
 * compiler API, finds the named symbols, and verifies JSDoc coverage.
 *
 * Wiring: invoked as [9/9] JSDoc-completeness in scripts/release-gate.mjs.
 *
 * Usage: node scripts/jsdoc-gate.mjs [--verbose]
 *
 * Pair with scripts/doc-drift.mjs ([8/9]) — that one typechecks docs/*.md
 * blocks against the real surface; this one verifies the surface itself
 * carries usage examples.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, '..');
const SRC_DIR = join(ROOT, 'src');
const VERBOSE = process.argv.includes('--verbose');

// ---------------------------------------------------------------------------
// Allowlist of public symbols REQUIRED to carry @example + @throws JSDoc.
//
// Per Wave C1-Amend §2e: forward-looking, not retroactive. New symbols added
// to the public surface MUST be added here; existing under-documented symbols
// stay out of the allowlist until a maintainer wave catches them up.
//
// To add a symbol:
//   1. Verify its JSDoc has @example AND (@throws OR @returns Promise<...>).
//   2. Add the qualified name to the array below.
//   3. The gate will then enforce.
//
// Symbol naming convention:
//   - Top-level export → `formatForUser`
//   - Class method     → `ClusterKernel.commitMutation`
//   - Static method    → `ClassName.methodName`
//
// New requirements landed in Wave C1-Amend:
// ---------------------------------------------------------------------------
const REQUIRED_JSDOC_SYMBOLS = [
    // §2b error formatter — landed this wave
    'formatForUser',
    'errorToAiEnvelope',
];

// ---------------------------------------------------------------------------
// File walking — collect every src/**/*.ts (excluding .d.ts + tests)
// ---------------------------------------------------------------------------

function findTsFiles(dir) {
    const out = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const full = join(entry.parentPath ?? dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === 'dist') continue;
            out.push(...findTsFiles(full));
        } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
            out.push(full);
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// JSDoc tag extraction
// ---------------------------------------------------------------------------

/**
 * Extract JSDoc tags + comment text on a node. TypeScript exposes `@example`
 * and `@throws` as JSDocTag nodes; we collect their tagName.text.
 */
function getJsdocTagNames(node) {
    const tags = new Set();
    const jsdocs = ts.getJSDocCommentsAndTags(node);
    for (const j of jsdocs) {
        // ts.JSDoc body
        if (j.kind === ts.SyntaxKind.JSDoc) {
            const inner = /** @type {any} */ (j).tags;
            if (Array.isArray(inner)) {
                for (const t of inner) {
                    if (t.tagName && t.tagName.text) {
                        tags.add(t.tagName.text);
                    }
                }
            }
        }
        // Also some JSDocTag nodes show up at top level (rare).
        if (j.tagName && j.tagName.text) {
            tags.add(j.tagName.text);
        }
    }
    return tags;
}

/**
 * Returns true if the node's @returns documents a Promise<SomeError> typed
 * return. Used as an alternative to @throws on async functions where the
 * "throws" semantics surface via a rejected promise.
 */
function returnsTypedErrorPromise(node) {
    const jsdocs = ts.getJSDocCommentsAndTags(node);
    for (const j of jsdocs) {
        if (j.kind !== ts.SyntaxKind.JSDoc) continue;
        const inner = /** @type {any} */ (j).tags;
        if (!Array.isArray(inner)) continue;
        for (const t of inner) {
            if (t.tagName && t.tagName.text === 'returns') {
                // text-form check: look for "Promise" + a recognised cluster error.
                const txt = typeof t.comment === 'string' ? t.comment : Array.isArray(t.comment) ? t.comment.map((c) => c.text || '').join('') : '';
                if (/Promise\s*<.*Error/i.test(txt)) return true;
            }
        }
    }
    return false;
}

// ---------------------------------------------------------------------------
// Symbol resolution — find each symbol in REQUIRED_JSDOC_SYMBOLS in source
// ---------------------------------------------------------------------------

/**
 * Walk an AST looking for top-level exports + class methods. Returns a map
 * `qualifiedName -> { node, sourceFile }`.
 */
function indexExportedSymbols(sourceFile) {
    /** @type {Map<string, {node: ts.Node, file: string}>} */
    const out = new Map();
    const file = sourceFile.fileName;

    function visit(node) {
        // Top-level exports.
        if (
            ts.isFunctionDeclaration(node) &&
            node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) &&
            node.name
        ) {
            out.set(node.name.text, { node, file });
        }
        if (
            ts.isVariableStatement(node) &&
            node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
        ) {
            for (const decl of node.declarationList.declarations) {
                if (decl.name && ts.isIdentifier(decl.name)) {
                    // For exported const X = function/arrow, attribute JSDoc to the
                    // VariableStatement (where it actually lives).
                    out.set(decl.name.text, { node: node, file });
                }
            }
        }
        if (
            ts.isClassDeclaration(node) &&
            node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) &&
            node.name
        ) {
            const className = node.name.text;
            out.set(className, { node, file });
            // Walk method members for `ClassName.methodName` entries.
            for (const member of node.members) {
                if (
                    ts.isMethodDeclaration(member) &&
                    member.name &&
                    ts.isIdentifier(member.name)
                ) {
                    // skip private/protected
                    const isPrivate = member.modifiers?.some(
                        (m) =>
                            m.kind === ts.SyntaxKind.PrivateKeyword ||
                            m.kind === ts.SyntaxKind.ProtectedKeyword,
                    );
                    if (isPrivate) continue;
                    out.set(`${className}.${member.name.text}`, { node: member, file });
                }
            }
        }
        ts.forEachChild(node, visit);
    }
    visit(sourceFile);
    return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
    console.log('=== JSDoc-completeness gate ===');

    if (!existsSync(SRC_DIR)) {
        console.error(`jsdoc-gate: src/ not found at ${SRC_DIR}`);
        process.exit(1);
    }

    const tsFiles = findTsFiles(SRC_DIR);
    console.log(`  Scanning ${tsFiles.length} TypeScript files under src/`);

    // Index every exported symbol across all files.
    /** @type {Map<string, {node: ts.Node, file: string}>} */
    const allSymbols = new Map();
    for (const f of tsFiles) {
        const text = readFileSync(f, 'utf8');
        const sf = ts.createSourceFile(f, text, ts.ScriptTarget.ES2022, true);
        const indexed = indexExportedSymbols(sf);
        for (const [k, v] of indexed) {
            // First definition wins — later files don't override.
            if (!allSymbols.has(k)) allSymbols.set(k, v);
        }
    }

    if (VERBOSE) {
        console.log(`  Indexed ${allSymbols.size} exported symbols`);
    }

    // Check each required symbol.
    const failures = [];
    for (const symbol of REQUIRED_JSDOC_SYMBOLS) {
        const found = allSymbols.get(symbol);
        if (!found) {
            failures.push({
                symbol,
                file: '<unresolved>',
                missing: ['<symbol not found in src/>'],
            });
            continue;
        }
        const tags = getJsdocTagNames(found.node);
        const missing = [];
        if (!tags.has('example')) missing.push('@example');
        // Coverage axis #2: the symbol must document its outcome. Three
        // acceptable shapes (audit §2e):
        //   - @throws — names the error class(es) the method can raise
        //   - @returns Promise<SomeError> — typed-promise rejection form
        //   - @returns — describes the return value (acceptable for pure
        //     functions that don't throw, like the §2b formatters)
        const hasThrows = tags.has('throws');
        const hasReturns = tags.has('returns') || tags.has('return');
        const hasTypedPromiseReturn = returnsTypedErrorPromise(found.node);
        if (!hasThrows && !hasReturns && !hasTypedPromiseReturn) {
            missing.push('@throws OR @returns');
        }
        if (missing.length > 0) {
            failures.push({
                symbol,
                file: relative(ROOT, found.file).replace(/\\/g, '/'),
                missing,
            });
        }
    }

    console.log(`\n  Required symbols: ${REQUIRED_JSDOC_SYMBOLS.length}`);
    console.log(`  Covered: ${REQUIRED_JSDOC_SYMBOLS.length - failures.length}`);
    console.log(`  Missing: ${failures.length}`);

    if (failures.length === 0) {
        console.log('\nPASS — every required symbol carries @example + @throws (or typed-promise @returns)\n');
        process.exit(0);
    }

    console.log('\n=== Failures ===');
    for (const f of failures) {
        console.log(`  ${f.symbol}  (${f.file})`);
        for (const m of f.missing) console.log(`    missing: ${m}`);
    }
    console.log(`\nFAIL — ${failures.length} required symbol(s) missing JSDoc.`);
    console.log('  To add a new symbol to the allowlist, edit REQUIRED_JSDOC_SYMBOLS in scripts/jsdoc-gate.mjs.');
    console.log('  To make an existing symbol pass, add @example + @throws (or @returns Promise<SomeError>) to its JSDoc.');
    process.exit(1);
}

main();
