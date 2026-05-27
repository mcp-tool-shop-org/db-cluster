import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from '../types/command.js';
import { CommandQueueCorruptError } from './errors.js';

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
 * Note on the import direction: the parallel {@link
 * import('../adapters/local/errors.js').CorruptStoreError} lives in the
 * adapters tree. The kernel does not import from adapters/, so this class
 * declares a sibling error type in {@link import('./errors.js')} so the
 * kernel error hierarchy stays self-contained.
 */
export class CommandQueue {
    private readonly filePath: string;

    constructor(dataDir: string) {
        mkdirSync(dataDir, { recursive: true });
        this.filePath = join(dataDir, 'pending-commands.json');
    }

    get(id: string): Command | undefined {
        const commands = this.load();
        return commands.get(id);
    }

    list(): Command[] {
        return Array.from(this.load().values());
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
        if (!existsSync(this.filePath)) return new Map();
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
        const tmpPath = `${this.filePath}.tmp`;
        writeFileSync(tmpPath, JSON.stringify(arr, null, 2));
        renameSync(tmpPath, this.filePath);
    }
}
