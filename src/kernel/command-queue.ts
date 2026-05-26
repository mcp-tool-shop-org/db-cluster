import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from '../types/command.js';

/**
 * Persists proposed commands so they survive across process invocations.
 * This is NOT a truth store — it is kernel working state.
 * Reads fresh from disk on every get() to support multi-instance workflows.
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
        const raw = readFileSync(this.filePath, 'utf-8');
        const arr: Command[] = JSON.parse(raw);
        return new Map(arr.map((c) => [c.id, c]));
    }

    private persist(commands: Map<string, Command>): void {
        const arr = Array.from(commands.values());
        writeFileSync(this.filePath, JSON.stringify(arr, null, 2));
    }
}
