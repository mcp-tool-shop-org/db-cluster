/**
 * CLI documentation verification — ensures docs/cli.md stays in sync with actual commands.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';

const CLI_DOC = readFileSync(resolve(import.meta.dirname, '../docs/cli.md'), 'utf-8');

describe('CLI docs verification', () => {
    it('docs mention every command group from --help', () => {
        const helpOutput = execSync('npx tsx src/cli.ts --help', {
            cwd: resolve(import.meta.dirname, '..'),
            encoding: 'utf-8',
        });

        // Extract command names from help output
        const commandLines = helpOutput
            .split('\n')
            .filter((line) => /^\s{2}\w/.test(line))
            .map((line) => line.trim().split(/\s+/)[0])
            .filter((cmd) => cmd !== 'help');

        for (const cmd of commandLines) {
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
