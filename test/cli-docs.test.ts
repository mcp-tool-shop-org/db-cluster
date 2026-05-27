/**
 * CLI documentation verification — ensures docs/cli.md stays in sync with actual commands.
 *
 * TESTS-006: this file previously shelled out to `npx tsx src/cli.ts --help`,
 * spinning up a full TS compilation just to extract command names. We now
 * parse the command declarations directly out of src/cli.ts source — much
 * cheaper, and the dependency direction is correct (the test reads source,
 * not the other way around).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const CLI_DOC = readFileSync(resolve(ROOT, 'docs/cli.md'), 'utf-8');
const CLI_SOURCE = readFileSync(resolve(ROOT, 'src/cli.ts'), 'utf-8');

/**
 * Extract top-level command names from the CLI source by matching the
 * `.command('<name>...')` declarations attached to `program.` chains.
 * Skips subcommands defined on other Command instances (those are in their
 * own .command() chains under their parent group — covered by the explicit
 * checks below).
 */
function extractTopLevelCommands(source: string): string[] {
    const names = new Set<string>();
    const re = /\.command\(['"]([a-z][a-z0-9-]*)\b/gi;
    let match: RegExpExecArray | null;
    while ((match = re.exec(source)) !== null) {
        const name = match[1].toLowerCase();
        if (name !== 'help') names.add(name);
    }
    return Array.from(names);
}

describe('CLI docs verification', () => {
    it('docs mention every command group declared in cli.ts', () => {
        const commands = extractTopLevelCommands(CLI_SOURCE);
        // Sanity: we should have found multiple commands.
        expect(commands.length).toBeGreaterThan(5);
        for (const cmd of commands) {
            expect(CLI_DOC).toContain(cmd);
        }
    });

    it('docs mention init command', () => {
        expect(CLI_DOC).toContain('db-cluster init');
    });

    it('docs mention ingest command', () => {
        expect(CLI_DOC).toContain('db-cluster ingest');
    });

    it('docs mention entity commands', () => {
        expect(CLI_DOC).toContain('db-cluster entity create');
        expect(CLI_DOC).toContain('db-cluster entity list');
    });

    it('docs mention find command', () => {
        expect(CLI_DOC).toContain('db-cluster find');
    });

    it('docs mention retrieve command', () => {
        expect(CLI_DOC).toContain('db-cluster retrieve');
    });

    it('docs mention trace/why/lineage commands', () => {
        expect(CLI_DOC).toContain('db-cluster trace');
        expect(CLI_DOC).toContain('db-cluster why');
        expect(CLI_DOC).toContain('db-cluster lineage');
    });

    it('docs mention mutation lifecycle commands', () => {
        expect(CLI_DOC).toContain('db-cluster propose');
        expect(CLI_DOC).toContain('db-cluster validate');
        expect(CLI_DOC).toContain('db-cluster approve');
        expect(CLI_DOC).toContain('db-cluster reject');
        expect(CLI_DOC).toContain('db-cluster commit');
        expect(CLI_DOC).toContain('db-cluster compensate');
    });

    it('docs mention receipts command', () => {
        expect(CLI_DOC).toContain('db-cluster receipts');
    });

    it('docs mention policy commands', () => {
        expect(CLI_DOC).toContain('db-cluster policy explain');
        expect(CLI_DOC).toContain('db-cluster policy test');
    });

    it('docs mention store management commands', () => {
        expect(CLI_DOC).toContain('db-cluster stores verify');
        expect(CLI_DOC).toContain('db-cluster stores migrate');
        expect(CLI_DOC).toContain('db-cluster stores list');
    });

    it('docs mention operations commands', () => {
        expect(CLI_DOC).toContain('db-cluster doctor');
        expect(CLI_DOC).toContain('db-cluster verify');
        expect(CLI_DOC).toContain('db-cluster rebuild index');
        expect(CLI_DOC).toContain('db-cluster rebuild check');
        expect(CLI_DOC).toContain('db-cluster backup');
        expect(CLI_DOC).toContain('db-cluster restore');
    });

    it('docs mention --json flag', () => {
        expect(CLI_DOC).toContain('--json');
    });

    it('docs do not use stale or removed commands', () => {
        // These commands do not exist in the CLI
        expect(CLI_DOC).not.toContain('db-cluster chat');
        expect(CLI_DOC).not.toContain('db-cluster ask');
        expect(CLI_DOC).not.toContain('db-cluster query');
        expect(CLI_DOC).not.toContain('db-cluster search'); // it's 'find', not 'search'
    });
});
