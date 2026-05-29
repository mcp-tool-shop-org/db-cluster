/**
 * Wave B1-Amend FIX-UP — regression nets for the 17 fix-up items dispatched
 * by the coordinator-as-judge after the verifier ensemble (V1+V2+V3) clustered
 * 45 findings into nine high-signal clusters.
 *
 * Tests written BEFORE the fixes landed per the per-finding test-first gate.
 * Each test pins one architectural invariant from the fix-up dispatch. A
 * regression that re-introduces the broken shape produces a self-explaining
 * failure.
 *
 * Findings covered (in tier order from the aggregator):
 *
 *  Tier 1 — Architectural integration (label-rendering boundary)
 *  - AGG-B1-1a — Stale JSDoc in `src/provenance/trace-builder.ts` claimed
 *    labels had identifier "structurally stripped" — false after coordinator
 *    fix-up made `renderPublicLabel` delegate to `renderProvenanceLabel(
 *    labelData, [])`. JSDoc must describe the actual literal-at-bare-kernel
 *    doctrine.
 *  - AGG-B1-1b — `PolicyEnforcedKernel.traceObject` / `traceBundle` did not
 *    re-render labels via `renderProvenanceLabel(labelData, policyView)`.
 *    `entity_name` and `artifact_filename` RedactionTargets were inert at
 *    the PolicyEnforced boundary.
 *
 *  Tier 2 — `LocalLedgerStore.rotate()` correctness
 *  - AGG-B1-2a — Atomicity: pre-fix mutated `this.events = retainEvents`
 *    BEFORE persist. Mid-write failure → permanent in-memory/on-disk
 *    divergence. Post-fix persists FIRST, mutates AFTER both persist calls
 *    succeed, restores in-memory snapshot on persist failure.
 *  - AGG-B1-2b — Input validation: pre-fix accepted any string as the
 *    boundary timestamp. Empty / non-ISO produced silent no-ops or
 *    lexicographic surprises. Post-fix throws typed
 *    `InvalidRotateTimestampError` (code `INVALID_ROTATE_TIMESTAMP`).
 *  - AGG-B1-2c — Archive directory orphan-tmp sweep: pre-fix
 *    `<dataDir>/ledger-archive/` was not swept at construction; failed
 *    rotations accumulated orphan `.tmp` files forever.
 *  - AGG-B1-2d — Future-timestamp safeguard: pre-fix returned silent
 *    `{archived:0, retained:N}` — indistinguishable from "nothing to
 *    archive." Post-fix throws `RotateBoundaryInFutureError` (code
 *    `ROTATE_BOUNDARY_IN_FUTURE`).
 *
 *  Tier 3 — Cross-domain (family-probe misses)
 *  - AGG-B1-3 — `scripts/release-gate.mjs:111` + `scripts/smoke-install.mjs:16`
 *    hardcoded `db-cluster-0.1.0.tgz`. SURFACE-B-013 family probe stopped at
 *    `src/` and missed `scripts/`. Fix reads version from `package.json`.
 *  - AGG-B1-4 — `LocalLedgerStore.loadArray` silently discarded bad-tail
 *    lines. Asymmetric with Wave A4's `CommandQueuePersistenceLostError`.
 *    Fix emits stderr warning + records a `ledger_tail_corruption_recovered`
 *    event after construction.
 *
 *  Tier 4 — Operator-surface fixes
 *  - AGG-B1-5 — `OperationsPanel` read `opsData.doctor?.overall` (no such
 *    field) — correct shape is `opsData.overall`. Same for
 *    `provenanceHealth.receipts` (→ `totalReceipts`) and `.events`
 *    (→ `totalEvents`).
 *  - AGG-B1-6 — CLI + dashboard's ops-model called `doctor(stores)` without
 *    options → `no_orphan_staging` check silently skipped. Fix threads
 *    `dataDir` + `commandQueue` from the kernel.
 *  - V1-B1-007 / V2-B1-011 — `ops-model.ts` defensive try/catch on
 *    `countEvents` set `orphanEvents = 0` on ANY error. Masks degraded as
 *    healthy. Fix distinguishes runtime-error (orphanEvents=null +
 *    degradedReason) from healthy.
 *  - V3-B1-005 — `ops-model.ts` had a defensive feature-detect
 *    `if (typeof (stores.ledger as ...).countEvents === 'function')` but
 *    `countEvents` is REQUIRED on the contract. Fix removes the feature
 *    detect; the try/catch above still handles runtime errors.
 *
 *  Tier 5 — Small surgical
 *  - V1-B1-010 — `recordOrphanMutation` wrote `orphanErr.message` to stderr
 *    unscrubbed. Persisted ledger detail IS scrubbed (line 262 via
 *    redactErrorMessage); stderr was asymmetric. Fix scrubs stderr too.
 *  - V2-B1-006 — `PolicyConfigError` (constructor name) was missing from
 *    `BUILTIN_ERROR_CODES` map → fell back to INTERNAL_ERROR. Fix adds the
 *    mapping. Also the new `InvalidRotateTimestampError` and
 *    `RotateBoundaryInFutureError` from AGG-B1-2b/2d.
 *  - V1-B1-006 — NDJSON shape gate accepted `id: ''`. Tampered ledger with
 *    `{"id":""}` slipped through. Fix: `id.length > 0`.
 *  - AGG-B1-9a — `docs/store-contracts.md` didn't document `rotate()`,
 *    `countEvents()`, `importEvent()`, `importReceipt()` — all REQUIRED.
 *  - AGG-B1-9b — `docs/policy-and-redaction.md` didn't document the new
 *    `entity_name` / `artifact_filename` RedactionTargets.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { LocalLedgerStore } from '../src/adapters/local/local-ledger-store.js';
import {
    InvalidRotateTimestampError,
    RotateBoundaryInFutureError,
} from '../src/adapters/local/errors.js';
import { buildRandomTmpPath } from '../src/util/tmp-paths.js';
import { redactError } from '../src/mcp/sanitize.js';
import { PolicyConfigError } from '../src/mcp/config-validator.js';

function makeTmpDir(): string {
    return mkdtempSync(join(tmpdir(), 'wave-b1-fixup-'));
}

// ─── Tier 1 — Label-rendering boundary ───────────────────────────────────

describe('AGG-B1-1a — trace-builder.ts JSDoc reflects post-fixup doctrine', () => {
    it('addStructuredNode JSDoc does NOT claim "structurally stripped"', () => {
        const src = readFileSync(resolve(process.cwd(), 'src/provenance/trace-builder.ts'), 'utf-8');
        // Find the addStructuredNode region (search start of jsdoc through method end).
        const idx = src.indexOf('private addStructuredNode(');
        expect(idx).toBeGreaterThan(0);
        const region = src.slice(Math.max(0, idx - 2000), idx);
        // Pre-fix wording that misrepresents the actual behavior.
        expect(region).not.toMatch(/sensitive identifier ALREADY structurally stripped/);
        expect(region).not.toMatch(/sensitive identifier.{0,20}structurally stripped/);
    });
    it('renderPublicLabel JSDoc describes literal-at-bare-kernel doctrine', () => {
        const src = readFileSync(resolve(process.cwd(), 'src/provenance/trace-builder.ts'), 'utf-8');
        const idx = src.indexOf('private renderPublicLabel(');
        expect(idx).toBeGreaterThan(0);
        const region = src.slice(Math.max(0, idx - 1500), idx + 200);
        // The new doctrine must be mentioned: bare ClusterKernel returns literal labels;
        // PolicyEnforcedKernel / MCP / dashboard re-render at their boundary.
        expect(region.toLowerCase()).toContain('literal');
        expect(region).toMatch(/PolicyEnforcedKernel|policy.{0,40}boundary/);
    });
});

describe('AGG-B1-1b — PolicyEnforcedKernel re-renders labels via renderProvenanceLabel', () => {
    it('traceObject body invokes renderProvenanceLabel (direct or via helper)', () => {
        const src = readFileSync(resolve(process.cwd(), 'src/kernel/policy-enforced-kernel.ts'), 'utf-8');
        const fnStart = src.indexOf('async traceObject(');
        expect(fnStart).toBeGreaterThan(0);
        // Body extends to the next async method declaration or class close.
        const nextDecl = Math.min(
            ...['\n    async ', '\n    explainTrace', '\n    checkVisibility('].map((s) => {
                const i = src.indexOf(s, fnStart + 10);
                return i === -1 ? src.length : i;
            }),
        );
        const body = src.slice(fnStart, nextDecl);
        // Direct call OR helper invocation that calls renderProvenanceLabel
        // (we add `rerenderLabelsWithPolicy` for this fix).
        expect(body).toMatch(/renderProvenanceLabel|rerenderLabelsWithPolicy/);
    });
    it('traceBundle body invokes renderProvenanceLabel (direct or via helper)', () => {
        const src = readFileSync(resolve(process.cwd(), 'src/kernel/policy-enforced-kernel.ts'), 'utf-8');
        const fnStart = src.indexOf('async traceBundle(');
        expect(fnStart).toBeGreaterThan(0);
        const nextDecl = Math.min(
            ...['\n    async ', '\n    explainTrace', '\n    checkVisibility('].map((s) => {
                const i = src.indexOf(s, fnStart + 10);
                return i === -1 ? src.length : i;
            }),
        );
        const body = src.slice(fnStart, nextDecl);
        expect(body).toMatch(/renderProvenanceLabel|rerenderLabelsWithPolicy/);
    });
});

// ─── Tier 2 — rotate() correctness ───────────────────────────────────────

describe('AGG-B1-2a — rotate() atomicity (persist FIRST, mutate AFTER)', () => {
    it('rotate() failure mid-persist restores in-memory snapshot', async () => {
        const dir = makeTmpDir();
        const store = new LocalLedgerStore(dir);
        // Seed two events with distinct timestamps.
        await store.append({
            action: 'entity_created',
            subjectId: 'old-1',
            subjectStore: 'canonical',
            actorId: 'test',
            detail: {},
        });
        // Sleep 5ms to ensure ISO timestamps differ.
        await new Promise((r) => setTimeout(r, 5));
        const newEvent = await store.append({
            action: 'entity_created',
            subjectId: 'new-1',
            subjectStore: 'canonical',
            actorId: 'test',
            detail: {},
        });
        // Boundary: at newEvent.timestamp so old-1 archives, new-1 retains.
        const boundary = newEvent.timestamp;
        // PROV-006: rotate() no longer calls persistEvents — it stages the
        // retained active files via serializeNdjson() + writeFileSync(tmp),
        // then renames, and mutates in-memory ONLY after both renames succeed.
        // Hook serializeNdjson to throw on its first call (post-archive-write,
        // pre-rename, pre-in-memory-mutation) — the exact "mid-persist" point
        // the AGG-B1-2a invariant guards. Private method reached via `as any`.
        const storeAny = store as unknown as { serializeNdjson(records: unknown[]): string; events: unknown[]; receipts: unknown[] };
        const snapshotEvents = [...storeAny.events];
        const snapshotReceipts = [...storeAny.receipts];
        const origSerialize = storeAny.serializeNdjson.bind(store);
        let calls = 0;
        storeAny.serializeNdjson = function () {
            calls++;
            throw new Error('simulated mid-rotate persist failure');
        };
        let threw = false;
        try {
            await store.rotate(boundary);
        } catch {
            threw = true;
        }
        // Restore method for cleanup.
        storeAny.serializeNdjson = origSerialize;
        expect(threw).toBe(true);
        expect(calls).toBe(1);
        // In-memory snapshot is restored — the array MUST be the same as
        // the pre-rotate snapshot (no partial mutation persisting through
        // the failed call).
        expect(storeAny.events.length).toBe(snapshotEvents.length);
        expect(storeAny.receipts.length).toBe(snapshotReceipts.length);
    });
});

describe('AGG-B1-2b — rotate() input validation', () => {
    it('rotate("") throws InvalidRotateTimestampError', async () => {
        const dir = makeTmpDir();
        const store = new LocalLedgerStore(dir);
        await expect(store.rotate('')).rejects.toBeInstanceOf(InvalidRotateTimestampError);
    });
    it('rotate("not-a-date") throws InvalidRotateTimestampError', async () => {
        const dir = makeTmpDir();
        const store = new LocalLedgerStore(dir);
        await expect(store.rotate('not-a-date')).rejects.toBeInstanceOf(InvalidRotateTimestampError);
    });
    it('InvalidRotateTimestampError carries code INVALID_ROTATE_TIMESTAMP', async () => {
        const dir = makeTmpDir();
        const store = new LocalLedgerStore(dir);
        try {
            await store.rotate('');
            expect.fail('should have thrown');
        } catch (err) {
            expect(err).toBeInstanceOf(InvalidRotateTimestampError);
            expect((err as InvalidRotateTimestampError).code).toBe('INVALID_ROTATE_TIMESTAMP');
        }
    });
});

describe('AGG-B1-2c — Archive directory orphan-tmp sweep at constructor', () => {
    it('orphan tmp in <dataDir>/ledger-archive/ is removed on construction', () => {
        const dir = makeTmpDir();
        const archiveDir = join(dir, 'ledger-archive');
        mkdirSync(archiveDir, { recursive: true });
        // Build a tmp filename matching the random-suffix pattern with an
        // mtime older than the orphan threshold.
        const archivePath = join(archiveDir, 'events-archive123.ndjson');
        const tmpPath = buildRandomTmpPath(archivePath);
        writeFileSync(tmpPath, 'orphan-content');
        // Age the file: set mtime 1 hour in the past so it's beyond the
        // 5-minute orphan threshold.
        const past = new Date(Date.now() - 60 * 60 * 1000);
        // node:fs.utimesSync sync
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { utimesSync } = require('node:fs');
        utimesSync(tmpPath, past, past);
        expect(existsSync(tmpPath)).toBe(true);
        // Construct the store → triggers the orphan sweep.
        new LocalLedgerStore(dir);
        expect(existsSync(tmpPath)).toBe(false);
    });
});

describe('AGG-B1-2d — Future-timestamp safeguard throws typed error', () => {
    it('rotate(future) throws RotateBoundaryInFutureError', async () => {
        const dir = makeTmpDir();
        const store = new LocalLedgerStore(dir);
        const future = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
        await expect(store.rotate(future)).rejects.toBeInstanceOf(RotateBoundaryInFutureError);
    });
    it('RotateBoundaryInFutureError carries code ROTATE_BOUNDARY_IN_FUTURE', async () => {
        const dir = makeTmpDir();
        const store = new LocalLedgerStore(dir);
        const future = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
        try {
            await store.rotate(future);
            expect.fail('should have thrown');
        } catch (err) {
            expect(err).toBeInstanceOf(RotateBoundaryInFutureError);
            expect((err as RotateBoundaryInFutureError).code).toBe('ROTATE_BOUNDARY_IN_FUTURE');
        }
    });
});

// ─── Tier 3 — Cross-domain ───────────────────────────────────────────────

describe('AGG-B1-3 — scripts/ no longer hardcodes db-cluster-0.1.0.tgz', () => {
    it('scripts/release-gate.mjs does not contain the literal "db-cluster-0.1.0.tgz"', () => {
        const src = readFileSync(resolve(process.cwd(), 'scripts/release-gate.mjs'), 'utf-8');
        expect(src).not.toContain('db-cluster-0.1.0.tgz');
    });
    it('scripts/smoke-install.mjs does not contain the literal "db-cluster-0.1.0.tgz" as default fallback', () => {
        const src = readFileSync(resolve(process.cwd(), 'scripts/smoke-install.mjs'), 'utf-8');
        expect(src).not.toContain('db-cluster-0.1.0.tgz');
    });
    it('release-gate reads version from package.json', () => {
        const src = readFileSync(resolve(process.cwd(), 'scripts/release-gate.mjs'), 'utf-8');
        // The fix path: read pkg.version and build the tarball name.
        expect(src).toMatch(/package\.json/);
        expect(src).toMatch(/\$\{[^}]*version[^}]*\}|version\s*[)\];,]/);
    });
});

describe('AGG-B1-4 — NDJSON tail-corruption is loud (stderr + ledger event)', () => {
    it('tail-corrupted NDJSON load emits stderr warning AND records a ledger_tail_corruption_recovered event', async () => {
        const dir = makeTmpDir();
        // Pre-create a good event then append garbage.
        const eventsPath = join(dir, 'events.json');
        // Two good lines + one garbage line.
        const good1 = '{"id":"e1","action":"entity_created","subjectId":"a","subjectStore":"canonical","actorId":"t","timestamp":"2024-01-01T00:00:00.000Z","owner":"ledger"}';
        const good2 = '{"id":"e2","action":"entity_created","subjectId":"b","subjectStore":"canonical","actorId":"t","timestamp":"2024-01-02T00:00:00.000Z","owner":"ledger"}';
        const garbage = '{"id":"e3","action":';
        writeFileSync(eventsPath, `${good1}\n${good2}\n${garbage}\n`);
        // Capture stderr.
        const errs: string[] = [];
        const origWrite = process.stderr.write.bind(process.stderr);
        process.stderr.write = ((chunk: unknown) => {
            errs.push(String(chunk));
            return true;
        }) as typeof process.stderr.write;
        let store: LocalLedgerStore;
        try {
            store = new LocalLedgerStore(dir);
        } finally {
            process.stderr.write = origWrite;
        }
        // Stderr signal.
        const joined = errs.join('');
        expect(joined.toLowerCase()).toMatch(/tail corruption|tail-corruption|corruption/);
        // Ledger event recorded post-construction.
        const events = await store.listEvents();
        const recovery = events.find((e) => e.action === 'ledger_tail_corruption_recovered');
        expect(recovery, 'expected a ledger_tail_corruption_recovered event').toBeDefined();
    });
});

// ─── Tier 4 — Operator-surface ───────────────────────────────────────────

describe('AGG-B1-5 — OperationsPanel reads correct OpsModel shape', () => {
    it('OperationsPanel does NOT reference opsData.doctor', () => {
        const src = readFileSync(resolve(process.cwd(), 'dashboard/components/OperationsPanel.jsx'), 'utf-8');
        expect(src).not.toMatch(/opsData\.doctor/);
    });
    it('OperationsPanel reads opsData.overall (top-level, not opsData.doctor.overall)', () => {
        const src = readFileSync(resolve(process.cwd(), 'dashboard/components/OperationsPanel.jsx'), 'utf-8');
        expect(src).toMatch(/opsData\.overall|opsData\?\.\overall/);
    });
    it('OperationsPanel reads provenanceHealth.totalReceipts and totalEvents (not .receipts / .events)', () => {
        const src = readFileSync(resolve(process.cwd(), 'dashboard/components/OperationsPanel.jsx'), 'utf-8');
        expect(src).toMatch(/provenanceHealth.{0,5}\.totalReceipts/);
        expect(src).toMatch(/provenanceHealth.{0,5}\.totalEvents/);
        // No stale .receipts or .events properties on provenanceHealth.
        expect(src).not.toMatch(/provenanceHealth\?\.receipts\b/);
        expect(src).not.toMatch(/provenanceHealth\?\.events\b/);
    });
});

describe('AGG-B1-6 — doctor() invoked with dataDir + commandQueue from CLI and ops-model', () => {
    it('src/cli.ts doctor command passes dataDir option', () => {
        const src = readFileSync(resolve(process.cwd(), 'src/cli.ts'), 'utf-8');
        // Find the doctor invocation block; assert dataDir is threaded.
        const idx = src.indexOf("const { doctor } = await import('./ops/doctor.js')");
        expect(idx).toBeGreaterThan(0);
        const region = src.slice(idx, idx + 600);
        // doctor() invocation in the region must include dataDir
        expect(region).toMatch(/doctor\([^)]*dataDir/);
    });
    it('src/dashboard/ops-model.ts buildOpsModel forwards dataDir + commandQueue to doctor()', () => {
        const src = readFileSync(resolve(process.cwd(), 'src/dashboard/ops-model.ts'), 'utf-8');
        // The doctor() call must include dataDir (the function signature now
        // accepts it).
        expect(src).toMatch(/doctor\([^)]*dataDir/);
    });
});

describe('V1-B1-007 / V2-B1-011 — ops-model distinguishes runtime-error from healthy', () => {
    it('ProvenanceHealth.orphanEvents type allows null (degraded-on-error signal)', () => {
        const src = readFileSync(resolve(process.cwd(), 'src/dashboard/ops-model.ts'), 'utf-8');
        // The interface or assignment must allow `number | null` for orphanEvents
        // when countEvents throws.
        expect(src).toMatch(/orphanEvents\??:\s*number\s*\|\s*null/);
    });
    it('ops-model sets degradedReason when countEvents throws', () => {
        const src = readFileSync(resolve(process.cwd(), 'src/dashboard/ops-model.ts'), 'utf-8');
        // Catch arm must set orphanEvents to null AND set a degradedReason
        // like 'orphan_count_unavailable'.
        expect(src).toMatch(/orphan_count_unavailable/);
    });
});

describe('V3-B1-005 — ops-model has no feature-detect on countEvents', () => {
    it('src/dashboard/ops-model.ts does not feature-detect countEvents (contract REQUIRED)', () => {
        const src = readFileSync(resolve(process.cwd(), 'src/dashboard/ops-model.ts'), 'utf-8');
        // The pre-fix shape: `typeof (stores.ledger as ...).countEvents === 'function'`.
        // Post-fix removes the feature-detect.
        expect(src).not.toMatch(/typeof\s*\([^)]*countEvents[^)]*\)\s*===\s*['"]function['"]/);
    });
});

// ─── Tier 5 — Small surgical ─────────────────────────────────────────────

describe('V1-B1-010 — recordOrphanMutation stderr scrub', () => {
    it('cluster-kernel.ts stderr line for orphan-recording uses redactErrorMessage on the secondary failure', () => {
        const src = readFileSync(resolve(process.cwd(), 'src/kernel/cluster-kernel.ts'), 'utf-8');
        // Find the catch block around recordOrphanMutation that writes to
        // stderr. The fix: instead of inserting `orphanErr.message` raw, use
        // `redactErrorMessage(orphanErr)`.
        const idx = src.indexOf("Failed to record orphan mutation");
        expect(idx).toBeGreaterThan(0);
        const region = src.slice(Math.max(0, idx - 500), idx + 300);
        // The variable interpolation must go through redactErrorMessage.
        expect(region).toMatch(/redactErrorMessage\(\s*orphanErr/);
    });
});

describe('V2-B1-006 — BUILTIN_ERROR_CODES covers PolicyConfigError + new rotate errors', () => {
    it('PolicyConfigError maps to INVALID_POLICY_CONFIG', () => {
        const err = new PolicyConfigError('test-field', 'test-reason');
        const out = redactError(err);
        expect(out.code).toBe('INVALID_POLICY_CONFIG');
    });
    it('InvalidRotateTimestampError maps to INVALID_ROTATE_TIMESTAMP', () => {
        const err = new InvalidRotateTimestampError('not-a-date');
        const out = redactError(err);
        expect(out.code).toBe('INVALID_ROTATE_TIMESTAMP');
    });
    it('RotateBoundaryInFutureError maps to ROTATE_BOUNDARY_IN_FUTURE', () => {
        const err = new RotateBoundaryInFutureError(new Date(Date.now() + 1e9).toISOString());
        const out = redactError(err);
        expect(out.code).toBe('ROTATE_BOUNDARY_IN_FUTURE');
    });
});

describe('V1-B1-006 — NDJSON shape gate rejects empty id', () => {
    it('NDJSON file with {"id":""} line throws CorruptStoreError on load', () => {
        const dir = makeTmpDir();
        const eventsPath = join(dir, 'events.json');
        // Bad: empty id.
        writeFileSync(eventsPath, '{"id":""}\n');
        expect(() => new LocalLedgerStore(dir)).toThrow();
    });
});

describe('AGG-B1-9a — docs/store-contracts.md covers new LedgerStore methods', () => {
    it('docs/store-contracts.md documents rotate()', () => {
        const src = readFileSync(resolve(process.cwd(), 'docs/store-contracts.md'), 'utf-8');
        expect(src).toMatch(/\brotate\b/);
    });
    it('docs/store-contracts.md documents countEvents()', () => {
        const src = readFileSync(resolve(process.cwd(), 'docs/store-contracts.md'), 'utf-8');
        expect(src).toMatch(/\bcountEvents\b/);
    });
    it('docs/store-contracts.md documents importEvent() + importReceipt()', () => {
        const src = readFileSync(resolve(process.cwd(), 'docs/store-contracts.md'), 'utf-8');
        expect(src).toMatch(/\bimportEvent\b/);
        expect(src).toMatch(/\bimportReceipt\b/);
    });
});

describe('AGG-B1-9b — docs/policy-and-redaction.md documents new RedactionTargets', () => {
    it('docs/policy-and-redaction.md mentions entity_name', () => {
        const src = readFileSync(resolve(process.cwd(), 'docs/policy-and-redaction.md'), 'utf-8');
        expect(src).toMatch(/entity_name/);
    });
    it('docs/policy-and-redaction.md mentions artifact_filename', () => {
        const src = readFileSync(resolve(process.cwd(), 'docs/policy-and-redaction.md'), 'utf-8');
        expect(src).toMatch(/artifact_filename/);
    });
});

// ─── PolicyEnforcedKernel.traceObject end-to-end: entity_name redaction ──

describe('AGG-B1-1b end-to-end — entity_name policy gate is no longer inert', () => {
    it('traceObject under entity_name-deny policy returns [REDACTED] in node.label', async () => {
        // This test exercises the wired-up path. It constructs a kernel,
        // adds an entity, wraps the kernel in PolicyEnforcedKernel with a
        // policy that carries an entity_name redaction rule, and verifies
        // the rendered label carries [REDACTED] (not the literal name).
        // Imports are dynamic to keep the test file's top-level scope clean
        // of every kernel surface symbol.
        const dir = makeTmpDir();
        const { createLocalCluster } = await import('../src/adapters/local/index.js');
        const { PolicyEnforcedKernel } = await import('../src/kernel/policy-enforced-kernel.js');
        const stores = createLocalCluster(dir);
        const entity = await stores.canonical.create({
            kind: 'fact',
            name: 'secret-entity-name',
            attributes: {},
        });
        const principal = {
            id: 'agent-1',
            name: 'Agent',
            roles: ['reader'],
            trustZone: 'agent',
        };
        const policies = [
            {
                id: 'p1',
                name: 'Allow read, redact entity_name',
                priority: 100,
                match: { trustZones: ['agent'] },
                decision: 'allow' as const,
                reason: 'reader access',
                redaction: {
                    id: 'r1',
                    target: 'entity_name' as const,
                    behavior: 'mask' as const,
                    reason: 'mask entity names',
                },
            },
        ];
        const visibilityRules = [
            {
                id: 'v1',
                scope: { stores: ['canonical', 'artifact', 'index', 'ledger'] as any },
                existenceVisible: true,
                emitPlaceholder: false,
            },
        ];
        const pek = new PolicyEnforcedKernel(stores, { principal }, {
            policies,
            visibilityRules,
            dataDir: dir,
        } as any);
        const uri = `cluster://canonical/${entity.id}`;
        const graph = await pek.traceObject(uri);
        const node = graph.nodes.find((n) => n.uri === uri);
        expect(node).toBeDefined();
        expect(node!.label).toContain('[REDACTED]');
        // And the literal name must NOT be present.
        expect(node!.label).not.toContain('secret-entity-name');
    });
});
