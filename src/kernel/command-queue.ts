import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from '../types/command.js';

/**
 * Persists proposed commands so they survive across process invocations.
 * This is NOT a truth store — it is kernel working state.
 */
export class CommandQueue {
    private readonly filePath: string;
    private commands: Map<string, Command>;

    constructor(dataDir: string) {
        mkdirSync(dataDir, { recursive: true });
        this.filePath = join(dataDir, 'pending-commands.json');
        this.commands = this.load();
    }

    get(id: string): Command | undefined {
        return this.commands.get(id);
    }

    save(command: Command): void {
        this.commands.set(command.id, command);
        this.persist();
    }

    remove(id: string): void {
        this.commands.delete(id);
        this.persist();
    }

    private load(): Map<string, Command> {
        if (!existsSync(this.filePath)) return new Map();
        const raw = readFileSync(this.filePath, 'utf-8');
        const arr: Command[] = JSON.parse(raw);
        return new Map(arr.map((c) => [c.id, c]));
    }

    private persist(): void {
        const arr = Array.from(this.commands.values());
        writeFileSync(this.filePath, JSON.stringify(arr, null, 2));
    }
}
