import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import type { Command } from '../types/command.js';
import { CommandQueueCorruptError, CommandQueuePersistenceLostError } from './errors.js';

/**
 * AGG-A4-3 / Wave A4 fix-up: random-suffix tmp path for persist().
 *
 * Pre-fix `persist()` wrote to a fixed `${filePath}.tmp` suffix. Two CLI
 * invocations racing on the same queue (rare but real for operators running
 * parallel `db-cluster propose` commands) would clobber each other's tmp
 * files silently.
 *
 * Mirrors src/adapters/local/tmp-cleanup.ts::buildRandomTmpPath. We inline
 * the helper here instead of importing it because the kernel tree is
 * forbidden from importing adapters/ (no-back-edge rule documented in
 * src/kernel/errors.ts and src/kernel/command-queue.ts header).
 *
 * Format: `${targetPath}.${process.pid}-${rand6}.tmp` where rand6 is 1-6
 * base36 characters. Matches the cleanup regex below.
 */
function buildRandomTmpPath(targetPath: string): string {
    const rand = Math.random().toString(36).slice(2, 8);
    return `${targetPath}.${process.pid}-${rand}.tmp`;
}

/**
 * AGG-A4-3 / Wave A4 fix-up: one-shot orphan sweep at constructor time.
 *
 * If a previous process crashed between writeFileSync and renameSync the
 * random-suffix tmp file would linger forever without this. 5-min age
 * threshold keeps tmp files belonging to actively-writing sibling processes.
 *
 * Mirrors src/adapters/local/tmp-cleanup.ts::cleanupOrphanTmpFiles. Inlined
 * for the same no-back-edge reason as buildRandomTmpPath.
 */
function cleanupOrphanTmpFiles(dir: string, baseName: string): void {
    const maxAgeMs = 5 * 60 * 1000;
    const cutoff = Date.now() - maxAgeMs;
    let entries: string[];
    try {
        entries = readdirSync(dir);
    } catch {
        return;
    }
    const escapedBase = baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const orphanPattern = new RegExp(`^${escapedBase}\\.\\d+-[a-z0-9]{1,6}\\.tmp$`);
    for (const entry of entries) {
        if (!orphanPattern.test(entry)) continue;
        const fullPath = join(dir, entry);
        let mtimeMs: number;
        try {
            mtimeMs = statSync(fullPath).mtimeMs;
        } catch {
            continue;
        }
        if (mtimeMs >= cutoff) continue;
        try {
            unlinkSync(fullPath);
        } catch {
            // Best-effort.
        }
    }
}

/**
 * Persists proposed commands so they survive across process invocations.
 * This is NOT a truth store — it is kernel working state.
 * Reads fresh from disk on every get() to support multi-instance workflows.
 *
 * Writes are atomic: serialize to a sibling `.tmp` then `renameSync` over the
 * real path. Crash mid-write leaves the previous good file intact.
 * Reads fail loudly with a typed {@link CommandQueueCorruptError} if
 * JSON.parse fails — matches the local Stores adapters' pattern (KERNEL-R001).
 *
 * Marker file (TESTS-B-003): a zero-byte sentinel at `command-queue-marker`
 * is created on the FIRST successful `persist()`. Its presence lets `load()`
 * distinguish "cold start" (no marker, no queue file → empty Map silently)
 * from "persistence lost" (marker present, queue file absent →
 * {@link CommandQueuePersistenceLostError}). Without the marker, the silent
 * empty-Map path masks a lost queue as confusing downstream "Not found in
 * command store" errors when the surrounding flow then tries to commit a
 * command that should have been on disk.
 *
 * Marker semantics:
 *  - absent + queue file absent → empty Map silently (legitimate cold start)
 *  - present + queue file present → load normally
 *  - present + queue file ABSENT → throw {@link CommandQueuePersistenceLostError}
 *  - absent + queue file PRESENT → self-heal: load AND re-create the marker
 *    (this case can happen if the marker was deleted by hand but the queue
 *    persisted; treat the observed state as authoritative)
 *
 * Note on the import direction: the parallel {@link
 * import('../adapters/local/errors.js').CorruptStoreError} lives in the
 * adapters tree. The kernel does not import from adapters/, so this class
 * declares a sibling error type in {@link import('./errors.js')} so the
 * kernel error hierarchy stays self-contained.
 */
export class CommandQueue {
    private readonly filePath: string;
    private readonly markerPath: string;

    constructor(dataDir: string) {
        mkdirSync(dataDir, { recursive: true });
        this.filePath = join(dataDir, 'pending-commands.json');
        this.markerPath = join(dirname(this.filePath), 'command-queue-marker');
        // AGG-A4-3 / Wave A4 fix-up: one-shot orphan-tmp sweep at construction.
        // Mirrors the local-store adapters' constructor-time sweep so stale
        // tmp files from a previous crashed CLI invocation don't accumulate.
        try {
            cleanupOrphanTmpFiles(dirname(this.filePath), basename(this.filePath));
        } catch {
            // Best-effort: dataDir may not exist yet on first start.
        }
    }

    get(id: string): Command | undefined {
        const commands = this.load();
        return commands.get(id);
    }

    list(): Command[] {
        return Array.from(this.load().values());
    }

    /**
     * PROV-005 (Wave S2-A1): read-only enumeration of persisted commands in a
     * given lifecycle status. Used by the cluster `verify` operation (ops,
     * Agent 5) to walk the command↔receipt bijection in BOTH directions —
     * `listByStatus('committed')` yields every committed command so verify can
     * assert each has a receipt, and the receipt side asserts each receipt's
     * commandId resolves back to a committed command.
     *
     * Pure read over {@link list}; never mutates the queue.
     */
    listByStatus(status: Command['status']): Command[] {
        return this.list().filter((c) => c.status === status);
    }

    save(command: Command): void {
        const commands = this.load();
        commands.set(command.id, command);
        this.persist(commands);
    }

    remove(id: string): void {
        const commands = this.load();
        commands.delete(id);
        this.persist(commands);
    }

    private load(): Map<string, Command> {
        const queueExists = existsSync(this.filePath);
        const markerExists = existsSync(this.markerPath);

        // Cold start: no marker, no queue file — legitimate empty state.
        if (!queueExists && !markerExists) {
            return new Map();
        }

        // Persistence lost: marker says "this queue has persisted before"
        // but the queue file is gone. Fail loudly so the operator sees a
        // typed signal instead of a silent empty Map masquerading as a
        // legitimate state.
        if (!queueExists && markerExists) {
            throw new CommandQueuePersistenceLostError(this.filePath, this.markerPath);
        }

        // Self-heal: queue file present, marker missing. Trust the queue
        // and re-establish the marker from observed state.
        if (queueExists && !markerExists) {
            try {
                writeFileSync(this.markerPath, '');
            } catch {
                // Best-effort: a marker we cannot create is recoverable on
                // the next successful persist().
            }
        }

        let raw: string;
        try {
            raw = readFileSync(this.filePath, 'utf-8');
        } catch (err) {
            throw new CommandQueueCorruptError(this.filePath, err);
        }
        try {
            const arr: Command[] = JSON.parse(raw);
            if (!Array.isArray(arr)) {
                throw new Error(`expected JSON array, got ${typeof arr}`);
            }
            return new Map(arr.map((c) => [c.id, c]));
        } catch (err) {
            throw new CommandQueueCorruptError(this.filePath, err);
        }
    }

    private persist(commands: Map<string, Command>): void {
        const arr = Array.from(commands.values());
        // AGG-A4-3 / Wave A4 fix-up: random-suffix tmp path. Pre-fix the fixed
        // `${this.filePath}.tmp` literal meant two CLI invocations racing on
        // persist would clobber each other's tmp files silently.
        const tmpPath = buildRandomTmpPath(this.filePath);
        writeFileSync(tmpPath, JSON.stringify(arr, null, 2));
        renameSync(tmpPath, this.filePath);

        // Create the marker on the FIRST successful persist (zero-byte
        // sentinel — existence is the signal). Subsequent persists no-op
        // if the marker already exists.
        if (!existsSync(this.markerPath)) {
            writeFileSync(this.markerPath, '');
        }
    }
}
