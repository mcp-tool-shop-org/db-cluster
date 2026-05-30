/**
 * Wave B1-Amend CI/Docs domain regression net.
 *
 * Pins the mechanical fixes the CI/Docs agent landed in Wave B1-Amend so
 * future passes can't quietly regress them. One test per finding; failures
 * point at the source of truth.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, mkdtempSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
    buildRandomTmpPath,
    cleanupOrphanTmpFiles,
    sweepContentDirOrphans,
    DEFAULT_TMP_MAX_AGE_MS,
} from '../src/util/tmp-paths.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

describe('Wave B1-Amend CI/Docs regression — package.json fields', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

    it('CIDOCS-B-003: engines.node is set to >=20', () => {
        expect(pkg.engines).toBeDefined();
        expect(pkg.engines.node).toBe('>=20');
    });

    it('CIDOCS-B-024: repository, bugs, homepage are present', () => {
        expect(pkg.repository).toBeDefined();
        expect(pkg.repository.url).toContain('github.com');
        expect(pkg.bugs).toContain('github.com');
        expect(pkg.homepage).toContain('github.com');
    });

    it('CIDOCS-011 / R2-009: prepublishOnly wires the release-gate (Wave A4 close)', () => {
        // Sanity check the A4 close is still in place; if a future wave drops
        // it we want this regression to fire.
        expect(pkg.scripts.prepublishOnly).toBe('node scripts/release-gate.mjs');
    });
});

describe('Wave B1-Amend CI/Docs regression — README + quickstart Node version claims', () => {
    it('README claims Node 20+, not Node 18+', () => {
        const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
        expect(readme).toContain('Node.js 20+');
        // Make sure no "Node.js 18+" or "Node 18+" remains as a positive
        // claim about supported versions.
        expect(/Node\.?js\s+18\+/i.test(readme)).toBe(false);
    });

    it('docs/quickstart.md claims Node 20+', () => {
        const qs = readFileSync(join(ROOT, 'docs', 'quickstart.md'), 'utf8');
        expect(qs).toContain('Node.js 20+');
        expect(/Node\.?js\s+18\+/i.test(qs)).toBe(false);
    });
});

describe('Wave B1-Amend CI/Docs regression — CI workflows', () => {
    const ciYml = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
    const rgYml = readFileSync(join(ROOT, '.github/workflows/release-gate.yml'), 'utf8');

    it('CIDOCS-B-010: ci.yml matrix includes Node 24', () => {
        expect(ciYml).toMatch(/node:\s*\[\s*20,\s*22,\s*24\s*\]/);
    });

    it('CIDOCS-B-010: ci.yml matrix includes macos-latest', () => {
        expect(ciYml).toContain('macos-latest');
    });

    it('CIDOCS-B-004 / B-015: ci.yml has workflow_dispatch trigger', () => {
        expect(ciYml).toContain('workflow_dispatch:');
    });

    it('CIDOCS-B-004 / B-015: release-gate.yml has workflow_dispatch trigger', () => {
        expect(rgYml).toContain('workflow_dispatch:');
    });
});

describe('Wave B1-Amend CI/Docs regression — release-readiness has known-flake section', () => {
    const rr = readFileSync(join(ROOT, 'docs/release-readiness.md'), 'utf8');

    it('CIDOCS-B-004: release-readiness has a "Known flake patterns" section', () => {
        expect(rr).toContain('Known flake patterns');
    });

    it('CIDOCS-B-012: release-readiness names the Stryker disposition', () => {
        expect(rr).toContain('Stryker mutation testing');
        expect(rr).toContain('verifier-3');
    });
});

describe('Wave B1-Amend CI/Docs regression — README test-count claim', () => {
    it('CIDOCS-B-005: README test-count claim is updated post-B1', () => {
        const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
        // Either the post-A4 claim (778+) or the Wave B1-Amend update (anything
        // larger). The point is "699+" alone is no longer accurate.
        expect(/699\+\s+tests/.test(readme)).toBe(false);
    });
});

describe('Wave B1-Amend CI/Docs regression — docs/README.md entry-point map', () => {
    const docsReadme = join(ROOT, 'docs/README.md');

    it('CIDOCS-B-013: docs/README.md exists', () => {
        expect(existsSync(docsReadme)).toBe(true);
    });

    it('CIDOCS-B-013: docs/README.md links to quickstart, handbook, sdk, policy-and-redaction', () => {
        const t = readFileSync(docsReadme, 'utf8');
        expect(t).toContain('quickstart.md');
        expect(t).toContain('handbook.md');
        expect(t).toContain('sdk.md');
        expect(t).toContain('policy-and-redaction.md');
    });

    it('CIDOCS-B-013: repo-root README links to docs/README.md', () => {
        const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
        expect(readme).toContain('docs/README.md');
    });
});

describe('Wave B1-Amend CI/Docs regression — sibling-doc drift fix', () => {
    it('CIDOCS-B-001: retrieval-bundles.md uses the real EvidenceBundle shape', () => {
        const rb = readFileSync(join(ROOT, 'docs/retrieval-bundles.md'), 'utf8');
        // The real shape has these fields and the invented ones from the
        // pre-fix doc do NOT.
        expect(rb).toContain('confidenceBoundaries');
        expect(rb).toContain('missingContext');
        expect(rb).toContain('freshness');
        // And no longer claims those invented fields AS A REAL INTERFACE
        // MEMBER. The doc may mention the old shape in prose ("older docs
        // sometimes showed...") but not as a typed field. Detect by
        // requiring the field appears INSIDE a `interface EvidenceBundle`
        // declaration block.
        const interfaceMatch = rb.match(/interface\s+EvidenceBundle\s*\{[\s\S]+?\}/);
        expect(interfaceMatch).not.toBeNull();
        const decl = interfaceMatch![0];
        expect(/confidence:\s*'high'/.test(decl)).toBe(false);
        expect(/staleRecords:\s*string\[\]/.test(decl)).toBe(false);
    });

    it('CIDOCS-B-001: provenance-graphs.md uses the real ProvenanceGraph shape', () => {
        const pg = readFileSync(join(ROOT, 'docs/provenance-graphs.md'), 'utf8');
        // Real fields:
        expect(pg).toContain('focalUri');
        expect(pg).toContain('NodeType');
        expect(pg).toContain('EdgeType');
        // Pre-fix invented fields gone:
        expect(/^\s*rootUri:\s*string/m.test(pg)).toBe(false);
        expect(/^\s*relationship:\s*string/m.test(pg)).toBe(false);
    });
});

describe('Wave B1-Amend CI/Docs regression — Principal canonical source consolidation', () => {
    it('CIDOCS-B-014: Principal interface declaration appears in policy-and-redaction.md only', () => {
        // Count `interface Principal` occurrences across docs/. The audit
        // saw 6+; post-B1 should be exactly one.
        const docs = [
            'sdk.md',
            'mcp.md',
            'cli.md',
            'handbook.md',
            'policy-and-redaction.md',
            'phase-7-closeout.md',
        ];
        let count = 0;
        for (const f of docs) {
            const p = join(ROOT, 'docs', f);
            if (!existsSync(p)) continue;
            const text = readFileSync(p, 'utf8');
            // Match the interface declaration form, not the prose mention.
            const matches = text.match(/\binterface\s+Principal\s*\{/g);
            if (matches) count += matches.length;
        }
        // phase-7-closeout.md may keep the historical record — allow up to 2
        // but the canonical-source compaction goal is "no consumer-doc
        // restates"; the policy-and-redaction.md one is the canonical.
        expect(count).toBeLessThanOrEqual(2);
    });
});

describe('Wave B1-Amend CI/Docs regression — doc-drift detector', () => {
    it('CIDOCS-B-001 §2d: scripts/doc-drift.mjs exists and is invokable', () => {
        const p = join(ROOT, 'scripts/doc-drift.mjs');
        expect(existsSync(p)).toBe(true);
    });

    it('CIDOCS-B-001 §2d: tsconfig.docs.json exists', () => {
        const p = join(ROOT, 'tsconfig.docs.json');
        expect(existsSync(p)).toBe(true);
        const cfg = JSON.parse(readFileSync(p, 'utf8'));
        expect(cfg.extends).toBe('./tsconfig.json');
        expect(cfg.include).toContain('src/**/*');
    });

    it('CIDOCS-B-001 §2d: release-gate.mjs wires doc-drift (renumbered to [8/9] in Wave C1-Amend)', () => {
        const rg = readFileSync(join(ROOT, 'scripts/release-gate.mjs'), 'utf8');
        // Wave C1-Amend §2e added [9/9] JSDoc-completeness, renumbering 8/8 → 8/9.
        // The fact of being doc-drift's stage is the contract; the exact number
        // shifts as new stages land. The basename + doc-drift label are stable.
        expect(rg).toMatch(/\[8\/\d+\] Doc-drift/);
        expect(rg).toContain("'doc-drift.mjs'");
        // Stages 1 + completeness still present (numbering follows total stage count).
        expect(rg).toMatch(/\[1\/\d+\] Build/);
        expect(rg).toMatch(/\[7\/\d+\] Completeness/);
    });

    it('CIDOCS-B-001 §2d: doc-drift detector exits 0 on clean docs', () => {
        // Run from repo root; ROOT is computed relative to this test file.
        try {
            execSync(`node ${join(ROOT, 'scripts/doc-drift.mjs')}`, {
                cwd: ROOT,
                stdio: 'pipe',
                timeout: 180_000,
            });
        } catch (e) {
            const stdout = e.stdout ? e.stdout.toString() : '';
            const stderr = e.stderr ? e.stderr.toString() : '';
            throw new Error(
                `doc-drift detector failed unexpectedly.\n` +
                `STDOUT:\n${stdout}\nSTDERR:\n${stderr}`,
            );
        }
    }, 200_000);
});

describe('Wave B1-Amend CI/Docs regression — src/util/tmp-paths helpers', () => {
    function setup() {
        return mkdtempSync(join(tmpdir(), 'wave-b1-tmp-paths-'));
    }
    function cleanup(dir: string) {
        try {
            rmSync(dir, { recursive: true, force: true });
        } catch {
            // Best-effort.
        }
    }

    it('buildRandomTmpPath produces ${target}.${pid}-${rand}.tmp shape', () => {
        const p = buildRandomTmpPath('/tmp/foo/bar.json');
        const m = p.match(/^\/tmp\/foo\/bar\.json\.(\d+)-([a-z0-9]{1,6})\.tmp$/);
        expect(m).not.toBeNull();
        expect(parseInt(m![1]!, 10)).toBe(process.pid);
    });

    it('buildRandomTmpPath random component varies across calls (collision-resistance)', () => {
        const seen = new Set<string>();
        for (let i = 0; i < 100; i++) {
            const p = buildRandomTmpPath('/tmp/x');
            seen.add(p);
        }
        // 100 calls, sub-millisecond — chance of collision in 36^6 space is
        // tiny; allow some slack.
        expect(seen.size).toBeGreaterThanOrEqual(95);
    });

    it('cleanupOrphanTmpFiles is a no-op on missing dir', () => {
        const r = cleanupOrphanTmpFiles('/this/path/should/not/exist/anywhere', 'foo.json');
        expect(r.swept).toBe(0);
    });

    it('cleanupOrphanTmpFiles ignores young tmp files', () => {
        const dir = setup();
        try {
            const tmpName = `entities.json.${process.pid}-abc123.tmp`;
            writeFileSync(join(dir, tmpName), 'fresh');
            const r = cleanupOrphanTmpFiles(dir, 'entities.json');
            expect(r.swept).toBe(0);
            expect(existsSync(join(dir, tmpName))).toBe(true);
        } finally {
            cleanup(dir);
        }
    });

    it('cleanupOrphanTmpFiles unlinks old tmp files matching the basename pattern', () => {
        const dir = setup();
        try {
            const tmpName = `entities.json.${process.pid}-abc123.tmp`;
            const tmpPath = join(dir, tmpName);
            writeFileSync(tmpPath, 'stale');
            // Force mtime to 1 hour ago — past the 5-min threshold.
            const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
            utimesSync(tmpPath, oneHourAgo, oneHourAgo);
            const r = cleanupOrphanTmpFiles(dir, 'entities.json');
            expect(r.swept).toBe(1);
            expect(existsSync(tmpPath)).toBe(false);
        } finally {
            cleanup(dir);
        }
    });

    it('cleanupOrphanTmpFiles does NOT match unrelated .tmp files', () => {
        const dir = setup();
        try {
            // Different basename should not be matched.
            writeFileSync(join(dir, `other-file.tmp`), 'unrelated');
            // Force age past threshold.
            const stale = new Date(Date.now() - 60 * 60 * 1000);
            utimesSync(join(dir, 'other-file.tmp'), stale, stale);
            const r = cleanupOrphanTmpFiles(dir, 'entities.json');
            expect(r.swept).toBe(0);
            expect(existsSync(join(dir, 'other-file.tmp'))).toBe(true);
        } finally {
            cleanup(dir);
        }
    });

    it('sweepContentDirOrphans matches the <sha256>.<pid>-<rand>.tmp pattern', () => {
        const dir = setup();
        try {
            const hash = 'a'.repeat(64); // any 64-hex string
            const tmpName = `${hash}.${process.pid}-deadbe.tmp`;
            const tmpPath = join(dir, tmpName);
            writeFileSync(tmpPath, 'staged');
            const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
            utimesSync(tmpPath, oneHourAgo, oneHourAgo);
            const r = sweepContentDirOrphans(dir);
            expect(r.swept).toBe(1);
            expect(existsSync(tmpPath)).toBe(false);
        } finally {
            cleanup(dir);
        }
    });

    it('DEFAULT_TMP_MAX_AGE_MS is 5 minutes', () => {
        expect(DEFAULT_TMP_MAX_AGE_MS).toBe(5 * 60 * 1000);
    });
});

describe('Wave B1-Amend CI/Docs regression — operations.md backup claim corrected', () => {
    it('CIDOCS-B-022: operations.md backup section names base64 + checksum', () => {
        const ops = readFileSync(join(ROOT, 'docs/operations.md'), 'utf8');
        expect(ops).toContain('base64-encoded');
        // No longer claims "metadata, not raw content"
        expect(/metadata,\s*not\s*raw\s*content/i.test(ops)).toBe(false);
    });
});

describe('Wave B1-Amend CI/Docs regression — .gitignore defensive additions', () => {
    it('CIDOCS-B-021: .gitignore covers .repo-knowledge/ and cluster-backup-*.json', () => {
        const gi = readFileSync(join(ROOT, '.gitignore'), 'utf8');
        expect(gi).toContain('.repo-knowledge/');
        expect(gi).toContain('cluster-backup-*.json');
    });

    it('CIDOCS-B-001: .gitignore covers .doc-drift-extract/', () => {
        const gi = readFileSync(join(ROOT, '.gitignore'), 'utf8');
        expect(gi).toContain('.doc-drift-extract/');
    });
});

// vitest-friendly beforeEach noop — kept here just so the unused-block label
// above doesn't trip linters.
// (No actual lifecycle hooks needed — every test in this file sets up + tears
// down its own scratch dir.)
