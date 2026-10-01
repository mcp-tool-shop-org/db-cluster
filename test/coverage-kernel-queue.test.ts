/**
 * Coverage — CommandQueue: persistence lifecycle, marker semantics, orphan-tmp
 * sweep, and the typed corruption failures. Every test asserts what is on
 * disk or what typed error is thrown, against a real temp directory.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
    mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, utimesSync, readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CommandQueue } from '../src/kernel/command-queue.js';
import { CommandQueueCorruptError, CommandQueuePersistenceLostError } from '../src/kernel/errors.js';
import { proposeCommand, validateCommand, markCommitted } from '../src/kernel/commands.js';
import type { Command } from '../src/types/command.js';

function makeCommand(name: string): Command {
    return proposeCommand('create_entity', 'canonical', { kind: 'note', name, attributes: {} }, 'agent-1');
}

describe('CommandQueue persistence', () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'cov-queue-'));
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('cold start is empty and writes nothing until the first save', () => {
        const q = new CommandQueue(join(dir, 'fresh', 'nested'));
        expect(q.list()).toEqual([]);
        expect(q.get('nope')).toBeUndefined();
        expect(existsSync(join(dir, 'fresh', 'nested', 'pending-commands.json'))).toBe(false);
        expect(existsSync(join(dir, 'fresh', 'nested', 'command-queue-marker'))).toBe(false);
    });

    it('save persists atomically, creates the marker, and round-trips through a second instance', () => {
        const q = new CommandQueue(dir);
        const a = makeCommand('alpha');
        const b = makeCommand('beta');
        q.save(a);
        q.save(b);

        const onDisk = JSON.parse(readFileSync(join(dir, 'pending-commands.json'), 'utf-8')) as Command[];
        expect(onDisk.map((c) => c.id).sort()).toEqual([a.id, b.id].sort());
        expect(existsSync(join(dir, 'command-queue-marker'))).toBe(true);
        // No stray tmp file after a successful persist.
        expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);

        const q2 = new CommandQueue(dir);
        expect(q2.get(a.id)?.payload).toEqual(a.payload);
        expect(q2.list()).toHaveLength(2);
    });

    it('save with an existing id replaces the entry rather than duplicating it', () => {
        const q = new CommandQueue(dir);
        const cmd = makeCommand('alpha');
        q.save(cmd);
        const validated = validateCommand(cmd);
        q.save(validated);
        expect(q.list()).toHaveLength(1);
        expect(q.get(cmd.id)?.status).toBe('validated');
    });

    it('listByStatus returns only commands in the requested status', () => {
        const q = new CommandQueue(dir);
        const proposed = makeCommand('p');
        const committed = markCommitted(validateCommand(makeCommand('c')), 'agent-1');
        q.save(proposed);
        q.save(committed);
        expect(q.listByStatus('proposed').map((c) => c.id)).toEqual([proposed.id]);
        expect(q.listByStatus('committed').map((c) => c.id)).toEqual([committed.id]);
        expect(q.listByStatus('rejected')).toEqual([]);
    });

    it('remove deletes the command from disk and is a no-op for unknown ids', () => {
        const q = new CommandQueue(dir);
        const a = makeCommand('a');
        const b = makeCommand('b');
        q.save(a);
        q.save(b);
        q.remove(a.id);
        q.remove('does-not-exist');
        const reread = new CommandQueue(dir);
        expect(reread.get(a.id)).toBeUndefined();
        expect(reread.get(b.id)?.id).toBe(b.id);
        expect(reread.list()).toHaveLength(1);
    });
});

describe('CommandQueue marker semantics', () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'cov-queue-marker-'));
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('marker present but queue file gone throws CommandQueuePersistenceLostError', () => {
        const q = new CommandQueue(dir);
        q.save(makeCommand('a'));
        rmSync(join(dir, 'pending-commands.json'));
        let caught: unknown;
        try {
            q.list();
        } catch (e) {
            caught = e;
        }
        expect(caught).toBeInstanceOf(CommandQueuePersistenceLostError);
        expect((caught as CommandQueuePersistenceLostError).code).toBe('COMMAND_QUEUE_PERSISTENCE_LOST');
    });

    it('queue file present but marker deleted self-heals: it loads and recreates the marker', () => {
        const q = new CommandQueue(dir);
        const cmd = makeCommand('a');
        q.save(cmd);
        rmSync(join(dir, 'command-queue-marker'));
        expect(q.get(cmd.id)?.id).toBe(cmd.id);
        expect(existsSync(join(dir, 'command-queue-marker'))).toBe(true);
    });

    it('unparseable queue file throws CommandQueueCorruptError', () => {
        writeFileSync(join(dir, 'pending-commands.json'), '{not json');
        const q = new CommandQueue(dir);
        expect(() => q.list()).toThrow(CommandQueueCorruptError);
    });

    it('queue file holding valid JSON that is not an array throws CommandQueueCorruptError', () => {
        writeFileSync(join(dir, 'pending-commands.json'), JSON.stringify({ commands: [] }));
        const q = new CommandQueue(dir);
        let caught: unknown;
        try {
            q.list();
        } catch (e) {
            caught = e;
        }
        expect(caught).toBeInstanceOf(CommandQueueCorruptError);
        expect((caught as CommandQueueCorruptError).code).toBe('COMMAND_QUEUE_CORRUPT');
    });

    it('queue path that cannot be read as a file throws CommandQueueCorruptError', () => {
        // A directory squatting on the queue path: existsSync is true, readFileSync throws.
        mkdirSync(join(dir, 'pending-commands.json'));
        const q = new CommandQueue(dir);
        expect(() => q.get('x')).toThrow(CommandQueueCorruptError);
    });
});

describe('CommandQueue orphan-tmp sweep', () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'cov-queue-sweep-'));
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('removes stale orphan tmp files at construction and keeps fresh and unrelated ones', () => {
        const stale = join(dir, 'pending-commands.json.4242-abc123.tmp');
        const fresh = join(dir, 'pending-commands.json.4243-def456.tmp');
        const unrelated = join(dir, 'pending-commands.json.notes.tmp');
        const other = join(dir, 'other-file.json.4242-abc123.tmp');
        for (const f of [stale, fresh, unrelated, other]) writeFileSync(f, 'x');
        const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
        utimesSync(stale, tenMinutesAgo, tenMinutesAgo);
        utimesSync(other, tenMinutesAgo, tenMinutesAgo);

        new CommandQueue(dir);

        expect(existsSync(stale)).toBe(false);
        expect(existsSync(fresh)).toBe(true);
        expect(existsSync(unrelated)).toBe(true);
        // Only this queue's own tmp files are swept.
        expect(existsSync(other)).toBe(true);
    });
});
