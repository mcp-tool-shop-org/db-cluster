/**
 * The contract every kernel error keeps with the three places it surfaces.
 *
 * A ClusterError reaches a caller three ways: the AI envelope an MCP host or
 * SDK consumer branches on (errorToAiEnvelope), the two-line prose and the
 * exit code an operator sees from the CLI (renderClusterErrorForCli,
 * typedErrorToExitCode), and the instance a programmatic caller catches.
 * Each of them depends on the same four things, so each case below checks
 * all four for one error class:
 *
 *   - its class name, which the envelope reports as `context.errorClass`
 *     (callers branch on it where two classes could share a code);
 *   - its message naming the subject that failed (the id, store, status,
 *     path, hash or shape the caller passed), so the headline says WHICH
 *     thing failed, not only that something did;
 *   - its remediation hint naming the recovery a caller can act on: the CLI
 *     command, SDK call, flag or recovery path. Prose that only explains the
 *     failure is deliberately not asserted; the hint's job is the next step;
 *   - its exit code.
 *
 * The mutation run (docs/release-readiness.md, Stryker section) showed that
 * nothing checked most of these: a class could lose its name, or a hint its
 * recovery command, and every test stayed green.
 */

import { describe, it, expect } from 'vitest';
import {
    ClusterError,
    NotFoundError,
    ProvenanceMissingError,
    CommandNotValidatedError,
    CommandRejectedError,
    CommandNotFoundError,
    CommandAlreadyTerminalError,
    InvalidStateTransitionError,
    ReceiptFailedError,
    CommandQueueCorruptError,
    CommandQueuePersistenceLostError,
    ContentHashMismatchError,
    StagedContentTamperedError,
    BufferSideChannelNotSupportedError,
    InvalidContentShapeError,
    InvalidActorError,
    assertActor,
} from '../src/kernel/errors.js';
import { errorToAiEnvelope, formatForUser } from '../src/policy/error-formatter.js';
import { renderClusterErrorForCli, typedErrorToExitCode } from '../src/cli.js';

interface ErrorCase {
    className: string;
    make: () => ClusterError;
    code: string;
    exitCode: number;
    /** Every value the caller supplied that identifies the failed subject. */
    subject: string[];
    /** Envelope context fields and the value each must carry. */
    context: Record<string, string>;
    /** One pattern per recovery step the hint offers. */
    recovery: RegExp[];
}

const CASES: ErrorCase[] = [
    {
        className: 'NotFoundError',
        make: () => new NotFoundError('canonical', 'ent-42'),
        code: 'NOT_FOUND',
        exitCode: 1,
        subject: ['canonical', 'ent-42'],
        context: { store: 'canonical', recordId: 'ent-42' },
        recovery: [/`db-cluster find "<query>"`/],
    },
    {
        className: 'ProvenanceMissingError',
        make: () => new ProvenanceMissingError('ent-7'),
        code: 'PROVENANCE_MISSING',
        exitCode: 1,
        subject: ['ent-7'],
        context: { subjectId: 'ent-7' },
        recovery: [/`db-cluster verify`/],
    },
    {
        className: 'CommandNotValidatedError',
        make: () => new CommandNotValidatedError('cmd-1'),
        code: 'COMMAND_NOT_VALIDATED',
        exitCode: 1,
        subject: ['cmd-1'],
        context: { commandId: 'cmd-1' },
        recovery: [/`validateMutation\(commandId\)`/, /`db-cluster validate <commandId>`/],
    },
    {
        className: 'CommandRejectedError',
        make: () => new CommandRejectedError('cmd-2', 'payload failed review'),
        code: 'COMMAND_REJECTED',
        exitCode: 1,
        subject: ['cmd-2', 'payload failed review'],
        context: { commandId: 'cmd-2', reason: 'payload failed review' },
        recovery: [/`db-cluster inspect-command <id>`/, /propose a fresh command/i],
    },
    {
        className: 'CommandNotFoundError',
        make: () => new CommandNotFoundError('cmd-3'),
        code: 'COMMAND_NOT_FOUND',
        exitCode: 1,
        subject: ['cmd-3'],
        context: { commandId: 'cmd-3' },
        recovery: [/`db-cluster list-commands`/, /`cluster\.listReceipts\(\{limit\}\)`/, /re-propose/],
    },
    {
        className: 'CommandAlreadyTerminalError',
        make: () => new CommandAlreadyTerminalError('cmd-4', 'committed'),
        code: 'COMMAND_ALREADY_TERMINAL',
        exitCode: 1,
        subject: ['cmd-4', "'committed'"],
        context: { commandId: 'cmd-4', terminalStatus: 'committed' },
        recovery: [/propose a fresh command/i, /`compensateMutation`/],
    },
    {
        className: 'InvalidStateTransitionError',
        make: () => new InvalidStateTransitionError('proposed', 'committed', 'cmd-5'),
        code: 'INVALID_STATE_TRANSITION',
        exitCode: 1,
        subject: ['cmd-5', "'proposed'", "'committed'"],
        context: { commandId: 'cmd-5', from: 'proposed', to: 'committed' },
        recovery: [/`validTransitions\(currentStatus\)`/],
    },
    {
        className: 'ReceiptFailedError',
        make: () => new ReceiptFailedError('ent-9', 'cmd-6', new Error('ledger append failed')),
        code: 'RECEIPT_FAILED',
        exitCode: 70,
        subject: ['ent-9', 'cmd-6', 'ledger append failed'],
        context: { subjectId: 'ent-9', commandId: 'cmd-6', causeName: 'Error', causeMessage: 'ledger append failed' },
        recovery: [/`db-cluster doctor`/, /`mutation_orphaned`/, /restore from backup/, /do not blindly retry/i],
    },
    {
        className: 'CommandQueueCorruptError',
        make: () => new CommandQueueCorruptError('queue/pending-commands.json', new SyntaxError('Unexpected token }')),
        code: 'COMMAND_QUEUE_CORRUPT',
        exitCode: 70,
        subject: ['queue/pending-commands.json', 'Unexpected token }'],
        context: { filePath: 'queue/pending-commands.json' },
        // The three recovery paths the module JSDoc names as the exemplar.
        recovery: [/restore from a backup that includes pending-commands\.json/, /delete the file to start fresh/, /inspect the file by hand/],
    },
    {
        className: 'CommandQueuePersistenceLostError',
        make: () => new CommandQueuePersistenceLostError('queue/pending-commands.json', 'queue/command-queue-marker'),
        code: 'COMMAND_QUEUE_PERSISTENCE_LOST',
        exitCode: 70,
        subject: ['queue/pending-commands.json', 'queue/command-queue-marker'],
        context: { filePath: 'queue/pending-commands.json', markerPath: 'queue/command-queue-marker' },
        // The delete path discards pending commands; the hint must say so.
        recovery: [/restore from a backup that\s+includes both files/, /delete the marker file to re-cold-start/, /loses any pending commands/],
    },
    {
        className: 'ContentHashMismatchError',
        make: () => new ContentHashMismatchError('aaa111', 'bbb222'),
        code: 'CONTENT_HASH_MISMATCH',
        exitCode: 65,
        subject: ['aaa111', 'bbb222'],
        context: { claimedHash: 'aaa111', actualHash: 'bbb222' },
        recovery: [/`sha256\(content\)`/, /re-propose/],
    },
    {
        className: 'StagedContentTamperedError',
        make: () => new StagedContentTamperedError('ccc333', 'staging/ccc333', 'ddd444'),
        code: 'STAGED_CONTENT_TAMPERED',
        exitCode: 65,
        subject: ['ccc333', 'staging/ccc333', 'ddd444'],
        context: { contentHash: 'ccc333', stagingPath: 'staging/ccc333', actualHash: 'ddd444' },
        recovery: [/examine the staging file by hand/, /re-propose the mutation with fresh content/, /DO NOT retry/],
    },
    {
        className: 'BufferSideChannelNotSupportedError',
        make: () => new BufferSideChannelNotSupportedError('postgres'),
        code: 'BUFFER_SIDE_CHANNEL_NOT_SUPPORTED',
        exitCode: 70,
        subject: ['postgres'],
        context: { adapterName: 'postgres' },
        recovery: [/local-adapter cluster/, /contentHash reference/],
    },
    {
        className: 'InvalidContentShapeError',
        make: () => new InvalidContentShapeError('object{type,data}'),
        code: 'INVALID_CONTENT_SHAPE',
        exitCode: 65,
        subject: ['object{type,data}'],
        context: { actualShape: 'object{type,data}' },
        recovery: [/real Buffer instance/, /string contentHash reference/],
    },
    {
        className: 'InvalidActorError',
        make: () => new InvalidActorError('approvedBy', undefined),
        code: 'INVALID_ACTOR',
        exitCode: 65,
        subject: ['approvedBy', 'undefined'],
        context: {},
        recovery: [/id of the person or service performing the action/, /--actor/, /DB_CLUSTER_OPERATOR/],
    },
];

describe('kernel errors: what each surface shows the caller', () => {
    for (const c of CASES) {
        describe(c.className, () => {
            it('is a non-retryable ClusterError with its code and exit code', () => {
                const err = c.make();
                expect(err).toBeInstanceOf(ClusterError);
                expect(err.code).toBe(c.code);
                expect(err.retryable).toBe(false);
                expect(typedErrorToExitCode(err.code)).toBe(c.exitCode);
            });

            it('names its class, so the AI envelope can report it', () => {
                const err = c.make();
                expect(err.name).toBe(c.className);
                expect(errorToAiEnvelope(err).context.errorClass).toBe(c.className);
                expect(String(err)).toMatch(new RegExp(`^${c.className}: `));
            });

            it('names the failed subject in its message', () => {
                const err = c.make();
                for (const part of c.subject) expect(err.message).toContain(part);
            });

            it('carries the subject into the envelope context', () => {
                const envelope = errorToAiEnvelope(c.make());
                expect(envelope.code).toBe(c.code);
                for (const [key, value] of Object.entries(c.context)) {
                    expect(envelope.context[key]).toBe(value);
                }
            });

            it('names the recovery a caller can act on, on every surface', () => {
                const err = c.make();
                for (const step of c.recovery) expect(err.remediationHint).toMatch(step);
                expect(errorToAiEnvelope(err).remediation_hint).toBe(err.remediationHint);
                expect(formatForUser(err)).toBe(`${err.message}\n  → try: ${err.remediationHint}`);
                expect(renderClusterErrorForCli(err).endsWith(`\n  → try: ${err.remediationHint}`)).toBe(true);
            });
        });
    }
});

describe('kernel errors: optional context leaves no placeholder behind', () => {
    it('a state transition without a command id names only the two statuses', () => {
        const err = new InvalidStateTransitionError('proposed', 'committed');
        expect(err.commandId).toBeUndefined();
        expect(err.message).toMatch(/^Cannot transition command from status 'proposed' to 'committed'\./);
        expect(errorToAiEnvelope(err).context).not.toHaveProperty('commandId');
    });

    it('a failed receipt without a command id names the subject, then the cause', () => {
        const err = new ReceiptFailedError('ent-9', undefined, new Error('ledger append failed'));
        expect(err.message).toMatch(/for subject ent-9: ledger append failed$/);
        expect(err.message).not.toContain('(command');
    });

    it('a corrupt queue file reports the cause it was given, whatever its type', () => {
        expect(new CommandQueueCorruptError('q.json', new Error('bad JSON')).message).toContain('(bad JSON)');
        expect(new CommandQueueCorruptError('q.json', 'truncated write').message).toContain('(truncated write)');
        const none = new CommandQueueCorruptError('q.json');
        expect(none.message).toContain('(unknown)');
        expect(none.innerCause).toBeUndefined();
    });
});

describe('assertActor: what the caller is told it passed instead of an actor', () => {
    const REFUSED: Array<{ value: unknown; received: string }> = [
        { value: undefined, received: 'undefined' },
        { value: null, received: 'null' },
        { value: '', received: 'blank' },
        { value: '   ', received: 'blank' },
        { value: 42, received: 'number' },
        { value: { id: 'x' }, received: 'object' },
        { value: false, received: 'boolean' },
    ];

    for (const { value, received } of REFUSED) {
        it(`refuses ${JSON.stringify(value) ?? 'undefined'} and reports it as ${received}`, () => {
            let caught: unknown;
            try {
                assertActor('actorId', value);
            } catch (err) {
                caught = err;
            }
            expect(caught).toBeInstanceOf(InvalidActorError);
            const err = caught as InvalidActorError;
            expect(err.field).toBe('actorId');
            expect(err.received).toBe(received);
            expect(err.message).toContain('actorId');
            expect(err.message).toMatch(new RegExp(`received ${received}\\.$`));
        });
    }

    it('accepts any non-blank string, including one with surrounding spaces', () => {
        expect(() => assertActor('actorId', 'operator')).not.toThrow();
        expect(() => assertActor('actorId', ' operator ')).not.toThrow();
    });
});
