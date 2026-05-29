/**
 * Wave S2-A1 fix-up — operator-surface WIRING regression net (Fix-up Agent B).
 *
 * Adversarial verifiers surfaced two gaps on the POLICED operator surfaces that
 * the existing ops-level tests (which call `verify(stores, { commandQueue })`
 * directly) could not catch, because they always supply a queue by hand:
 *
 *   TASK 2 (HIGH, the load-bearing one) — `verify()` SKIPS the
 *   `command_receipt_bijection` check entirely when no `commandQueue` is
 *   supplied (intentional back-compat default). The two operator-facing verify
 *   paths — `createSafeCluster(...).verify()` (factory.ts) and the CLI `verify`
 *   command (cli.ts) — never supplied one, so an orphan/forged receipt read
 *   back as HEALTHY at the surface a real operator actually touches. The fix
 *   wires `new CommandQueue(rootDir)` into both paths so the bijection check
 *   runs by default. This test drives the PROGRAMMATIC policed surface
 *   (`createSafeCluster`) end-to-end; the CLI mirrors the identical call (we do
 *   NOT shell out to a possibly-mid-rebuild dist — see the source-level CLI
 *   assertion below).
 *
 *   TASK 1 (CRITICAL via honest disclosure) — the ledger `integrityHash` is an
 *   UNKEYED SHA-256 chain. It is tamper-EVIDENT (accidental corruption,
 *   reordering, casual single-record edits) but NOT tamper-PROOF: a package
 *   holder can recompute the public chain and re-stamp it clean. SECURITY.md
 *   and `src/types/integrity.ts` previously called it "tamper-evident" with no
 *   disclosure of this limit. These tests assert the honest disclosure is now
 *   present in both surfaces.
 *
 *   V1-105 (fold-in) — the pg `Pool` 'error' handler (EGRESS-001) was only
 *   source-string-asserted. This adds a RUNTIME test that emitting
 *   `pool.emit('error', new Error('ECONNRESET'))` does NOT rethrow / crash.
 *
 * Throwaway temp dirs only — NEVER the repo's `.db-cluster/`.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

// The POLICED package-root surface — the entry a real consumer/operator reaches.
import { createSafeCluster } from '../src/index.js';
// The UNSAFE escape hatch — used here, on purpose, to plant a forged receipt
// directly in the ledger (bypassing the kernel) so we can prove the policed
// verify() detects the bijection break.
import { createLocalCluster } from '../src/unsafe.js';
// The raw factory + Pool, for the V1-105 runtime handler test.
import { createCluster } from '../src/adapters/factory.js';

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');

const tempDirs: string[] = [];
function freshDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'db-cluster-s2a1-fixup-'));
    tempDirs.push(dir);
    return dir;
}

afterEach(() => {
    while (tempDirs.length) {
        const dir = tempDirs.pop()!;
        try {
            rmSync(dir, { recursive: true, force: true });
        } catch {
            // best-effort
        }
    }
});

function findCheck(health: { checks: { name: string; status: string }[] }, name: string) {
    return health.checks.find((c) => c.name === name);
}

// =====================================================================
// TASK 2 — the load-bearing wiring proof.
// =====================================================================

describe('Wave S2-A1 fix-up — Task 2: command_receipt_bijection wired on the policed verify surface', () => {
    it('createSafeCluster().verify() RUNS the bijection check (it is present, not silently skipped)', async () => {
        const rootDir = freshDir();
        const cluster = createSafeCluster({ rootDir });

        // A committed entity creates a command WITH a receipt — a healthy,
        // bijection-complete baseline through the policed kernel.
        await cluster.kernel.createEntity({
            kind: 'doc',
            name: 'Alpha',
            attributes: {},
            actorId: 'u',
        });

        const health = await cluster.verify();

        // At HEAD the factory binds `verify(stores, options)` with NO queue, so
        // the check is SKIPPED ENTIRELY (no entry pushed). After the fix the
        // factory wires `new CommandQueue(rootDir)`, so the check is PRESENT.
        const check = findCheck(health, 'command_receipt_bijection');
        expect(check, 'command_receipt_bijection must be present on the policed verify surface').toBeTruthy();
    });

    it('createSafeCluster().verify() reports NON-healthy when an orphan receipt is planted via /unsafe [command_receipt_bijection]', async () => {
        const rootDir = freshDir();

        // Seed a healthy, policed cluster (committed command + matching receipt).
        {
            const seedCluster = createSafeCluster({ rootDir });
            await seedCluster.kernel.createEntity({
                kind: 'doc',
                name: 'Beta',
                attributes: {},
                actorId: 'u',
            });
        }

        // Plant an orphan receipt whose commandId resolves to NO committed
        // command, via the raw /unsafe ledger (bypasses the kernel). The adapter
        // stamps a valid integrityHash + prevHash on appendReceipt, so the
        // ledger_integrity_chain check stays clean and we isolate the bijection
        // failure.
        const raw = createLocalCluster(rootDir);
        await raw.ledger.appendReceipt({
            commandId: 'NONEXISTENT',
            resultSummary: 'forged orphan receipt',
            affectedIds: [],
            provenanceEventId: 'NONEXISTENT-EVENT',
        });

        // Build a FRESH policed cluster over the same rootDir so its in-memory
        // ledger loads the on-disk receipts (the LocalLedgerStore caches
        // `this.receipts` at construction; reusing the seed instance would not
        // see the out-of-band /unsafe append). This mirrors how a real operator
        // process — separate from whatever wrote the forged receipt — observes
        // the on-disk state.
        const cluster = createSafeCluster({ rootDir });

        // The POLICED surface must now detect it. At HEAD this FAILS: the check
        // is absent (no queue wired) so the cluster reports healthy and the
        // orphan reads back clean. After the fix the factory wires the queue,
        // the bijection direction-A check fires, and verify is NON-healthy.
        const health = await cluster.verify();

        expect(health.status, 'a planted orphan receipt must make the policed verify NON-healthy').not.toBe(
            'healthy',
        );
        const check = findCheck(health, 'command_receipt_bijection');
        expect(check, 'command_receipt_bijection must be present').toBeTruthy();
        expect(check!.status, 'command_receipt_bijection must be non-healthy with an orphan receipt').not.toBe(
            'healthy',
        );
    });

    it('a caller-supplied commandQueue still wins over the factory default (merge precedence)', async () => {
        const rootDir = freshDir();
        const cluster = createSafeCluster({ rootDir });
        await cluster.kernel.createEntity({
            kind: 'doc',
            name: 'Gamma',
            attributes: {},
            actorId: 'u',
        });

        // Supplying an EMPTY queue (no committed commands) means the one real
        // committed command from createEntity now looks receipt-less OR its
        // receipt looks orphaned — either way the bijection breaks. This proves
        // the caller's queue is honoured (caller wins) rather than silently
        // overridden by the factory-built one.
        const emptyQueue = { list: () => [] };
        const health = await cluster.verify({ commandQueue: emptyQueue });

        const check = findCheck(health, 'command_receipt_bijection');
        expect(check, 'caller-supplied queue must still drive the bijection check').toBeTruthy();
        expect(check!.status, 'an empty caller queue breaks the bijection (caller wins)').not.toBe('healthy');
    });
});

// =====================================================================
// TASK 2 (CLI mirror) — source-level assertion that the CLI verify action
// wires a CommandQueue the same way doctor does. We do NOT shell out to
// node dist/cli.js (dist may be mid-rebuild by the coordinator); the
// programmatic SafeCluster.verify test above is the primary behavioural proof.
// =====================================================================

describe('Wave S2-A1 fix-up — Task 2: CLI verify action mirrors doctor\'s CommandQueue wiring', () => {
    const cliSource = readFileSync(join(REPO_ROOT, 'src', 'cli.ts'), 'utf-8');

    // Isolate just the OPS `verify` command action block. NOTE there are two
    // `.command('verify')` in cli.ts — the `stores verify` subcommand (backend
    // connectivity) and the top-level ops `verify` (cluster invariants). Anchor
    // on the ops command's unambiguous description so we assert against the
    // right action. The block ends at the next `.command(` that follows it.
    // (CRLF-safe: we slice on string offsets, not literal newlines.)
    const verifyDescAnchor = "Verify cluster invariants (data consistency)";
    const verifyActionStart = cliSource.indexOf(verifyDescAnchor);
    const nextCommandStart = cliSource.indexOf('.command(', verifyActionStart + 1);
    const verifyBlock = cliSource.slice(
        verifyActionStart,
        nextCommandStart > verifyActionStart ? nextCommandStart : verifyActionStart + 1500,
    );

    it('the CLI verify action constructs a CommandQueue (mirrors the doctor action)', () => {
        expect(verifyBlock).toMatch(/CommandQueue/);
        expect(verifyBlock).toMatch(/new CommandQueue\(\s*CLUSTER_DIR\s*\)/);
    });

    it('the CLI verify action passes the commandQueue into verify()', () => {
        expect(verifyBlock).toMatch(/commandQueue/);
    });
});

// =====================================================================
// TASK 1 — honest tamper-evident-NOT-proof disclosure.
// =====================================================================

describe('Wave S2-A1 fix-up — Task 1: tamper-evident ≠ tamper-proof disclosure', () => {
    const securityMd = readFileSync(join(REPO_ROOT, 'SECURITY.md'), 'utf-8');
    const integrityTs = readFileSync(join(REPO_ROOT, 'src', 'types', 'integrity.ts'), 'utf-8');

    it('SECURITY.md discloses tamper-evident is NOT a cryptographic anti-forgery guarantee', () => {
        expect(securityMd).toMatch(/tamper-evident/i);
        // The disclosure must co-locate "tamper-evident" with the limit ("not")
        // and the tracked upgrade path (HMAC / keyed / re-stamp).
        expect(securityMd).toMatch(/not[\s\S]{0,400}(HMAC|keyed|re-stamp|anti-forgery)/i);
        expect(securityMd).toMatch(/HMAC|keyed/i);
        expect(securityMd).toMatch(/re-stamp/i);
    });

    it('SECURITY.md discloses the two content-addressing limits (metadata reads + re-content)', () => {
        // (a) metadata reads (get/list) are not byte-integrity-checked.
        expect(securityMd).toMatch(/metadata[\s\S]{0,200}(not[\s\S]{0,40}byte|byte[\s\S]{0,40}integrit)/i);
        // (b) re-content (rewriting blob AND its recorded contentHash) is
        //     undetectable at the content layer by design.
        expect(securityMd).toMatch(/re-content|contentHash[\s\S]{0,120}(undetect|by design)/i);
    });

    it('src/types/integrity.ts carries the tamper-evident-not-proof caveat', () => {
        expect(integrityTs).toMatch(/tamper-eviden/i);
        expect(integrityTs).toMatch(/tamper-proof|anti-forgery/i);
        expect(integrityTs).toMatch(/HMAC|keyed/i);
        expect(integrityTs).toMatch(/re-stamp/i);
    });

    it('src/types/integrity.ts notes the bulk-read (list/trace) verify gap (V2-002)', () => {
        // Bulk reads do NOT recompute integrity; use verify() over a set.
        expect(integrityTs).toMatch(/listEvents|listReceipts|bulk|trace/i);
        expect(integrityTs).toMatch(/verify\(\)/);
    });
});

// =====================================================================
// V1-105 — pg Pool 'error' handler does not crash the process (runtime).
// =====================================================================

describe('Wave S2-A1 fix-up — V1-105: pg Pool idle-client error is swallowed (EGRESS-001)', () => {
    it('emitting pool.emit("error", ECONNRESET) does NOT rethrow (handler is attached + swallows)', () => {
        const rootDir = freshDir();
        // A bogus connection string never actually connects — we only need the
        // Pool object and its attached 'error' listener. createCluster attaches
        // attachPoolErrorHandler() before returning.
        const { pool } = createCluster({
            rootDir,
            backends: { canonical: 'postgres' },
            postgresUrl: 'postgres://nobody:nobody@127.0.0.1:1/none',
        });

        expect(pool, 'postgres backend must return a pool').toBeTruthy();
        // A handler MUST be attached — otherwise EventEmitter rethrows 'error'.
        expect(pool!.listenerCount('error')).toBeGreaterThan(0);

        // The load-bearing assertion: emitting 'error' must NOT throw. Without a
        // listener, Node's EventEmitter rethrows the emitted Error synchronously
        // here and crashes the process; with the EGRESS-001 handler it is logged
        // and swallowed.
        expect(() => {
            pool!.emit('error', new Error('ECONNRESET'), {} as never);
        }).not.toThrow();

        // Clean up the pool's internal resources so the test process exits
        // cleanly (no open handles). end() on a never-connected pool resolves.
        return pool!.end().catch(() => {
            /* never connected — ignore */
        });
    });
});
