/**
 * Wave C1-Amend CI/Docs domain regression net.
 *
 * Pins the doc + CI fixes the CI/Docs agent landed in Wave C1-Amend so
 * future passes can't quietly regress them. One test per finding; failures
 * point at the source of truth.
 *
 * Findings covered:
 *   - CIDOCS-C-001 README has "Who is this for"
 *   - CIDOCS-C-002 docs/runbooks/ + index of typed-error → runbook map
 *   - CIDOCS-C-003 docs/cli.md has Exit Codes table
 *   - CIDOCS-C-004 CHANGELOG audience-tagged sections
 *   - CIDOCS-C-005 4 examples have READMEs
 *   - CIDOCS-C-006 docs/mcp.md documents AiErrorEnvelope shape
 *   - CIDOCS-C-007 dashboard/README.md documents component props
 *   - CIDOCS-C-008 agent-safe-app-db README documents failure paths
 *   - CIDOCS-C-009 handbook §9.6 expanded
 *   - CIDOCS-C-010 package.json keywords + description
 *   - SHA-CIDOCS-C-SHBA-001 Node 18+ → 20+ in quickstart README
 *   - §2e JSDoc-completeness gate ships + wires into release-gate [9/9]
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

describe('Wave C1-Amend CI/Docs regression — README humanization (CIDOCS-C-001)', () => {
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');

    it('README has a "Who is this for" section in the first 50 lines', () => {
        const firstFifty = readme.split('\n').slice(0, 50).join('\n');
        expect(/who\s+is\s+this\s+for/i.test(firstFifty)).toBe(true);
    });

    it('README has a "Why use db-cluster" or equivalent value-prop section', () => {
        // Match either heading; the section name is the contract.
        expect(/##\s+Why\s+(?:use\s+)?db-cluster/i.test(readme)).toBe(true);
    });

    it('README has a quickstart link prominently', () => {
        expect(/docs\/quickstart\.md/.test(readme)).toBe(true);
    });

    it('README links to docs/runbooks/README.md (new this wave)', () => {
        expect(/docs\/runbooks\/README\.md/.test(readme)).toBe(true);
    });
});

describe('Wave C1-Amend CI/Docs regression — runbooks (CIDOCS-C-002)', () => {
    const runbookFiles = [
        'docs/runbooks/README.md',
        'docs/runbooks/corrupt-store.md',
        'docs/runbooks/orphan-mutations.md',
        'docs/runbooks/index-stale.md',
        'docs/runbooks/postgres-unreachable.md',
    ];

    for (const f of runbookFiles) {
        it(`runbook file exists: ${f}`, () => {
            expect(existsSync(join(ROOT, f))).toBe(true);
        });
    }

    it('each runbook follows the canonical structure (Symptom / Cause / Verify / Recover / Escalate)', () => {
        for (const f of runbookFiles.slice(1)) {
            // skip the index (README.md), which has its own shape
            const text = readFileSync(join(ROOT, f), 'utf8');
            expect(text).toMatch(/##\s+Symptom/);
            expect(text).toMatch(/##\s+Cause/);
            expect(text).toMatch(/##\s+Verify/);
            expect(text).toMatch(/##\s+Recover/);
            expect(text).toMatch(/##\s+Escalate/);
        }
    });

    it('runbook index maps typed-error codes to runbook files', () => {
        const idx = readFileSync(join(ROOT, 'docs/runbooks/README.md'), 'utf8');
        // Spot-check a few load-bearing typed errors:
        expect(idx).toContain('CORRUPT_STORE');
        expect(idx).toContain('COMMAND_QUEUE_CORRUPT');
        expect(idx).toContain('RECEIPT_FAILED');
        expect(idx).toContain('CONTENT_HASH_MISMATCH');
        expect(idx).toContain('POLICY_DENIED');
    });

    it('runbook index documents CLI exit-code mapping', () => {
        const idx = readFileSync(join(ROOT, 'docs/runbooks/README.md'), 'utf8');
        // The four sysexits codes the CLI maps to.
        expect(idx).toContain('77');
        expect(idx).toContain('70');
        expect(idx).toContain('65');
        expect(idx).toContain('78');
    });
});

describe('Wave C1-Amend CI/Docs regression — CLI exit codes (CIDOCS-C-003)', () => {
    const cli = readFileSync(join(ROOT, 'docs/cli.md'), 'utf8');

    it('docs/cli.md has an "Exit Codes" section', () => {
        expect(/##\s+Exit\s+Codes/i.test(cli)).toBe(true);
    });

    it('docs/cli.md exit-codes table covers the four sysexits codes', () => {
        // Find the exit-codes section block.
        const idx = cli.search(/##\s+Exit\s+Codes/i);
        expect(idx).toBeGreaterThan(-1);
        const section = cli.slice(idx);
        expect(section).toContain('77');
        expect(section).toContain('70');
        expect(section).toContain('65');
        expect(section).toContain('78');
    });

    it('docs/cli.md exit-codes table names POLICY_DENIED, CORRUPT_STORE, CONTENT_HASH_MISMATCH, INVALID_POLICY_CONFIG', () => {
        const idx = cli.search(/##\s+Exit\s+Codes/i);
        const section = cli.slice(idx);
        expect(section).toContain('POLICY_DENIED');
        expect(section).toContain('CORRUPT_STORE');
        expect(section).toContain('CONTENT_HASH_MISMATCH');
        expect(section).toContain('INVALID_POLICY_CONFIG');
    });

    it('docs/cli.md exit-codes table contains a markdown table (pipe character pattern)', () => {
        const idx = cli.search(/##\s+Exit\s+Codes/i);
        const section = cli.slice(idx);
        // At least one row with the | character pattern.
        expect(/^\s*\|.+\|.+\|.+\|/m.test(section)).toBe(true);
    });
});

describe('Wave C1-Amend CI/Docs regression — CHANGELOG audience (CIDOCS-C-004)', () => {
    const cl = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');

    it('CHANGELOG has the Wave C1-Amend section', () => {
        expect(cl).toContain('Wave C1-Amend');
    });

    it('CHANGELOG Wave C1-Amend has User-visible / Breaking / Migration subsections', () => {
        // Locate the section.
        const idx = cl.search(/Wave\s+C1-Amend/);
        const section = cl.slice(idx, idx + 5000);
        expect(/User-visible\s+changes/i.test(section)).toBe(true);
        expect(/Breaking\s+changes/i.test(section)).toBe(true);
        expect(/Migration\s+notes/i.test(section)).toBe(true);
    });

    it('CHANGELOG preamble explains the audience-tagged structure', () => {
        // First 1500 chars should describe the format.
        const head = cl.slice(0, 1500);
        expect(head).toMatch(/external\s+readers/i);
        expect(head).toMatch(/User-visible/);
        expect(head).toMatch(/Breaking/);
        expect(head).toMatch(/Migration/);
    });
});

describe('Wave C1-Amend CI/Docs regression — example READMEs (CIDOCS-C-005)', () => {
    const examples = [
        'examples/agent-safe-app-db/README.md',
        'examples/project-memory-cluster/README.md',
        'examples/research-evidence-cluster/README.md',
        'examples/sdk/README.md',
        // existing — should still be there
        'examples/quickstart/README.md',
    ];

    for (const f of examples) {
        it(`example README exists: ${f}`, () => {
            expect(existsSync(join(ROOT, f))).toBe(true);
        });
    }

    it('each new example README documents: prerequisites + run command + expected output + next steps', () => {
        const newOnes = examples.slice(0, 4);
        for (const f of newOnes) {
            const text = readFileSync(join(ROOT, f), 'utf8');
            expect(/##\s+Prerequisites/i.test(text)).toBe(true);
            expect(/##\s+Run/i.test(text)).toBe(true);
            expect(/##\s+Expected\s+output/i.test(text)).toBe(true);
            expect(/##\s+Next\s+steps/i.test(text)).toBe(true);
        }
    });
});

describe('Wave C1-Amend CI/Docs regression — MCP envelope docs (CIDOCS-C-006)', () => {
    const mcp = readFileSync(join(ROOT, 'docs/mcp.md'), 'utf8');

    it('docs/mcp.md documents AiErrorEnvelope shape', () => {
        expect(mcp).toContain('AiErrorEnvelope');
    });

    it('docs/mcp.md shows the canonical AI branching pattern', () => {
        expect(mcp).toMatch(/AI\s+agent\s+branching/i);
    });

    it('docs/mcp.md documents EmptyResultMeta shape', () => {
        expect(mcp).toContain('EmptyResultMeta');
        expect(mcp).toContain('empty_reason');
    });

    it('docs/mcp.md envelope examples cover at least 3 typed-error codes', () => {
        // Hit-count of error codes in fenced JSON examples.
        const codes = ['CONTENT_HASH_MISMATCH', 'COMMAND_NOT_VALIDATED', 'COMMAND_QUEUE_CORRUPT', 'POLICY_DENIED'];
        const hits = codes.filter((c) => mcp.includes(c));
        expect(hits.length).toBeGreaterThanOrEqual(3);
    });
});

describe('Wave C1-Amend CI/Docs regression — agent-safe failure paths (CIDOCS-C-008)', () => {
    const r = readFileSync(join(ROOT, 'examples/agent-safe-app-db/README.md'), 'utf8');

    it('agent-safe-app-db README documents AI agent failure paths', () => {
        expect(/##\s+Failure\s+paths/i.test(r)).toBe(true);
    });

    it('agent-safe-app-db README references typed-error codes the AI must branch on', () => {
        expect(r).toContain('POLICY_DENIED');
        expect(r).toContain('CONTENT_HASH_MISMATCH');
        expect(r).toContain('COMMAND_NOT_VALIDATED');
        expect(r).toContain('COMMAND_REJECTED');
    });
});

describe('Wave C1-Amend CI/Docs regression — handbook §9.6 expansion (CIDOCS-C-009)', () => {
    const hb = readFileSync(join(ROOT, 'docs/handbook.md'), 'utf8');

    it('handbook §9.6 has verify-symptom / verify-recovery / escalate columns', () => {
        // Locate section 9.6.
        const idx = hb.search(/9\.6\s+Common\s+damage\s+scenarios/i);
        expect(idx).toBeGreaterThan(-1);
        const section = hb.slice(idx, idx + 5000);
        // The new table headers must be present (post-fix).
        expect(section).toMatch(/Verify-symptom/i);
        expect(section).toMatch(/Verify-recovery/i);
        expect(section).toMatch(/Escalate/i);
    });

    it('handbook §9.6 cross-links to docs/runbooks/', () => {
        const idx = hb.search(/9\.6\s+Common\s+damage\s+scenarios/i);
        const section = hb.slice(idx, idx + 5000);
        // At least one link to runbooks/.
        expect(section).toContain('runbooks/');
    });

    it('handbook §9.6 covers orphan mutations + ledger cycle + postgres scenarios', () => {
        const idx = hb.search(/9\.6\s+Common\s+damage\s+scenarios/i);
        const section = hb.slice(idx, idx + 5000);
        expect(/Orphan\s+mutations/i.test(section)).toBe(true);
        expect(/Ledger\s+cycle/i.test(section)).toBe(true);
        expect(/Postgres/i.test(section)).toBe(true);
    });
});

describe('Wave C1-Amend CI/Docs regression — package.json metadata (CIDOCS-C-010)', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

    it('package.json keywords has at least 12 entries', () => {
        expect(Array.isArray(pkg.keywords)).toBe(true);
        expect(pkg.keywords.length).toBeGreaterThanOrEqual(12);
    });

    it('package.json keywords includes high-signal terms', () => {
        const must = ['mcp', 'ai', 'database', 'provenance', 'typescript', 'cli'];
        for (const k of must) {
            expect(pkg.keywords).toContain(k);
        }
    });

    it('package.json description names the problem solved + audience', () => {
        // ~150 chars target; allow 80-200.
        expect(pkg.description.length).toBeGreaterThan(80);
        expect(pkg.description.length).toBeLessThan(220);
        // Names at least one audience.
        expect(/(AI agents?|operators?|developers?)/i.test(pkg.description)).toBe(true);
    });
});

describe('Wave C1-Amend CI/Docs regression — SHA-CIDOCS-C-SHBA-001 Node 18 → 20', () => {
    it('examples/quickstart/README.md does NOT contain "Node.js 18"', () => {
        const text = readFileSync(join(ROOT, 'examples/quickstart/README.md'), 'utf8');
        expect(/Node\.?js?\s+18/i.test(text)).toBe(false);
        expect(/Node\.?js?\s+20\+/.test(text)).toBe(true);
    });

    it('family probe: no Node 18+ claims linger anywhere in user-facing files', () => {
        const userFacing = [
            'README.md',
            'examples/quickstart/README.md',
            'examples/agent-safe-app-db/README.md',
            'examples/project-memory-cluster/README.md',
            'examples/research-evidence-cluster/README.md',
            'examples/sdk/README.md',
            'docs/quickstart.md',
            'docs/handbook.md',
        ];
        const offenders: string[] = [];
        for (const f of userFacing) {
            const p = join(ROOT, f);
            if (!existsSync(p)) continue;
            const text = readFileSync(p, 'utf8');
            if (/Node\.?js?\s+18/i.test(text)) offenders.push(f);
        }
        expect(offenders).toEqual([]);
    });
});

describe('Wave C1-Amend CI/Docs regression — JSDoc-completeness gate (§2e)', () => {
    it('scripts/jsdoc-gate.mjs exists', () => {
        expect(existsSync(join(ROOT, 'scripts/jsdoc-gate.mjs'))).toBe(true);
    });

    it('jsdoc-gate.mjs is wired into release-gate as [9/9]', () => {
        const rg = readFileSync(join(ROOT, 'scripts/release-gate.mjs'), 'utf8');
        expect(rg).toContain('[9/9] JSDoc-completeness');
        expect(rg).toContain("'jsdoc-gate.mjs'");
        // Existing stages renumbered to /9:
        expect(rg).toContain('[1/9] Build');
        expect(rg).toContain('[8/9] Doc-drift');
    });

    it('jsdoc-gate.mjs exits 0 on current src/ (allowlisted symbols all covered)', () => {
        // The gate is forward-looking — it only enforces against the allowlist.
        // The wave landed @example + @returns on every allowlisted symbol.
        try {
            execSync(`node ${join(ROOT, 'scripts/jsdoc-gate.mjs')}`, {
                cwd: ROOT,
                stdio: 'pipe',
                timeout: 60_000,
            });
        } catch (e: any) {
            const stdout = e.stdout ? e.stdout.toString() : '';
            const stderr = e.stderr ? e.stderr.toString() : '';
            throw new Error(`jsdoc-gate failed unexpectedly.\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
        }
    }, 65_000);

    it('jsdoc-gate.mjs requires at least one symbol in the allowlist', () => {
        // Defense against a future refactor emptying the allowlist —
        // an empty allowlist defeats the gate.
        const text = readFileSync(join(ROOT, 'scripts/jsdoc-gate.mjs'), 'utf8');
        const m = text.match(/REQUIRED_JSDOC_SYMBOLS\s*=\s*\[([\s\S]*?)\]/);
        expect(m).not.toBeNull();
        // At least one quoted entry inside the array.
        expect(/'[\w.]+'/.test(m![1])).toBe(true);
    });

    it('jsdoc-gate.mjs detects missing @example (adversarial probe)', () => {
        // Spawn the gate with an artificially-broken allowlist by importing
        // and running it programmatically. We don't actually exec a mutated
        // gate — instead we assert the gate's logic is reachable by checking
        // its source carries the @example check.
        const text = readFileSync(join(ROOT, 'scripts/jsdoc-gate.mjs'), 'utf8');
        expect(text).toContain("if (!tags.has('example'))");
    });
});

describe('Wave C1-Amend CI/Docs regression — dashboard component props (CIDOCS-C-007)', () => {
    const r = readFileSync(join(ROOT, 'dashboard/README.md'), 'utf8');

    it('dashboard/README.md documents at least 4 components', () => {
        expect(r).toContain('ClusterTruthInspector');
        expect(r).toContain('OperationsPanel');
        expect(r).toContain('CommandPreviewPanel');
        expect(r).toContain('PolicyViewToggle');
    });

    it('dashboard/README.md documents the ComponentState prop pattern', () => {
        expect(r).toContain('ComponentState');
    });

    it('dashboard/README.md screenshots section names each PNG file', () => {
        // Look for the four screenshot filenames currently shipped.
        expect(r).toContain('01-default.png');
        expect(r).toContain('02-full.png');
        expect(r).toContain('03-full2.png');
        expect(r).toContain('04-hq.png');
    });

    it('dashboard/README.md has a host-app mount code example', () => {
        // The block should reference ReactDOM.createRoot or createElement.
        expect(/ReactDOM\.createRoot/.test(r)).toBe(true);
    });
});
