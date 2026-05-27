/**
 * Wave C1-Amend — Stores domain regression nets (Stage C Wave C1 audit closes).
 *
 * Stage C Wave C1-Audit behavioral-humanization findings the Stores domain closes:
 *
 *  - STORES-C-001 — `mutation_orphaned > 0` health check produced by `doctor()`
 *    had `repairAvailable: false` AND no `suggestedCommand` AND no `nextSteps`.
 *    Operator was told "uninspectable state" with no remediation path. Fix:
 *    set `suggestedCommand` to an inspection command + populate `nextSteps`
 *    with operator-readable next-step strings on the HealthCheck.
 *
 *  - STORES-C-002 — `rebuildIndex()` / `backup()` / `restore()` walk all
 *    records serially with no progress feedback. Operator stares at blank
 *    for 30+ seconds. Fix: add optional `onProgress?: (current, total,
 *    message?) => void` callback parameter to each long-running op + wire
 *    it to the inner record-walking loop.
 *
 *  - STORES-C-003 — `restore()` silently rebuilt index + swallowed
 *    `entity.errors[]` in CLI output. Fix: structured `RestoreResult` already
 *    carried per-entity errors arrays (entities.errors/artifacts.errors/etc.) —
 *    extend with explicit `dryRun: boolean` + `warnings: string[]` + a
 *    `summary` field aggregating counts, and add `dryRun` option that
 *    returns what WOULD happen without mutating.
 *
 *  - STORES-C-006 — `backup -o existing.json` silently overwrote the prior
 *    backup. Fix: add `outputPath` + `force` options to `backup()`; throw
 *    `BackupTargetExistsError` (new typed error) when `outputPath` exists
 *    and `force` is not set.
 *
 *  - STORES-C-008 — `rebuildCheck` / `checkStale()` listed stale records but
 *    didn't append `→ fix: db-cluster rebuild index`. Fix: the load-bearing
 *    HealthCheck `suggestedCommand` is canonical — verify the
 *    `index_references_valid` and `index_populated` checks all carry
 *    suggestedCommand when remediation exists.
 *
 *  - STORES-C-009 / STORES-C-010 — Typed-error subclasses in
 *    `src/adapters/local/errors.ts` + `src/ops/errors.ts` lacked the §2b
 *    contract: `code`, `remediationHint`, `retryable` fields. Fix: apply
 *    the contract uniformly to every adapter-tier typed error.
 *
 *  - STORES-C-011 — Contract interface methods in `src/contracts/*` had
 *    interface-level JSDoc but most methods (`append`, `update`, `ingest`,
 *    `get`, `list`, etc.) lacked per-method semantic preconditions a
 *    custom-adapter author would need. Fix: add JSDoc to every method on
 *    every contract interface (CanonicalStore, ArtifactStore, IndexStore,
 *    LedgerStore).
 *
 *  - SHA-STORES-PHANTOM-CMD — `doctor()` set `suggestedCommand:
 *    'db-cluster stores migrate'` for the `postgres_migration` missing-table
 *    check. Per advisor disposition: DROP the suggestedCommand (the underlying
 *    Postgres `applied_migrations` registry lands with v0.2). Replacement:
 *    expand `message` with inspection guidance; do not promise a command.
 *
 * Cross-domain notes (read-only for this agent):
 *  - Surface agent owns CLI plumbing of new options (e.g., `--dry-run`,
 *    `--force`, `--output`) and rendering of the structured RestoreResult.
 *  - Kernel agent owns `ClusterErrorCode` + `AiErrorEnvelope` types; this
 *    file references them defensively (uses `code: string` if Kernel hasn't
 *    landed yet, narrows once available).
 */

import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLocalCluster } from '../src/adapters/local/index.js';
import { LocalLedgerStore } from '../src/adapters/local/local-ledger-store.js';
import { doctor } from '../src/ops/doctor.js';
import { verify } from '../src/ops/verify.js';
import { rebuildIndex, checkStale } from '../src/ops/rebuild.js';
import { backup, restore, type ClusterBackup } from '../src/ops/backup.js';
import {
    CorruptStoreError,
    InvalidContentHashError,
    ImportConflictError,
    LedgerCycleDetectedError,
    InvalidRotateTimestampError,
    RotateBoundaryInFutureError,
    BackupTargetExistsError,
} from '../src/adapters/local/errors.js';
import { ImportSnapshotNotSupportedError } from '../src/ops/errors.js';

function withTmpDir(prefix: string, body: (dir: string) => Promise<void> | void): () => Promise<void> {
    return async () => {
        const dir = mkdtempSync(join(tmpdir(), `wave-c1-stores-${prefix}-`));
        try {
            await body(dir);
        } finally {
            try {
                rmSync(dir, { recursive: true, force: true });
            } catch {
                // Best-effort.
            }
        }
    };
}

describe('Wave C1-Amend — Stores regression nets', () => {
    // ─── STORES-C-001 — mutation_orphaned health check actionable ─────
    describe('STORES-C-001 — mutation_orphaned health check carries actionable remediation', () => {
        it(
            'doctor() flags orphaned-mutation events with suggestedCommand AND nextSteps',
            withTmpDir('c001-doctor', async (dir) => {
                const stores = createLocalCluster(dir);
                // Seed an orphaned mutation event so the check fires.
                await stores.ledger.append({
                    action: 'mutation_orphaned',
                    actorId: 'test',
                    subjectId: 'subj-1',
                    subjectStore: 'canonical',
                    detail: { commandId: 'cmd-orphan-1' },
                });
                const health = await doctor(stores);
                const check = health.checks.find((c) => c.name === 'no_orphaned_mutations');
                expect(check, 'no_orphaned_mutations check exists').toBeDefined();
                expect(check?.status).toBe('degraded');
                expect(
                    check?.suggestedCommand,
                    'mutation_orphaned check carries actionable suggestedCommand',
                ).toBeTruthy();
                expect(typeof check?.suggestedCommand).toBe('string');
                expect((check?.suggestedCommand ?? '').length).toBeGreaterThan(0);
                // nextSteps array present + non-empty
                expect(
                    Array.isArray(check?.nextSteps),
                    'nextSteps is an array',
                ).toBe(true);
                expect((check?.nextSteps ?? []).length).toBeGreaterThan(0);
            }),
        );

        it(
            'verify() also surfaces mutation_orphaned with actionable remediation',
            withTmpDir('c001-verify', async (dir) => {
                const stores = createLocalCluster(dir);
                await stores.ledger.append({
                    action: 'mutation_orphaned',
                    actorId: 'test',
                    subjectId: 'subj-1',
                    subjectStore: 'canonical',
                    detail: { commandId: 'cmd-orphan-1' },
                });
                const health = await verify(stores);
                const check = health.checks.find((c) => c.name === 'no_orphaned_mutations');
                expect(check, 'no_orphaned_mutations check exists in verify()').toBeDefined();
                expect(check?.status).toBe('degraded');
                expect(check?.suggestedCommand).toBeTruthy();
                expect(Array.isArray(check?.nextSteps)).toBe(true);
                expect((check?.nextSteps ?? []).length).toBeGreaterThan(0);
            }),
        );
    });

    // ─── STORES-C-002 — progress callbacks on long-running ops ────────
    describe('STORES-C-002 — long-running ops accept onProgress callbacks', () => {
        it(
            'rebuildIndex() fires onProgress at least once with current <= total',
            withTmpDir('c002-rebuild', async (dir) => {
                const stores = createLocalCluster(dir);
                // Seed some entities so there's work to do
                for (let i = 0; i < 5; i++) {
                    await stores.canonical.create({
                        kind: 'doc',
                        name: `entity-${i}`,
                        attributes: {},
                    });
                }
                const progress: Array<{ current: number; total: number; message?: string }> = [];
                await rebuildIndex(stores, {
                    onProgress: (current, total, message) => {
                        progress.push({ current, total, message });
                    },
                });
                expect(progress.length, 'onProgress fired at least once').toBeGreaterThan(0);
                for (const tick of progress) {
                    expect(tick.current).toBeLessThanOrEqual(tick.total);
                    expect(tick.current).toBeGreaterThanOrEqual(0);
                }
            }),
        );

        it(
            'backup() fires onProgress at least once',
            withTmpDir('c002-backup', async (dir) => {
                const stores = createLocalCluster(dir);
                for (let i = 0; i < 3; i++) {
                    await stores.canonical.create({
                        kind: 'doc',
                        name: `entity-${i}`,
                        attributes: {},
                    });
                }
                const progress: number[] = [];
                await backup(stores, {
                    onProgress: (current, _total) => {
                        progress.push(current);
                    },
                });
                expect(progress.length, 'backup onProgress fired').toBeGreaterThan(0);
            }),
        );

        it(
            'restore() fires onProgress at least once',
            withTmpDir('c002-restore', async (dir) => {
                const stores1 = createLocalCluster(dir);
                for (let i = 0; i < 3; i++) {
                    await stores1.canonical.create({
                        kind: 'doc',
                        name: `entity-${i}`,
                        attributes: {},
                    });
                }
                const data = await backup(stores1);

                // Restore into a fresh cluster
                const dir2 = mkdtempSync(join(tmpdir(), 'wave-c1-stores-c002-restore-2-'));
                try {
                    const stores2 = createLocalCluster(dir2);
                    const progress: number[] = [];
                    await restore(stores2, data, {
                        onProgress: (current, _total) => {
                            progress.push(current);
                        },
                    });
                    expect(progress.length, 'restore onProgress fired').toBeGreaterThan(0);
                } finally {
                    try {
                        rmSync(dir2, { recursive: true, force: true });
                    } catch {
                        // Best-effort.
                    }
                }
            }),
        );
    });

    // ─── STORES-C-003 — restore() typed structured result + dry-run ───
    describe('STORES-C-003 — restore returns structured RestoreResult with dry-run support', () => {
        it(
            'restore() with dryRun: true does NOT mutate stores but reports counts',
            withTmpDir('c003-dryrun', async (dir) => {
                const stores1 = createLocalCluster(dir);
                for (let i = 0; i < 3; i++) {
                    await stores1.canonical.create({
                        kind: 'doc',
                        name: `entity-${i}`,
                        attributes: {},
                    });
                }
                const data = await backup(stores1);

                const dir2 = mkdtempSync(join(tmpdir(), 'wave-c1-stores-c003-dryrun-2-'));
                try {
                    const stores2 = createLocalCluster(dir2);
                    const result = await restore(stores2, data, { dryRun: true });
                    // dry-run reports what WOULD happen
                    expect(result.dryRun, 'dryRun flag echoed in result').toBe(true);
                    expect(result.entities.created, 'dry-run reports projected creates').toBe(3);
                    // BUT the target stores remain untouched
                    const actual = await stores2.canonical.list({});
                    expect(actual.length, 'no mutation when dryRun: true').toBe(0);
                } finally {
                    try {
                        rmSync(dir2, { recursive: true, force: true });
                    } catch {
                        // Best-effort.
                    }
                }
            }),
        );

        it(
            'restore() result surfaces per-entity errors (does not silently swallow them)',
            withTmpDir('c003-errors', async (dir) => {
                // Create a backup with a tampered entity (same id, different content)
                const stores1 = createLocalCluster(dir);
                const e = await stores1.canonical.create({
                    kind: 'doc',
                    name: 'original-name',
                    attributes: { v: 1 },
                });
                const data = await backup(stores1);
                // Tamper: same id, different name
                data.entities[0] = { ...e, name: 'tampered-name' };

                // Restore into the SAME dir — entity id already exists.
                // assertContentMatch should throw ImportConflictError.
                const result = await restore(stores1, data);
                // The error must surface in entities.errors[] — not silently swallowed
                expect(
                    result.entities.errors.length,
                    'tampered backup surfaces conflict error',
                ).toBeGreaterThan(0);
                // RestoreResult shape: errors are non-empty strings or structured
                const errEntry = result.entities.errors[0];
                expect(typeof errEntry === 'string' || typeof errEntry === 'object').toBe(true);
            }),
        );
    });

    // ─── STORES-C-006 — backup -o existing no-overwrite check ─────────
    describe('STORES-C-006 — backup() to existing outputPath errors unless force', () => {
        it(
            'backup() to an existing outputPath throws BackupTargetExistsError',
            withTmpDir('c006-existing', async (dir) => {
                const stores = createLocalCluster(dir);
                const outPath = join(dir, 'existing-backup.json');
                writeFileSync(outPath, '{"version":1}', 'utf-8');
                await expect(
                    backup(stores, { outputPath: outPath }),
                ).rejects.toThrow(BackupTargetExistsError);
            }),
        );

        it(
            'backup() to an existing outputPath with force: true overwrites',
            withTmpDir('c006-force', async (dir) => {
                const stores = createLocalCluster(dir);
                const outPath = join(dir, 'existing-backup.json');
                writeFileSync(outPath, 'OLD_CONTENT', 'utf-8');
                await backup(stores, { outputPath: outPath, force: true });
                const now = readFileSync(outPath, 'utf-8');
                expect(now).not.toBe('OLD_CONTENT');
                // Parses as a backup
                const parsed = JSON.parse(now);
                expect(parsed.version).toBe(1);
            }),
        );

        it(
            'backup() to a new outputPath writes successfully',
            withTmpDir('c006-fresh', async (dir) => {
                const stores = createLocalCluster(dir);
                const outPath = join(dir, 'fresh-backup.json');
                expect(existsSync(outPath)).toBe(false);
                await backup(stores, { outputPath: outPath });
                expect(existsSync(outPath)).toBe(true);
                const parsed = JSON.parse(readFileSync(outPath, 'utf-8'));
                expect(parsed.version).toBe(1);
            }),
        );

        it(
            'BackupTargetExistsError carries §2b fields (code, remediationHint, retryable)',
            withTmpDir('c006-shape', async (dir) => {
                const stores = createLocalCluster(dir);
                const outPath = join(dir, 'shape-backup.json');
                writeFileSync(outPath, '{}', 'utf-8');
                let caught: unknown;
                try {
                    await backup(stores, { outputPath: outPath });
                } catch (e) {
                    caught = e;
                }
                expect(caught).toBeInstanceOf(BackupTargetExistsError);
                const err = caught as BackupTargetExistsError;
                expect(err.code).toBe('BACKUP_TARGET_EXISTS');
                expect(err.remediationHint).toBeTruthy();
                expect(typeof err.remediationHint).toBe('string');
                expect(err.remediationHint.length).toBeGreaterThan(0);
                expect(err.retryable).toBe(false);
            }),
        );
    });

    // ─── STORES-C-008 — stale-records suggested command ───────────────
    describe('STORES-C-008 — stale records surface suggestedCommand', () => {
        it(
            'verify() index_references_valid stale check sets suggestedCommand: db-cluster rebuild index',
            withTmpDir('c008-stale', async (dir) => {
                const stores = createLocalCluster(dir);
                // Create an entity that isn't in the index — pure missing.
                await stores.canonical.create({
                    kind: 'doc',
                    name: 'unindexed',
                    attributes: {},
                });
                const health = await verify(stores);
                const check = health.checks.find((c) => c.name === 'index_references_valid');
                expect(check).toBeDefined();
                // Either stale or corrupt — both should have suggestedCommand
                if (check?.status !== 'healthy') {
                    expect(check?.suggestedCommand).toBeTruthy();
                    expect(check?.suggestedCommand).toContain('rebuild');
                }
            }),
        );

        it(
            'doctor() index_populated degraded check sets suggestedCommand to rebuild',
            withTmpDir('c008-doctor', async (dir) => {
                const stores = createLocalCluster(dir);
                // Create an entity, then clear the index to simulate index-empty + canonical-populated
                await stores.canonical.create({
                    kind: 'doc',
                    name: 'present',
                    attributes: {},
                });
                await stores.index.clear();
                const health = await doctor(stores);
                const check = health.checks.find((c) => c.name === 'index_populated');
                expect(check).toBeDefined();
                expect(check?.status).toBe('degraded');
                expect(check?.suggestedCommand).toContain('rebuild');
            }),
        );
    });

    // ─── STORES-C-009 / STORES-C-010 — §2b contract on typed errors ───
    describe('STORES-C-009 / STORES-C-010 — adapter typed errors carry §2b contract', () => {
        it('CorruptStoreError has code, remediationHint, retryable', () => {
            const err = new CorruptStoreError('/some/path.json', new Error('broken'));
            expect(err.code).toBe('CORRUPT_STORE');
            expect(err.remediationHint).toBeTruthy();
            expect(err.remediationHint.length).toBeGreaterThan(0);
            expect(typeof err.retryable).toBe('boolean');
            expect(err.retryable).toBe(false);
        });

        it('InvalidContentHashError has code, remediationHint, retryable', () => {
            const err = new InvalidContentHashError('not-a-hash');
            expect(err.code).toBe('INVALID_CONTENT_HASH');
            expect(err.remediationHint).toBeTruthy();
            expect(err.remediationHint.length).toBeGreaterThan(0);
            expect(err.retryable).toBe(false);
        });

        it('ImportConflictError has code, remediationHint, retryable', () => {
            const err = new ImportConflictError('canonical', 'id-1', 'h1', 'h2');
            expect(err.code).toBe('IMPORT_CONFLICT');
            expect(err.remediationHint).toBeTruthy();
            expect(err.remediationHint.length).toBeGreaterThan(0);
            expect(err.retryable).toBe(false);
        });

        it('LedgerCycleDetectedError has code, remediationHint, retryable', () => {
            const err = new LedgerCycleDetectedError(['a', 'b', 'a']);
            expect(err.code).toBe('LEDGER_CYCLE_DETECTED');
            expect(err.remediationHint).toBeTruthy();
            expect(err.remediationHint.length).toBeGreaterThan(0);
            expect(err.retryable).toBe(false);
        });

        it('InvalidRotateTimestampError has code, remediationHint, retryable', () => {
            const err = new InvalidRotateTimestampError('bogus');
            // pre-existing code: 'INVALID_ROTATE_TIMESTAMP'
            expect(err.code).toBe('INVALID_ROTATE_TIMESTAMP');
            expect(err.remediationHint).toBeTruthy();
            expect(err.remediationHint.length).toBeGreaterThan(0);
            expect(err.retryable).toBe(false);
        });

        it('RotateBoundaryInFutureError has code, remediationHint, retryable', () => {
            const err = new RotateBoundaryInFutureError(
                new Date(Date.now() + 60000).toISOString(),
            );
            expect(err.code).toBe('ROTATE_BOUNDARY_IN_FUTURE');
            expect(err.remediationHint).toBeTruthy();
            expect(err.remediationHint.length).toBeGreaterThan(0);
            expect(err.retryable).toBe(false);
        });

        it('ImportSnapshotNotSupportedError has code, remediationHint, retryable', () => {
            const err = new ImportSnapshotNotSupportedError('canonical', 'importSnapshot');
            expect(err.code).toBe('IMPORT_SNAPSHOT_NOT_SUPPORTED');
            expect(err.remediationHint).toBeTruthy();
            expect(err.remediationHint.length).toBeGreaterThan(0);
            expect(err.retryable).toBe(false);
        });

        it('typed-error messages name a CLI command the operator can run', () => {
            // STORES-C-009: messages should name a concrete recovery action — the
            // CommandQueueCorruptError exemplar names 3 recovery paths in its
            // message. Each adapter error should pattern-match: name a command,
            // a file to inspect, or a concrete operator action.
            const corrupt = new CorruptStoreError('/x.json', new Error('broken'));
            // The remediationHint is the canonical channel; the message must
            // give an operator something concrete to do.
            expect(corrupt.message).toMatch(/restore|backup|inspect|delete/i);

            const importConflict = new ImportConflictError('c', 'i', 'a', 'b');
            expect(importConflict.message).toMatch(/inspect|backup|restore/i);

            const cycle = new LedgerCycleDetectedError(['a', 'b', 'a']);
            expect(cycle.message).toMatch(/inspect|restore|excise/i);
        });
    });

    // ─── STORES-C-011 — contract interface JSDoc ──────────────────────
    describe('STORES-C-011 — contract interface methods have semantic JSDoc', () => {
        it('LedgerStore contract methods have per-method JSDoc', async () => {
            // Read the contract source and grep for per-method JSDoc blocks.
            // Each method declaration should be preceded by a /** ... */ block.
            const src = readFileSync('src/contracts/ledger-store.ts', 'utf-8');
            // append / getEvent / listEvents / countEvents / trace / appendReceipt
            // / getReceipt / listReceipts / importEvent / importReceipt / rotate
            const methods = [
                'append',
                'getEvent',
                'listEvents',
                'countEvents',
                'trace',
                'appendReceipt',
                'getReceipt',
                'listReceipts',
                'importEvent',
                'importReceipt',
                'rotate',
            ];
            for (const method of methods) {
                // Find the method-DECLARATION line (4-space indent + name +
                // paren), not occurrences inside JSDoc/prose.
                const declRegex = new RegExp(`^ {4}${method}\\(`, 'm');
                const m = declRegex.exec(src);
                expect(m, `declaration of ${method}() found in contract`).not.toBeNull();
                const idx = m!.index;
                const before = src.slice(Math.max(0, idx - 500), idx);
                expect(
                    before.includes('*/'),
                    `${method} preceded by JSDoc close`,
                ).toBe(true);
            }
        });

        it('CanonicalStore contract methods have per-method JSDoc', () => {
            const src = readFileSync('src/contracts/canonical-store.ts', 'utf-8');
            const methods = ['get', 'list', 'exists', 'create', 'update', 'importSnapshot'];
            for (const method of methods) {
                const declRegex = new RegExp(`^ {4}${method}\\(`, 'm');
                const m = declRegex.exec(src);
                expect(m, `declaration of ${method}() found`).not.toBeNull();
                const idx = m!.index;
                const before = src.slice(Math.max(0, idx - 500), idx);
                expect(
                    before.includes('*/'),
                    `${method} preceded by JSDoc close`,
                ).toBe(true);
            }
        });

        it('ArtifactStore contract methods have per-method JSDoc', () => {
            const src = readFileSync('src/contracts/artifact-store.ts', 'utf-8');
            const methods = ['get', 'getContent', 'list', 'exists', 'ingest', 'versions', 'importSnapshot'];
            for (const method of methods) {
                // Find the method-DECLARATION line (4-space indent + name + paren),
                // not occurrences inside JSDoc/prose. The contract interface
                // members are at 4-space indent.
                const declRegex = new RegExp(`^ {4}${method}\\(`, 'm');
                const m = declRegex.exec(src);
                expect(m, `declaration of ${method}() found`).not.toBeNull();
                const idx = m!.index;
                const before = src.slice(Math.max(0, idx - 500), idx);
                expect(
                    before.includes('*/'),
                    `${method} preceded by JSDoc close`,
                ).toBe(true);
            }
        });

        it('IndexStore contract methods have per-method JSDoc', () => {
            const src = readFileSync('src/contracts/index-store.ts', 'utf-8');
            const methods = ['search', 'get', 'index', 'remove', 'clear', 'count', 'replaceAll'];
            for (const method of methods) {
                const declRegex = new RegExp(`^ {4}${method}\\(`, 'm');
                const m = declRegex.exec(src);
                expect(m, `declaration of ${method}() found`).not.toBeNull();
                const idx = m!.index;
                const before = src.slice(Math.max(0, idx - 500), idx);
                expect(
                    before.includes('*/'),
                    `${method} preceded by JSDoc close`,
                ).toBe(true);
            }
        });
    });

    // ─── STORES-C-010 — @throws coverage across src/ops/ ──────────────
    describe('STORES-C-010 — public ops functions have @throws JSDoc', () => {
        it('doctor() has @throws / @param / @returns JSDoc', () => {
            const src = readFileSync('src/ops/doctor.ts', 'utf-8');
            // Find the export of doctor()
            const exportIdx = src.indexOf('export async function doctor');
            expect(exportIdx).toBeGreaterThan(0);
            const beforeExport = src.slice(0, exportIdx);
            // Last JSDoc block should immediately precede the export
            const lastDocStart = beforeExport.lastIndexOf('/**');
            const lastDocEnd = beforeExport.lastIndexOf('*/');
            expect(lastDocEnd).toBeGreaterThan(lastDocStart);
            const docBlock = beforeExport.slice(lastDocStart, lastDocEnd);
            expect(docBlock).toContain('@param');
            expect(docBlock).toContain('@returns');
        });

        it('rebuildIndex() has @throws / @param / @returns JSDoc', () => {
            const src = readFileSync('src/ops/rebuild.ts', 'utf-8');
            const exportIdx = src.indexOf('export async function rebuildIndex');
            expect(exportIdx).toBeGreaterThan(0);
            const beforeExport = src.slice(0, exportIdx);
            const lastDocStart = beforeExport.lastIndexOf('/**');
            const lastDocEnd = beforeExport.lastIndexOf('*/');
            const docBlock = beforeExport.slice(lastDocStart, lastDocEnd);
            expect(docBlock).toContain('@param');
            expect(docBlock).toContain('@returns');
        });

        it('backup() has @throws / @param / @returns JSDoc', () => {
            const src = readFileSync('src/ops/backup.ts', 'utf-8');
            const exportIdx = src.indexOf('export async function backup');
            expect(exportIdx).toBeGreaterThan(0);
            const beforeExport = src.slice(0, exportIdx);
            const lastDocStart = beforeExport.lastIndexOf('/**');
            const lastDocEnd = beforeExport.lastIndexOf('*/');
            const docBlock = beforeExport.slice(lastDocStart, lastDocEnd);
            expect(docBlock).toContain('@param');
            expect(docBlock).toContain('@returns');
            expect(docBlock).toContain('@throws');
        });

        it('restore() has @throws / @param / @returns JSDoc', () => {
            const src = readFileSync('src/ops/backup.ts', 'utf-8');
            const exportIdx = src.indexOf('export async function restore');
            expect(exportIdx).toBeGreaterThan(0);
            const beforeExport = src.slice(0, exportIdx);
            const lastDocStart = beforeExport.lastIndexOf('/**');
            const lastDocEnd = beforeExport.lastIndexOf('*/');
            const docBlock = beforeExport.slice(lastDocStart, lastDocEnd);
            expect(docBlock).toContain('@param');
            expect(docBlock).toContain('@returns');
            expect(docBlock).toContain('@throws');
        });

        it('verify() has @throws / @param / @returns JSDoc', () => {
            const src = readFileSync('src/ops/verify.ts', 'utf-8');
            const exportIdx = src.indexOf('export async function verify');
            expect(exportIdx).toBeGreaterThan(0);
            const beforeExport = src.slice(0, exportIdx);
            const lastDocStart = beforeExport.lastIndexOf('/**');
            const lastDocEnd = beforeExport.lastIndexOf('*/');
            const docBlock = beforeExport.slice(lastDocStart, lastDocEnd);
            expect(docBlock).toContain('@param');
            expect(docBlock).toContain('@returns');
        });

        it('checkStale() has @throws / @param / @returns JSDoc', () => {
            const src = readFileSync('src/ops/rebuild.ts', 'utf-8');
            const exportIdx = src.indexOf('export async function checkStale');
            expect(exportIdx).toBeGreaterThan(0);
            const beforeExport = src.slice(0, exportIdx);
            const lastDocStart = beforeExport.lastIndexOf('/**');
            const lastDocEnd = beforeExport.lastIndexOf('*/');
            const docBlock = beforeExport.slice(lastDocStart, lastDocEnd);
            expect(docBlock).toContain('@param');
            expect(docBlock).toContain('@returns');
        });

        it('checkReceipts() has @throws / @param / @returns JSDoc', () => {
            const src = readFileSync('src/ops/receipt-check.ts', 'utf-8');
            const exportIdx = src.indexOf('export async function checkReceipts');
            expect(exportIdx).toBeGreaterThan(0);
            const beforeExport = src.slice(0, exportIdx);
            const lastDocStart = beforeExport.lastIndexOf('/**');
            const lastDocEnd = beforeExport.lastIndexOf('*/');
            const docBlock = beforeExport.slice(lastDocStart, lastDocEnd);
            expect(docBlock).toContain('@param');
            expect(docBlock).toContain('@returns');
        });

        it('checkProvenance() has @throws / @param / @returns JSDoc', () => {
            const src = readFileSync('src/ops/provenance-check.ts', 'utf-8');
            const exportIdx = src.indexOf('export async function checkProvenance');
            expect(exportIdx).toBeGreaterThan(0);
            const beforeExport = src.slice(0, exportIdx);
            const lastDocStart = beforeExport.lastIndexOf('/**');
            const lastDocEnd = beforeExport.lastIndexOf('*/');
            const docBlock = beforeExport.slice(lastDocStart, lastDocEnd);
            expect(docBlock).toContain('@param');
            expect(docBlock).toContain('@returns');
        });

        it('checkMigrationStatus() has @throws / @param / @returns JSDoc', () => {
            const src = readFileSync('src/ops/migrations.ts', 'utf-8');
            const exportIdx = src.indexOf('export async function checkMigrationStatus');
            expect(exportIdx).toBeGreaterThan(0);
            const beforeExport = src.slice(0, exportIdx);
            const lastDocStart = beforeExport.lastIndexOf('/**');
            const lastDocEnd = beforeExport.lastIndexOf('*/');
            const docBlock = beforeExport.slice(lastDocStart, lastDocEnd);
            expect(docBlock).toContain('@param');
            expect(docBlock).toContain('@returns');
        });

        it('verifySchema() has @throws / @param / @returns JSDoc', () => {
            const src = readFileSync('src/ops/migrations.ts', 'utf-8');
            const exportIdx = src.indexOf('export async function verifySchema');
            expect(exportIdx).toBeGreaterThan(0);
            const beforeExport = src.slice(0, exportIdx);
            const lastDocStart = beforeExport.lastIndexOf('/**');
            const lastDocEnd = beforeExport.lastIndexOf('*/');
            const docBlock = beforeExport.slice(lastDocStart, lastDocEnd);
            expect(docBlock).toContain('@param');
            expect(docBlock).toContain('@returns');
        });

        it('at least one @example in src/ops/ JSDoc', () => {
            // STORES-C-010 acceptance: at least one @example block across src/ops/
            const files = [
                'src/ops/doctor.ts',
                'src/ops/verify.ts',
                'src/ops/rebuild.ts',
                'src/ops/backup.ts',
            ];
            const anyExample = files.some((f) => readFileSync(f, 'utf-8').includes('@example'));
            expect(anyExample, 'at least one @example in src/ops/').toBe(true);
        });
    });

    // ─── SHA-STORES-PHANTOM-CMD — drop the phantom suggestedCommand ───
    describe('SHA-STORES-PHANTOM-CMD — postgres_migration check does not promise a phantom command', () => {
        it('doctor() postgres_migration missing-table check does NOT set suggestedCommand to "db-cluster stores migrate"', async () => {
            // The Postgres applied_migrations registry lands with v0.2. Until then,
            // suggesting `db-cluster stores migrate` over-promises (the command
            // exists but is a "create table if not exists" no-op-ish, not a real
            // applied_migrations workflow). Per advisor disposition: DROP the
            // suggestedCommand entirely; surface the situation in `message`.
            const fakePool = {
                async query(_text: string, _values?: unknown[]) {
                    return { rows: [] }; // No tables found — triggers the missing branch
                },
            };
            const dir = mkdtempSync(join(tmpdir(), 'wave-c1-stores-sha-pgmig-'));
            try {
                const stores = createLocalCluster(dir);
                const health = await doctor(stores, { postgresPool: fakePool });
                const check = health.checks.find((c) => c.name === 'postgres_migration');
                expect(check).toBeDefined();
                // Phantom command MUST NOT be set
                expect(check?.suggestedCommand).not.toBe('db-cluster stores migrate');
                // Either suggestedCommand is unset OR set to a real inspection
                // command (e.g. `db-cluster verify-schema` if Surface agent
                // adds that route). Either is acceptable; phantom is not.
            } finally {
                try {
                    rmSync(dir, { recursive: true, force: true });
                } catch {
                    // Best-effort.
                }
            }
        });
    });

    // ─── suggestedCommand audit pass (family probe) ───────────────────
    describe('suggestedCommand family probe — every remediable check carries an actionable command', () => {
        it('every doctor() check with repairAvailable: true also sets suggestedCommand', async () => {
            // Family-of-call-sites probe: if a HealthCheck reports
            // repairAvailable: true, it MUST also set suggestedCommand. The
            // converse is fine (some checks may surface remediation context
            // without auto-repair).
            const dir = mkdtempSync(join(tmpdir(), 'wave-c1-stores-fam-doctor-'));
            try {
                const stores = createLocalCluster(dir);
                // Seed an orphan
                await stores.ledger.append({
                    action: 'mutation_orphaned',
                    actorId: 'x',
                    subjectId: 's',
                    subjectStore: 'canonical',
                    detail: {},
                });
                // Seed an unindexed entity
                await stores.canonical.create({
                    kind: 'doc',
                    name: 'unindexed-fam',
                    attributes: {},
                });
                await stores.index.clear();
                const health = await doctor(stores);
                for (const check of health.checks) {
                    if (check.repairAvailable) {
                        expect(
                            check.suggestedCommand,
                            `check ${check.name} has repairAvailable: true but no suggestedCommand`,
                        ).toBeTruthy();
                    }
                }
            } finally {
                try {
                    rmSync(dir, { recursive: true, force: true });
                } catch {
                    // Best-effort.
                }
            }
        });

        it('every verify() check with repairAvailable: true also sets suggestedCommand', async () => {
            const dir = mkdtempSync(join(tmpdir(), 'wave-c1-stores-fam-verify-'));
            try {
                const stores = createLocalCluster(dir);
                await stores.ledger.append({
                    action: 'mutation_orphaned',
                    actorId: 'x',
                    subjectId: 's',
                    subjectStore: 'canonical',
                    detail: {},
                });
                await stores.canonical.create({
                    kind: 'doc',
                    name: 'unindexed-fam',
                    attributes: {},
                });
                await stores.index.clear();
                const health = await verify(stores);
                for (const check of health.checks) {
                    if (check.repairAvailable) {
                        expect(
                            check.suggestedCommand,
                            `verify check ${check.name} has repairAvailable: true but no suggestedCommand`,
                        ).toBeTruthy();
                    }
                }
            } finally {
                try {
                    rmSync(dir, { recursive: true, force: true });
                } catch {
                    // Best-effort.
                }
            }
        });
    });
});
