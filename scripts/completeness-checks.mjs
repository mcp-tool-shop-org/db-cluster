#!/usr/bin/env node
/**
 * completeness-checks.mjs — mechanical completeness gates.
 *
 * Runs the 5 ast-grep rules in `scripts/checks/` against the source tree
 * and prints a summary table. Exit 0 iff every rule reports zero matches.
 *
 * Rule index:
 *   R1 — kernel-underscore-access       (SURFACE-R001 regression net)
 *   R2 — index-clear-then-loop          (KERNEL-R2-003 regression net)
 *   R3 — raw-cluster-resolver-instantiation
 *   R4 — switch-on-resolved-store-incomplete   (case-completeness gate)
 *   R5 — optional-import-contract-method       (STORES-R2-002 regression net)
 *   R6 — content-read-without-hash-check       (PROV-001 regression net)
 *   R7 — update-mutation-without-previous      (PROV-002 lineage regression net)
 *   R8 — ledger-append-without-integrity-stamp (PROV-004 regression net)
 *
 * R4 has a post-process step: ast-grep reports every switch on `*.store`,
 * then this script asserts that the matched text contains all 5 case
 * labels (canonical, artifact, ledger, receipt, index). Matches with the
 * full set are dropped; matches missing any label remain as failures.
 *
 * Run:
 *   node scripts/completeness-checks.mjs
 *   node scripts/completeness-checks.mjs --json
 *
 * Exit codes:
 *   0 — every rule passes (0 effective matches)
 *   1 — at least one rule has effective matches
 *   2 — ast-grep itself errored (bad rule file, missing CLI, etc.)
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const CHECKS_DIR = join(__dirname, 'checks');

const REQUIRED_STORE_CASES = ['canonical', 'artifact', 'ledger', 'receipt', 'index'];

const RULES = [
    {
        id: 'R1',
        file: 'R1-kernel-underscore-access.yml',
        label: 'kernel._kernel access outside test/',
    },
    {
        id: 'R2',
        file: 'R2-index-clear-then-loop.yml',
        label: 'index.clear() then index() loop in same function',
    },
    {
        id: 'R3',
        file: 'R3-raw-cluster-resolver-instantiation.yml',
        label: 'raw `new ClusterResolver(...)` outside SDK',
    },
    {
        id: 'R4',
        file: 'R4-switch-on-resolved-store-incomplete.yml',
        label: 'switch on *.store missing one of the 5 cases',
        postProcess: postProcessSwitchCompleteness,
    },
    {
        id: 'R5',
        file: 'R5-optional-import-contract-method.yml',
        label: 'optional importSnapshot/importEvent/importReceipt in contracts',
    },
    {
        id: 'R6',
        file: 'R6-content-read-without-hash-check.yml',
        label: 'getContent-shaped read without an adjacent sha256 integrity check (PROV-001)',
    },
    {
        id: 'R7',
        file: 'R7-update-mutation-without-previous.yml',
        label: "update_entity mutation_committed detail missing `previous` lineage key (PROV-002)",
    },
    {
        id: 'R8',
        file: 'R8-ledger-append-without-integrity-stamp.yml',
        label: 'ledger append/appendReceipt persisting without computeIntegrityHash stamp (PROV-004)',
    },
    {
        id: 'R9',
        file: 'R9-sdk-artifact-without-sanitize.yml',
        label: 'SDK method forwarding an Artifact (findSources/retrieveBundle) without sanitizeArtifactForOutput (REDACT-001)',
    },
    {
        id: 'R10',
        file: 'R10-path-scrub-regex-outside-redactor.yml',
        label: 'hand-rolled path-scrub RegExp literal outside src/policy/redactor.ts (REDACT-002)',
    },
    {
        id: 'R11',
        file: 'R11-snippet-without-integrity-read.yml',
        label: 'retrieval buildSnippet building a content excerpt without the integrity-checked getContent path (RETR-004/PROV-001)',
    },
    {
        id: 'R12',
        file: 'R12-retrieval-without-ranking.yml',
        label: 'RetrievalPlanner.plan assembling a bundle without consuming rankByBM25 (RETR-001)',
    },
    {
        id: 'R13',
        file: 'R13-version-read-without-per-element-redaction.yml',
        label: 'policed listEntityVersions/listArtifactVersions without per-element evaluatePolicy redaction (VERSIONS-001)',
    },
];

/**
 * Drop matches whose body contains every required case label.
 * Keep matches that are missing at least one case (incomplete switches).
 */
function postProcessSwitchCompleteness(matches) {
    const incomplete = [];
    for (const m of matches) {
        const text = m.text ?? m.lines ?? '';
        const missing = REQUIRED_STORE_CASES.filter(
            (label) => !text.includes(`'${label}'`) && !text.includes(`"${label}"`),
        );
        if (missing.length > 0) {
            incomplete.push({ ...m, missingCases: missing });
        }
    }
    return incomplete;
}

function runRule(rule) {
    const rulePath = join(CHECKS_DIR, rule.file);
    if (!existsSync(rulePath)) {
        return { ok: false, error: `rule file missing: ${rulePath}`, matches: [] };
    }
    const result = spawnSync(
        'npx',
        ['ast-grep', 'scan', '--rule', rulePath, '--json'],
        {
            cwd: ROOT,
            encoding: 'utf8',
            shell: process.platform === 'win32',
            // ast-grep emits the JSON array on stdout regardless of findings;
            // diagnostics go to stderr. We always parse stdout.
            maxBuffer: 50 * 1024 * 1024,
        },
    );
    // ast-grep exits non-zero when error-severity matches are found. That is
    // exactly the "we found legacy patterns" state we want to count, not an
    // ast-grep tool failure. So we ignore the exit code and parse stdout.
    if (result.error) {
        return {
            ok: false,
            error: `failed to spawn ast-grep: ${result.error.message}`,
            matches: [],
        };
    }
    const stdout = (result.stdout ?? '').trim();
    if (!stdout) {
        return { ok: true, matches: [] };
    }
    let parsed;
    try {
        parsed = JSON.parse(stdout);
    } catch (err) {
        return {
            ok: false,
            error: `ast-grep emitted non-JSON output: ${err.message}\n${stdout.slice(0, 500)}`,
            matches: [],
        };
    }
    if (!Array.isArray(parsed)) {
        return {
            ok: false,
            error: `ast-grep JSON output was not an array: ${typeof parsed}`,
            matches: [],
        };
    }
    return { ok: true, matches: parsed };
}

function formatMatchLocation(m) {
    const file = m.file ?? '?';
    const line = m.range?.start?.line != null ? m.range.start.line + 1 : '?';
    const col = m.range?.start?.column != null ? m.range.start.column + 1 : '?';
    return `${file}:${line}:${col}`;
}

function ensureChecksDirExists() {
    if (!existsSync(CHECKS_DIR)) {
        console.error(`completeness-checks: checks directory missing — ${CHECKS_DIR}`);
        process.exit(2);
    }
    const files = readdirSync(CHECKS_DIR).filter((f) => f.endsWith('.yml'));
    if (files.length === 0) {
        console.error(`completeness-checks: no .yml rule files in ${CHECKS_DIR}`);
        process.exit(2);
    }
}

function main() {
    ensureChecksDirExists();
    const wantJson = process.argv.includes('--json');

    const results = [];
    let toolFailure = false;
    let totalEffectiveMatches = 0;

    for (const rule of RULES) {
        const raw = runRule(rule);
        if (!raw.ok) {
            toolFailure = true;
            results.push({
                id: rule.id,
                label: rule.label,
                matches: [],
                effective: [],
                error: raw.error,
            });
            continue;
        }
        const effective = rule.postProcess ? rule.postProcess(raw.matches) : raw.matches;
        totalEffectiveMatches += effective.length;
        results.push({
            id: rule.id,
            label: rule.label,
            matches: raw.matches,
            effective,
        });
    }

    if (wantJson) {
        console.log(
            JSON.stringify(
                {
                    pass: !toolFailure && totalEffectiveMatches === 0,
                    totalEffectiveMatches,
                    toolFailure,
                    results: results.map((r) => ({
                        id: r.id,
                        label: r.label,
                        rawMatchCount: r.matches.length,
                        effectiveMatchCount: r.effective.length,
                        error: r.error,
                        locations: r.effective.map((m) => ({
                            location: formatMatchLocation(m),
                            missingCases: m.missingCases,
                        })),
                    })),
                },
                null,
                2,
            ),
        );
    } else {
        console.log('\n=== Mechanical Completeness Gates ===\n');
        console.log(' ID  | Raw | Eff | Status | Description');
        console.log('-----+-----+-----+--------+--------------------------------------------');
        for (const r of results) {
            const raw = String(r.matches.length).padStart(3);
            const eff = String(r.effective.length).padStart(3);
            const status = r.error
                ? 'ERROR '
                : r.effective.length === 0
                  ? 'PASS  '
                  : 'FAIL  ';
            console.log(` ${r.id}  | ${raw} | ${eff} | ${status} | ${r.label}`);
        }
        console.log('');
        for (const r of results) {
            if (r.error) {
                console.error(`  [${r.id}] ERROR: ${r.error}`);
            }
            if (r.effective.length > 0) {
                console.log(`  [${r.id}] ${r.effective.length} match(es):`);
                for (const m of r.effective) {
                    const where = formatMatchLocation(m);
                    if (m.missingCases) {
                        console.log(`    - ${where}  (missing cases: ${m.missingCases.join(', ')})`);
                    } else {
                        console.log(`    - ${where}`);
                    }
                }
            }
        }
        console.log('');
        if (toolFailure) {
            console.log('VERDICT: ERROR — ast-grep tool failure (see above)');
        } else if (totalEffectiveMatches === 0) {
            console.log(`VERDICT: PASS — all ${RULES.length} rules report 0 effective matches`);
        } else {
            console.log(`VERDICT: FAIL — ${totalEffectiveMatches} effective match(es) across rules`);
        }
        console.log('');
    }

    if (toolFailure) process.exit(2);
    process.exit(totalEffectiveMatches === 0 ? 0 : 1);
}

main();
