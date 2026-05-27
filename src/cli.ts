#!/usr/bin/env node
import { Command } from 'commander';
import { dirname, resolve } from 'node:path';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { userInfo } from 'node:os';
import { createLocalCluster } from './adapters/local/index.js';
import { ClusterKernel } from './kernel/cluster-kernel.js';
import { PolicyEnforcedKernel } from './kernel/policy-enforced-kernel.js';
import { formatClusterUri, parseClusterUri, isClusterUri } from './uri/index.js';
import { evaluatePolicy, explainPolicyDecision, checkVisibility } from './policy/policy-engine.js';
import { DEFAULT_POLICIES, DEFAULT_TRUST_ZONES, DEFAULT_VISIBILITY_RULES } from './policy/default-policies.js';
import { INTERNAL_TRUSTED_PRINCIPAL } from './policy/index.js';
import { ClusterError } from './kernel/errors.js';
// SURFACE-B-006 (Wave B1-Amend): shared structural validators used by
// both the CLI and MCP surface. The CLI previously had NO structural
// check on .db-cluster/policies.json — a malformed file silently slipped
// into PolicyEnforcedKernel.
import { validatePolicyConfig, PolicyConfigError } from './mcp/config-validator.js';
import { redactErrorMessage } from './policy/redactor.js';
import type { Principal, Capability, Policy, TrustZone, VisibilityRule } from './types/policy.js';

const CLUSTER_DIR = resolve(process.cwd(), '.db-cluster');
const POLICIES_FILE = resolve(CLUSTER_DIR, 'policies.json');

// SURFACE-B-013 (Wave B1-Amend): version is sourced from package.json at
// module load. Pre-fix this was a hardcoded literal `'0.1.0'` that
// silently went stale on every version bump. The version flows into
// commander's `.version()` below.
//
// `import.meta.dirname` is Node 22+; we use `fileURLToPath(import.meta.url)`
// + `dirname` for portability with the project's Node 20 target.
const __cliDir = dirname(fileURLToPath(import.meta.url));
// dist/cli.js sits at <pkg>/dist/cli.js → package.json is one level up.
const PACKAGE_VERSION: string = (() => {
    try {
        const pkgPath = resolve(__cliDir, '..', 'package.json');
        return JSON.parse(readFileSync(pkgPath, 'utf-8')).version as string;
    } catch {
        return 'unknown';
    }
})();

/** Resolved operator identity for the current CLI invocation. */
interface OperatorContext {
    actorId: string;
    /** True when the operator was derived from --actor or DB_CLUSTER_OPERATOR. */
    explicit: boolean;
}

/** Optional policies/principal loaded from .db-cluster/policies.json. */
interface PolicyConfig {
    policies?: Policy[];
    trustZones?: TrustZone[];
    visibilityRules?: VisibilityRule[];
    principal?: Principal;
}

/**
 * Resolve the operator (actor) identity for this CLI invocation.
 * Priority: --actor <id> > DB_CLUSTER_OPERATOR > os.userInfo().username > 'cli-user'.
 *
 * `explicit` is true when the operator came from --actor or DB_CLUSTER_OPERATOR
 * (i.e. the user/automation chose it). Used to soften the self-approval warning
 * for purely interactive single-user use.
 */
function resolveOperator(cliActor?: string): OperatorContext {
    if (cliActor && cliActor.trim() !== '') {
        return { actorId: cliActor, explicit: true };
    }
    const fromEnv = process.env.DB_CLUSTER_OPERATOR;
    if (fromEnv && fromEnv.trim() !== '') {
        return { actorId: fromEnv, explicit: true };
    }
    try {
        const u = userInfo();
        if (u.username && u.username.trim() !== '') {
            return { actorId: u.username, explicit: false };
        }
    } catch {
        // fall through
    }
    return { actorId: 'cli-user', explicit: false };
}

/**
 * Load policy configuration from .db-cluster/policies.json if present.
 * Returns null when no policies are configured — kernel runs in raw mode.
 *
 * SURFACE-B-006 fix (Wave B1-Amend): pre-fix did `JSON.parse(raw) as PolicyConfig`
 * with no runtime check. A malformed `policies.json` (e.g. principal
 * missing `roles`, policies field is a non-array) silently slipped into
 * `PolicyEnforcedKernel`, which may then trust-zone-not-found-branch
 * into bypass behavior. Now fails closed via the shared
 * `validatePolicyConfig` validator — the MCP surface uses the same
 * validator on `DB_CLUSTER_POLICIES_FILE`, so the two surfaces have
 * matching fail-shapes.
 *
 * The `PolicyConfigError` raised by the validator is caught by the
 * `cliCommand` wrapper and mapped to exit code 78 (EX_CONFIG); when
 * `loadPolicyConfig` is called outside a wrapped action (e.g. at module
 * load) the error is rethrown so the unhandled-rejection default fires
 * — that case should never happen in practice because every caller is
 * inside a `cliCommand` body.
 */
function loadPolicyConfig(): PolicyConfig | null {
    if (!existsSync(POLICIES_FILE)) return null;
    let raw: string;
    try {
        raw = readFileSync(POLICIES_FILE, 'utf-8');
    } catch (err: any) {
        throw new PolicyConfigError(POLICIES_FILE, `read failed: ${err.message}`);
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (err: any) {
        throw new PolicyConfigError(POLICIES_FILE, `JSON.parse failed: ${err.message}`);
    }
    // validatePolicyConfig throws PolicyConfigError on structural defects —
    // the cliCommand wrapper catches and maps to exit code 78.
    return validatePolicyConfig(parsed);
}

/**
 * Construct the kernel to use for a CLI invocation.
 * When .db-cluster/policies.json exists, wrap with PolicyEnforcedKernel
 * using the principal from the file (the SDK's no-principal warning fires
 * downstream when none is provided). Otherwise, return raw ClusterKernel.
 *
 * SURFACE-B-009 fix (Wave B1-Amend): pre-fix substituted
 * `INTERNAL_TRUSTED_PRINCIPAL` BEFORE constructing the PolicyEnforcedKernel,
 * which silenced the SDK's well-engineered "policies configured without
 * principal" warning. The CLI now passes the principal through unchanged
 * (undefined if not set) and lets the same warning fire that the MCP
 * surface relies on. Operators who really want the trusted principal
 * still get it — PolicyEnforcedKernel currently requires a principal,
 * so the kernel falls back to INTERNAL_TRUSTED_PRINCIPAL itself with
 * a stderr warning emitted at the SDK layer (cluster-sdk.ts:159-162).
 * This is the routes-converge fix: same input → same warning across CLI
 * and MCP boundaries.
 */
function getKernel(): ClusterKernel | PolicyEnforcedKernel {
    if (!existsSync(CLUSTER_DIR)) {
        console.error('No cluster found. Run `db-cluster init` first.');
        process.exit(1);
    }
    const stores = createLocalCluster(CLUSTER_DIR);
    const config = loadPolicyConfig();
    if (config && ((config.policies && config.policies.length > 0) || (config.trustZones && config.trustZones.length > 0) || (config.visibilityRules && config.visibilityRules.length > 0))) {
        // SURFACE-B-009: emit the no-principal warning at the CLI boundary
        // (mirrors the SDK's warning at cluster-sdk.ts:159-162) so the
        // CLI surfaces the same observability signal the MCP surface does.
        // PolicyEnforcedKernel requires a non-undefined principal, so we
        // fall back to INTERNAL_TRUSTED_PRINCIPAL after the warning fires
        // — operators are told what's happening, in contrast to the
        // pre-fix silent substitution.
        let principal: Principal;
        if (config.principal === undefined) {
            console.warn(
                'db-cluster CLI: policies configured without principal — using INTERNAL_TRUSTED_PRINCIPAL. ' +
                'Set `principal` in .db-cluster/policies.json to silence.',
            );
            principal = INTERNAL_TRUSTED_PRINCIPAL;
        } else {
            principal = config.principal;
        }
        return new PolicyEnforcedKernel(
            stores,
            { principal },
            {
                dataDir: CLUSTER_DIR,
                policies: config.policies ?? [],
                trustZones: config.trustZones,
                visibilityRules: config.visibilityRules,
            },
        );
    }
    return new ClusterKernel(stores, { dataDir: CLUSTER_DIR });
}

/**
 * Soft self-approval check. Emits a stderr warning when the same identity
 * proposed AND committed (no separation of duties).
 *
 * - When `policies.json` is configured, the policy layer's `approve_command`
 *   gate is the real enforcement point — surface this as a hard reject when
 *   the caller hasn't passed --self-approve.
 * - When no policies are configured (default local single-user mode), the
 *   warning still fires but doesn't block — preserves CLI ergonomics for the
 *   common case while flagging the missing separation of duties.
 */
function checkSelfApproval(
    proposer: string | undefined,
    operator: OperatorContext,
    selfApprove: boolean,
): void {
    if (!proposer) return;
    if (proposer !== operator.actorId) return; // separation of duties achieved
    if (selfApprove) {
        console.error(
            `⚠️  WARNING: --self-approve set. Same identity (${operator.actorId}) proposed and committed. No separation of duties.`,
        );
        return;
    }
    const policyConfigured = existsSync(POLICIES_FILE);
    if (policyConfigured) {
        console.error(
            `Refusing to commit: proposer (${proposer}) is the same as operator (${operator.actorId}). ` +
            `Pass --self-approve to acknowledge, or have a different operator commit this command.`,
        );
        process.exit(1);
    }
    console.error(
        `⚠️  WARNING: proposer (${proposer}) is the same as operator (${operator.actorId}). No separation of duties. ` +
        `Pass --self-approve to silence this warning, or configure .db-cluster/policies.json to enforce.`,
    );
}

function safeJsonParse(input: string, what: string): any {
    try {
        return JSON.parse(input);
    } catch (err: any) {
        console.error(`Invalid JSON for ${what}: ${err.message}`);
        process.exit(1);
    }
}

// ─── §2c CLI uniform try/catch wrapper (Wave B1-Amend) ────────────────────
//
// Every CLI subcommand action MUST be wrapped in `cliCommand(...)` so kernel
// exceptions are caught at the surface boundary instead of escaping to the
// Node unhandled-rejection default. Pre-fix ~20 subcommands (ingest, entity
// create, link, find, propose, receipts, index commands, retrieve,
// explain-retrieval, trace, why, lineage, trace-bundle, doctor, verify,
// rebuild, backup, …) had no top-level try/catch — raw kernel stack traces
// hit stderr and exit codes were incoherent.
//
// Behavior:
//   1. `ClusterError` subclasses → map to a stable exit code via
//      `typedErrorToExitCode(err.code)` + emit `err.message` to stderr.
//   2. Non-`ClusterError` errors → exit 1, emit a path-scrubbed message
//      via `redactErrorForCli(err)`. With `DEBUG=1`, the full stack is
//      printed instead.
//   3. The wrapper does not interfere with successful exits — the action
//      returns normally and commander handles exit.

/**
 * Map a {@link ClusterError} code (or one of the adapter-side typed error
 * codes) to a stable POSIX-style exit code.
 *
 * Codes covered here are the union of:
 *   - kernel errors (NOT_FOUND, POLICY_DENIED, …) — from src/kernel/errors.ts
 *   - adapter-side errors that may surface (CORRUPT_STORE, IMPORT_CONFLICT, …)
 *   - validator errors (INVALID_POLICY_CONFIG, INVALID_REDACTION_RULE)
 *
 * Defaults to 1 for unrecognized codes so the CLI always returns a
 * non-zero exit on uncaught errors.
 */
export function typedErrorToExitCode(code: string): number {
    switch (code) {
        case 'POLICY_DENIED': return 77;          // EX_NOPERM
        case 'NOT_FOUND': return 1;
        case 'PROVENANCE_MISSING': return 1;
        case 'CORRUPT_STORE': return 70;          // EX_SOFTWARE
        case 'COMMAND_QUEUE_CORRUPT': return 70;
        case 'COMMAND_QUEUE_PERSISTENCE_LOST': return 70;
        case 'LEDGER_CYCLE_DETECTED': return 70;
        case 'INVALID_CONTENT_HASH': return 65;   // EX_DATAERR
        case 'CONTENT_HASH_MISMATCH': return 65;
        case 'STAGED_CONTENT_TAMPERED': return 65;
        case 'IMPORT_CONFLICT': return 65;
        case 'INVALID_CONTENT_SHAPE': return 65;
        case 'BUFFER_SIDE_CHANNEL_NOT_SUPPORTED': return 70;
        case 'COMMAND_NOT_VALIDATED': return 1;
        case 'COMMAND_REJECTED': return 1;
        case 'RECEIPT_FAILED': return 70;
        case 'INVALID_REDACTION_RULE': return 78; // EX_CONFIG
        case 'INVALID_POLICY_CONFIG': return 78;
        default: return 1;
    }
}

/**
 * CLI-side error scrubber. Uses the kernel's shared `redactErrorMessage`
 * helper (which the kernel agent shipped to live alongside the other
 * boundary scrubbers) so the CLI and MCP boundaries produce byte-equivalent
 * sanitization. Falls back to a minimal inline scrub if the import is
 * mid-wave.
 *
 * Note: this is intentionally a thin wrapper around `redactErrorMessage`
 * because the absolute-path scrubbing logic must stay in one place — the
 * surface boundary cannot maintain a divergent regex.
 */
function redactErrorForCli(err: unknown): string {
    return redactErrorMessage(err);
}

/**
 * Higher-order function that wraps a CLI `.action(...)` body with uniform
 * error handling. Every subcommand action MUST be wrapped (the structural
 * test in test/wave-b1-surface-regression.test.ts asserts ≥15 sites).
 *
 * Behavior:
 *  - `ClusterError` → mapped exit code + sanitized `err.message` to stderr.
 *  - Non-Cluster `Error` → exit 1 + path-scrubbed message (or full stack
 *    under `DEBUG=1`).
 *  - Sync throws are caught by the surrounding `async` — Promise.reject is
 *    awaited and reaches the catch arm.
 *
 * Returns the wrapped function so callers can write
 * `.action(cliCommand(async (args, opts) => { ... }))`.
 */
export function cliCommand<T extends unknown[]>(
    fn: (...args: T) => Promise<void>,
): (...args: T) => Promise<void> {
    return async (...args: T) => {
        try {
            await fn(...args);
        } catch (err: unknown) {
            if (err instanceof ClusterError) {
                process.stderr.write(err.message + '\n');
                process.exit(typedErrorToExitCode(err.code));
                return;
            }
            if (err instanceof PolicyConfigError) {
                process.stderr.write(err.message + '\n');
                process.exit(typedErrorToExitCode(err.code));
                return;
            }
            if (process.env.DEBUG === '1') {
                // Full stack for trusted operator debug.
                console.error(err);
            } else {
                const message = err instanceof Error
                    ? redactErrorForCli(err)
                    : 'An internal error occurred.';
                process.stderr.write(`Error: ${message}\n`);
            }
            process.exit(1);
        }
    };
}

const program = new Command();

program
    .name('db-cluster')
    .description('AI-native federated database cluster')
    // SURFACE-B-013 (Wave B1-Amend): version read from package.json at
    // module load instead of hardcoded literal.
    .version(PACKAGE_VERSION)
    .option('--actor <id>', 'Operator identity for this invocation (overrides DB_CLUSTER_OPERATOR / OS user)');

/** Pull the resolved --actor option from the root program. */
function rootActor(): string | undefined {
    return program.opts<{ actor?: string }>().actor;
}

// --- init ---
program
    .command('init')
    .description('Initialize a new cluster in the current directory')
    .action(cliCommand(async () => {
        if (existsSync(CLUSTER_DIR)) {
            console.log('Cluster already initialized at .db-cluster/');
            return;
        }
        mkdirSync(CLUSTER_DIR, { recursive: true });
        createLocalCluster(CLUSTER_DIR);
        console.log('Cluster initialized at .db-cluster/');
        console.log('  canonical/  — entities, state');
        console.log('  artifact/   — raw files, evidence');
        console.log('  index/      — discoverability');
        console.log('  ledger/     — provenance, receipts');
    }));

// --- ingest ---
program
    .command('ingest <file>')
    .description('Ingest a source artifact into the cluster')
    .action(cliCommand(async (file: string) => {
        const kernel = getKernel();
        const operator = resolveOperator(rootActor());
        const filePath = resolve(file);
        if (!existsSync(filePath)) {
            console.error(`File not found: ${filePath}`);
            process.exit(1);
        }
        const content = readFileSync(filePath);
        const filename = file.split(/[/\\]/).pop()!;
        const mimeType = guessMime(filename);

        const result = await kernel.ingestArtifact({
            filename,
            content,
            mimeType,
            actorId: operator.actorId,
        });

        console.log(`Ingested: ${filename}`);
        console.log(`  artifact: ${result.artifact.id}`);
        console.log(`  version:  ${result.artifact.version}`);
        console.log(`  hash:     ${result.artifact.contentHash.slice(0, 12)}...`);
        console.log(`  indexed:  ${result.indexRecord.id}`);
        console.log(`  receipt:  ${result.receipt.id}`);
    }));

// --- entity create ---
const entity = program.command('entity').description('Manage canonical entities');

entity
    .command('create')
    .description('Create a canonical entity')
    .requiredOption('--kind <kind>', 'Entity kind/type')
    .requiredOption('--name <name>', 'Entity name')
    .option('--attr <json>', 'Attributes as JSON', '{}')
    .action(cliCommand(async (opts: { kind: string; name: string; attr: string }) => {
        const kernel = getKernel();
        const operator = resolveOperator(rootActor());
        const attributes = safeJsonParse(opts.attr, '--attr');

        const result = await kernel.createEntity({
            kind: opts.kind,
            name: opts.name,
            attributes,
            actorId: operator.actorId,
        });

        console.log(`Created entity: ${opts.kind}/${opts.name}`);
        console.log(`  id:      ${result.entity.id}`);
        console.log(`  indexed: ${result.indexRecord.id}`);
        console.log(`  receipt: ${result.receipt.id}`);
    }));

// --- link ---
program
    .command('link')
    .description('Link an artifact as evidence for an entity')
    .requiredOption('--artifact <id>', 'Artifact ID')
    .requiredOption('--entity <id>', 'Entity ID')
    .action(cliCommand(async (opts: { artifact: string; entity: string }) => {
        const kernel = getKernel();
        const operator = resolveOperator(rootActor());

        const result = await kernel.linkEvidence({
            artifactId: opts.artifact,
            entityId: opts.entity,
            actorId: operator.actorId,
        });

        console.log(`Linked: artifact ${opts.artifact} → entity ${opts.entity}`);
        console.log(`  provenance: ${result.provenance.id}`);
        console.log(`  receipt:    ${result.receipt.id}`);
    }));

// --- find ---
program
    .command('find <query>')
    .description('Find sources through the cluster index')
    .option('--limit <n>', 'Max results', '10')
    .action(cliCommand(async (query: string, opts: { limit: string }) => {
        const kernel = getKernel();

        const result = await kernel.findSources({ query, limit: parseInt(opts.limit) });

        console.log(`Found ${result.indexRecords.length} index record(s) for "${query}":`);
        for (const r of result.indexRecords) {
            console.log(`  [${r.sourceStore}] ${r.sourceId} — ${r.text}`);
        }
        if (result.resolvedEntities.length) {
            console.log(`\nResolved entities:`);
            for (const e of result.resolvedEntities) {
                console.log(`  ${e.kind}/${e.name} (${e.id})`);
            }
        }
        if (result.resolvedArtifacts.length) {
            console.log(`\nResolved artifacts:`);
            for (const a of result.resolvedArtifacts) {
                console.log(`  ${a.filename} v${a.version} (${a.id})`);
            }
        }
    }));

// --- inspect ---
program
    .command('inspect <entity-id>')
    .description('Inspect a canonical entity (returns truth, not index projection)')
    .action(cliCommand(async (entityId: string) => {
        const kernel = getKernel();
        const entity = await kernel.inspectEntity(entityId);
        console.log(`Entity: ${entity.kind}/${entity.name}`);
        console.log(`  id:         ${entity.id}`);
        console.log(`  owner:      ${entity.owner}`);
        console.log(`  created:    ${entity.createdAt}`);
        console.log(`  updated:    ${entity.updatedAt}`);
        console.log(`  attributes: ${JSON.stringify(entity.attributes)}`);
    }));

// --- propose ---
program
    .command('propose <command-json>')
    .description('Propose a mutation (does NOT write to stores)')
    .action(cliCommand(async (commandJson: string) => {
        const kernel = getKernel();
        const operator = resolveOperator(rootActor());
        const { verb, targetStore, payload } = safeJsonParse(commandJson, 'command JSON');

        const command = await kernel.proposeMutation({
            verb,
            targetStore,
            payload,
            proposedBy: operator.actorId,
        });

        console.log(`Proposed command: ${command.id}`);
        console.log(`  verb:   ${command.verb}`);
        console.log(`  target: ${command.targetStore}`);
        console.log(`  status: ${command.status}`);
        console.log(`\nTo commit: db-cluster commit ${command.id}`);
    }));

// --- commit ---
program
    .command('commit <command-id>')
    .description('Commit a proposed mutation through command runtime')
    .option('--self-approve', 'Acknowledge that the operator is also the proposer (no separation of duties)', false)
    .option('--accept-soft-duty-bypass', 'Required alongside --self-approve to actually walk validate→approve→commit with a single actor (KERNEL-R002 soft bypass)', false)
    .action(cliCommand(async (commandId: string, opts: { selfApprove?: boolean; acceptSoftDutyBypass?: boolean }) => {
        const kernel = getKernel();
        const operator = resolveOperator(rootActor());

        // Inspect the command to see who proposed it and its current state.
        // SURFACE-005 self-approve guard fires before any lifecycle write.
        const proposed = await kernel.inspectCommand(commandId).catch(() => null);
        const proposer = proposed?.proposedBy;
        checkSelfApproval(proposer, operator, !!opts.selfApprove);

        // SURFACE-R2-006 fix: when --self-approve causes the CLI to
        // auto-walk validate → approve → commit under a single actor,
        // require an explicit additional acknowledgment flag. This is
        // the same shape as KERNEL-R002 (separation of duties was
        // removed from the SDK auto-walk) but applied at the CLI
        // surface, where the auto-walk still lives for operator
        // ergonomics. Without --accept-soft-duty-bypass, refuse loudly.
        const willAutoWalk = !!opts.selfApprove && proposed !== null && (proposed.status === 'proposed' || proposed.status === 'validated');
        if (willAutoWalk) {
            if (!opts.acceptSoftDutyBypass) {
                console.error(
                    'WARNING: --self-approve walks validate→approve→commit with a single actor, defeating separation of duties. ' +
                    'Pass --accept-soft-duty-bypass to acknowledge.',
                );
                process.exit(1);
            }
            console.error(
                `⚠️  --self-approve + --accept-soft-duty-bypass: walking validate→approve→commit under a single actor (${operator.actorId}). ` +
                'Separation of duties is intentionally bypassed for this invocation.',
            );
        }

        // KERNEL-R002 fix: the CLI now explicitly chains validate → approve →
        // commit. The SDK's commitMutation no longer auto-walks; callers must
        // sequence the lifecycle themselves so separation of duties is visible
        // at every layer above the kernel. The self-approve guard above is
        // the operator-identity check; this section just orders the writes.
        if (proposed && proposed.status === 'proposed') {
            await kernel.validateMutation(commandId);
            await kernel.approveMutation(commandId, operator.actorId);
        } else if (proposed && proposed.status === 'validated') {
            await kernel.approveMutation(commandId, operator.actorId);
        }

        const result = await kernel.commitMutation(commandId, operator.actorId);
        console.log(`Committed: ${result.command.id}`);
        console.log(`  verb:    ${result.command.verb}`);
        console.log(`  status:  ${result.command.status}`);
        console.log(`  result:  ${result.receipt.resultSummary}`);
        console.log(`  receipt: ${result.receipt.id}`);
    }));

// --- validate ---
program
    .command('validate <command-id>')
    .description('Validate a proposed command without committing')
    .action(cliCommand(async (commandId: string) => {
        const kernel = getKernel();
        const cmd = await kernel.validateMutation(commandId);
        console.log(`Validated: ${cmd.id}`);
        console.log(`  verb:   ${cmd.verb}`);
        console.log(`  status: ${cmd.status}`);
        if (cmd.validation) {
            console.log(`  checks:`);
            for (const check of cmd.validation.checks) {
                console.log(`    ${check.passed ? '✓' : '✗'} ${check.name}${check.message ? ': ' + check.message : ''}`);
            }
        }
    }));

// --- approve ---
program
    .command('approve <command-id>')
    .description('Approve a validated command (operator/policy gate)')
    .option('--note <text>', 'Approval note')
    .option('--self-approve', 'Acknowledge that the approver is also the proposer (no separation of duties)', false)
    .action(cliCommand(async (commandId: string, opts: { note?: string; selfApprove?: boolean }) => {
        const kernel = getKernel();
        const operator = resolveOperator(rootActor());
        const proposed = await kernel.inspectCommand(commandId).catch(() => null);
        const proposer = proposed?.proposedBy;
        checkSelfApproval(proposer, operator, !!opts.selfApprove);

        const cmd = await kernel.approveMutation(commandId, operator.actorId, opts.note);
        console.log(`Approved: ${cmd.id}`);
        console.log(`  verb:       ${cmd.verb}`);
        console.log(`  status:     ${cmd.status}`);
        console.log(`  approvedBy: ${cmd.approvedBy}`);
        if (cmd.approvalNote) {
            console.log(`  note:       ${cmd.approvalNote}`);
        }
    }));

// --- reject ---
program
    .command('reject <command-id>')
    .description('Reject a proposed or validated command')
    .requiredOption('--reason <text>', 'Rejection reason')
    .action(cliCommand(async (commandId: string, opts: { reason: string }) => {
        const kernel = getKernel();
        const operator = resolveOperator(rootActor());
        const cmd = await kernel.rejectMutation(commandId, operator.actorId, opts.reason);
        console.log(`Rejected: ${cmd.id}`);
        console.log(`  verb:     ${cmd.verb}`);
        console.log(`  status:   ${cmd.status}`);
        console.log(`  reason:   ${cmd.rejectionReason}`);
    }));

// --- compensate ---
program
    .command('compensate <command-id>')
    .description('Compensate a committed command (correct without erasing)')
    .requiredOption('--reason <text>', 'Compensation reason')
    .action(cliCommand(async (commandId: string, opts: { reason: string }) => {
        const kernel = getKernel();
        const operator = resolveOperator(rootActor());
        const result = await kernel.compensateMutation(commandId, operator.actorId, opts.reason);
        console.log(`Compensated: ${result.originalCommand.id}`);
        console.log(`  original status: ${result.originalCommand.status}`);
        console.log(`  compensating:    ${result.compensatingCommand.id}`);
        console.log(`  receipt:         ${result.receipt.id}`);
        console.log(`  reason:          ${opts.reason}`);
    }));

// --- inspect-command ---
program
    .command('inspect-command <command-id>')
    .description('Inspect a command — full lifecycle state')
    .action(cliCommand(async (commandId: string) => {
        const kernel = getKernel();
        const cmd = await kernel.inspectCommand(commandId);
        console.log(JSON.stringify(cmd, null, 2));
    }));

// --- receipts ---
program
    .command('receipts')
    .description('List all mutation receipts')
    .option('--limit <n>', 'Max results', '20')
    .action(cliCommand(async (opts: { limit: string }) => {
        const kernel = getKernel();

        const receipts = await kernel.listReceipts({ limit: parseInt(opts.limit) });

        if (receipts.length === 0) {
            console.log('No receipts found.');
            return;
        }
        console.log(`Receipts (${receipts.length}):`);
        for (const r of receipts) {
            console.log(`  [${r.committedAt}] ${r.resultSummary}`);
            console.log(`    id:      ${r.id}`);
            console.log(`    command: ${r.commandId}`);
        }
    }));

// --- index ---
const index = program.command('index').description('Manage the cluster index');

index
    .command('rebuild')
    .description('Clear and rebuild the index from owner stores')
    .action(cliCommand(async () => {
        const kernel = getKernel();
        const operator = resolveOperator(rootActor());
        const result = await kernel.rebuildIndex(operator.actorId);
        console.log(`Index rebuilt: ${result.rebuilt} record(s) from owner stores.`);
        console.log(`  provenance: ${result.provenance.id}`);
        console.log(`  receipt:    ${result.receipt.id}`);
    }));

index
    .command('status')
    .description('Show index status and staleness estimate')
    .action(cliCommand(async () => {
        const kernel = getKernel();
        const status = await kernel.indexStatus();
        console.log(`Index status:`);
        console.log(`  total records: ${status.total}`);
        console.log(`  expected:      ${status.expectedTotal}`);
        console.log(`  stale:         ${status.possiblyStale ? 'POSSIBLY STALE' : 'ok'}`);
        console.log(`  by store:`);
        for (const [store, count] of Object.entries(status.byStore)) {
            console.log(`    ${store}: ${count}`);
        }
    }));

index
    .command('explain <record-id>')
    .description('Explain why an index record exists and whether it is stale')
    .action(cliCommand(async (recordId: string) => {
        const kernel = getKernel();
        const explanation = await kernel.explainIndex(recordId);
        console.log(`Index record: ${explanation.indexRecordId}`);
        console.log(`  source:       ${explanation.sourceStore}/${explanation.sourceId}`);
        console.log(`  text:         ${explanation.text}`);
        console.log(`  indexedAt:    ${explanation.indexedAt}`);
        console.log(`  sourceExists: ${explanation.sourceExists}`);
        console.log(`  stale:        ${explanation.stale}`);
        if (explanation.staleCause) {
            console.log(`  staleCause:   ${explanation.staleCause}`);
        }
    }));

index
    .command('stale')
    .description('List index records that do not match source truth')
    .action(cliCommand(async () => {
        const kernel = getKernel();
        const stale = await kernel.listStaleRecords();
        if (stale.length === 0) {
            console.log('No stale index records.');
            return;
        }
        console.log(`Stale records (${stale.length}):`);
        for (const s of stale) {
            console.log(`  ${s.indexRecordId}`);
            console.log(`    source: ${s.sourceStore}/${s.sourceId}`);
            console.log(`    cause:  ${s.cause}`);
        }
    }));

// --- resolve ---
program
    .command('resolve <uri>')
    .description('Resolve a cluster URI to its owner-store object')
    .action(cliCommand(async (uri: string) => {
        if (!existsSync(CLUSTER_DIR)) {
            console.error('No cluster found. Run `db-cluster init` first.');
            process.exit(1);
        }
        // SURFACE-R2-001 fix: route through ClusterSDK so policy + per-store
        // sanitization apply. Previously the CLI built a raw ClusterResolver
        // and JSON.stringified the result — `storagePath` and other internal
        // fields leaked unconditionally. The SDK now sanitizes all five
        // store types when policy-enforced (SURFACE-R2-003), and the CLI
        // additionally scrubs known leaky fields before printing so even the
        // no-policy path is safe.
        const config = loadPolicyConfig();
        const policyConfigured = !!(
            config && (
                (config.policies && config.policies.length > 0) ||
                (config.trustZones && config.trustZones.length > 0) ||
                (config.visibilityRules && config.visibilityRules.length > 0)
            )
        );

        const { ClusterSDK } = await import('./sdk/cluster-sdk.js');
        const { sanitizeArtifactForOutput, sanitizeEntityForOutput, sanitizeReceiptForOutput }
            = await import('./mcp/sanitize.js');
        const { sanitizeIndexRecordForOutput, sanitizeProvenanceEventForOutput }
            = await import('./policy/store-output-sanitizers.js');

        // SURFACE-B-009 (Wave B1-Amend): pre-fix substituted
        // `INTERNAL_TRUSTED_PRINCIPAL` here as well, suppressing the SDK
        // warning. Now pass `config.principal` through unchanged — the
        // SDK's `ClusterSDK` constructor emits the no-principal warning
        // (cluster-sdk.ts:159-162) when policies are configured but no
        // principal was supplied.
        const sdk = policyConfigured
            ? new ClusterSDK({
                clusterDir: CLUSTER_DIR,
                policies: config!.policies,
                trustZones: config!.trustZones,
                visibilityRules: config!.visibilityRules,
                principal: config!.principal,
            })
            : new ClusterSDK({ clusterDir: CLUSTER_DIR });

        const resolved = await sdk.resolve(uri);
        // Belt-and-suspenders: even on the no-policy SDK path the CLI
        // must not print `storagePath` (artifact) or raw ledger payload.
        // SDK.resolve already sanitizes when policy-enforced; this is
        // the unconditional CLI-output baseline.
        // AGG-003 fix-up (Wave A3): cover all 5 store types. The
        // pre-fix CLI baseline-sanitization only covered 3 of 5
        // (artifact + canonical + receipt) and `cluster://index/<id>`
        // / `cluster://ledger/<id>` printed raw IndexRecord.metadata
        // / ProvenanceEvent.actorId+detail to stdout — captured in CI
        // logs / shell history / piped consumers. Now mirrors the
        // SDK's 5-arm coverage (which is unconditional after AGG-002).
        let object: unknown = resolved.object;
        if (resolved.store === 'artifact') {
            object = sanitizeArtifactForOutput(resolved.object as any);
        } else if (resolved.store === 'canonical') {
            object = sanitizeEntityForOutput(resolved.object as any);
        } else if (resolved.store === 'receipt') {
            object = sanitizeReceiptForOutput(resolved.object as any);
        } else if (resolved.store === 'index') {
            object = sanitizeIndexRecordForOutput(resolved.object as any);
        } else if (resolved.store === 'ledger') {
            object = sanitizeProvenanceEventForOutput(resolved.object as any);
        }
        console.log(`Resolved: ${uri}`);
        console.log(`  store: ${resolved.store}`);
        console.log(`  object: ${JSON.stringify(object, null, 2)}`);
    }));

// --- retrieve ---
program
    .command('retrieve <query>')
    .description('Retrieve an evidence bundle (structured cluster retrieval)')
    .option('--limit <n>', 'Max index candidates', '20')
    .action(cliCommand(async (query: string, opts: { limit: string }) => {
        const kernel = getKernel();
        const bundle = await kernel.retrieveBundle(query, { limit: parseInt(opts.limit) });

        console.log(`Evidence Bundle: ${bundle.id}`);
        console.log(`  query:     "${bundle.query}"`);
        console.log(`  assembled: ${bundle.assembledAt}`);
        console.log(`  entities:  ${bundle.resolvedEntities.length}`);
        console.log(`  artifacts: ${bundle.resolvedArtifacts.length}`);
        console.log(`  index:     ${bundle.indexRecords.length} candidates`);
        console.log(`  provenance: ${bundle.provenanceEvents.length} events`);
        console.log(`  fresh:     ${bundle.freshness.allFresh ? 'YES' : 'NO'}`);

        if (bundle.resolvedEntities.length > 0) {
            console.log(`\nResolved entities:`);
            for (const e of bundle.resolvedEntities) {
                const staleTag = e.indexStale ? ' [STALE]' : '';
                console.log(`  ${e.uri} — ${e.object.kind}/${e.object.name}${staleTag}`);
            }
        }
        if (bundle.resolvedArtifacts.length > 0) {
            console.log(`\nResolved artifacts:`);
            for (const a of bundle.resolvedArtifacts) {
                console.log(`  ${a.uri} — ${a.object.filename} v${a.object.version}`);
            }
        }
        if (bundle.missingContext.length > 0) {
            console.log(`\nMissing context:`);
            for (const gap of bundle.missingContext) {
                console.log(`  [${gap.impact}] ${gap.description}`);
            }
        }
        if (bundle.confidenceBoundaries.length > 0) {
            console.log(`\nConfidence boundaries:`);
            for (const b of bundle.confidenceBoundaries) {
                console.log(`  [${b.level}] ${b.claim}`);
            }
        }
    }));

// --- explain-retrieval ---
program
    .command('explain-retrieval <query>')
    .description('Retrieve and explain — shows what was found, missing, and confidence')
    .option('--limit <n>', 'Max index candidates', '20')
    .action(cliCommand(async (query: string, opts: { limit: string }) => {
        const kernel = getKernel();
        const bundle = await kernel.retrieveBundle(query, { limit: parseInt(opts.limit) });
        const explanation = await kernel.explainRetrieval(bundle);

        console.log(explanation.summary);
    }));

// --- trace ---
program
    .command('trace <uri>')
    .description('Trace provenance for any cluster URI — navigable graph')
    .option('--direction <dir>', 'backward | forward | bidirectional', 'backward')
    .option('--depth <n>', 'Max traversal depth', '10')
    .option('--graph', 'Output full graph JSON', false)
    .action(cliCommand(async (uri: string, opts: { direction: string; depth: string; graph: boolean }) => {
        const kernel = getKernel();
        const graph = await kernel.traceObject(uri, {
            direction: opts.direction as 'backward' | 'forward' | 'bidirectional',
            depth: parseInt(opts.depth),
        });

        if (opts.graph) {
            console.log(JSON.stringify(graph, null, 2));
        } else {
            console.log(kernel.explainTrace(graph));
        }
    }));

// --- why ---
program
    .command('why <uri>')
    .description('Why does this object exist? Compact provenance explanation.')
    .action(cliCommand(async (uri: string) => {
        const kernel = getKernel();
        const explanation = await kernel.why(uri);
        console.log(explanation);
    }));

// --- lineage ---
program
    .command('lineage <uri>')
    .description('Full lineage — bidirectional trace with all edges')
    .option('--depth <n>', 'Max traversal depth', '10')
    .action(cliCommand(async (uri: string, opts: { depth: string }) => {
        const kernel = getKernel();
        const graph = await kernel.traceObject(uri, {
            direction: 'bidirectional',
            depth: parseInt(opts.depth),
            includeIndex: true,
            includeReceipts: true,
            includeGaps: true,
        });
        console.log(kernel.explainTrace(graph));
    }));

// --- trace-bundle ---
program
    .command('trace-bundle <query>')
    .description('Retrieve a bundle and trace its full provenance graph')
    .option('--limit <n>', 'Max index candidates', '20')
    .option('--direction <dir>', 'backward | forward | bidirectional', 'backward')
    .option('--graph', 'Output full graph JSON', false)
    .action(cliCommand(async (query: string, opts: { limit: string; direction: string; graph: boolean }) => {
        const kernel = getKernel();
        const bundle = await kernel.retrieveBundle(query, { limit: parseInt(opts.limit) });
        const graph = await kernel.traceBundle(bundle, {
            direction: opts.direction as 'backward' | 'forward' | 'bidirectional',
        });

        if (opts.graph) {
            console.log(JSON.stringify(graph, null, 2));
        } else {
            console.log(kernel.explainTrace(graph));
        }
    }));

// --- policy ---
const policy = program.command('policy').description('Policy explain and test surface');

/**
 * Resolve the policy engine inputs for the policy explain/test dry-run
 * subcommands.
 *
 * SURFACE-B-002 fix (Wave A4): pre-fix, these subcommands hardcoded
 * `{policies: DEFAULT_POLICIES, trustZones: DEFAULT_TRUST_ZONES}` regardless
 * of whether `.db-cluster/policies.json` existed. Operators dry-ran policies
 * that had no relationship to what the cluster actually enforced. The fix
 * routes through `loadPolicyConfig()` (the same helper `getKernel()` uses)
 * so the explain/test surface evaluates against the SAME ruleset that
 * `getKernel()` would wire into a real `PolicyEnforcedKernel`. When no
 * policies.json is present we still fall back to DEFAULT_POLICIES (so the
 * subcommand remains usable on a fresh cluster), but emit an explicit
 * stderr notice so the operator knows what they're seeing.
 */
function resolvePolicyDryRunInputs(): { policies: Policy[]; trustZones: TrustZone[]; visibilityRules: VisibilityRule[] } {
    const config = loadPolicyConfig();
    if (config === null) {
        // No .db-cluster/policies.json — fall back to defaults but signal.
        console.error('Notice: no .db-cluster/policies.json found; evaluating against default policy set.');
        return {
            policies: DEFAULT_POLICIES,
            trustZones: DEFAULT_TRUST_ZONES,
            visibilityRules: DEFAULT_VISIBILITY_RULES,
        };
    }
    return {
        policies: config.policies ?? [],
        trustZones: config.trustZones ?? DEFAULT_TRUST_ZONES,
        visibilityRules: config.visibilityRules ?? DEFAULT_VISIBILITY_RULES,
    };
}

policy
    .command('explain')
    .description('Explain what the policy engine would decide for a given action (dry-run)')
    .requiredOption('--principal <id>', 'Principal ID')
    .requiredOption('--capability <cap>', 'Capability to check')
    .option('--roles <roles>', 'Comma-separated roles', '')
    .option('--trust-zone <zone>', 'Trust zone', 'internal')
    .option('--uri <uri>', 'Resource URI')
    .option('--store <store>', 'Owner store')
    .option('--kind <kind>', 'Entity kind')
    .option('--verb <verb>', 'Command verb')
    .action(cliCommand(async (opts) => {
        const principal: Principal = {
            id: opts.principal,
            name: opts.principal,
            roles: opts.roles ? opts.roles.split(',') : [],
            trustZone: opts.trustZone,
        };

        const { policies, trustZones, visibilityRules } = resolvePolicyDryRunInputs();

        const decision = evaluatePolicy({
            principal,
            capability: opts.capability as Capability,
            resourceUri: opts.uri,
            ownerStore: opts.store,
            entityKind: opts.kind,
            commandVerb: opts.verb,
            trustZone: opts.trustZone,
        }, { policies, trustZones });

        const explanation = explainPolicyDecision(decision);
        console.log(explanation);

        if (decision.decision === 'deny' && opts.uri) {
            const vis = checkVisibility(opts.uri, opts.store, visibilityRules);
            console.log(`\nVisibility: existence ${vis.existenceVisible ? 'VISIBLE' : 'HIDDEN'}${vis.emitPlaceholder ? ' (placeholder emitted)' : ''}`);
        }
    }));

policy
    .command('test')
    .description('Test a policy scenario — evaluate multiple capabilities for a principal')
    .requiredOption('--principal <id>', 'Principal ID')
    .requiredOption('--capabilities <caps>', 'Comma-separated capabilities to test')
    .option('--roles <roles>', 'Comma-separated roles', '')
    .option('--trust-zone <zone>', 'Trust zone', 'internal')
    .option('--store <store>', 'Owner store')
    .option('--uri <uri>', 'Resource URI')
    .action(cliCommand(async (opts) => {
        const principal: Principal = {
            id: opts.principal,
            name: opts.principal,
            roles: opts.roles ? opts.roles.split(',') : [],
            trustZone: opts.trustZone,
        };

        const { policies, trustZones } = resolvePolicyDryRunInputs();

        const capabilities = opts.capabilities.split(',') as Capability[];
        const results = capabilities.map((capability) => {
            const decision = evaluatePolicy({
                principal,
                capability,
                resourceUri: opts.uri,
                ownerStore: opts.store,
                trustZone: opts.trustZone,
            }, { policies, trustZones });
            return { capability, decision: decision.decision, reason: decision.reason, policyId: decision.matchedPolicyId };
        });

        const allowed = results.filter((r) => r.decision === 'allow').length;
        const denied = results.filter((r) => r.decision === 'deny').length;

        console.log(`Policy test for ${principal.id} [${principal.roles.join(', ')}] in zone ${opts.trustZone}:`);
        console.log('');
        for (const r of results) {
            const icon = r.decision === 'allow' ? '✓' : '✗';
            console.log(`  ${icon} ${r.capability}: ${r.decision.toUpperCase()} — ${r.reason} (${r.policyId})`);
        }
        console.log('');
        console.log(`Summary: ${allowed} allowed, ${denied} denied out of ${results.length} actions.`);
    }));

// --- stores ---
const stores = program.command('stores').description('Manage store backends');

stores
    .command('verify')
    .description('Verify store backend configuration and connectivity')
    .action(cliCommand(async () => {
        const canonicalBackend = process.env.DB_CLUSTER_CANONICAL_BACKEND ?? 'local';
        const postgresUrl = process.env.DB_CLUSTER_POSTGRES_URL;

        console.log('Store Backend Configuration');
        console.log('═══════════════════════════════════════');
        console.log(`  canonical: ${canonicalBackend}`);
        console.log(`  artifact:  local`);
        console.log(`  index:     local`);
        console.log(`  ledger:    local`);
        console.log('');

        // Canonical backend check
        if (canonicalBackend === 'postgres') {
            if (!postgresUrl) {
                console.error('✗ DB_CLUSTER_POSTGRES_URL not set');
                process.exit(1);
            }
            try {
                const { Pool } = await import('pg');
                const pool = new Pool({ connectionString: postgresUrl });
                const result = await pool.query('SELECT 1 AS ok');
                if (result.rows[0].ok === 1) {
                    console.log('  ✓ Postgres connection: OK');
                }
                // Check migrations
                const tableCheck = await pool.query(
                    `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'canonical_entities') AS exists`,
                );
                if (tableCheck.rows[0].exists) {
                    console.log('  ✓ Migrations: canonical_entities table exists');
                } else {
                    console.log('  ✗ Migrations: canonical_entities table NOT found');
                    console.log('    Run: db-cluster stores migrate');
                }
                await pool.end();
            } catch (err: any) {
                console.error(`  ✗ Postgres connection failed: ${err.message}`);
                process.exit(1);
            }
        } else {
            const clusterExists = existsSync(CLUSTER_DIR);
            if (clusterExists) {
                console.log('  ✓ Local cluster directory exists');
            } else {
                console.log('  ✗ No cluster initialized. Run: db-cluster init');
            }
        }

        console.log('');
        console.log('Contract compatibility: all backends implement CanonicalStore interface');
    }));

stores
    .command('migrate')
    .description('Run pending store migrations')
    .action(cliCommand(async () => {
        const canonicalBackend = process.env.DB_CLUSTER_CANONICAL_BACKEND ?? 'local';
        const postgresUrl = process.env.DB_CLUSTER_POSTGRES_URL;

        if (canonicalBackend !== 'postgres') {
            console.log('No migrations needed for local backend.');
            return;
        }

        if (!postgresUrl) {
            console.error('DB_CLUSTER_POSTGRES_URL not set.');
            process.exit(1);
        }

        const { Pool } = await import('pg');
        const { PostgresCanonicalStore } = await import('./adapters/postgres/postgres-canonical-store.js');
        const pool = new Pool({ connectionString: postgresUrl });
        const store = new PostgresCanonicalStore(pool);
        await store.migrate();
        console.log('✓ Migrations applied: canonical_entities table ready');
        await pool.end();
    }));

stores
    .command('list')
    .description('List configured store backends')
    .action(cliCommand(async () => {
        const canonicalBackend = process.env.DB_CLUSTER_CANONICAL_BACKEND ?? 'local';
        console.log('Backend     Store');
        console.log('─────────── ──────────');
        console.log(`${canonicalBackend.padEnd(12)}canonical`);
        console.log(`local       artifact`);
        console.log(`local       index`);
        console.log(`local       ledger`);
    }));

// --- Operations commands ---

program
    .command('doctor')
    .description('Run full cluster health assessment')
    .option('--json', 'Output as JSON')
    .action(cliCommand(async (opts) => {
        const stores = createLocalCluster(CLUSTER_DIR);
        const { doctor } = await import('./ops/doctor.js');
        // AGG-B1-6 (Wave B1-Amend fix-up): thread `dataDir` + `commandQueue`
        // so the `no_orphan_staging` check actually runs. Pre-fix `doctor(
        // stores)` silently skipped the check at every operator-facing
        // surface — the staging gate was effectively dead at the CLI.
        const { CommandQueue } = await import('./kernel/command-queue.js');
        const commandQueue = new CommandQueue(CLUSTER_DIR);
        const health = await doctor(stores, {
            dataDir: CLUSTER_DIR,
            commandQueue,
        });
        if (opts.json) {
            console.log(JSON.stringify(health, null, 2));
        } else {
            console.log(`Cluster: ${health.status}`);
            console.log(`Checks: ${health.summary.total} total, ${health.summary.healthy} healthy, ${health.summary.errors} errors, ${health.summary.warnings} warnings`);
            for (const check of health.checks) {
                const icon = check.status === 'healthy' ? '✓' : check.severity === 'error' ? '✗' : '!';
                console.log(`  ${icon} [${check.store}] ${check.name}: ${check.message}`);
                if (check.suggestedCommand) {
                    console.log(`    → fix: ${check.suggestedCommand}`);
                }
            }
        }
    }));

program
    .command('verify')
    .description('Verify cluster invariants (data consistency)')
    .option('--json', 'Output as JSON')
    .option('--sample <n>', 'Max records to sample per store', '100')
    .action(cliCommand(async (opts) => {
        const stores = createLocalCluster(CLUSTER_DIR);
        const { verify } = await import('./ops/verify.js');
        const health = await verify(stores, { sampleLimit: parseInt(opts.sample, 10) });
        if (opts.json) {
            console.log(JSON.stringify(health, null, 2));
        } else {
            console.log(`Verification: ${health.status}`);
            for (const check of health.checks) {
                const icon = check.status === 'healthy' ? '✓' : check.severity === 'error' ? '✗' : '!';
                console.log(`  ${icon} ${check.name}: ${check.message}`);
            }
        }
    }));

const rebuild = program
    .command('rebuild')
    .description('Rebuild derivative state from owner truth');

rebuild
    .command('index')
    .description('Rebuild the index from canonical + artifact stores')
    .option('--dry-run', 'Show what would be rebuilt without mutating')
    .option('--json', 'Output as JSON')
    .action(cliCommand(async (opts) => {
        const stores = createLocalCluster(CLUSTER_DIR);
        const { rebuildIndex } = await import('./ops/rebuild.js');
        const result = await rebuildIndex(stores, { dryRun: opts.dryRun });
        if (opts.json) {
            console.log(JSON.stringify(result, null, 2));
        } else {
            console.log(`Rebuilt: ${result.rebuilt} records${result.dryRun ? ' (dry run)' : ''}`);
            if (result.errors.length > 0) {
                console.log(`Errors: ${result.errors.length}`);
                for (const e of result.errors) console.log(`  ${e}`);
            }
        }
    }));

rebuild
    .command('check')
    .description('Check for stale or orphan index records')
    .option('--json', 'Output as JSON')
    .action(cliCommand(async (opts) => {
        const stores = createLocalCluster(CLUSTER_DIR);
        const { checkStale } = await import('./ops/rebuild.js');
        const stale = await checkStale(stores);
        if (opts.json) {
            console.log(JSON.stringify(stale, null, 2));
        } else {
            if (stale.length === 0) {
                console.log('No stale records found.');
            } else {
                console.log(`Found ${stale.length} stale record(s):`);
                for (const s of stale) {
                    console.log(`  [${s.type}] ${s.sourceStore}/${s.sourceId}: ${s.message}`);
                }
            }
        }
    }));

program
    .command('backup')
    .description('Export cluster state to JSON backup')
    .option('-o, --output <file>', 'Output file path')
    .option('--json', 'Write to stdout as JSON')
    .action(cliCommand(async (opts) => {
        const stores = createLocalCluster(CLUSTER_DIR);
        const { backup } = await import('./ops/backup.js');
        const data = await backup(stores);
        const json = JSON.stringify(data, null, 2);
        if (opts.output) {
            const { writeFileSync } = await import('node:fs');
            writeFileSync(resolve(opts.output), json, 'utf-8');
            console.log(`Backup written to ${opts.output}`);
        } else {
            console.log(json);
        }
    }));

program
    .command('restore <file>')
    .description('Restore cluster state from a backup file')
    .option('--json', 'Output as JSON')
    .action(cliCommand(async (file: string, opts: { json?: boolean }) => {
        const stores = createLocalCluster(CLUSTER_DIR);
        const { restore } = await import('./ops/backup.js');
        const raw = readFileSync(resolve(file), 'utf-8');
        const data = safeJsonParse(raw, 'backup file');
        const result = await restore(stores, data);
        if (opts.json) {
            console.log(JSON.stringify(result, null, 2));
        } else {
            console.log(`Entities: ${result.entities.created} created, ${result.entities.skipped} skipped`);
            console.log(`Events: ${result.events.created} created, ${result.events.skipped} skipped`);
            console.log(`Receipts: ${result.receipts.created} created, ${result.receipts.skipped} skipped`);
        }
    }));

program
    .command('migration-status')
    .description('Check Postgres schema migration state')
    .option('--json', 'Output as JSON')
    .action(cliCommand(async (opts) => {
        const url = process.env.DB_CLUSTER_POSTGRES_URL;
        if (!url) {
            console.error('DB_CLUSTER_POSTGRES_URL not set.');
            process.exit(1);
        }
        const pg = await import('pg');
        const pool = new pg.default.Pool({ connectionString: url });
        try {
            const { checkMigrationStatus } = await import('./ops/migrations.js');
            const status = await checkMigrationStatus(pool);
            if (opts.json) {
                console.log(JSON.stringify(status, null, 2));
            } else {
                console.log(`Backend: ${status.backend}`);
                console.log(`Migrated: ${status.migrated}`);
                console.log(`Tables: ${status.tables.join(', ') || '(none)'}`);
                console.log(status.message);
            }
        } finally {
            await pool.end();
        }
    }));

program
    .command('verify-schema')
    .description('Validate physical backend schema structure')
    .option('--json', 'Output as JSON')
    .action(cliCommand(async (opts) => {
        const url = process.env.DB_CLUSTER_POSTGRES_URL;
        if (!url) {
            console.error('DB_CLUSTER_POSTGRES_URL not set.');
            process.exit(1);
        }
        const pg = await import('pg');
        const pool = new pg.default.Pool({ connectionString: url });
        try {
            const { verifySchema } = await import('./ops/migrations.js');
            const result = await verifySchema(pool);
            if (opts.json) {
                console.log(JSON.stringify(result, null, 2));
            } else {
                console.log(`Schema valid: ${result.valid}`);
                if (result.issues.length > 0) {
                    for (const issue of result.issues) console.log(`  ✗ ${issue}`);
                }
            }
        } finally {
            await pool.end();
        }
    }));

program.parse();

function guessMime(filename: string): string {
    const ext = filename.split('.').pop()?.toLowerCase();
    switch (ext) {
        case 'md': return 'text/markdown';
        case 'txt': return 'text/plain';
        case 'json': return 'application/json';
        case 'pdf': return 'application/pdf';
        case 'html': return 'text/html';
        case 'ts': case 'js': return 'text/javascript';
        default: return 'application/octet-stream';
    }
}
