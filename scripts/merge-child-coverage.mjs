#!/usr/bin/env node
/**
 * Fold child-process coverage into vitest's coverage report.
 *
 * Usage: node scripts/merge-child-coverage.mjs <vitest-final.json> <children-final.json> [out.json]
 *
 * Why: the CLI tests run the built `dist/cli.js` as a child process, and vitest's
 * v8 provider only sees code that runs inside its own workers. Without this,
 * `src/cli.ts` reads as ~14% covered while ~1,900 tests exercise it. CI runs the
 * suite with NODE_V8_COVERAGE set, converts what the children wrote back to
 * `src/` through the source maps (`c8 report`), and merges it here.
 *
 * The merge is strict on purpose. vitest's report is the universe: its
 * statements, branches and functions, and nothing else. c8 counts comment and
 * blank lines inside a covered function as covered, so taking its line set
 * would inflate the number. A statement vitest saw as not run is marked run
 * only when a child process executed the line it starts on. Branches and
 * functions keep vitest's counts, which can only under-report.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const norm = (p) => p.split('\\').join('/').toLowerCase();

/** Lines each child-process file actually executed. */
export function childHitLines(children) {
  const byFile = new Map();
  for (const [file, cov] of Object.entries(children)) {
    const lines = new Set();
    for (const [id, loc] of Object.entries(cov.statementMap ?? {})) {
      if ((cov.s?.[id] ?? 0) > 0) for (let l = loc.start.line; l <= loc.end.line; l++) lines.add(l);
    }
    byFile.set(norm(file), lines);
  }
  return byFile;
}

/** Return a copy of `base` with child-process hits folded into its statements. */
export function mergeChildHits(base, children) {
  const hits = childHitLines(children);
  const out = structuredClone(base);
  let added = 0;
  for (const [file, cov] of Object.entries(out)) {
    const lines = hits.get(norm(file));
    if (!lines) continue;
    for (const [id, loc] of Object.entries(cov.statementMap ?? {})) {
      if ((cov.s[id] ?? 0) === 0 && lines.has(loc.start.line)) {
        cov.s[id] = 1;
        added++;
      }
    }
  }
  return { coverage: out, added };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [basePath, childPath, outPath = basePath] = process.argv.slice(2);
  if (!basePath || !childPath) {
    console.error('usage: merge-child-coverage.mjs <vitest-final.json> <children-final.json> [out.json]');
    process.exit(64);
  }
  const base = JSON.parse(readFileSync(basePath, 'utf8'));
  const children = JSON.parse(readFileSync(childPath, 'utf8'));
  const { coverage, added } = mergeChildHits(base, children);
  writeFileSync(outPath, JSON.stringify(coverage));
  console.log(`merge-child-coverage: ${added} statements covered only by child processes, written to ${outPath}`);
}
