/**
 * Every exit-code table agrees with the CLI's map.
 *
 * `typedErrorToExitCode` in src/cli.ts decides the exit code. Five other
 * places restate it: the table `--help-exit-codes` prints, the copy in
 * cli.ts's header comment, docs/cli.md, the runbooks index, and the site
 * handbook's CLI page. The earlier checks only looked for a handful of
 * codes, so the tables drifted. docs/cli.md gave PROVENANCE_MISSING as 70
 * (the CLI exits 1), LEDGER_CYCLE_DETECTED as 65 (70) and
 * BUFFER_SIDE_CHANNEL_NOT_SUPPORTED as 1 (70); the runbooks repeated two of
 * those; and several codes, including 73's BACKUP_TARGET_EXISTS, appeared in
 * no summary table at all. This file derives the map from the source and
 * requires every table to list every code, at its exit, and nothing else.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const cliSource = readFileSync(join(ROOT, 'src', 'cli.ts'), 'utf8');

/** code → exit, parsed from the `case 'CODE': return N;` arms. */
function cliMap(): Map<string, number> {
    const start = cliSource.indexOf('export function typedErrorToExitCode');
    const end = cliSource.indexOf('default: return 1;', start);
    const body = cliSource.slice(start, end);
    return new Map(
        [...body.matchAll(/case '([A-Z_]+)': return (\d+);/g)].map((m) => [m[1], Number(m[2])]),
    );
}

const MAP = cliMap();

type Listing = Map<string, number[]>;

function add(listing: Listing, code: string, exit: number): void {
    listing.set(code, [...(listing.get(code) ?? []), exit]);
}

/**
 * A grouped table: `| <exit> | <sysexits> | CODE, CODE |`, where a blank exit
 * cell continues the row above. Header and separator rows are skipped.
 */
function groupedTable(lines: string[]): Listing {
    const listing: Listing = new Map();
    let exit: number | undefined;
    for (const line of lines) {
        const cells = line.split('|');
        if (cells.length < 4) continue;
        const first = cells[1].trim().replace(/`/g, '');
        if (/^\d+$/.test(first)) exit = Number(first);
        else if (first !== '') continue;
        if (exit === undefined) continue;
        for (const [code] of cells[3].matchAll(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g)) add(listing, code, exit);
    }
    return listing;
}

/** A Markdown section, from its `## ` heading up to the next one. */
function section(md: string, heading: RegExp): string {
    const start = md.search(heading);
    expect(start, `heading ${heading} not found`).toBeGreaterThan(-1);
    const rest = md.slice(start + 1);
    const next = rest.search(/^## /m);
    return next === -1 ? rest : rest.slice(0, next);
}

/** Everything a table gets wrong against the CLI's map. */
function drift(listing: Listing): string[] {
    const problems: string[] = [];
    for (const [code, exit] of MAP) {
        const listed = listing.get(code);
        if (!listed) problems.push(`${code}: missing (the CLI exits ${exit})`);
        else if (listed.some((e) => e !== exit)) problems.push(`${code}: listed as ${listed.join(' and ')}, the CLI exits ${exit}`);
    }
    for (const code of listing.keys()) {
        if (!MAP.has(code)) problems.push(`${code}: listed, but the CLI has no such code`);
    }
    return problems;
}

describe('exit-code tables agree with typedErrorToExitCode', () => {
    it('the map parses (a broken parse must not pass as agreement)', () => {
        expect(MAP.size).toBeGreaterThanOrEqual(30);
        expect(MAP.get('POLICY_DENIED')).toBe(77);
        expect(MAP.get('BACKUP_TARGET_EXISTS')).toBe(73);
    });

    it('the table --help-exit-codes prints', () => {
        const start = cliSource.indexOf('const EXIT_CODE_TABLE = [');
        const end = cliSource.indexOf("].join('\\n');", start);
        expect(start).toBeGreaterThan(-1);
        const lines = [...cliSource.slice(start, end).matchAll(/^\s*'(.*)',$/gm)].map((m) => m[1]);
        expect(drift(groupedTable(lines))).toEqual([]);
    });

    it("the copy in cli.ts's header comment", () => {
        const header = cliSource.slice(0, cliSource.indexOf('*/'));
        const lines = header.split('\n').map((l) => l.replace(/^\s*\*\s?/, ''));
        expect(drift(groupedTable(lines))).toEqual([]);
    });

    it('docs/cli.md', () => {
        const md = readFileSync(join(ROOT, 'docs', 'cli.md'), 'utf8');
        const listing: Listing = new Map();
        for (const m of section(md, /^## Exit Codes/m).matchAll(/^\| `([A-Z_]+)` \| `(\d+)` \|/gm)) {
            add(listing, m[1], Number(m[2]));
        }
        expect(drift(listing)).toEqual([]);
    });

    it('the runbooks index', () => {
        const md = readFileSync(join(ROOT, 'docs', 'runbooks', 'README.md'), 'utf8');
        expect(drift(groupedTable(section(md, /^## CLI exit-code mapping/m).split('\n')))).toEqual([]);
    });

    it("the site handbook's CLI page", () => {
        const md = readFileSync(join(ROOT, 'site', 'src', 'content', 'docs', 'handbook', 'cli.md'), 'utf8');
        expect(drift(groupedTable(section(md, /^## Exit codes/m).split('\n')))).toEqual([]);
    });
});
