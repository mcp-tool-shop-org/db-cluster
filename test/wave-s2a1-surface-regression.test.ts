/**
 * Wave S2-A1 (Protocol-v2 amend) — Fix Agent 3 surface-regression gate.
 *
 * Full-invariant FAIL→PASS tests for the three Agent-3 findings:
 *
 *  - KERNEL-001 (CRITICAL) — the PUBLIC PACKAGE ROOT must NOT hand back raw
 *    stores. `createCluster` / `createClusterFromEnv` / `createLocalCluster`
 *    are removed from the root; the root exposes ONLY the policed
 *    `createSafeCluster`, whose handle carries NO raw `.canonical` / `.ledger`
 *    mutator surface. The raw factories remain reachable ONLY via the explicit
 *    `@mcptoolshop/db-cluster/unsafe` escape hatch.
 *
 *  - PROV-002 (HIGH) — the Postgres canonical store must version IDENTICALLY
 *    to local: create→v1, update appends v2 while v1 is retained, listVersions
 *    / getVersion, and local↔Postgres parity. Gated on a test Postgres
 *    (DB_CLUSTER_POSTGRES_URL); SKIPS cleanly without one (mirrors
 *    test/postgres-canonical-store.test.ts).
 *
 *  - EGRESS-001 (MEDIUM) — the SSL/TLS "respected/honored" claim is RETRACTED
 *    from the security docs (TLS is NOT configured in v1.0.0), and every
 *    Postgres Pool site attaches a `pool.on('error', …)` handler so an
 *    idle-client TCP RST does not crash the process.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

// ───────────────────────────────────────────────────────────────────────────
// KERNEL-001 — safe-by-default package root + explicit unsafe escape hatch
// ───────────────────────────────────────────────────────────────────────────

describe('KERNEL-001 — package root is policy-enforced by default', () => {
    it('the root does NOT re-export the raw store factories', async () => {
        const root = await import('../src/index.js');
        // The threat: `import { createLocalCluster } from '@mcptoolshop/db-cluster'`
        // handing back raw, unpoliced stores. None of the three raw factories
        // may be reachable from the package root.
        expect((root as Record<string, unknown>).createLocalCluster).toBeUndefined();
        expect((root as Record<string, unknown>).createCluster).toBeUndefined();
        expect((root as Record<string, unknown>).createClusterFromEnv).toBeUndefined();
    });

    it('the root DOES export the policed createSafeCluster factory', async () => {
        const root = await import('../src/index.js');
        expect(typeof (root as Record<string, unknown>).createSafeCluster).toBe('function');
    });

    it('createSafeCluster returns a policed handle with NO raw store-mutator surface', async () => {
        const { createSafeCluster } = await import('../src/index.js');
        const dir = mkdtempSync(join(tmpdir(), 's2a1-safe-'));
        try {
            const safe = createSafeCluster({ rootDir: dir });

            // The policed handle must expose a PolicyEnforcedKernel and the
            // read-only ops — but NEVER the raw store handles. A consumer that
            // can reach `.canonical` / `.artifact` / `.index` / `.ledger`
            // could call their mutators directly, bypassing the kernel.
            const handle = safe as unknown as Record<string, unknown>;
            expect(handle.canonical).toBeUndefined();
            expect(handle.artifact).toBeUndefined();
            expect(handle.index).toBeUndefined();
            expect(handle.ledger).toBeUndefined();
            expect(handle.stores).toBeUndefined();

            // The policed kernel IS present and is a PolicyEnforcedKernel.
            expect(handle.kernel).toBeDefined();
            const { PolicyEnforcedKernel } = await import('../src/kernel/policy-enforced-kernel.js');
            expect(handle.kernel).toBeInstanceOf(PolicyEnforcedKernel);

            // The PolicyEnforcedKernel exposes NO raw-store backdoor: every
            // legitimate verb is a method, but there is no `.canonical` /
            // `.ledger` raw mutator and no `_kernel` accessor.
            const kernel = handle.kernel as Record<string, unknown>;
            expect(kernel.canonical).toBeUndefined();
            expect(kernel.ledger).toBeUndefined();
            expect((kernel as { _kernel?: unknown })._kernel).toBeUndefined();

            // The ops are bound and callable.
            expect(typeof handle.doctor).toBe('function');
            expect(typeof handle.verify).toBe('function');
            expect(typeof handle.backup).toBe('function');
            expect(typeof handle.restore).toBe('function');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('the raw factories ARE reachable via the explicit /unsafe escape hatch', async () => {
        const unsafe = await import('../src/unsafe.js');
        expect(typeof (unsafe as Record<string, unknown>).createCluster).toBe('function');
        expect(typeof (unsafe as Record<string, unknown>).createClusterFromEnv).toBe('function');
        expect(typeof (unsafe as Record<string, unknown>).createLocalCluster).toBe('function');
    });

    it('the root surfaces ContentReadIntegrityError (PROV-001 read-integrity error)', async () => {
        // Surfaced so consumers branch on it without deep-importing the
        // adapter barrel. (Class defined by Agent 2 in local/errors.ts.)
        const root = await import('../src/index.js');
        expect(typeof (root as Record<string, unknown>).ContentReadIntegrityError).toBe('function');
    });
});

// ───────────────────────────────────────────────────────────────────────────
// EGRESS-001 — SSL claim retracted from security docs; Pool error handler
// ───────────────────────────────────────────────────────────────────────────

describe('EGRESS-001 — SSL/TLS claim retracted, Pool error handler attached', () => {
    it('SECURITY.md no longer claims SSL is "respected" / "honored"', () => {
        const securityMd = readFileSync(join(REPO_ROOT, 'SECURITY.md'), 'utf-8');
        // The retracted claim: "SSL respected when DB_CLUSTER_POSTGRES_SSL is set".
        // No affirmative "SSL is respected/honored" wording may remain.
        expect(securityMd).not.toMatch(/SSL[^.\n]*respected/i);
        expect(securityMd).not.toMatch(/SSL[^.\n]*honou?red/i);
        // The variable must no longer be presented as a WORKING knob (e.g.
        // "SSL respected when DB_CLUSTER_POSTGRES_SSL is set"). Naming it to
        // say it does NOT exist is fine (an honest retraction), so we forbid
        // only the affirmative "respected/enabled/required … when … is set"
        // shape, not every mention of the string.
        expect(securityMd).not.toMatch(
            /DB_CLUSTER_POSTGRES_SSL[^.\n]*\bis set\b/i,
        );
        expect(securityMd).not.toMatch(
            /\b(respected|honou?red|enabled|required)\b[^.\n]*DB_CLUSTER_POSTGRES_SSL/i,
        );
    });

    it('README.md no longer claims DB_CLUSTER_POSTGRES_SSL is respected', () => {
        const readmeMd = readFileSync(join(REPO_ROOT, 'README.md'), 'utf-8');
        expect(readmeMd).not.toMatch(/DB_CLUSTER_POSTGRES_SSL[^)\n]*respected/i);
    });

    it('factory.ts attaches a pool.on("error", …) handler at the Pool site', () => {
        const factoryTs = readFileSync(join(REPO_ROOT, 'src', 'adapters', 'factory.ts'), 'utf-8');
        // The handler must be present so an idle-client TCP RST does not crash
        // the host process (STORES-B-006 / EGRESS-001). It must NOT introduce
        // SSL config (the decision is to retract the TLS claim, not implement it).
        expect(factoryTs).toMatch(/pool\.on\(\s*['"]error['"]/);
        expect(factoryTs).not.toMatch(/DB_CLUSTER_POSTGRES_SSL/);
    });
});

// ───────────────────────────────────────────────────────────────────────────
// PROV-002 — Postgres canonical versioning (parity with local)
// ───────────────────────────────────────────────────────────────────────────
//
// Mirror the existing Postgres test gating (test/postgres-canonical-store.test.ts):
// run only when DB_CLUSTER_POSTGRES_URL is set; SKIP cleanly otherwise so the
// suite never hangs without a test Postgres.

const POSTGRES_URL = process.env.DB_CLUSTER_POSTGRES_URL;
const describePostgres = POSTGRES_URL ? describe : describe.skip;

describePostgres('PROV-002 — Postgres canonical versioning behaves identically to local', () => {
    // Lazy-loaded so the imports never even resolve a Pool without a test PG.
    let PoolCtor: typeof import('pg').Pool;
    let PostgresCanonicalStore: typeof import('../src/adapters/postgres/postgres-canonical-store.js').PostgresCanonicalStore;
    let LocalCanonicalStore: typeof import('../src/adapters/local/local-canonical-store.js').LocalCanonicalStore;
    let pool: import('pg').Pool;
    let pgStore: import('../src/adapters/postgres/postgres-canonical-store.js').PostgresCanonicalStore;

    beforeAll(async () => {
        ({ Pool: PoolCtor } = await import('pg'));
        ({ PostgresCanonicalStore } = await import('../src/adapters/postgres/postgres-canonical-store.js'));
        ({ LocalCanonicalStore } = await import('../src/adapters/local/local-canonical-store.js'));
        pool = new PoolCtor({ connectionString: POSTGRES_URL });
        pgStore = new PostgresCanonicalStore(pool);
        await pgStore.migrate();
    });

    afterAll(async () => {
        if (pgStore) await pgStore.teardown();
        if (pool) await pool.end();
    });

    beforeEach(async () => {
        await pool.query(`DELETE FROM canonical_entities`);
    });

    it('create stamps version=1', async () => {
        const e = await pgStore.create({ kind: 'concept', name: 'V', attributes: { a: 1 } });
        expect(e.version).toBe(1);
    });

    it('update APPENDS version 2 and retains version 1 (append, not overwrite)', async () => {
        const v1 = await pgStore.create({ kind: 'concept', name: 'Orig', attributes: { a: 1 } });
        const v2 = await pgStore.update(v1.id, { name: 'Updated' });

        expect(v2.version).toBe(2);
        expect(v2.name).toBe('Updated');
        expect(v2.attributes).toEqual({ a: 1 }); // merged-forward from v1

        // get() returns the LATEST version.
        const latest = await pgStore.get(v1.id);
        expect(latest?.version).toBe(2);
        expect(latest?.name).toBe('Updated');

        // Prior version retained immutably.
        const retainedV1 = await pgStore.getVersion(v1.id, 1);
        expect(retainedV1?.version).toBe(1);
        expect(retainedV1?.name).toBe('Orig');
    });

    it('listVersions returns all versions ascending; getVersion fetches one', async () => {
        const v1 = await pgStore.create({ kind: 'concept', name: 'A', attributes: {} });
        await pgStore.update(v1.id, { name: 'B' });
        await pgStore.update(v1.id, { name: 'C' });

        const versions = await pgStore.listVersions(v1.id);
        expect(versions.map((v) => v.version)).toEqual([1, 2, 3]);
        expect(versions.map((v) => v.name)).toEqual(['A', 'B', 'C']);

        expect((await pgStore.getVersion(v1.id, 2))?.name).toBe('B');
        expect(await pgStore.getVersion(v1.id, 99)).toBeNull();
        expect(await pgStore.getVersion('00000000-0000-0000-0000-000000000000', 1)).toBeNull();
    });

    it('importSnapshot preserves the incoming version', async () => {
        const snapshot = {
            id: '11111111-1111-1111-1111-111111111111',
            kind: 'concept',
            name: 'Imported',
            attributes: { k: 'v' },
            version: 7,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-02T00:00:00.000Z',
            owner: 'canonical' as const,
        };
        const stored = await pgStore.importSnapshot(snapshot);
        expect(stored.version).toBe(7);
        const back = await pgStore.getVersion(snapshot.id, 7);
        expect(back?.version).toBe(7);
        expect(back?.name).toBe('Imported');
    });

    it('local ↔ Postgres versioning parity (same observable behaviour)', async () => {
        const dir = mkdtempSync(join(tmpdir(), 's2a1-parity-'));
        try {
            const local = new LocalCanonicalStore(join(dir, 'canonical'));

            const lv1 = await local.create({ kind: 'k', name: 'A', attributes: { n: 1 } });
            const pv1 = await pgStore.create({ kind: 'k', name: 'A', attributes: { n: 1 } });
            expect(lv1.version).toBe(pv1.version);
            expect(lv1.version).toBe(1);

            const lv2 = await local.update(lv1.id, { name: 'B' });
            const pv2 = await pgStore.update(pv1.id, { name: 'B' });
            expect(lv2.version).toBe(pv2.version);
            expect(lv2.version).toBe(2);

            const lVersions = await local.listVersions(lv1.id);
            const pVersions = await pgStore.listVersions(pv1.id);
            expect(lVersions.map((v) => v.version)).toEqual(pVersions.map((v) => v.version));
            expect(lVersions.map((v) => v.name)).toEqual(pVersions.map((v) => v.name));
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
