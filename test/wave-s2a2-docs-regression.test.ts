/**
 * Wave S2-A2 (Protocol-v2 amend) — Fix Agent 5 docs-regression gate.
 *
 * Content-assertion tests (same shape as Wave S2-A1's surface test did for the
 * SSL retraction) pinning that the docs reflect the NEW A2 posture and do NOT
 * regress the A1 disclosures:
 *
 *  - KERNEL-002 — SECURITY.md + README.md state the MCP server DEFAULTS to the
 *    `ai-facing` trust zone with redaction ON; the privileged posture is opt-in.
 *  - INJECT-001 — SECURITY.md + README.md state MCP write tools enforce approval
 *    (commit refused unless the command is `approved`).
 *  - EGRESS-002 — SECURITY.md + SHIP_GATE.md state the config.json `clusterDir`
 *    is contained to cwd and `DB_CLUSTER_DIR` is the explicit operator override.
 *  - site-config.ts no longer claims "PolicyEnforcedKernel is the only exported
 *    entry" — it now reflects A1's `createSafeCluster` root + `/unsafe` hatch.
 *  - CHANGELOG.md carries a pending 2.0.0 (MAJOR) section capturing A2 + the A1
 *    KERNEL-001 breaking surface change.
 *  - NO file reintroduces the retracted SSL "respected/honored" claim, and the
 *    A1 tamper-evident-not-proof disclosure is preserved.
 *
 * Note (coordinator reconcile): the KERNEL-002 privileged opt-in flag is
 * documented with the PLACEHOLDER name `DB_CLUSTER_MCP_ALLOW_PRIVILEGED` because
 * Agent 1's src/mcp/server.ts change had not landed at authoring time. If Agent 1
 * chose a different final name, update the docs AND the placeholder constant
 * below in lockstep.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

// Placeholder for the KERNEL-002 privileged opt-in flag. Reconcile to Agent 1's
// final name if it differs (see file header).
const PRIVILEGED_OPT_IN = 'DB_CLUSTER_MCP_ALLOW_PRIVILEGED';

function read(rel: string): string {
    return readFileSync(join(REPO_ROOT, rel), 'utf-8');
}

// ───────────────────────────────────────────────────────────────────────────
// KERNEL-002 — MCP defaults to ai-facing + redaction (README + SECURITY)
// ───────────────────────────────────────────────────────────────────────────

describe('KERNEL-002 — docs state MCP ai-facing-default + redaction', () => {
    it('README.md states the MCP server defaults to the ai-facing trust zone with redaction', () => {
        const md = read('README.md');
        // The MCP default must be present and pair "ai-facing" with redaction.
        expect(md).toMatch(/MCP server defaults to the `?ai-facing`? trust zone/i);
        expect(md).toMatch(/redaction\s+ON/i);
    });

    it('SECURITY.md states the MCP server defaults to ai-facing + redaction', () => {
        const md = read('SECURITY.md');
        expect(md).toMatch(/defaults to the `?ai-facing`? trust zone/i);
        expect(md).toMatch(/redaction\s+ON/i);
    });

    it('SECURITY.md no longer claims the MCP server falls back to a fully-trusted kernel returning raw owner truth', () => {
        const md = read('SECURITY.md');
        // The OLD posture: server falls back to a trusted in-process kernel and
        // returns raw owner truth. The new SECURITY.md may MENTION that it "no
        // longer falls back" — so we forbid only an AFFIRMATIVE claim that the
        // MCP boundary returns raw owner truth by default.
        expect(md).not.toMatch(/MCP[^.\n]*returns? raw owner truth by default/i);
    });

    it('README.md + SECURITY.md document the privileged opt-in flag (placeholder name OK)', () => {
        expect(read('README.md')).toContain(PRIVILEGED_OPT_IN);
        expect(read('SECURITY.md')).toContain(PRIVILEGED_OPT_IN);
    });
});

// ───────────────────────────────────────────────────────────────────────────
// INJECT-001 — MCP write tools enforce approval (README + SECURITY)
// ───────────────────────────────────────────────────────────────────────────

describe('INJECT-001 — docs state MCP write approval gate', () => {
    it('README.md states MCP write tools enforce approval', () => {
        const md = read('README.md');
        expect(md).toMatch(/MCP write tools enforce approval/i);
        // commit refused until approved.
        expect(md).toMatch(/`?cluster_commit_mutation`?/);
        expect(md).toMatch(/approved/i);
    });

    it('SECURITY.md states MCP write tools refuse to commit unless approved', () => {
        const md = read('SECURITY.md');
        expect(md).toMatch(/MCP write tools enforce approval/i);
        expect(md).toMatch(/refuse[s]? to write unless the command is in `?approved`? status/i);
    });

    it('SECURITY.md scopes the approval gate to the MCP surface (SDK callers unaffected)', () => {
        const md = read('SECURITY.md');
        expect(md).toMatch(/MCP-surface only/i);
    });
});

// ───────────────────────────────────────────────────────────────────────────
// EGRESS-002 — config.json clusterDir contained to cwd; DB_CLUSTER_DIR override
// ───────────────────────────────────────────────────────────────────────────

describe('EGRESS-002 — docs align clusterDir containment with the new reality', () => {
    it('SECURITY.md states config.json clusterDir is contained to cwd and DB_CLUSTER_DIR is the explicit override', () => {
        const md = read('SECURITY.md');
        expect(md).toMatch(/`?config\.json`?[^.\n]*`?clusterDir`?[^.\n]*contained to (the )?(working directory|cwd)/i);
        expect(md).toMatch(/`?DB_CLUSTER_DIR`?[^.\n]*explicit (operator )?override/i);
    });

    it('SHIP_GATE.md known-directories item reflects clusterDir containment + DB_CLUSTER_DIR override', () => {
        const md = read('SHIP_GATE.md');
        // The known-directories line must mention containment of the config.json
        // clusterDir and the DB_CLUSTER_DIR explicit override.
        expect(md).toMatch(/contained to cwd/i);
        expect(md).toMatch(/`?DB_CLUSTER_DIR`?[^.\n]*(explicit|override)/i);
    });
});

// ───────────────────────────────────────────────────────────────────────────
// site-config.ts — no stale "only exported entry" claim (reflect A1 root)
// ───────────────────────────────────────────────────────────────────────────

describe('site-config.ts — only-exported-entry wording removed', () => {
    const cfg = () => read('site/src/site-config.ts');

    it('no longer claims PolicyEnforcedKernel is the only exported entry', () => {
        expect(cfg()).not.toMatch(/only exported entry/i);
        expect(cfg()).not.toMatch(/intentionally not on the public surface/i);
    });

    it('reflects the createSafeCluster root + explicit /unsafe escape hatch', () => {
        const c = cfg();
        expect(c).toMatch(/createSafeCluster/);
        expect(c).toMatch(/@mcptoolshop\/db-cluster\/unsafe/);
    });
});

// ───────────────────────────────────────────────────────────────────────────
// CHANGELOG — pending 2.0.0 (MAJOR) section with A2 + A1 breaking surface
// ───────────────────────────────────────────────────────────────────────────

describe('CHANGELOG.md — 2.0.0 MAJOR section', () => {
    const cl = () => read('CHANGELOG.md');

    it('has a 2.0.0 release section', () => {
        expect(cl()).toMatch(/^##\s+v?2\.0\.0\b/m);
    });

    it('captures the MCP-surface breaking changes user-facingly', () => {
        const c = cl();
        expect(c).toMatch(/ai-facing/i);
        expect(c).toMatch(/approv/i);
        expect(c).toContain('isError');
    });

    it('notes the package-root breaking surface change', () => {
        const c = cl();
        expect(c).toContain('createSafeCluster');
        // The /unsafe escape hatch is the breaking-surface tell.
        expect(c).toMatch(/@mcptoolshop\/db-cluster\/unsafe/);
    });
});

// ───────────────────────────────────────────────────────────────────────────
// DO-NOT-REGRESS — A1 disclosures preserved across all owned files
// ───────────────────────────────────────────────────────────────────────────

describe('A1 disclosures preserved (no overclaim reintroduced)', () => {
    // The owned doc surface that must never reintroduce the retracted SSL claim.
    const ownedDocs = [
        'README.md',
        'SECURITY.md',
        'CHANGELOG.md',
        'SHIP_GATE.md',
        'docs/mcp.md',
        'docs/sdk.md',
        'docs/policy-and-redaction.md',
        'docs/handbook.md',
        'docs/architecture.md',
        'site/src/site-config.ts',
        'site/src/content/docs/handbook/mcp.md',
        'site/src/content/docs/handbook/policy-and-redaction.md',
    ];

    it('no owned file reintroduces the retracted SSL "respected/honored" claim', () => {
        // An honest retraction QUOTES the old claim to retract it, so the words
        // "respected"/"honored" legitimately appear on lines that also carry a
        // disqualifier ("retract", "never", "not", "was", "claimed", "earlier").
        // We therefore scan line-by-line and flag only an AFFIRMATIVE working-knob
        // line — one that pairs SSL / DB_CLUSTER_POSTGRES_SSL with
        // respected/honored/enabled AND carries no disqualifier. This mirrors the
        // intent of the A1 surface test's regexes without false-positiving on the
        // retraction prose itself.
        const affirmKnob = /\b(respected|honou?red|enabled|required)\b/i;
        const sslSubject = /\b(SSL|TLS|DB_CLUSTER_POSTGRES_SSL)\b/i;
        // Disqualifier stems (no trailing \b so "retract"→"retracted" matches).
        const disqualifier = /\b(retract|never|claimed|earlier|drafted?)|\bnot\b|\bwas\b|\bwere\b|does\s+not|no\s+`?DB_CLUSTER_POSTGRES_SSL/i;
        for (const rel of ownedDocs) {
            const offenders = read(rel)
                .split('\n')
                .filter((line) => affirmKnob.test(line) && sslSubject.test(line) && !disqualifier.test(line));
            expect(offenders, `${rel} affirms SSL is respected/honored as a working knob`).toEqual([]);
        }
    });

    it('SECURITY.md keeps the tamper-evident-not-tamper-proof disclosure', () => {
        const md = read('SECURITY.md');
        expect(md).toMatch(/tamper-evident,?\s+not\s+tamper-proof/i);
    });

    it('SECURITY.md keeps the content-addressing limits disclosure', () => {
        const md = read('SECURITY.md');
        // metadata reads not byte-integrity-checked + consistent re-content undetectable.
        expect(md).toMatch(/metadata[^.\n]*not\s+byte-integrity-checked/i);
        expect(md).toMatch(/re-content/i);
    });

    it('no owned file claims the ledger is "tamper-proof" (positive claim)', () => {
        // The honest disclosure is "tamper-evident, not tamper-proof" — the word
        // "tamper-proof" legitimately appears on lines that also say "not" (or
        // "evident"). Scan line-by-line and flag only a POSITIVE tamper-proof
        // line: one mentioning tamper-proof with no negating qualifier.
        for (const rel of ownedDocs) {
            const offenders = read(rel)
                .split('\n')
                .filter(
                    (line) =>
                        /\btamper-?proof\b/i.test(line) &&
                        !/\bnot\b|tamper-?evident|never|n['’]t\b/i.test(line),
                );
            expect(offenders, `${rel} makes a positive tamper-proof claim`).toEqual([]);
        }
    });
});
