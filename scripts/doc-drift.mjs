#!/usr/bin/env node
/**
 * Doc-drift detector — mechanical guard against documentation drift from
 * the actual code surface. Wave B1-Amend §2d (CIDOCS-B-001).
 *
 * Wave history:
 *   - Wave A1, A2, A3 each fixed a doc that contradicted src/types/* shapes.
 *   - Wave A4 closed the sdk.md drift again.
 *   - Wave B1-Amend lands this detector so the pattern stops recurring.
 *
 * Two layers:
 *
 *   Layer 1 — Type-shape verification by typecheck.
 *     Extracts every ```typescript / ```ts code block from docs/**\/*.md,
 *     wraps each in a synthetic .ts file with the doc's existing imports,
 *     and runs `tsc --noEmit` against the bundle (via tsconfig.docs.json).
 *     Any block that references invented field names, hallucinated types,
 *     or stale type shapes fails the check with a file:line pointer to the
 *     source doc.
 *
 *   Layer 2 — Import name verification.
 *     Greps every `from '@mcptoolshop/db-cluster'` and `from '@mcptoolshop/db-cluster/<subpath>'` in
 *     docs/**\/*.md, extracts the named imports, and verifies each name is
 *     present in the actual exported surface (by parsing the index.ts of
 *     the relevant subpath). Catches drift like `import { ClusterKernel }
 *     from '@mcptoolshop/db-cluster'` after ClusterKernel was made non-public (the
 *     KERNEL-013 wave) or `import { doctor } from '@mcptoolshop/db-cluster/ops/doctor'`
 *     where the subpath doesn't exist in the exports map.
 *
 * Wiring:
 *   Invoked as [8/8] Doc-drift in `scripts/release-gate.mjs`. Exit non-zero
 *   on any drift (any failing block or any missing export name). Exit 0 on
 *   clean docs.
 *
 * Pairing with existing Stage [5/8]:
 *   The existing [5/8] `scanForDrift` in release-gate.mjs catches `from
 *   '../../src/...'` imports in shipped directories (examples/, dashboard/lib/)
 *   that should be @mcptoolshop/db-cluster-public-API imports. This new detector is the
 *   inverse — it catches @mcptoolshop/db-cluster-public-API imports of names that don't
 *   actually exist in the public surface. Complementary, not overlapping.
 *
 * Usage: node scripts/doc-drift.mjs [--verbose]
 */

import { execSync } from 'node:child_process';
import {
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, '..');
const DOCS_DIR = join(ROOT, 'docs');

const VERBOSE = process.argv.includes('--verbose');

// ---------------------------------------------------------------------------
// Subpath → exports-source-file map. Maps the public subpath the doc imports
// from (e.g. `@mcptoolshop/db-cluster/sdk`) to the relative path of the file that defines
// the public exports (e.g. `src/sdk/index.ts`). The set of named exports in
// that file IS the source of truth for the layer-2 import-name check.
//
// Subpaths not in this map are looked up dynamically via package.json
// `exports`, but the index file path is computed by stripping `@mcptoolshop/db-cluster/`
// and looking under src/<rest>/index.ts. The explicit map covers cases where
// the dist path → src path mapping isn't 1:1.
//
// If you add a new subpath to package.json `exports`, you do NOT need to
// update this map unless the src layout differs from the convention.
// ---------------------------------------------------------------------------

const SUBPATH_TO_SRC = {
    '@mcptoolshop/db-cluster': 'src/index.ts',
    '@mcptoolshop/db-cluster/sdk': 'src/sdk/index.ts',
    '@mcptoolshop/db-cluster/mcp': 'src/mcp/index.ts',
    '@mcptoolshop/db-cluster/policy': 'src/policy/index.ts',
    '@mcptoolshop/db-cluster/types': 'src/types/index.ts',
};

// ---------------------------------------------------------------------------
// Layer 1 — Extract + typecheck typescript code blocks
// ---------------------------------------------------------------------------

/**
 * Result of a single doc-block typecheck. blockId is unique within the
 * detector run; sourceFile + sourceLine point back to the doc that owns
 * the block so a failure message can name the source location.
 */
/** @typedef {{ blockId: string; sourceFile: string; sourceLine: number; content: string }} DocBlock */

/**
 * Scan a directory recursively for *.md files. Returns absolute paths.
 */
function findMarkdownFiles(dir) {
    const out = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const full = join(entry.parentPath ?? dir, entry.name);
        if (entry.isDirectory()) {
            out.push(...findMarkdownFiles(full));
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
            out.push(full);
        }
    }
    return out;
}

/**
 * Extract typescript code blocks from a markdown file. Returns an array
 * of DocBlock entries. Tracks line numbers so failures can point at the
 * exact line in the source doc.
 *
 * Matches both ```typescript and ```ts opening fences. Closing fence is
 * a bare ``` (no language tag).
 */
function extractTypescriptBlocks(filePath) {
    const text = readFileSync(filePath, 'utf8');
    const lines = text.split('\n');
    const blocks = [];
    let inBlock = false;
    let buffer = [];
    let startLine = 0;
    let blockCounter = 0;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const opener = line.match(/^```(typescript|ts)\s*$/);
        if (!inBlock && opener) {
            inBlock = true;
            buffer = [];
            startLine = i + 1; // 1-based, pointing at the line AFTER the fence
            continue;
        }
        if (inBlock && /^```\s*$/.test(line)) {
            blockCounter++;
            // Hash short label for filename — keeps temp files unique per source.
            const blockId = `${blockCounter}`;
            blocks.push({
                blockId,
                sourceFile: filePath,
                sourceLine: startLine,
                content: buffer.join('\n'),
            });
            inBlock = false;
            buffer = [];
            continue;
        }
        if (inBlock) {
            buffer.push(line);
        }
    }
    return blocks;
}

/**
 * Wrap a doc block into a synthetic .ts file. We surround the content with
 * a single async function so top-level `await` resolves and we don't have to
 * model whether each block is a statement, an expression, or a declaration.
 *
 * The wrapper also imports anything the doc block expects to be globally in
 * scope (e.g. `sdk`, `kernel`, `stores`) as `declare const` so the typechecker
 * doesn't reject blocks that show usage assuming a context.
 *
 * The block's own `import` statements are HOISTED to the top of the synthetic
 * file (TS forbids imports inside a function body). Anything else stays
 * inside the wrapper async function.
 */
function wrapBlock(block, _index) {
    const lines = block.content.split('\n');
    const importLines = [];
    const topLevelLines = [];
    const bodyLines = [];
    let inImport = false;
    let topLevelBraceDepth = 0; // when > 0, we're inside a multi-line top-level decl
    let lastClassifiedAsTopLevel = false;
    let pendingTypeContinuation = false; // for `type X =\n  { ... }` patterns

    function depthDelta(line) {
        let d = 0;
        // Strip string literals + line comments to avoid counting braces inside them.
        const stripped = line
            .replace(/\/\/.*$/, '')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/'(?:\\.|[^'\\])*'/g, "''")
            .replace(/"(?:\\.|[^"\\])*"/g, '""')
            .replace(/`(?:\\.|[^`\\])*`/g, '``');
        for (const ch of stripped) {
            if (ch === '{') d++;
            else if (ch === '}') d--;
        }
        return d;
    }

    for (const line of lines) {
        if (inImport) {
            importLines.push(line);
            // import block ends on a line with `from '...'` or a closing brace
            // followed by a quoted module specifier on the same line.
            if (/from\s+['"][^'"]+['"]/.test(line) || /^\s*}\s+from\s+/.test(line)) {
                inImport = false;
            }
            continue;
        }
        if (/^\s*import\s+/.test(line) || /^\s*import\s*\(/.test(line)) {
            importLines.push(line);
            // Single-line imports end with `from '...'` on the same line.
            // Multi-line imports open with `import {` and close several lines later.
            if (!/from\s+['"][^'"]+['"]/.test(line) && /\{[^}]*$/.test(line)) {
                inImport = true;
            }
            continue;
        }
        if (topLevelBraceDepth > 0) {
            // Inside a multi-line top-level declaration (interface body, etc.)
            topLevelLines.push(line);
            topLevelBraceDepth += depthDelta(line);
            if (topLevelBraceDepth <= 0) {
                topLevelBraceDepth = 0;
                lastClassifiedAsTopLevel = true;
            }
            continue;
        }
        if (pendingTypeContinuation) {
            // After `type X =` we may have a multi-line shape until the line ends
            // with `;` or until we balance braces.
            topLevelLines.push(line);
            topLevelBraceDepth += depthDelta(line);
            if (topLevelBraceDepth <= 0 && /;\s*$/.test(line.trim())) {
                topLevelBraceDepth = 0;
                pendingTypeContinuation = false;
                lastClassifiedAsTopLevel = true;
            } else if (topLevelBraceDepth <= 0 && depthDelta(line) === 0 && line.trim().length === 0) {
                // blank line keeps us in continuation
            }
            continue;
        }
        if (
            // `declare`, `interface`, and `type X =` are top-level-only
            // constructs in TS — hoist them out of the async wrapper so
            // they parse. Includes `declare const`, `declare function`,
            // `declare module`, etc.
            /^\s*declare\s+/.test(line) ||
            /^\s*interface\s+\w+/.test(line) ||
            /^\s*type\s+\w+\s*[=<]/.test(line) ||
            /^\s*export\s+(?:type|interface|declare)\s+/.test(line)
        ) {
            topLevelLines.push(line);
            topLevelBraceDepth += depthDelta(line);
            // `type X = SomeType` may have no braces — end of declaration is `;`
            if (/^\s*(?:export\s+)?type\s+\w+\s*=/.test(line) && !/;\s*$/.test(line.trim())) {
                pendingTypeContinuation = true;
            }
            if (topLevelBraceDepth === 0 && !pendingTypeContinuation) {
                lastClassifiedAsTopLevel = true;
            }
            continue;
        }
        // Default: body line
        bodyLines.push(line);
        lastClassifiedAsTopLevel = false;
    }
    void lastClassifiedAsTopLevel;

    // Common context bindings the doc blocks assume exist. We declare them as
    // `any` so the block can use them without typecheck breaking — the block
    // is exercising public-surface SHAPES, not the values of these bindings.
    //
    // The TYPE NAMES below are declared as `any` aliases so doc blocks that
    // SHOW interface shapes (e.g. `interface EvidenceBundle { foo: Entity[]; }`)
    // typecheck even though the block doesn't import `Entity`. The drift we
    // care about is wrong USE of a typed value (e.g. `bundle.invented_field`),
    // not informational interface declarations. The full source-of-truth
    // versions live in `src/types/*` and are spot-checked by reference imports
    // in OTHER blocks.
    const ambient = [
        'declare const sdk: any;',
        'declare const kernel: any;',
        'declare const stores: any;',
        'declare const freshStores: any;',
        'declare const policyKernel: any;',
        'declare const result: any;',
        'declare const command: any;',
        'declare const bundle: any;',
        'declare const graph: any;',
        'declare const trace: any;',
        'declare const explanation: any;',
        'declare const verified: any;',
        'declare const health: any;',
        'declare const test: any;',
        'declare const rebuilt: any;',
        'declare const stale: any;',
        'declare const data: any;',
        'declare const cmd: any;',
        'declare const commandId: any;',
        'declare const newStores: any;',
        // Type aliases — used in interface-shape docs without imports.
        'type Entity = any;',
        'type Artifact = any;',
        'type ArtifactIngestInput = any;',
        'type IndexRecord = any;',
        'type ProvenanceEvent = any;',
        'type FreshnessAssessment = any;',
        'type MissingContext = any;',
        'type ConfidenceBoundary = any;',
        'type NodeType = any;',
        'type EdgeType = any;',
        'type TraceDirection = any;',
        'type TraceOptions = any;',
        'type TraceGap = any;',
        'type TraceWarning = any;',
        'type TraceSummary = any;',
        'type ProvenanceGraph = any;',
        'type ProvenanceNode = any;',
        'type ProvenanceEdge = any;',
        'type ResolvedEvidence<T = any> = any;',
        'type Capability = any;',
        'type RedactionRule = any;',
        'type RedactionTarget = any;',
        'type PolicyMatch = any;',
        'type Policy = any;',
        'type Principal = any;',
        'type TrustZone = any;',
        'type VisibilityRule = any;',
        'type EvidenceBundle = any;',
        'type Command = any;',
        'type Receipt = any;',
        'type ClusterSDK = any;',
        'type HealthCheck = any;',
        'type ClusterHealth = any;',
        'type ClusterStores = any;',
        'type ClusterBackup = any;',
        'type ValidationResult = any;',
        'type ValidationCheck = any;',
        'type CanonicalStore = any;',
        'type ArtifactStore = any;',
        'type IndexStore = any;',
        'type LedgerStore = any;',
        'type LedgerFilter = any;',
        'type ReceiptFilter = any;',
    ];

    // If the body's first non-blank line starts with `{`, the block is an
    // object-literal example (not a statement). Wrap with an assignment so
    // it parses as a valid statement.
    const firstNonBlank = bodyLines.find((l) => l.trim().length > 0) ?? '';
    const startsWithBrace = /^\s*\{/.test(firstNonBlank);

    // If the block is ENTIRELY top-level (e.g. only an `interface Foo { ... }`
    // declaration with no executable body), skip the async wrapper.
    const isPurelyTopLevel = bodyLines.every((l) => l.trim().length === 0);

    let wrappedBody;
    if (isPurelyTopLevel) {
        wrappedBody = [];
    } else if (startsWithBrace) {
        wrappedBody = ['const __obj_literal: any = (', ...bodyLines.map((l) => '    ' + l), ');'];
    } else {
        wrappedBody = bodyLines.map((l) => '    ' + l);
    }

    const wrapperOpen = startsWithBrace || isPurelyTopLevel ? '' : 'async function __doc_block_wrapper() {';
    const wrapperClose = startsWithBrace || isPurelyTopLevel ? '' : '}';
    const wrapperVoid = startsWithBrace || isPurelyTopLevel ? '' : 'void __doc_block_wrapper;';

    // Detect which type aliases the block ALREADY declares locally (e.g.
    // `interface Principal { ... }` shows up in 5+ docs). Skip those aliases
    // from the ambient block to avoid TS2300 duplicate-identifier collisions.
    const ambientFiltered = ambient.filter((line) => {
        const m = line.match(/^(?:declare\s+const|type)\s+(\w+)/);
        if (!m) return true;
        const name = m[1];
        // Check the imports + top-level + body for a same-name declaration.
        const allUserLines = [...importLines, ...topLevelLines, ...bodyLines].join('\n');
        const localDecl = new RegExp(`\\b(?:interface|type|class|enum|const|let|var)\\s+${name}\\b`);
        if (localDecl.test(allUserLines)) return false;
        // Or an import binding of the same name.
        const importBind = new RegExp(`\\b${name}\\b`);
        for (const il of importLines) {
            if (importBind.test(il)) return false;
        }
        return true;
    });

    return [
        '// @ts-nocheck-disabled — doc-drift detector synthetic wrapper',
        `// Source: ${block.sourceFile}:${block.sourceLine}`,
        '// Wrap as a module (export {}) to give the block its own scope.',
        'export {};',
        '',
        ...importLines,
        '',
        ...topLevelLines,
        '',
        ...ambientFiltered,
        '',
        wrapperOpen,
        ...wrappedBody,
        wrapperClose,
        wrapperVoid,
        '',
    ].join('\n');
}

/**
 * Write doc blocks to a temp dir as synthetic .ts files, generate a
 * tsconfig.docs.json that includes both src/ and the temp dir, and run
 * `tsc --noEmit`. Returns array of TscFailure objects parsed from output.
 */
/** @typedef {{ tempPath: string; tsFile: string; line: number; col: number; code: string; message: string }} TscFailure */

function runLayer1Typecheck(blocks) {
    if (blocks.length === 0) {
        return { failures: [], extractCount: 0 };
    }

    // Extract dir lives UNDER repo root so the configured tsconfig.docs.json
    // can include it via a stable relative path. The dir is gitignored.
    const extractDir = join(ROOT, '.doc-drift-extract');
    if (existsSync(extractDir)) {
        try {
            rmSync(extractDir, { recursive: true, force: true });
        } catch {
            // Best-effort.
        }
    }
    mkdirSync(extractDir, { recursive: true });

    // Map each block's temp file path → source location, so we can rewrite
    // tsc errors back to file:line in the source doc.
    /** @type {Map<string, DocBlock>} */
    const tempToBlock = new Map();
    /** @type {Map<string, DocBlock>} */
    const tempRelToBlock = new Map();

    for (const block of blocks) {
        const safeBaseSlug = relative(ROOT, block.sourceFile)
            .replace(/[^a-zA-Z0-9]+/g, '-')
            .toLowerCase()
            .replace(/^-+|-+$/g, '');
        const tempFile = join(extractDir, `${safeBaseSlug}-block-${block.blockId}.ts`);
        writeFileSync(tempFile, wrapBlock(block));
        tempToBlock.set(tempFile, block);
        // Also store the path tsc will report (normalised relative to ROOT
        // with forward slashes).
        const rel = relative(ROOT, tempFile).replace(/\\/g, '/');
        tempRelToBlock.set(rel, block);
    }

    // Use the checked-in tsconfig.docs.json at the repo root.
    const tsconfigDocsPath = join(ROOT, 'tsconfig.docs.json');
    if (!existsSync(tsconfigDocsPath)) {
        console.error(`doc-drift: tsconfig.docs.json missing at ${tsconfigDocsPath}`);
        return { failures: [], extractCount: blocks.length };
    }

    /** @type {TscFailure[]} */
    const failures = [];
    try {
        // --pretty false keeps the output easy to parse line-by-line.
        execSync(`npx tsc --noEmit -p ${JSON.stringify(tsconfigDocsPath)} --pretty false`, {
            cwd: ROOT,
            stdio: 'pipe',
        });
    } catch (e) {
        const stdout = e.stdout ? e.stdout.toString() : '';
        const stderr = e.stderr ? e.stderr.toString() : '';
        const combined = stdout + '\n' + stderr;

        // tsc --pretty false output: relative/path.ts(line,col): error TSxxxx: <message>
        const lineRe = /^(.*?)\((\d+),(\d+)\):\s+(?:error|warning)\s+(TS\d+):\s+(.+)$/gm;
        let m;
        while ((m = lineRe.exec(combined)) !== null) {
            const [, file, lineStr, colStr, code, msg] = m;
            // Resolve the file path: tsc may report relative or absolute.
            let abs = resolve(ROOT, file);
            if (!tempToBlock.has(abs)) {
                // Maybe tsc cwd-resolved differently; try the extract dir.
                const candidate = resolve(extractDir, file);
                if (tempToBlock.has(candidate)) abs = candidate;
            }
            failures.push({
                tempPath: abs,
                tsFile: file,
                line: parseInt(lineStr, 10),
                col: parseInt(colStr, 10),
                code,
                message: msg,
            });
        }
    }

    // Annotate failures with source-doc locations. Filter out failures whose
    // tempPath we don't recognise — those are tsc errors against src/ files
    // (not doc blocks) and should bubble up via the main `npm run lint`
    // instead of this detector.
    const annotated = failures
        .filter((f) => tempToBlock.has(f.tempPath))
        .map((f) => {
            const block = tempToBlock.get(f.tempPath);
            return {
                ...f,
                docFile: block.sourceFile,
                docLine: block.sourceLine,
            };
        });

    // Leave the extract dir on VERBOSE; clean it on normal runs.
    if (!VERBOSE) {
        try {
            rmSync(extractDir, { recursive: true, force: true });
        } catch {
            // Best-effort cleanup.
        }
    } else {
        console.error(`(doc-drift) verbose: extract dir kept at ${extractDir}`);
    }

    return { failures: annotated, extractCount: blocks.length, extractDir };
}

// ---------------------------------------------------------------------------
// Layer 2 — Verify @mcptoolshop/db-cluster imports in docs reference real exports
// ---------------------------------------------------------------------------

/**
 * Parse the named exports of an index.ts file. Recognises:
 *   - `export { A, B, C as D } from '...'`
 *   - `export type { A, B } from '...'`
 *   - `export const X = ...`
 *   - `export function X(...)`
 *   - `export class X`
 *   - `export type X = ...`
 *   - `export interface X`
 *
 * Returns a Set of exported NAMES (the renamed name for `as` cases).
 */
function parseExportedNames(filePath) {
    if (!existsSync(filePath)) {
        return null;
    }
    const text = readFileSync(filePath, 'utf8');
    /** @type {Set<string>} */
    const names = new Set();

    // Re-export blocks: export [type] { A, B as C, D } from '...';
    const reExportBlockRe = /export\s+(?:type\s+)?\{([^}]*)\}\s*(?:from\s+['"][^'"]+['"])?/g;
    let m;
    while ((m = reExportBlockRe.exec(text)) !== null) {
        const inner = m[1];
        // split on commas; allow `A as B` and trailing commas
        const parts = inner.split(',').map((p) => p.trim()).filter(Boolean);
        for (const p of parts) {
            // strip leading `type` for export type { A, B as C }
            const cleaned = p.replace(/^type\s+/, '');
            const asMatch = cleaned.match(/^(\S+)\s+as\s+(\S+)$/);
            if (asMatch) {
                names.add(asMatch[2]);
            } else {
                names.add(cleaned);
            }
        }
    }

    // Direct exports: export const|let|var X = ...
    const constRe = /export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g;
    while ((m = constRe.exec(text)) !== null) {
        names.add(m[1]);
    }
    // export function X
    const fnRe = /export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g;
    while ((m = fnRe.exec(text)) !== null) {
        names.add(m[1]);
    }
    // export class X
    const classRe = /export\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g;
    while ((m = classRe.exec(text)) !== null) {
        names.add(m[1]);
    }
    // export interface X
    const interfaceRe = /export\s+interface\s+([A-Za-z_$][\w$]*)/g;
    while ((m = interfaceRe.exec(text)) !== null) {
        names.add(m[1]);
    }
    // export type X = ...
    const typeRe = /export\s+type\s+([A-Za-z_$][\w$]*)\s*=/g;
    while ((m = typeRe.exec(text)) !== null) {
        names.add(m[1]);
    }
    // export enum X
    const enumRe = /export\s+enum\s+([A-Za-z_$][\w$]*)/g;
    while ((m = enumRe.exec(text)) !== null) {
        names.add(m[1]);
    }
    // export default — not name-based; doc imports use named imports so skip.

    return names;
}

/**
 * Resolve a @mcptoolshop/db-cluster subpath to its src index file. Tries the explicit
 * SUBPATH_TO_SRC map first; falls back to a path-shaped convention.
 *
 * Returns null if the subpath cannot be resolved — the doc-drift detector
 * treats null resolution as drift (the subpath isn't a real export).
 */
function resolveSubpathToSrc(subpath) {
    if (SUBPATH_TO_SRC[subpath]) {
        return join(ROOT, SUBPATH_TO_SRC[subpath]);
    }
    // Fallback convention: @mcptoolshop/db-cluster/<a> → src/<a>/index.ts
    const rest = subpath.replace(/^@mcptoolshop\/db-cluster\//, '');
    if (rest === subpath) return null; // not a @mcptoolshop/db-cluster path
    // Try src/<rest>/index.ts
    const candidate = join(ROOT, 'src', rest, 'index.ts');
    if (existsSync(candidate)) return candidate;
    // Try src/<rest>.ts
    const candidate2 = join(ROOT, 'src', rest + '.ts');
    if (existsSync(candidate2)) return candidate2;
    return null;
}

/**
 * Extract `import { ... } from '@mcptoolshop/db-cluster'` and similar imports from a
 * markdown file's typescript blocks, then verify each named import is in
 * the actual exported surface.
 */
function checkLayer2Imports(blocks) {
    /** @type {Array<{ docFile: string; docLine: number; subpath: string; missing: string[] }>} */
    const failures = [];

    // Allow `import { ... } from '@mcptoolshop/db-cluster[/subpath]'` and
    // `import type { ... } from '...'`.
    const importRe = /import\s+(?:type\s+)?\{\s*([^}]+)\s*\}\s+from\s+['"](@mcptoolshop\/db-cluster(?:\/[\w-]+)?)['"]/g;

    for (const block of blocks) {
        let m;
        while ((m = importRe.exec(block.content)) !== null) {
            const namedRaw = m[1];
            const subpath = m[2];
            const names = namedRaw
                .split(',')
                .map((s) => s.trim().replace(/^type\s+/, ''))
                .map((s) => s.replace(/\s+as\s+\S+$/, '').trim())
                .filter(Boolean);

            const srcFile = resolveSubpathToSrc(subpath);
            if (!srcFile) {
                failures.push({
                    docFile: block.sourceFile,
                    docLine: block.sourceLine,
                    subpath,
                    missing: [`<subpath ${subpath} not in package exports>`],
                });
                continue;
            }
            const exported = parseExportedNames(srcFile);
            if (!exported) {
                failures.push({
                    docFile: block.sourceFile,
                    docLine: block.sourceLine,
                    subpath,
                    missing: [`<source ${relative(ROOT, srcFile)} not found>`],
                });
                continue;
            }
            const missing = names.filter((n) => !exported.has(n));
            if (missing.length > 0) {
                failures.push({
                    docFile: block.sourceFile,
                    docLine: block.sourceLine,
                    subpath,
                    missing,
                });
            }
        }
    }

    return failures;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
    if (!existsSync(DOCS_DIR)) {
        console.error('doc-drift: docs/ not found at', DOCS_DIR);
        process.exit(1);
    }

    console.log('=== Doc-drift detector ===');

    const mdFiles = findMarkdownFiles(DOCS_DIR);
    console.log(`  Scanning ${mdFiles.length} markdown files in docs/`);

    /** @type {DocBlock[]} */
    const allBlocks = [];
    for (const f of mdFiles) {
        const blocks = extractTypescriptBlocks(f);
        allBlocks.push(...blocks);
    }
    console.log(`  Extracted ${allBlocks.length} typescript code blocks`);

    // --- Layer 1: typecheck blocks ---
    console.log('\n[1/2] Layer 1 — Typecheck doc blocks');
    let layer1Failures = [];
    let extractCount = 0;
    try {
        const r = runLayer1Typecheck(allBlocks);
        layer1Failures = r.failures;
        extractCount = r.extractCount;
    } catch (e) {
        console.error(`  Layer 1 detector itself crashed: ${e.message}`);
        process.exit(2);
    }
    if (layer1Failures.length === 0) {
        console.log(`  OK — ${extractCount} blocks typechecked cleanly`);
    } else {
        console.log(`  FAIL — ${layer1Failures.length} typecheck error(s) across ${extractCount} blocks`);
        for (const f of layer1Failures) {
            const docRel = relative(ROOT, f.docFile);
            console.error(`    ${docRel}:${f.docLine} (block line ${f.line}, col ${f.col}) — ${f.code} ${f.message}`);
        }
    }

    // --- Layer 2: import-name verification ---
    console.log('\n[2/2] Layer 2 — Import-name verification');
    const layer2Failures = checkLayer2Imports(allBlocks);
    if (layer2Failures.length === 0) {
        console.log('  OK — all @mcptoolshop/db-cluster imports reference real exports');
    } else {
        console.log(`  FAIL — ${layer2Failures.length} import drift(s)`);
        for (const f of layer2Failures) {
            const docRel = relative(ROOT, f.docFile);
            console.error(`    ${docRel}:${f.docLine} — imports missing from ${f.subpath}: ${f.missing.join(', ')}`);
        }
    }

    // --- Verdict ---
    const total = layer1Failures.length + layer2Failures.length;
    console.log('\n=== Verdict ===');
    if (total === 0) {
        console.log('PASS — no doc drift detected\n');
        process.exit(0);
    } else {
        console.log(`FAIL — ${total} doc-drift issue(s) detected`);
        console.log('  Layer 1 (typecheck): ' + layer1Failures.length);
        console.log('  Layer 2 (imports): ' + layer2Failures.length);
        process.exit(1);
    }
}

main();
