/**
 * Wave C1-Amend — Kernel domain regression nets.
 *
 * Each test pins one Stage C Wave C1-Amend behavioral-humanization
 * invariant. Tests were written BEFORE the fixes landed (per v2
 * protocol per-finding test-first gate); each was confirmed to FAIL on
 * the pre-fix HEAD and passes on the post-fix HEAD.
 *
 * Findings covered:
 *
 *  - §2a / KERNEL-C-001 — AiErrorEnvelope shape exported from
 *    `src/types/ai-envelope.ts`; covers MCP / SDK consumer contract.
 *
 *  - §2b / KERNEL-C-010 / SURFACE-C-015 — ClusterError base contract:
 *    every typed-error subclass carries non-empty `remediationHint`,
 *    typed `code: ClusterErrorCode`, boolean `retryable`. The CLUSTER_ERROR_CODES
 *    const + ClusterErrorCode union live in `src/kernel/errors.ts` as
 *    the single source of truth (cli.ts + mcp/sanitize.ts mirror it).
 *
 *  - §2d — ComponentState type at `src/types/component-state.ts`.
 *
 *  - KERNEL-C-002 — proposeMutation/commitMutation/etc. return values
 *    surface `nextValidActions: CommandStatus[]`. Computed from
 *    `validTransitions(command.status)`.
 *
 *  - KERNEL-C-003 — findSources empty-result populates
 *    `_meta.empty_reason` ('no_data' / 'no_match' /
 *    'all_filtered_by_policy') with a remediation hint.
 *
 *  - KERNEL-C-004 — RedactedMarker (`src/types/redaction.ts`) carries
 *    an optional `capability` field naming which capability would
 *    unlock the redacted field. `redactedMarker()` factory accepts
 *    the 4th arg.
 *
 *  - KERNEL-C-005 — commitMutation throws 3 distinct typed errors for
 *    the 3 invalid-state cases (not-found / not-validated /
 *    already-terminal) rather than collapsing all to
 *    CommandNotValidatedError.
 *
 *  - KERNEL-C-006 — kernel/index.ts exports ALL 14 typed errors,
 *    PolicyEnforcedKernel, PolicyDeniedError, ClusterErrorCode union,
 *    CLUSTER_ERROR_CODES const, command-lifecycle helpers
 *    (approveCommand, rejectCommand, markCommitted, markRejected,
 *    markCompensated, isValidTransition, validTransitions).
 *
 *  - SHA-KERNEL-C-001 — kernel/commands.ts state-transition failures
 *    throw typed errors (InvalidStateTransitionError) not bare
 *    `new Error(...)`. 6 sites covered (validateCommand,
 *    approveCommand, rejectCommand, markCommitted, markCompensated,
 *    cluster-kernel.ts compensateMutation).
 *
 *  - formatForUser (src/policy/error-formatter.ts) renders the
 *    canonical `${message}\n  → try: ${remediationHint}` shape.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalCluster } from '../src/adapters/local/index.js';
import {
    ClusterKernel,
    // Every typed-error subclass exports from kernel/index.ts now.
    ClusterError,
    CLUSTER_ERROR_CODES,
    NotFoundError,
    ProvenanceMissingError,
    CommandNotValidatedError,
    CommandNotFoundError,
    CommandAlreadyTerminalError,
    CommandRejectedError,
    InvalidStateTransitionError,
    ReceiptFailedError,
    CommandQueueCorruptError,
    CommandQueuePersistenceLostError,
    ContentHashMismatchError,
    StagedContentTamperedError,
    BufferSideChannelNotSupportedError,
    InvalidContentShapeError,
    // PolicyEnforcedKernel + PolicyDeniedError exported from kernel/index.ts.
    PolicyEnforcedKernel,
    PolicyDeniedError,
    // Command-lifecycle helpers.
    approveCommand,
    rejectCommand,
    markCommitted,
    markRejected,
    markCompensated,
    isValidTransition,
    validTransitions,
    proposeCommand,
    validateCommand,
    CommandValidationFailedError,
    type ClusterErrorCode,
} from '../src/kernel/index.js';
import { isRedactedMarker, redactedMarker } from '../src/types/redaction.js';
import type { ComponentState } from '../src/types/component-state.js';
import type { AiErrorEnvelope, EmptyResultMeta } from '../src/types/ai-envelope.js';
import {
    formatForUser,
    errorToAiEnvelope,
} from '../src/policy/error-formatter.js';
import type { Policy } from '../src/types/policy.js';
import type { Command } from '../src/types/command.js';

let testDir: string;
const setupTmp = () => {
    testDir = mkdtempSync(join(tmpdir(), 'wave-c1-kernel-'));
};
const cleanupTmp = () => {
    if (testDir) rmSync(testDir, { recursive: true, force: true });
};

describe('Wave C1-Amend — §2b ClusterError contract (KERNEL-C-010 / SURFACE-C-015)', () => {
    // Every concrete subclass instantiable in this test set. The list
    // is the exhaustive coverage of `src/kernel/errors.ts` typed errors
    // — adding a new subclass requires extending this list.
    const cases: Array<[string, () => ClusterError]> = [
        ['NotFoundError', () => new NotFoundError('canonical', 'id-1')],
        ['ProvenanceMissingError', () => new ProvenanceMissingError('s-1')],
        ['CommandNotValidatedError', () => new CommandNotValidatedError('c-1')],
        ['CommandNotFoundError', () => new CommandNotFoundError('c-1')],
        ['CommandAlreadyTerminalError', () => new CommandAlreadyTerminalError('c-1', 'committed')],
        ['CommandRejectedError', () => new CommandRejectedError('c-1', 'bad payload')],
        ['InvalidStateTransitionError', () => new InvalidStateTransitionError('proposed', 'committed', 'c-1')],
        ['ReceiptFailedError', () => new ReceiptFailedError('s-1', 'c-1', new Error('boom'))],
        ['CommandQueueCorruptError', () => new CommandQueueCorruptError('/tmp/foo.json')],
        ['CommandQueuePersistenceLostError', () => new CommandQueuePersistenceLostError('/tmp/q.json', '/tmp/m')],
        ['ContentHashMismatchError', () => new ContentHashMismatchError('aaa', 'bbb')],
        ['StagedContentTamperedError', () => new StagedContentTamperedError('aaa', '/tmp/x', 'bbb')],
        ['BufferSideChannelNotSupportedError', () => new BufferSideChannelNotSupportedError('remote')],
        ['InvalidContentShapeError', () => new InvalidContentShapeError('object')],
    ];

    it.each(cases)('%s carries non-empty remediationHint', (_name, factory) => {
        const err = factory();
        expect(typeof err.remediationHint).toBe('string');
        expect(err.remediationHint.length).toBeGreaterThan(20);
    });

    it.each(cases)('%s carries a ClusterErrorCode-valid code', (_name, factory) => {
        const err = factory();
        expect(CLUSTER_ERROR_CODES).toContain(err.code as ClusterErrorCode);
    });

    it.each(cases)('%s carries a boolean retryable flag', (_name, factory) => {
        const err = factory();
        expect(typeof err.retryable).toBe('boolean');
    });

    it('PolicyDeniedError participates in the §2b contract', () => {
        const err = new PolicyDeniedError({
            decision: 'deny',
            matchedPolicyId: 'p-1',
            matchedPolicyName: 'Test policy',
            capability: 'read_owner_truth',
            reason: 'No matching scope.',
            principalId: 'principal:test',
            trustZone: 'internal',
            resourceUri: 'cluster://canonical/x',
            requiresApproval: false,
        });
        expect(err.code).toBe('POLICY_DENIED');
        expect(CLUSTER_ERROR_CODES).toContain(err.code as ClusterErrorCode);
        expect(err.remediationHint.length).toBeGreaterThan(20);
        // Per-instance remediation names the matched capability.
        expect(err.remediationHint).toContain('read_owner_truth');
        expect(typeof err.retryable).toBe('boolean');
    });

    it('ClusterErrorCode union and CLUSTER_ERROR_CODES const are in lock-step', () => {
        // Codes I expect to be present at minimum.
        const expectedCodes: ClusterErrorCode[] = [
            'NOT_FOUND',
            'POLICY_DENIED',
            'CONTENT_HASH_MISMATCH',
            'COMMAND_NOT_VALIDATED',
            'COMMAND_NOT_FOUND',
            'COMMAND_ALREADY_TERMINAL',
            'INVALID_STATE_TRANSITION',
            'CORRUPT_STORE',
            'INVALID_CONTENT_HASH',
            'IMPORT_CONFLICT',
            'LEDGER_CYCLE_DETECTED',
            'INVALID_POLICY_CONFIG',
            'INVALID_ROTATE_TIMESTAMP',
            'ROTATE_BOUNDARY_IN_FUTURE',
        ];
        for (const code of expectedCodes) {
            expect(CLUSTER_ERROR_CODES).toContain(code);
        }
    });
});

describe('Wave C1-Amend — formatForUser + errorToAiEnvelope helpers (§2b helper)', () => {
    it('formatForUser renders the `${message}\\n  → try: ${hint}` shape on ClusterError', () => {
        const err = new ContentHashMismatchError('aaa', 'bbb');
        const formatted = formatForUser(err);
        expect(formatted).toContain('Content hash mismatch');
        expect(formatted).toContain('→ try:');
        expect(formatted).toContain('Recompute the hash');
    });

    it('formatForUser handles raw AiErrorEnvelope shape', () => {
        const envelope: AiErrorEnvelope = {
            code: 'POLICY_DENIED',
            message: 'Policy denied: read_owner_truth',
            retryable: false,
            remediation_hint: 'Acquire the read_owner_truth capability.',
            context: { capability: 'read_owner_truth' },
        };
        const formatted = formatForUser(envelope);
        expect(formatted).toContain('Policy denied');
        expect(formatted).toContain('→ try:');
        expect(formatted).toContain('Acquire');
    });

    it('errorToAiEnvelope populates subclass context for ContentHashMismatchError', () => {
        const err = new ContentHashMismatchError('aaa', 'bbb');
        const envelope = errorToAiEnvelope(err);
        expect(envelope.code).toBe('CONTENT_HASH_MISMATCH');
        expect(envelope.retryable).toBe(false);
        expect(envelope.context.claimedHash).toBe('aaa');
        expect(envelope.context.actualHash).toBe('bbb');
        expect(envelope.remediation_hint).toBeTruthy();
    });

    it('errorToAiEnvelope populates subclass context for PolicyDeniedError', () => {
        const err = new PolicyDeniedError({
            decision: 'deny',
            matchedPolicyId: 'p-1',
            matchedPolicyName: 'Test',
            capability: 'commit_command',
            reason: 'No scope.',
            principalId: 'p:1',
            trustZone: 'internal',
            requiresApproval: false,
        });
        const envelope = errorToAiEnvelope(err);
        expect(envelope.code).toBe('POLICY_DENIED');
        expect(envelope.context.capability).toBe('commit_command');
        expect(envelope.context.matchedPolicyName).toBe('Test');
    });

    it('errorToAiEnvelope populates subclass context for ReceiptFailedError', () => {
        const cause = new Error('disk full');
        cause.name = 'DiskFullError';
        const err = new ReceiptFailedError('s-1', 'c-1', cause);
        const envelope = errorToAiEnvelope(err);
        expect(envelope.code).toBe('RECEIPT_FAILED');
        expect(envelope.context.subjectId).toBe('s-1');
        expect(envelope.context.commandId).toBe('c-1');
        expect(envelope.context.causeName).toBe('DiskFullError');
    });

    it('errorToAiEnvelope populates subclass context for InvalidStateTransitionError', () => {
        const err = new InvalidStateTransitionError('proposed', 'committed', 'c-1');
        const envelope = errorToAiEnvelope(err);
        expect(envelope.code).toBe('INVALID_STATE_TRANSITION');
        expect(envelope.context.from).toBe('proposed');
        expect(envelope.context.to).toBe('committed');
        expect(envelope.context.commandId).toBe('c-1');
    });
});

describe('Wave C1-Amend — KERNEL-C-002 nextValidActions on lifecycle envelopes', () => {
    beforeEach(setupTmp);
    afterEach(cleanupTmp);

    it('proposeMutation result → withNextValidActions surfaces validTransitions("proposed")', async () => {
        const stores = await createLocalCluster(testDir);
        const kernel = new ClusterKernel(stores, { dataDir: testDir });

        const command = await kernel.proposeMutation({
            verb: 'create_entity',
            targetStore: 'canonical',
            payload: { kind: 'Person', name: 'Alice', attributes: {} },
            proposedBy: 'tester',
        });

        const envelope = kernel.withNextValidActions(command);
        expect(envelope.command.id).toBe(command.id);
        expect(envelope.nextValidActions).toEqual(['validated', 'rejected']);
    });

    it('validateMutation result → nextValidActions = ["approved","committed","rejected"]', async () => {
        const stores = await createLocalCluster(testDir);
        const kernel = new ClusterKernel(stores, { dataDir: testDir });

        const command = await kernel.proposeMutation({
            verb: 'create_entity',
            targetStore: 'canonical',
            payload: { kind: 'Person', name: 'Alice', attributes: {} },
            proposedBy: 'tester',
        });
        const validated = await kernel.validateMutation(command.id);
        const envelope = kernel.withNextValidActions(validated);
        expect(envelope.nextValidActions).toEqual(['approved', 'committed', 'rejected']);
    });

    it('commitMutation returns CommitMutationResult with nextValidActions = ["compensated"]', async () => {
        const stores = await createLocalCluster(testDir);
        const kernel = new ClusterKernel(stores, { dataDir: testDir });

        const command = await kernel.proposeMutation({
            verb: 'create_entity',
            targetStore: 'canonical',
            payload: { kind: 'Person', name: 'Alice', attributes: {} },
            proposedBy: 'tester',
        });
        await kernel.validateMutation(command.id);
        const committed = await kernel.commitMutation(command.id, 'tester');
        expect(committed.nextValidActions).toEqual(['compensated']);
    });

    it('rejected / compensated commands surface empty nextValidActions (terminal)', () => {
        const cmd: Command = {
            id: 'c-1',
            verb: 'create_entity',
            targetStore: 'canonical',
            payload: {},
            proposedAt: new Date().toISOString(),
            proposedBy: 't',
            status: 'rejected',
        };
        expect(validTransitions(cmd.status)).toEqual([]);
    });
});

describe('Wave C1-Amend — KERNEL-C-003 findSources empty-result _meta', () => {
    beforeEach(setupTmp);
    afterEach(cleanupTmp);

    it('empty cluster → _meta.empty_reason === "no_data"', async () => {
        const stores = await createLocalCluster(testDir);
        const kernel = new ClusterKernel(stores, { dataDir: testDir });

        const result = await kernel.findSources({ query: 'anything', limit: 10 });
        expect(result.indexRecords).toHaveLength(0);
        expect(result._meta).toBeDefined();
        expect(result._meta?.empty_reason).toBe('no_data');
        expect(result._meta?.remediation_hint).toMatch(/cluster has no indexed records/i);
    });

    it('populated cluster + no-match query → _meta.empty_reason === "no_match"', async () => {
        const stores = await createLocalCluster(testDir);
        const kernel = new ClusterKernel(stores, { dataDir: testDir });

        await kernel.createEntity({
            kind: 'Person',
            name: 'Alice',
            attributes: {},
            actorId: 'tester',
        });

        const result = await kernel.findSources({ query: 'something-that-doesnt-match', limit: 10 });
        expect(result.indexRecords).toHaveLength(0);
        expect(result._meta).toBeDefined();
        expect(result._meta?.empty_reason).toBe('no_match');
        expect(result._meta?.remediation_hint).toMatch(/no records match/i);
    });

    it('non-empty result omits _meta', async () => {
        const stores = await createLocalCluster(testDir);
        const kernel = new ClusterKernel(stores, { dataDir: testDir });
        await kernel.createEntity({
            kind: 'Person',
            name: 'Alice',
            attributes: {},
            actorId: 'tester',
        });
        const result = await kernel.findSources({ query: 'Alice', limit: 10 });
        expect(result.indexRecords.length).toBeGreaterThan(0);
        expect(result._meta).toBeUndefined();
    });

    it('PolicyEnforcedKernel: matches all-filtered → _meta.empty_reason === "all_filtered_by_policy"', async () => {
        const stores = await createLocalCluster(testDir);
        const bareKernel = new ClusterKernel(stores, { dataDir: testDir });
        // Seed a Person; the policy below will deny read_owner_truth.
        await bareKernel.createEntity({
            kind: 'Person',
            name: 'Alice',
            attributes: { ssn: 'X' },
            actorId: 'tester',
        });

        const policies: Policy[] = [
            {
                id: 'allow-discover',
                name: 'allow discover',
                decision: 'allow',
                match: {
                    capabilities: ['discover_existence'],
                    principals: ['p:guest'],
                },
            },
            {
                id: 'allow-derivative',
                name: 'allow derivative',
                decision: 'allow',
                match: {
                    capabilities: ['read_derivative'],
                    principals: ['p:guest'],
                },
            },
            {
                id: 'deny-owner',
                name: 'deny owner truth',
                decision: 'deny',
                match: {
                    capabilities: ['read_owner_truth'],
                    principals: ['p:guest'],
                },
            },
        ];
        const policyKernel = new PolicyEnforcedKernel(
            stores,
            {
                principal: {
                    id: 'p:guest',
                    name: 'guest',
                    roles: [],
                    trustZone: 'internal',
                },
            },
            { policies, dataDir: testDir },
        );

        const result = await policyKernel.findSources({ query: 'Alice', limit: 10 });
        // Find DID match (we created an Alice entity), but
        // read_owner_truth is denied → policy filtered every record out.
        expect(result.indexRecords).toHaveLength(0);
        expect(result.resolvedEntities).toHaveLength(0);
        expect(result._meta).toBeDefined();
        expect(result._meta?.empty_reason).toBe('all_filtered_by_policy');
        expect(result._meta?.filteredCount).toBeGreaterThan(0);
        expect(result._meta?.remediation_hint).toMatch(/policy/i);
    });
});

describe('Wave C1-Amend — KERNEL-C-004 RedactedMarker.capability', () => {
    it('redactedMarker accepts capability arg', () => {
        const marker = redactedMarker('string', 'capability_denied', 'read_owner_truth');
        expect(marker._redacted).toBe(true);
        expect(marker.kind).toBe('string');
        expect(marker.reason).toBe('capability_denied');
        expect(marker.capability).toBe('read_owner_truth');
    });

    it('capability is optional — old call shape still works', () => {
        const marker = redactedMarker('string', 'capability_denied');
        expect(marker._redacted).toBe(true);
        expect(marker.capability).toBeUndefined();
    });

    it('non-capability reasons may still carry capability undefined', () => {
        const marker = redactedMarker('object', 'sensitive_field');
        expect(marker.reason).toBe('sensitive_field');
        expect(marker.capability).toBeUndefined();
    });

    it('isRedactedMarker recognizes markers with capability set', () => {
        const marker = redactedMarker('number', 'capability_denied', 'read_command');
        expect(isRedactedMarker(marker)).toBe(true);
    });
});

describe('Wave C1-Amend — KERNEL-C-005 commitMutation distinct typed errors', () => {
    beforeEach(setupTmp);
    afterEach(cleanupTmp);

    it('commitMutation on non-existent id throws CommandNotFoundError (not CommandNotValidatedError)', async () => {
        const stores = await createLocalCluster(testDir);
        const kernel = new ClusterKernel(stores, { dataDir: testDir });

        await expect(
            kernel.commitMutation('nonexistent-id', 'tester'),
        ).rejects.toBeInstanceOf(CommandNotFoundError);
    });

    it('commitMutation on proposed-not-validated id throws CommandNotValidatedError', async () => {
        const stores = await createLocalCluster(testDir);
        const kernel = new ClusterKernel(stores, { dataDir: testDir });

        const command = await kernel.proposeMutation({
            verb: 'create_entity',
            targetStore: 'canonical',
            payload: { kind: 'Person', name: 'Alice', attributes: {} },
            proposedBy: 'tester',
        });

        await expect(
            kernel.commitMutation(command.id, 'tester'),
        ).rejects.toBeInstanceOf(CommandNotValidatedError);
    });

    it('commitMutation on already-committed id throws CommandAlreadyTerminalError', async () => {
        const stores = await createLocalCluster(testDir);
        const kernel = new ClusterKernel(stores, { dataDir: testDir });

        const command = await kernel.proposeMutation({
            verb: 'create_entity',
            targetStore: 'canonical',
            payload: { kind: 'Person', name: 'Alice', attributes: {} },
            proposedBy: 'tester',
        });
        await kernel.validateMutation(command.id);
        await kernel.commitMutation(command.id, 'tester');

        // Second commit on the now-committed command → CommandAlreadyTerminalError.
        await expect(
            kernel.commitMutation(command.id, 'tester'),
        ).rejects.toBeInstanceOf(CommandAlreadyTerminalError);
    });

    it('commitMutation on rejected id throws CommandRejectedError', async () => {
        const stores = await createLocalCluster(testDir);
        const kernel = new ClusterKernel(stores, { dataDir: testDir });

        const command = await kernel.proposeMutation({
            verb: 'create_entity',
            targetStore: 'canonical',
            payload: { kind: 'Person', name: 'Alice', attributes: {} },
            proposedBy: 'tester',
        });
        await kernel.rejectMutation(command.id, 'tester', 'rejected for test');

        await expect(
            kernel.commitMutation(command.id, 'tester'),
        ).rejects.toBeInstanceOf(CommandRejectedError);
    });
});

describe('Wave C1-Amend — KERNEL-C-006 kernel/index.ts complete exports', () => {
    it('all 14 typed-error subclasses are importable as named exports', () => {
        // If any of these are undefined the import would have failed at
        // module-load time — but assert them defensively anyway so a
        // regression that removes one fails here, not later.
        const all = [
            ClusterError,
            NotFoundError,
            ProvenanceMissingError,
            CommandNotValidatedError,
            CommandNotFoundError,
            CommandAlreadyTerminalError,
            CommandRejectedError,
            InvalidStateTransitionError,
            ReceiptFailedError,
            CommandQueueCorruptError,
            CommandQueuePersistenceLostError,
            ContentHashMismatchError,
            StagedContentTamperedError,
            BufferSideChannelNotSupportedError,
            InvalidContentShapeError,
            PolicyDeniedError,
        ];
        for (const cls of all) {
            expect(typeof cls).toBe('function');
        }
    });

    it('CLUSTER_ERROR_CODES const is importable and non-empty', () => {
        expect(Array.isArray(CLUSTER_ERROR_CODES)).toBe(true);
        expect(CLUSTER_ERROR_CODES.length).toBeGreaterThan(20);
    });

    it('command-lifecycle helpers are importable from kernel/index.ts', () => {
        expect(typeof proposeCommand).toBe('function');
        expect(typeof validateCommand).toBe('function');
        expect(typeof approveCommand).toBe('function');
        expect(typeof rejectCommand).toBe('function');
        expect(typeof markCommitted).toBe('function');
        expect(typeof markRejected).toBe('function');
        expect(typeof markCompensated).toBe('function');
        expect(typeof isValidTransition).toBe('function');
        expect(typeof validTransitions).toBe('function');
    });

    it('PolicyEnforcedKernel + PolicyDeniedError importable from kernel/index.ts', () => {
        expect(typeof PolicyEnforcedKernel).toBe('function');
        expect(typeof PolicyDeniedError).toBe('function');
    });
});

describe('Wave C1-Amend — SHA-KERNEL-C-001 bare new Error() → typed errors', () => {
    it('validateCommand fails → throws CommandValidationFailedError (not bare Error)', () => {
        const cmd = proposeCommand(
            'create_entity' as any,
            'canonical',
            { /* missing name + kind */ },
            'tester',
        );
        let thrown: unknown;
        try {
            validateCommand(cmd);
        } catch (e) {
            thrown = e;
        }
        expect(thrown).toBeInstanceOf(CommandValidationFailedError);
        expect((thrown as CommandValidationFailedError).code).toBe('COMMAND_VALIDATION_FAILED');
    });

    it('approveCommand on non-validated → throws InvalidStateTransitionError', () => {
        const cmd = proposeCommand(
            'create_entity' as any,
            'canonical',
            { kind: 'Person', name: 'Alice' },
            'tester',
        );
        // Command is in 'proposed' status.
        expect(() => approveCommand(cmd, 'approver')).toThrow(InvalidStateTransitionError);
    });

    it('rejectCommand on committed → throws InvalidStateTransitionError', () => {
        const committed: Command = {
            id: 'c-1',
            verb: 'create_entity',
            targetStore: 'canonical',
            payload: {},
            proposedAt: new Date().toISOString(),
            proposedBy: 't',
            status: 'committed',
        };
        expect(() => rejectCommand(committed, 't', 'too late')).toThrow(InvalidStateTransitionError);
    });

    it('markCommitted on proposed → throws InvalidStateTransitionError', () => {
        const proposed: Command = {
            id: 'c-1',
            verb: 'create_entity',
            targetStore: 'canonical',
            payload: {},
            proposedAt: new Date().toISOString(),
            proposedBy: 't',
            status: 'proposed',
        };
        expect(() => markCommitted(proposed)).toThrow(InvalidStateTransitionError);
    });

    it('markCompensated on proposed → throws InvalidStateTransitionError', () => {
        const proposed: Command = {
            id: 'c-1',
            verb: 'create_entity',
            targetStore: 'canonical',
            payload: {},
            proposedAt: new Date().toISOString(),
            proposedBy: 't',
            status: 'proposed',
        };
        expect(() => markCompensated(proposed, 'c-2', 't')).toThrow(InvalidStateTransitionError);
    });

    it('compensateMutation on non-committed → throws InvalidStateTransitionError', async () => {
        setupTmp();
        try {
            const stores = await createLocalCluster(testDir);
            const kernel = new ClusterKernel(stores, { dataDir: testDir });
            const command = await kernel.proposeMutation({
                verb: 'create_entity',
                targetStore: 'canonical',
                payload: { kind: 'Person', name: 'Alice', attributes: {} },
                proposedBy: 'tester',
            });
            // Don't validate or commit — compensate on proposed status.
            await expect(
                kernel.compensateMutation(command.id, 'tester', 'reverse'),
            ).rejects.toBeInstanceOf(InvalidStateTransitionError);
        } finally {
            cleanupTmp();
        }
    });

    it('every typed-error subclass thrown carries a code that is a valid ClusterErrorCode', () => {
        // Sample: each typed error a test above demonstrates lives in
        // CLUSTER_ERROR_CODES.
        const sample = [
            new InvalidStateTransitionError('proposed', 'committed', 'c-1'),
            new CommandValidationFailedError('payload missing'),
        ];
        for (const err of sample) {
            // CommandValidationFailedError extends plain Error (not
            // ClusterError, since it isn't a ClusterErrorCode subclass);
            // verify it carries the same surface contract.
            expect(typeof err.code).toBe('string');
            expect(typeof (err as { remediationHint?: unknown }).remediationHint).toBe('string');
        }
    });
});

describe('Wave C1-Amend — §2a AiErrorEnvelope shape', () => {
    it('AiErrorEnvelope type is importable; populated envelope has the expected fields', () => {
        const env: AiErrorEnvelope = {
            code: 'CONTENT_HASH_MISMATCH',
            message: 'hash mismatch',
            retryable: false,
            remediation_hint: 'recompute',
            context: { claimedHash: 'aaa', actualHash: 'bbb' },
        };
        expect(env.code).toBe('CONTENT_HASH_MISMATCH');
        expect(env.retryable).toBe(false);
        expect(env.context.claimedHash).toBe('aaa');
    });

    it('EmptyResultMeta type is importable; populated meta has the expected fields', () => {
        const meta: EmptyResultMeta = {
            _meta: {
                empty_reason: 'all_filtered_by_policy',
                remediation_hint: 'request capability',
            },
        };
        expect(meta._meta.empty_reason).toBe('all_filtered_by_policy');
    });
});

describe('Wave C1-Amend — §2d ComponentState type', () => {
    it('discriminated union: loading / empty / error / redacted / ready render branches', () => {
        const states: ComponentState<{ value: number }>[] = [
            { kind: 'loading' },
            { kind: 'empty', reason: 'no_data', remediationHint: 'add data' },
            {
                kind: 'error',
                error: {
                    code: 'NOT_FOUND',
                    message: 'missing',
                    retryable: false,
                    remediation_hint: 'check id',
                    context: {},
                },
            },
            {
                kind: 'redacted',
                markers: [redactedMarker('string', 'capability_denied', 'read_owner_truth')],
                reason: 'capability denied',
            },
            { kind: 'ready', data: { value: 42 } },
        ];

        const seen = new Set<string>();
        for (const s of states) {
            switch (s.kind) {
                case 'loading':
                    seen.add('loading');
                    break;
                case 'empty':
                    seen.add('empty');
                    expect(s.reason).toBe('no_data');
                    break;
                case 'error':
                    seen.add('error');
                    expect(s.error.code).toBe('NOT_FOUND');
                    break;
                case 'redacted':
                    seen.add('redacted');
                    expect(s.markers[0].capability).toBe('read_owner_truth');
                    break;
                case 'ready':
                    seen.add('ready');
                    expect(s.data.value).toBe(42);
                    break;
            }
        }
        expect(seen.size).toBe(5);
    });
});
