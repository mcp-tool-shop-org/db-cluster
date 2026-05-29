#!/usr/bin/env node
/**
 * db-cluster CLI surface.
 *
 * ─── Exit code mapping (SURFACE-C-008 / CIDOCS-C-003 — Wave C1-Amend) ───
 *
 * | Exit | Sysexits name  | Meaning                                       |
 * |------|----------------|-----------------------------------------------|
 * |   0  | EX_OK          | success                                       |
 * |   1  | (general)      | unrecognized error; NOT_FOUND;                |
 * |      |                | PROVENANCE_MISSING; COMMAND_NOT_VALIDATED;    |
 * |      |                | COMMAND_REJECTED; usage errors                |
 * |  65  | EX_DATAERR     | CONTENT_HASH_MISMATCH;                        |
 * |      |                | INVALID_CONTENT_HASH; STAGED_CONTENT_TAMPERED;|
 * |      |                | IMPORT_CONFLICT; INVALID_CONTENT_SHAPE        |
 * |  70  | EX_SOFTWARE    | CORRUPT_STORE; COMMAND_QUEUE_CORRUPT;         |
 * |      |                | COMMAND_QUEUE_PERSISTENCE_LOST;               |
 * |      |                | LEDGER_CYCLE_DETECTED; RECEIPT_FAILED;        |
 * |      |                | BUFFER_SIDE_CHANNEL_NOT_SUPPORTED             |
 * |  77  | EX_NOPERM      | POLICY_DENIED                                 |
 * |  78  | EX_CONFIG      | INVALID_POLICY_CONFIG;                        |
 * |      |                | INVALID_REDACTION_RULE                        |
 *
 * Run `db-cluster --help-exit-codes` to print the current table. CI
 * scripts should branch on these codes — they are stable across versions.
 * The full canonical version with operator-readable prose lives in
 * docs/cli.md (CI/Docs agent maintains that file).
 */
import { Command } from 'commander';
import { dirname, resolve, join, sep } from 'node:path';
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
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
// Wave C1-Amend fix-up (Cluster A — V1-C1-007 + V3-C1-001 + V3-C1-013):
// canonical user-facing error formatter exported at §2b. The CLI catch arm
// now reads through formatForUser so subclass-supplied remediationHint is
// the single source of truth — no parallel CLI-side remediation map.
import { formatForUser } from './policy/error-formatter.js';
import { setCliColorEnabled, cliColor, colorizeFormattedError } from './cli/color-output.js';
import type { Principal, Capability, Policy, TrustZone, VisibilityRule } from './types/policy.js';

// SURFACE-C-011 (Wave C1-Amend): cluster-dir resolution now mirrors the
// MCP surface (server.ts uses `DB_CLUSTER_DIR`). Precedence:
//   1. process.env.DB_CLUSTER_DIR (explicit override; symmetry with MCP)
//   2. `.db-cluster/config.json` under cwd → field "clusterDir" (optional,
//      lets operators pin a non-standard directory per-project)
//   3. cwd/.db-cluster (the original default)
//
// We resolve once at module load; CLI commands read CLUSTER_DIR directly.
//
// EGRESS-002 (Wave S2-A2 — Fix Agent 2): the `config.json`-sourced
// `clusterDir` is a PLANT-ABLE input — an attacker can drop a malicious
// `.db-cluster/config.json` in a directory a victim later runs from, and
// (pre-fix) redirect the cluster root anywhere on disk (absolute path or
// `../` traversal). This was asymmetric with the rigorously-sandboxed MCP
// `DB_CLUSTER_POLICIES_FILE` path. We now contain the config.json-sourced
// path to cwd via realpath + prefix check; an out-of-cwd value falls back
// to the in-cwd default rather than silently redirecting the root.
//
// The explicit `DB_CLUSTER_DIR` ENV override is left unconstrained on
// purpose: it is a documented operator escape hatch (an operator typing an
// env var is stating intent), unlike a config file that travels with a
// checked-out repo / unpacked archive.
//
// Injectable `cwd`/`env` params (defaulting to the live `process.*`) keep
// the function unit-testable without a `dist` rebuild — the module-load
// call below passes nothing and behaves exactly as before.
export function resolveClusterDir(
    cwd: string = process.cwd(),
    env: NodeJS.ProcessEnv = process.env,
): string {
    const fromEnv = env.DB_CLUSTER_DIR;
    if (fromEnv && fromEnv.trim() !== '') {
        // Operator-intentional override — not contained (documented escape hatch).
        return resolve(fromEnv);
    }
    const configCandidate = resolve(cwd, '.db-cluster', 'config.json');
    if (existsSync(configCandidate)) {
        try {
            const cfg = JSON.parse(readFileSync(configCandidate, 'utf-8')) as { clusterDir?: string };
            if (typeof cfg.clusterDir === 'string' && cfg.clusterDir.trim() !== '') {
                const candidate = resolve(cwd, cfg.clusterDir);
                if (isContainedInCwd(candidate, cwd)) {
                    return candidate;
                }
                // EGRESS-002: a config.json that points the cluster root
                // OUTSIDE cwd is rejected (treated as if absent). We fall
                // through to the in-cwd default rather than honoring a
                // plant-able redirect. Warn so an operator who set this
                // intentionally sees why it was ignored (use DB_CLUSTER_DIR
                // for an intentional out-of-cwd root).
                //
                // Direct stderr write — NOT the cliWarn helper: this runs at
                // module-load time (the `const CLUSTER_DIR = resolveClusterDir()`
                // initializer), which is BEFORE cliWarn's LOG_LEVEL_RANK /
                // cliLogLevel module bindings are initialized. Routing through
                // cliWarn here would hit the temporal-dead-zone ReferenceError.
                process.stderr.write(
                    'Warning: ignoring .db-cluster/config.json `clusterDir` — it resolves ' +
                        'outside the current directory. Use the DB_CLUSTER_DIR environment ' +
                        'variable for an intentional out-of-tree cluster root.\n',
                );
            }
        } catch {
            // Malformed config → fall through to default. We don't fail
            // closed here because the config file is optional; the
            // policy file already has the structural validator
            // (loadPolicyConfig) for the fail-closed shape.
        }
    }
    return resolve(cwd, '.db-cluster');
}

/**
 * EGRESS-002 containment check: is `candidate` inside (or equal to) `cwd`?
 *
 * Uses `realpathSync` on the longest existing ancestor of each path so a
 * symlinked cwd / symlinked candidate cannot smuggle the resolved root
 * outside the real cwd (the classic `realpath` containment bypass). The
 * candidate dir often does not exist yet (first run), so we realpath the
 * nearest existing ancestor and re-append the unresolved tail.
 */
function isContainedInCwd(candidate: string, cwd: string): boolean {
    const realCwd = realpathExisting(cwd);
    const realCandidate = realpathExisting(candidate);
    if (realCandidate === realCwd) return true;
    // Append a separator so `/a/b` is not treated as containing `/a/bc`.
    const prefix = realCwd.endsWith(sep) ? realCwd : realCwd + sep;
    return realCandidate.startsWith(prefix);
}

/**
 * `realpathSync` the longest existing prefix of `p`, then re-append the
 * non-existent tail. Pure path normalization fallback when nothing on the
 * path exists yet.
 */
function realpathExisting(p: string): string {
    let cur = resolve(p);
    const tail: string[] = [];
    // Walk up until we hit an existing directory (or the filesystem root).
    while (!existsSync(cur)) {
        const parent = dirname(cur);
        if (parent === cur) break; // reached root; nothing existed
        tail.unshift(cur.slice(parent.length + 1));
        cur = parent;
    }
    let real: string;
    try {
        real = realpathSync(cur);
    } catch {
        real = cur;
    }
    return tail.length > 0 ? join(real, ...tail) : real;
}
const CLUSTER_DIR = resolveClusterDir();
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
        // SURFACE-C-021 (Wave C1-Amend): pre-fix echoed V8's
        // "Unexpected token } at position 42" without context. Operators
        // counting characters into a multi-line CLI argument struggled.
        // Post-fix:
        //   - Echo a window of the input around the error position
        //   - Show a caret pointing at the bad character (à la jq)
        //   - Surface a sample of valid JSON shape per `what`
        //   - Keep V8's original message at the top for completeness
        process.stderr.write(`Invalid JSON for ${what}: ${err.message}\n`);

        const pos = locateJsonErrorPosition(input, err.message);
        if (pos !== null && Number.isFinite(pos) && pos >= 0 && pos <= input.length) {
            // Show 40 chars of context on each side of the failing position.
            const winStart = Math.max(0, pos - 40);
            const winEnd = Math.min(input.length, pos + 40);
            const snippet = input.slice(winStart, winEnd).replace(/\n/g, ' ');
            const caretCol = pos - winStart;
            process.stderr.write(`  Input near position ${pos}:\n`);
            process.stderr.write(`    ${snippet}\n`);
            process.stderr.write(`    ${' '.repeat(Math.max(0, caretCol))}^\n`);
        } else if (input.length <= 200) {
            // Short input — show the whole thing.
            process.stderr.write(`  Input: ${input}\n`);
        }

        process.stderr.write(`  Expected shape for ${what}: ${jsonShapeHintFor(what)}\n`);
        process.stderr.write(`  → try: validate the JSON with \`jq . <<<'<your input>'\` then re-run.\n`);
        process.exit(1);
    }
}

/**
 * Locate the byte position of a JSON.parse failure in `input`.
 *
 * V8 has emitted at least two message formats:
 *   - Older: "Unexpected token } in JSON at position 42"
 *   - Newer (Node 20+): "Unexpected token '}', ...\"getStore\":}\" is not valid JSON"
 *
 * For the older format we extract the numeric position directly.
 * For the newer format we look for the quoted snippet ("…getStore":}…)
 * inside the input and return that position; if neither pattern
 * matches we fall back to searching for the named token.
 *
 * Returns null when we can't localize — the caller falls back to
 * echoing the whole input (when short).
 */
function locateJsonErrorPosition(input: string, message: string): number | null {
    // 1) Older "at position N" format.
    const posMatch = /position\s+(\d+)/i.exec(message);
    if (posMatch) {
        const n = Number(posMatch[1]);
        if (Number.isFinite(n)) return n;
    }
    // 2) Newer format embeds a quoted snippet like `..."getStore":}"`.
    // Find that snippet (with surrounding `...`) and locate it in input.
    const snippetMatch = /"\.\.\.(?:\\"|[^"])*?"|"((?:\\"|[^"])*?)"\s+is not valid JSON/i.exec(message);
    if (snippetMatch) {
        const raw = snippetMatch[0].replace(/^"\.\.\./, '').replace(/"$/, '');
        const stripped = raw.replace(/\\"/g, '"');
        const idx = input.indexOf(stripped);
        if (idx >= 0) {
            // Point at the END of the snippet — that's where the parse
            // failure is (the next unexpected character).
            return idx + stripped.length;
        }
    }
    // 3) Fallback: search for the named token in the message ("Unexpected
    // token '}'") and locate the LAST occurrence in the input.
    const tokenMatch = /Unexpected token ['"]?(.)/i.exec(message);
    if (tokenMatch) {
        const token = tokenMatch[1];
        const idx = input.lastIndexOf(token);
        if (idx >= 0) return idx;
    }
    return null;
}

/**
 * Per-`what` shape hint surfaced when JSON parsing fails. Mirrors what
 * the command actually expects. When `what` is unknown, a generic
 * sample is returned.
 */
function jsonShapeHintFor(what: string): string {
    if (/command/i.test(what)) {
        return '{"verb":"create_entity","targetStore":"canonical","payload":{"kind":"...","name":"...","attributes":{...}}}';
    }
    if (/attr/i.test(what)) {
        return '{"key":"value"}';
    }
    if (/backup/i.test(what)) {
        return '{"entities":[...],"events":[...],"receipts":[...],"artifacts":[...]}';
    }
    return 'valid JSON object/array conforming to the command schema';
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
 * SURFACE-C-015 note (Wave C1-Amend): the LIST of codes appears in three
 * places — here, `BUILTIN_ERROR_CODES` / `TYPED_ERROR_ENRICHMENT` in
 * mcp/sanitize.ts, and the kernel error subclasses themselves. This is
 * intentional: each surface needs to MAP the code to its own concern
 * (exit code, AI envelope, kernel taxonomy). When `ClusterErrorCode`
 * union ships from the Kernel agent, these maps can reference the union
 * for compile-time exhaustiveness without merging the maps themselves.
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
        // Wave C1-Amend fix-up (V3-C1-015 + V1-C1-001 + V1-C1-002):
        // close the 9-code arm gap so adapter + lifecycle typed errors
        // surface their proper sysexits code instead of collapsing to 1.
        case 'BACKUP_TARGET_EXISTS': return 73;   // EX_CANTCREAT
        case 'INVALID_CLUSTER_URI': return 65;
        case 'INVALID_ROTATE_TIMESTAMP': return 78;
        case 'ROTATE_BOUNDARY_IN_FUTURE': return 78;
        case 'IMPORT_SNAPSHOT_NOT_SUPPORTED': return 65;
        case 'RESOLVE_NOT_FOUND': return 1;
        case 'COMMAND_NOT_FOUND': return 1;
        case 'COMMAND_ALREADY_TERMINAL': return 1;
        case 'INVALID_STATE_TRANSITION': return 1;
        case 'COMMAND_VALIDATION_FAILED': return 65;
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
 * REDACT-003 (Wave S2-A2 — Fix Agent 2): render a {@link ClusterError} to
 * the canonical CLI two-line prose, with the HEADLINE path-scrubbed.
 *
 * `formatForUser(err)` produces `${err.message}\n  → try: ${remediationHint}`
 * but does NOT scrub `err.message`. For the path-bearing subclasses
 * (StagedContentTamperedError, CommandQueueCorruptError,
 * CommandQueuePersistenceLostError) that message embeds an absolute
 * `stagingPath` / `filePath` / `markerPath` (see src/kernel/errors.ts) —
 * which then leaked verbatim to stderr.
 *
 * We scrub the headline through the SAME boundary scrubber the sibling
 * adapter-error arm uses ({@link redactErrorForCli} → `redactErrorMessage`),
 * then re-attach the remediation hint UNCHANGED. The hint is a static
 * subclass literal (no dynamic path; verified across every subclass), so
 * it needs no scrub and stays fully actionable — preserving both halves of
 * the contract: the error still renders usefully AND the path is gone.
 *
 * The output shape (`<scrubbed headline>\n  → try: <hint>`) is byte-for-byte
 * what {@link colorizeFormattedError} expects, so the caller composes them
 * exactly as before. We keep {@link formatForUser} as the single source of
 * the two-line structure (the C1-Amend contract) and scrub ONLY the headline
 * segment — the `→ try:` hint is left verbatim.
 *
 * Exported so the regression suite can assert the scrub behavior directly
 * (the `cliCommand` catch arm itself calls `process.exit`, so it is not
 * unit-callable).
 */
export function renderClusterErrorForCli(err: ClusterError): string {
    const formatted = formatForUser(err);
    const sep = '\n  → try: ';
    const idx = formatted.indexOf(sep);
    if (idx === -1) {
        // No hint segment (shouldn't happen for a ClusterError, which always
        // carries a remediationHint) — scrub the whole thing defensively.
        return redactErrorForCli(formatted);
    }
    const headline = redactErrorForCli(formatted.slice(0, idx));
    const hintSegment = formatted.slice(idx); // includes the leading separator
    return `${headline}${hintSegment}`;
}

/**
 * Higher-order function that wraps a CLI `.action(...)` body with uniform
 * error handling. Every subcommand action MUST be wrapped (the structural
 * test in test/wave-b1-surface-regression.test.ts asserts ≥15 sites).
 *
 * Behavior:
 *  - `ClusterError` → mapped exit code + sanitized `err.message` to stderr.
 *    On Wave C1-Amend, the error message is also followed by a
 *    `→ try: ${remediation_hint}` line when one is available (SURFACE-C-005)
 *    so operators see what command to run next.
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
                // Cluster A (Wave C1-Amend fix-up): formatForUser is the
                // canonical CLI/MCP/SDK/dashboard rendering helper. It
                // reads err.message + err.remediationHint directly from
                // the subclass — no parallel `remediationForCode` table.
                // Phase 10 §3b: colorize the headline red, the → try hint dim italic.
                //
                // REDACT-003 (Wave S2-A2): the headline is path-scrubbed via
                // renderClusterErrorForCli — path-bearing subclasses
                // (StagedContentTamperedError, CommandQueueCorruptError,
                // CommandQueuePersistenceLostError) embed an absolute
                // stagingPath/filePath/markerPath in err.message. This uses
                // the SAME scrubber the sibling adapter-error arm below
                // applies (redactErrorForCli), so both Cluster catch arms
                // sanitize consistently.
                process.stderr.write(colorizeFormattedError(renderClusterErrorForCli(err)) + '\n');
                process.exit(typedErrorToExitCode(err.code));
                return;
            }
            if (err instanceof PolicyConfigError) {
                // REDACT-003 sibling (Wave S2-A2 fix-up): PolicyConfigError's
                // message embeds the `POLICIES_FILE` ABSOLUTE path (e.g.
                // "...policies file <abs path>: ..."). The adjacent ClusterError
                // and adapter-error arms scrub via renderClusterErrorForCli /
                // redactErrorForCli; this arm printed raw. Route it through the
                // SAME scrubber for parity so no absolute path leaks to stderr.
                process.stderr.write(cliColor.error(redactErrorForCli(err)) + '\n');
                const hint = remediationForCode(err.code);
                if (hint) {
                    process.stderr.write(`  ${cliColor.hint(`→ try: ${hint}`)}\n`);
                }
                process.exit(typedErrorToExitCode(err.code));
                return;
            }
            // Cluster D (Wave C1-Amend fix-up — V2-C1-004 + V3-C1-005):
            // adapter-layer typed errors (CorruptStoreError,
            // BackupTargetExistsError, ImportConflictError, …) extend
            // plain Error (no-back-edge rule prevents importing
            // ClusterError into src/adapters/). They carry .code +
            // .remediationHint; duck-type detect via the field shape.
            if (
                err &&
                typeof err === 'object' &&
                'code' in err &&
                typeof (err as { code: unknown }).code === 'string' &&
                'message' in err &&
                typeof (err as { message: unknown }).message === 'string'
            ) {
                const adapterErr = err as {
                    code: string;
                    message: string;
                    remediationHint?: string;
                };
                // Sanitize the message at the boundary (paths leak from
                // adapter prose) before surfacing.
                const safeMsg = redactErrorForCli(err);
                process.stderr.write(cliColor.error(`Error: ${safeMsg}`) + '\n');
                const hint = adapterErr.remediationHint || remediationForCode(adapterErr.code);
                if (hint) {
                    process.stderr.write(`  ${cliColor.hint(`→ try: ${hint}`)}\n`);
                }
                process.exit(typedErrorToExitCode(adapterErr.code));
                return;
            }
            if (process.env.DEBUG === '1') {
                // Full stack for trusted operator debug.
                console.error(err);
            } else {
                const message = err instanceof Error
                    ? redactErrorForCli(err)
                    : 'An internal error occurred.';
                process.stderr.write(cliColor.error(`Error: ${message}`) + '\n');
            }
            process.exit(1);
        }
    };
}

/**
 * Map a typed-error code to a one-line CLI-flavored remediation hint.
 *
 * SURFACE-C-005 (Wave C1-Amend): the CLI catch arm in {@link cliCommand}
 * surfaces this as `→ try: <hint>` so operators see what to do next.
 *
 * Mirrors the per-code map in `src/mcp/sanitize.ts::TYPED_ERROR_ENRICHMENT`
 * but worded for the CLI context (named commands, not MCP tool names).
 *
 * `undefined` return = no hint for this code (the catch arm omits the
 * `→ try:` line).
 */
function remediationForCode(code: string): string | undefined {
    switch (code) {
        case 'POLICY_DENIED':
            return 'Inspect the failing capability with `db-cluster policy explain --principal <id> --capability <cap> [...]` to see why and what role/policy would unlock it.';
        case 'NOT_FOUND':
            return 'Verify the ID/URI exists with `db-cluster find <query>` or `db-cluster resolve <uri>`.';
        case 'PROVENANCE_MISSING':
            return 'Trace the subject with `db-cluster trace <uri>` to inspect what lineage (if any) exists.';
        case 'COMMAND_NOT_VALIDATED':
            return 'Validate, then approve, then commit: `db-cluster validate <id> && db-cluster approve <id> && db-cluster commit <id>`.';
        case 'COMMAND_REJECTED':
            return 'Rejected commands are terminal. Re-propose with corrections: `db-cluster propose <new-command-json>`.';
        case 'RECEIPT_FAILED':
            return 'Run `db-cluster doctor` to inspect cluster health, then `db-cluster verify --json` to confirm ledger state.';
        case 'COMMAND_QUEUE_CORRUPT':
            return 'Restore from a backup: `db-cluster restore <file>`. Or remove the corrupted queue file to start fresh (pending commands lost).';
        case 'COMMAND_QUEUE_PERSISTENCE_LOST':
            return 'Restore from a backup that includes pending-commands.json + the marker file. Otherwise, remove the marker file to cold-start.';
        case 'CONTENT_HASH_MISMATCH':
            return 'Recompute sha256(content) and re-propose ingest_artifact with the correct contentHash.';
        case 'STAGED_CONTENT_TAMPERED':
            return 'Inspect the staging directory (the staging file is preserved for forensics), then re-propose with fresh content.';
        case 'INVALID_CONTENT_SHAPE':
            return 'payload.content must be a Buffer instance or a string (contentHash). Re-issue the command with one of those shapes.';
        case 'CORRUPT_STORE':
            return 'Run `db-cluster doctor` to identify which store is corrupted, then `db-cluster restore <file>` from a known-good backup.';
        case 'INVALID_CONTENT_HASH':
            return 'Recompute sha256(content) and re-supply the matching contentHash.';
        case 'IMPORT_CONFLICT':
            return 'Restore detected an ID collision. Restore into a fresh cluster directory (`db-cluster init` in an empty dir, then `db-cluster restore <file>`).';
        case 'LEDGER_CYCLE_DETECTED':
            return 'Run `db-cluster doctor` to inspect ledger state. Restore from a clean backup if confirmed.';
        case 'INVALID_POLICY_CONFIG':
            return 'Fix .db-cluster/policies.json structure — the error message names the offending field. Re-run after correction.';
        case 'INVALID_REDACTION_RULE':
            return 'A redaction rule is malformed. Inspect the relevant policy file and correct the rule shape.';
        case 'INVALID_ROTATE_TIMESTAMP':
            return 'Pass an ISO-8601 timestamp to the ledger rotate command.';
        case 'ROTATE_BOUNDARY_IN_FUTURE':
            return 'Ledger rotate boundary cannot be in the future. Pass a past timestamp.';
        case 'INVALID_CLUSTER_URI':
            return 'URIs must match `cluster://<store>/<id>`. Re-form the URI and retry.';
        case 'RESOLVE_NOT_FOUND':
            return 'The URI does not resolve. Confirm the store name and ID with `db-cluster find <query>`.';
        case 'BACKUP_TARGET_EXISTS':
            return 'Re-run backup with `--force` to overwrite, or choose a different output path.';
        // Wave C1-Amend fix-up (V1-C1-001): CommandValidationFailedError
        // — extends plain Error not ClusterError; adapter-style code path.
        case 'COMMAND_VALIDATION_FAILED':
            return 'The command failed structural validation. Inspect command.validation.checks (or re-run with DEBUG=1) to see which check failed; fix the payload and re-propose.';
        case 'COMMAND_NOT_FOUND':
            return 'The command ID does not exist. Propose a new command with `db-cluster propose <command-json>`.';
        case 'COMMAND_ALREADY_TERMINAL':
            return 'The command is already in a terminal state. To correct a committed command, run `db-cluster compensate <command-id> --reason <text>`; for a rejected one, re-propose with corrections.';
        case 'INVALID_STATE_TRANSITION':
            return 'The requested transition is not legal from the current command status. Inspect the command with `db-cluster inspect-command <command-id>`.';
        default:
            return undefined;
    }
}

// ─── §2c destructiveCommand HOF (Wave C1-Amend) ────────────────────────────
//
// SURFACE-C-007 (Wave C1-Amend) — mutation-causing CLI commands had no
// confirmation, no automatic pre-mutation snapshot, no `--yes` bypass for
// non-interactive automation, and no `undo` hint on error. The HOF below
// composes those four behaviors on top of `cliCommand` so every
// destructive-op site gets uniform safety.
//
// Pattern (parallel to `cliCommand`):
//   .action(destructiveCommand(async (args, opts) => { ... }, {
//       name: 'restore',
//       preMutationSnapshot: true,
//       undoHint: 'rerun with `db-cluster restore <previous-snapshot>`',
//   }))
//
// The HOF reads two well-known fields from `opts`:
//   - `opts.yes`       — if true, skip confirmation prompt (CI automation)
//   - `opts.dryRun`    — if true, signal to fn() that it must not mutate
//                        (fn is still called; it inspects this and short-
//                        circuits). dryRun bypasses confirmation +
//                        snapshot — no mutation, no need.

/**
 * Options accepted by {@link destructiveCommand}.
 */
export interface DestructiveCommandOptions {
    /** Human-readable name of the operation — used in confirmation prompts. */
    name: string;
    /**
     * If true, take a JSON-export snapshot of the cluster to
     * `.db-cluster/auto-snapshots/<timestamp>/` BEFORE invoking the wrapped
     * function. On error during fn(), the snapshot path is included in the
     * stderr message so the operator has a clear undo target.
     *
     * Skipped when `opts.dryRun === true` (no mutation = no need).
     */
    preMutationSnapshot?: boolean;
    /**
     * One-line operator-facing recovery instruction surfaced on the
     * post-mutation error path. Example: 'rerun with `db-cluster restore
     * <previous-snapshot>`'. Required because every destructive op MUST
     * tell the operator what to do if it fails partway.
     */
    undoHint: string;
}

/**
 * Higher-order function that wraps a destructive CLI action with safety
 * scaffolding:
 *   1. If `opts.dryRun` is truthy → invoke fn with no snapshot, no prompt.
 *      fn is responsible for honoring dry-run mode itself.
 *   2. If `opts.yes` is NOT set → block on an interactive Y/N prompt.
 *      Refuse to proceed on N or any non-Y response. Non-TTY → error
 *      ("pass `--yes` to confirm").
 *   3. If `opts.yes` IS set OR the operator confirmed → optionally take
 *      a pre-mutation snapshot, then invoke fn.
 *   4. On error from fn → emit the snapshot path (if taken) and the
 *      `undoHint`, then rethrow so cliCommand's uniform exit handling
 *      runs.
 *
 * The wrapped function is in turn passed through {@link cliCommand} so
 * typed-error mapping + `→ try:` remediation lines all still fire. The
 * caller never invokes cliCommand directly — destructiveCommand composes
 * both safety layers in the correct order.
 */
export function destructiveCommand<T extends unknown[]>(
    fn: (...args: T) => Promise<void>,
    opts: DestructiveCommandOptions,
): (...args: T) => Promise<void> {
    return cliCommand(async (...args: T) => {
        // Commander 14: action(positional1, ..., opts, command). The LAST
        // arg is the Command instance; the SECOND-TO-LAST is the options
        // object. For action(opts), args = [opts, command]. We pick the
        // second-to-last position when it's an object (and not the
        // Command — Command has a `name()` method we can sniff for).
        let trailingOpts: { yes?: boolean; dryRun?: boolean; force?: boolean } = {};
        for (let i = args.length - 1; i >= 0; i--) {
            const candidate = args[i];
            if (
                typeof candidate === 'object' &&
                candidate !== null &&
                // commander Command instance has a `.opts()` method —
                // we skip past it.
                typeof (candidate as { opts?: unknown }).opts !== 'function'
            ) {
                trailingOpts = candidate as { yes?: boolean; dryRun?: boolean; force?: boolean };
                break;
            }
        }

        // Path 1: dry-run — pass through without confirmation / snapshot.
        if (trailingOpts.dryRun) {
            await fn(...args);
            return;
        }

        // Path 2: confirmation. `--yes` bypasses; `--force` also bypasses
        // for symmetry with common Unix conventions (`rm -rf`, `cp -f`).
        const bypass = !!trailingOpts.yes || !!trailingOpts.force;
        if (!bypass) {
            const stdinIsTTY = !!process.stdin.isTTY;
            if (!stdinIsTTY) {
                process.stderr.write(
                    `Refusing to ${opts.name}: stdin is not a TTY. Pass --yes to confirm non-interactively.\n`,
                );
                process.exit(1);
            }
            // Interactive prompt. We avoid pulling in readline as a top-
            // level dep — load lazily.
            const { createInterface } = await import('node:readline/promises');
            const rl = createInterface({ input: process.stdin, output: process.stderr });
            try {
                const answer = await rl.question(
                    `About to ${opts.name}. This is a destructive operation.\nProceed? (y/N) `,
                );
                if (answer.trim().toLowerCase() !== 'y') {
                    process.stderr.write(`Cancelled. (To skip this prompt, pass --yes.)\n`);
                    process.exit(1);
                }
            } finally {
                rl.close();
            }
        }

        // Path 3: pre-mutation snapshot.
        let snapshotPath: string | undefined;
        if (opts.preMutationSnapshot) {
            snapshotPath = await takeAutoSnapshot(opts.name);
            // Cluster F (Wave C1-Amend fix-up — V1-C1-008 + V2-C1-006):
            // gate the auto-snapshot announcement by log level so
            // `--quiet` and `--log-level=warn|error` actually suppress
            // it. The info banner is operator-friendly but it noise up
            // pipelines that just want exit code + JSON.
            if (!cliQuiet && shouldEmit('info')) {
                process.stderr.write(`Auto-snapshot saved to: ${snapshotPath}\n`);
            }
        }

        // Path 4: invoke fn — on error attach undo guidance.
        try {
            await fn(...args);
        } catch (err) {
            // Wave C1-Amend fix-up (V2-C1-011): undoHints have TWO
            // placeholders: <previous-snapshot> (the snapshot directory)
            // and <file> (the snapshot-file argument operators would
            // pass to `db-cluster restore <file>`). Pre-fix only the
            // first was substituted; operators saw literal `<file>` in
            // the recovery prose. Both substitutions now happen in one
            // chain — first the directory, then the cluster-snapshot
            // JSON file path within it.
            const undoLine = snapshotPath
                ? `  → undo: ${opts.undoHint
                    .replace('<previous-snapshot>', snapshotPath)
                    .replace('<file>', resolve(snapshotPath, 'cluster-snapshot.json'))}\n`
                : `  → undo: ${opts.undoHint}\n`;
            process.stderr.write(undoLine);
            throw err;
        }
    });
}

/**
 * Write a JSON backup of the cluster to
 * `.db-cluster/auto-snapshots/<isoTimestamp>/cluster-snapshot.json`.
 *
 * Returns the absolute path to the directory. Used by
 * {@link destructiveCommand} when `preMutationSnapshot: true`.
 *
 * Failure mode: if the snapshot itself fails (write error, no cluster),
 * the function rethrows. The destructive command's caller decides whether
 * to proceed without a snapshot — currently we surface the error rather
 * than silently skipping the safety net.
 */
async function takeAutoSnapshot(operationName: string): Promise<string> {
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const { randomBytes } = await import('node:crypto');
    const { backup } = await import('./ops/backup.js');
    const stores = createLocalCluster(CLUSTER_DIR);
    const isoTs = new Date().toISOString().replace(/[:.]/g, '-');
    // Wave C1-Amend fix-up (V2-C1-010): two concurrent destructive ops
    // within the same millisecond would collide on the snapshot
    // directory name (mkdirSync recursive is silent on collision —
    // the second op would overwrite the first's snapshot). Append a
    // 4-byte random suffix so concurrent ops separate.
    // Also: operation names like `rebuild index` contain a space that
    // breaks shell scripts copy-pasting the path. Replace spaces with
    // hyphens uniformly.
    const safeName = operationName.replace(/\s+/g, '-');
    const randSuffix = randomBytes(4).toString('hex');
    const snapshotDir = resolve(CLUSTER_DIR, 'auto-snapshots', `${isoTs}-${safeName}-${randSuffix}`);
    mkdirSync(snapshotDir, { recursive: true });
    const snapshotFile = resolve(snapshotDir, 'cluster-snapshot.json');
    const data = await backup(stores);
    writeFileSync(snapshotFile, JSON.stringify(data, null, 2), 'utf-8');
    return snapshotDir;
}

// ─── Cluster F (Wave C1-Amend fix-up — V1-C1-008 + V2-C1-006) ──────────
//
// --quiet + --log-level wiring. Pre-fix both were declared but never read
// (`grep opts.quiet` returned zero matches across the CLI). Operators
// piping `db-cluster doctor --json --quiet | jq` saw stderr noise mixed
// in with the JSON.
//
// Discipline:
//   - cliQuiet (--quiet): suppress STDOUT non-error output entirely
//     (info banners, progress, success prose). Errors still emit.
//   - cliLogLevel (--log-level): gate STDERR-bound info/warn/debug
//     output by level. 'error' = quietest, 'debug' = noisiest. Hard
//     errors always emit.
//
// Both states are module-level and set in the pre-action hook below
// (the only callsite where commander has finished parsing). Every
// stdout/stderr call site in cli.ts that ISN'T an error reads through
// the cliInfo / cliWarn / cliDebug helpers (or checks cliQuiet
// directly for compound output like JSON dumps).

type CliLogLevel = 'debug' | 'info' | 'warn' | 'error';
let cliQuiet = false;
let cliLogLevel: CliLogLevel = 'info';

const LOG_LEVEL_RANK: Record<CliLogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
};

/** Whether a message at `level` should be emitted given the current cliLogLevel. */
function shouldEmit(level: CliLogLevel): boolean {
    return LOG_LEVEL_RANK[level] >= LOG_LEVEL_RANK[cliLogLevel];
}

/** Emit an info-level non-error message to stdout. Suppressed under --quiet. */
function cliInfo(msg: string): void {
    if (cliQuiet) return;
    if (!shouldEmit('info')) return;
    process.stdout.write(msg + (msg.endsWith('\n') ? '' : '\n'));
}

/** Emit a warning to stderr — respects --log-level. */
function cliWarn(msg: string): void {
    if (!shouldEmit('warn')) return;
    process.stderr.write(msg + (msg.endsWith('\n') ? '' : '\n'));
}

/** Emit a debug-level message to stderr — only at --log-level=debug. */
function cliDebug(msg: string): void {
    if (!shouldEmit('debug')) return;
    process.stderr.write(msg + (msg.endsWith('\n') ? '' : '\n'));
}

// Voids the lint warning about unused helpers (cliWarn + cliDebug are
// available for future use sites; they're cheap to keep wired).
void cliWarn;
void cliDebug;

// Wave C1-Amend fix-up (V2-C1-005): default CLI progress renderer.
// Subscribes the four long-running ops contracts (rebuildIndex, verify,
// doctor, backup) so operators see live progress instead of staring at
// a blank terminal for 30+ seconds. Honors --quiet (no output) and
// --log-level=warn|error (suppressed, since progress is info-level).
//
// TTY path uses \r so the line updates in place; non-TTY emits one
// line per ~N records to avoid flooding pipelines.
function makeProgressRenderer(label: string): (current: number, total: number, message?: string) => void {
    if (cliQuiet || !shouldEmit('info')) {
        return () => {
            /* noop */
        };
    }
    if (process.stderr.isTTY) {
        return (current, total, message) => {
            const tail = message ? ` ${message}` : '';
            process.stderr.write(`\r[${label}] ${current}/${total}${tail}`);
            if (current >= total) process.stderr.write('\n');
        };
    }
    // Non-TTY: throttle to ~one line per 100 records (plus a final line).
    let lastEmit = -1;
    const EMIT_STEP = 100;
    return (current, total, message) => {
        const tail = message ? ` ${message}` : '';
        if (current === total || current - lastEmit >= EMIT_STEP) {
            process.stderr.write(`[${label}] ${current}/${total}${tail}\n`);
            lastEmit = current;
        }
    };
}
void makeProgressRenderer;

const program = new Command();

program
    .name('db-cluster')
    .description(
        'AI-native federated database cluster.\n\n' +
        'Exit codes (SURFACE-C-008 — stable across versions):\n' +
        '  0   success\n' +
        '  1   general failure (NOT_FOUND, COMMAND_NOT_VALIDATED, …)\n' +
        '  65  EX_DATAERR  — content/hash mismatches, import conflicts\n' +
        '  70  EX_SOFTWARE — corrupted store, command-queue corruption\n' +
        '  77  EX_NOPERM   — POLICY_DENIED\n' +
        '  78  EX_CONFIG   — invalid policy config or redaction rule\n' +
        'CI scripts can branch on these. Pass --help-exit-codes for the full table.',
    )
    // SURFACE-B-013 (Wave B1-Amend): version read from package.json at
    // module load instead of hardcoded literal.
    .version(PACKAGE_VERSION)
    .option('--actor <id>', 'Operator identity for this invocation (overrides DB_CLUSTER_OPERATOR / OS user)')
    .option('--quiet', 'Suppress non-error output (SURFACE-C-023)')
    .option('--log-level <level>', 'Gate stderr output by level: debug | info | warn | error (SURFACE-C-023)', 'info')
    .option('--no-color', 'Disable ANSI color in CLI output (NO_COLOR env var is also honoured)')
    .option('--help-exit-codes', 'Print the table of exit codes mapped to typed-error codes and exit', false);

const EXIT_CODE_TABLE = [
    'db-cluster exit-code table (SURFACE-C-008 / CIDOCS-C-003):',
    '',
    '| Exit | Sysexits     | Typed-error codes mapped here                        |',
    '|------|--------------|------------------------------------------------------|',
    '|   0  | EX_OK        | success                                              |',
    '|   1  | (general)    | NOT_FOUND, PROVENANCE_MISSING,                       |',
    '|      |              | COMMAND_NOT_VALIDATED, COMMAND_REJECTED, usage error |',
    '|  65  | EX_DATAERR   | CONTENT_HASH_MISMATCH, INVALID_CONTENT_HASH,         |',
    '|      |              | STAGED_CONTENT_TAMPERED, IMPORT_CONFLICT,            |',
    '|      |              | INVALID_CONTENT_SHAPE                                |',
    '|  70  | EX_SOFTWARE  | CORRUPT_STORE, COMMAND_QUEUE_CORRUPT,                |',
    '|      |              | COMMAND_QUEUE_PERSISTENCE_LOST,                      |',
    '|      |              | LEDGER_CYCLE_DETECTED, RECEIPT_FAILED,               |',
    '|      |              | BUFFER_SIDE_CHANNEL_NOT_SUPPORTED                    |',
    '|  77  | EX_NOPERM    | POLICY_DENIED                                        |',
    '|  78  | EX_CONFIG    | INVALID_POLICY_CONFIG, INVALID_REDACTION_RULE,       |',
    '|      |              | INVALID_ROTATE_TIMESTAMP, ROTATE_BOUNDARY_IN_FUTURE  |',
    '',
    'These exit codes are stable across versions. CI scripts may branch on them.',
    'For per-command tunable behavior, run `db-cluster <command> --help`.',
    '',
].join('\n');

// SURFACE-C-008 (Wave C1-Amend): handle --help-exit-codes early.
// `program.hook('preAction')` only fires when a subcommand runs, so
// `db-cluster --help-exit-codes` alone wouldn't trigger it. We scan
// process.argv directly so the flag works at the top level with no
// subcommand AND alongside any subcommand.
if (process.argv.includes('--help-exit-codes')) {
    process.stdout.write(EXIT_CODE_TABLE);
    process.exit(0);
}

// Cluster F (Wave C1-Amend fix-up — V1-C1-008 + V2-C1-006): read
// --quiet + --log-level into module-level state once commander has
// parsed. preAction fires before every subcommand action runs, so
// cliQuiet / cliLogLevel are populated by the time the action's body
// (or any wrapper like cliCommand / destructiveCommand) executes.
program.hook('preAction', (thisCmd) => {
    // Commander materializes `--no-color` as `opts.color === false`.
    const opts = thisCmd.opts<{ quiet?: boolean; logLevel?: string; color?: boolean }>();
    cliQuiet = !!opts.quiet;
    // `--no-color` sets opts.color to false; absence leaves it undefined.
    // Default behavior (no flag) preserves the auto-detected TTY/NO_COLOR state.
    if (opts.color === false) {
        setCliColorEnabled(false);
    }
    const level = (opts.logLevel ?? 'info').toLowerCase();
    if (level === 'debug' || level === 'info' || level === 'warn' || level === 'error') {
        cliLogLevel = level;
    } else {
        // Unknown level — keep default and emit a warning. The
        // declared 'info' default keeps existing behavior intact.
        process.stderr.write(`Unknown --log-level value: ${opts.logLevel}; defaulting to 'info'\n`);
        cliLogLevel = 'info';
    }
});

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
        console.log(cliColor.success('Cluster initialized at .db-cluster/'));
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

        console.log(cliColor.success(`Ingested: ${filename}`));
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

        console.log(cliColor.success(`Created entity: ${opts.kind}/${opts.name}`));
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

        console.log(cliColor.success(`Linked: artifact ${opts.artifact} → entity ${opts.entity}`));
        console.log(`  provenance: ${result.provenance.id}`);
        console.log(`  receipt:    ${result.receipt.id}`);
    }));

// --- find ---
program
    .command('find <query>')
    .description('Find sources through the cluster index')
    .option('--limit <n>', 'Max results', '10')
    .option('--offset <n>', 'Skip N results before limit (pagination)', '0')
    .action(cliCommand(async (query: string, opts: { limit: string; offset: string }) => {
        const kernel = getKernel();

        const result = await kernel.findSources({ query, limit: parseInt(opts.limit), offset: parseInt(opts.offset) });

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
        console.log(cliColor.header(`Entity: ${entity.kind}/${entity.name}`));
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
    .description(
        'Commit a proposed mutation through the command runtime.\n\n' +
        'Separation of duties:\n' +
        '  By default a different operator must commit a command than the one\n' +
        '  who proposed it. When the proposer and the operator are the same\n' +
        '  identity, commit refuses unless --self-approve is passed.\n\n' +
        '  --self-approve only acknowledges that the same identity proposed +\n' +
        '  committed (silences the soft warning in single-user mode).\n\n' +
        '  --accept-soft-duty-bypass is required IN ADDITION when --self-approve\n' +
        '  causes commit to walk validate→approve→commit under a single actor.\n' +
        '  Splitting this into two flags is intentional: passing --self-approve\n' +
        '  alone is for cases where validate + approve were performed earlier\n' +
        '  (perhaps by an operator who is now offline); passing both flags is a\n' +
        '  loud acknowledgement that an automation is performing the entire\n' +
        '  lifecycle as one identity. Operators-of-record audit on the second flag.',
    )
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
        console.log(cliColor.success(`Committed: ${result.command.id}`));
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
        } else {
            // SHA-SURFACE-LEAK-5 (Wave C1-Amend should-have-been-A):
            // pre-fix the renderer dropped silently when `cmd.validation`
            // was undefined on a 'validated' status. Operators saw three
            // lines + nothing — looked broken. Surface a one-line "no
            // validation record" notice so the renderer never has a
            // blind spot.
            console.log(`  checks: (no validation record on the command — re-run \`db-cluster validate ${cmd.id}\` to populate)`);
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
//
// Wave C1-Amend fix-up (V2-C1-002): compensate is implicitly destructive
// — it writes a new committed command + receipt + provenance event that
// CANNOT be undone (compensation is a forward-only correction). Pre-fix
// it ran on plain `cliCommand` with no --yes / --force / pre-snapshot /
// undo hint, so a piped-non-TTY compensate would silently mutate the
// ledger with exit 0.
//
// The undo hint is intentionally non-recovery prose: compensation is
// recorded as a forward fact in the ledger; the appropriate
// "rollback" is to issue ANOTHER compensating mutation (or accept the
// recorded state).
program
    .command('compensate <command-id>')
    .description('Compensate a committed command (correct without erasing). DESTRUCTIVE: writes a new committed command + receipt + provenance event that cannot be undone — re-propose another compensation rather than expecting rollback. Pass --yes in non-interactive pipelines.')
    .requiredOption('--reason <text>', 'Compensation reason')
    .option('--dry-run', 'Show what would be compensated without mutating')
    .option('--force', 'Skip confirmation prompt (also --yes)')
    .option('--yes', 'Skip confirmation prompt (alias for --force)')
    .action(destructiveCommand(async (commandId: string, opts: { reason: string; dryRun?: boolean }) => {
        const kernel = getKernel();
        const operator = resolveOperator(rootActor());
        if (opts.dryRun) {
            if (!cliQuiet) {
                console.log('Dry run (no mutation performed).');
                console.log(`  Would compensate: ${commandId}`);
                console.log(`  Reason:           ${opts.reason}`);
            }
            return;
        }
        const result = await kernel.compensateMutation(commandId, operator.actorId, opts.reason);
        if (!cliQuiet) {
            console.log(`Compensated: ${result.originalCommand.id}`);
            console.log(`  original status: ${result.originalCommand.status}`);
            console.log(`  compensating:    ${result.compensatingCommand.id}`);
            console.log(`  receipt:         ${result.receipt.id}`);
            console.log(`  reason:          ${opts.reason}`);
        }
    }, {
        name: 'compensate',
        preMutationSnapshot: true,
        undoHint: 'compensation is permanently recorded — re-propose a corrective mutation rather than attempting to roll back the original command',
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
    .description('Clear and rebuild the index from owner stores. DESTRUCTIVE: same effect as the top-level `db-cluster rebuild index` — both paths route through the destructive-command guard (pre-mutation snapshot, --yes / --force required in non-TTY, undo hint on error). Use --dry-run to preview.')
    .option('--dry-run', 'Show what would be rebuilt without mutating')
    .option('--force', 'Skip confirmation prompt (also --yes)')
    .option('--yes', 'Skip confirmation prompt (alias for --force)')
    .action(destructiveCommand(async (opts: { dryRun?: boolean }) => {
        // Wave C1-Amend fix-up (V2-C1-001): `index rebuild` is a
        // sibling-of-`rebuild index` — both invoke kernel.rebuildIndex
        // (or ops/rebuild.rebuildIndex through the SDK boundary) and
        // both must carry the same safety scaffolding. Pre-fix this
        // path was a parallel destructive code route with NO --yes,
        // NO auto-snapshot, NO undo hint — operators piping
        // `db-cluster index rebuild | jq` would silently wipe the
        // index with exit 0.
        const kernel = getKernel();
        const operator = resolveOperator(rootActor());
        if (opts.dryRun) {
            // Dry-run: don't invoke kernel.rebuildIndex (which always
            // mutates today). Surface a structural preview only.
            if (!cliQuiet) {
                console.log('Dry run (no mutation performed). Would rebuild the index from owner stores.');
            }
            return;
        }
        const result = await kernel.rebuildIndex(operator.actorId);
        if (!cliQuiet) {
            console.log(`Index rebuilt: ${result.rebuilt} record(s) from owner stores.`);
            console.log(`  provenance: ${result.provenance.id}`);
            console.log(`  receipt:    ${result.receipt.id}`);
        }
    }, {
        name: 'index rebuild',
        preMutationSnapshot: true,
        undoHint: 'restore the prior cluster state from the auto-snapshot at <previous-snapshot> via `db-cluster restore <file>`',
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
    .option('--offset <n>', 'Skip N ranked results before limit (pagination)', '0')
    .action(cliCommand(async (query: string, opts: { limit: string; offset: string }) => {
        const kernel = getKernel();
        const bundle = await kernel.retrieveBundle(query, { limit: parseInt(opts.limit), offset: parseInt(opts.offset) });

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
    .description('Explain what the policy engine would decide for a given action (dry-run). On a deny decision, the closest alternative rule that WOULD have allowed (when one exists) is also surfaced — operators iterate less by guess.')
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

        // SURFACE-C-009 (Wave C1-Amend): on deny, surface which match clause
        // appears to have caused the decision PLUS the closest alternative
        // rule that WOULD have allowed (if any). Operators previously
        // iterated by guessing — now they see the diff between "what was
        // requested" and "what would unlock".
        if (decision.decision === 'deny') {
            const matched = policies.find((p) => p.id === decision.matchedPolicyId);
            if (matched && matched.match) {
                const clauseHints: string[] = [];
                const m = matched.match;
                if (Array.isArray(m.principals) && m.principals.length > 0) {
                    const matchedByPrincipal = m.principals.some((p) => p === principal.id || principal.roles.includes(p));
                    if (matchedByPrincipal) clauseHints.push(`principals clause matched (one of: ${m.principals.join(', ')})`);
                }
                if (Array.isArray(m.capabilities) && m.capabilities.length > 0) {
                    if (m.capabilities.includes(opts.capability)) clauseHints.push(`capabilities clause matched (${opts.capability} is in the rule)`);
                }
                if (Array.isArray(m.trustZones) && m.trustZones.length > 0) {
                    if (m.trustZones.includes(opts.trustZone)) clauseHints.push(`trustZones clause matched (${opts.trustZone})`);
                }
                if (Array.isArray(m.stores) && opts.store && m.stores.includes(opts.store)) {
                    clauseHints.push(`stores clause matched (${opts.store})`);
                }
                if (clauseHints.length > 0) {
                    console.log(`\nWhich clauses fired in '${decision.matchedPolicyName}':`);
                    for (const c of clauseHints) console.log(`  - ${c}`);
                }
            }

            // Search for an allow-rule that would match if the principal
            // had one more role / belonged to a different trust zone.
            const candidateAllows = policies.filter((p) => p.decision === 'allow');
            const wouldUnlock: Array<{ id: string; name: string; reason: string }> = [];
            for (const allow of candidateAllows) {
                const am = allow.match ?? {};
                // Same capability requirement?
                if (Array.isArray(am.capabilities) && am.capabilities.length > 0 && !am.capabilities.includes(opts.capability)) continue;
                if (Array.isArray(am.stores) && am.stores.length > 0 && opts.store && !am.stores.includes(opts.store)) continue;
                // What would the principal need?
                const missing: string[] = [];
                if (Array.isArray(am.principals) && am.principals.length > 0) {
                    const matchedByPrincipal = am.principals.some((p) => p === principal.id || principal.roles.includes(p));
                    if (!matchedByPrincipal) {
                        missing.push(`role/principal one of: ${am.principals.join(', ')}`);
                    }
                }
                if (Array.isArray(am.trustZones) && am.trustZones.length > 0 && !am.trustZones.includes(opts.trustZone)) {
                    missing.push(`trustZone one of: ${am.trustZones.join(', ')}`);
                }
                if (missing.length > 0 && missing.length <= 2) {
                    // 1-2 missing slots = "closest" alternative.
                    wouldUnlock.push({
                        id: allow.id,
                        name: allow.name,
                        reason: missing.join('; '),
                    });
                }
            }
            if (wouldUnlock.length > 0) {
                console.log(`\nClosest allow rule(s) that would unlock this:`);
                for (const a of wouldUnlock.slice(0, 3)) {
                    console.log(`  - ${a.name} (${a.id})`);
                    console.log(`    needs: ${a.reason}`);
                }
            } else {
                console.log(`\nNo 1- or 2-step allow rule found. Add a new policy or grant additional roles.`);
            }
        }

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
                // EGRESS-001: swallow idle-client pool errors so a dropped
                // backend connection can't crash the CLI mid-command. Log the
                // message only (no stack / connection string / secret).
                pool.on('error', (err) => console.error(`postgres pool error: ${err.message}`));
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
                // EGRESS-003 (Wave S2-A2): scrub absolute paths (e.g. a
                // unix-socket path `/var/run/postgresql/.s.PGSQL.5432`) out of
                // the surfaced connection error before printing.
                console.error(`  ✗ Postgres connection failed: ${redactErrorMessage(err)}`);
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
        // EGRESS-001: idle-client pool errors must not crash the CLI.
        pool.on('error', (err) => console.error(`postgres pool error: ${err.message}`));
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
    .description('Run full cluster health assessment. Output is sorted by severity (errors first, then warnings, then healthy). A footer surfaces the top fix when the cluster is degraded.')
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
            // Wave C1-Amend fix-up (V2-C1-005): wire onProgress to the
            // doctor ops contract — STORES-C-002 ships the channel; the
            // CLI consumer was missing.
            onProgress: makeProgressRenderer('doctor'),
        });
        if (opts.json) {
            // --json overrides --quiet: AI consumers always want the
            // structured body. (--quiet still suppresses ancillary chatter
            // like the auto-snapshot announcement.)
            console.log(JSON.stringify(health, null, 2));
        } else if (!cliQuiet) {
            // SURFACE-C-012 (Wave C1-Amend): sort checks by severity so
            // errors surface first. Tie-breaker: name (deterministic
            // ordering). Pre-fix the order was producer-dependent and an
            // error could be buried below a list of healthy checks.
            const SEVERITY_RANK: Record<string, number> = {
                error: 0,
                warn: 1,
                info: 2,
                // Healthy checks rank below all severity-bearing ones.
                healthy: 3,
            };
            const rank = (check: { status?: string; severity?: string }) =>
                check.status === 'healthy'
                    ? SEVERITY_RANK.healthy
                    : SEVERITY_RANK[check.severity ?? 'info'] ?? SEVERITY_RANK.info;
            const sortedChecks = [...health.checks].sort((a, b) => {
                const dr = rank(a) - rank(b);
                if (dr !== 0) return dr;
                return (a.name ?? '').localeCompare(b.name ?? '');
            });

            console.log(`Cluster: ${health.status}`);
            console.log(`Checks: ${health.summary.total} total, ${health.summary.healthy} healthy, ${health.summary.errors} errors, ${health.summary.warnings} warnings`);
            for (const check of sortedChecks) {
                const icon = check.status === 'healthy' ? '✓' : check.severity === 'error' ? '✗' : '!';
                console.log(`  ${icon} [${check.store}] ${check.name}: ${check.message}`);
                if (check.suggestedCommand) {
                    console.log(`    → fix: ${check.suggestedCommand}`);
                }
            }

            // SURFACE-C-012 (Wave C1-Amend) — degraded footer:
            // when the cluster is not healthy, surface a "Top fix" line
            // pointing at the highest-severity check with a suggested
            // command. Operators see a clear "do this next" hand-off
            // instead of having to scan the whole list.
            if (health.status !== 'healthy') {
                const topFix = sortedChecks.find(
                    (c) => c.status !== 'healthy' && c.suggestedCommand,
                );
                if (topFix) {
                    console.log('');
                    console.log(`Top fix: ${topFix.suggestedCommand}`);
                    console.log(`  (check: ${topFix.name} — ${topFix.message})`);
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
        // Wave S2-A1 fix-up (Task 2): thread a CommandQueue so the
        // `command_receipt_bijection` check actually runs. verify() SKIPS that
        // check entirely when no queue is supplied — pre-fix `verify(stores,
        // {...})` meant `db-cluster verify` never detected an orphan/forged
        // receipt. MIRRORS the doctor action's CommandQueue(CLUSTER_DIR)
        // pattern above.
        const { CommandQueue } = await import('./kernel/command-queue.js');
        const commandQueue = new CommandQueue(CLUSTER_DIR);
        const health = await verify(stores, {
            sampleLimit: parseInt(opts.sample, 10),
            commandQueue,
            // Wave C1-Amend fix-up (V2-C1-005): wire onProgress to the
            // verify ops contract so operators see per-step progress on
            // long verifies (large clusters) instead of staring at blank.
            onProgress: makeProgressRenderer('verify'),
        });
        if (opts.json) {
            console.log(JSON.stringify(health, null, 2));
        } else if (!cliQuiet) {
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
    .description('Rebuild the index from canonical + artifact stores. DESTRUCTIVE: clears all current index records and rebuilds from owner stores. Use --dry-run to preview.')
    .option('--dry-run', 'Show what would be rebuilt without mutating')
    .option('--force', 'Skip confirmation prompt (also --yes)')
    .option('--yes', 'Skip confirmation prompt (alias for --force)')
    .option('--json', 'Output as JSON')
    .action(destructiveCommand(async (opts) => {
        const stores = createLocalCluster(CLUSTER_DIR);
        const { rebuildIndex } = await import('./ops/rebuild.js');
        const result = await rebuildIndex(stores, {
            dryRun: opts.dryRun,
            // Wave C1-Amend fix-up (V2-C1-005): wire onProgress so the
            // STORES-C-002 contract bears fruit at the operator surface.
            onProgress: makeProgressRenderer('rebuild'),
        });
        if (opts.json) {
            console.log(JSON.stringify(result, null, 2));
        } else if (!cliQuiet) {
            console.log(`Rebuilt: ${result.rebuilt} records${result.dryRun ? ' (dry run)' : ''}`);
            if (result.errors.length > 0) {
                console.log(`Errors: ${result.errors.length}`);
                for (const e of result.errors) console.log(`  ${e}`);
            }
        }
    }, {
        name: 'rebuild index',
        preMutationSnapshot: true,
        undoHint: 'restore the prior cluster state from the auto-snapshot at <previous-snapshot> via `db-cluster restore <file>`',
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
    .description('Export cluster state to JSON backup. Refuses to overwrite an existing output file unless --force is passed.')
    .option('-o, --output <file>', 'Output file path')
    .option('--json', 'Write to stdout as JSON')
    .option('--force', 'Overwrite an existing output file')
    .option('--yes', 'Skip overwrite confirmation prompt (alias for --force when --output points at an existing file)')
    .action(cliCommand(async (opts) => {
        const stores = createLocalCluster(CLUSTER_DIR);
        const { backup } = await import('./ops/backup.js');
        // Wave C1-Amend fix-up (V2-C1-005): wire onProgress to the
        // backup ops contract. Backup walks every record in every
        // store, so the channel is useful for clusters of any size.
        const data = await backup(stores, {
            onProgress: makeProgressRenderer('backup'),
        });
        const json = JSON.stringify(data, null, 2);
        if (opts.output) {
            const outPath = resolve(opts.output);
            // STORES-C-006 / SURFACE-C-007 (Wave C1-Amend): refuse to
            // silently overwrite. The Stores agent owns the upstream
            // ImportConflict-style check; the surface layer adds a
            // simple existence + --force guard so operators don't
            // accidentally clobber a prior backup file.
            if (existsSync(outPath) && !opts.force && !opts.yes) {
                process.stderr.write(
                    `Refusing to overwrite existing file: ${outPath}\n`,
                );
                process.stderr.write(
                    `  → try: pass --force to overwrite, or choose a different --output path.\n`,
                );
                process.exit(1);
            }
            const { writeFileSync } = await import('node:fs');
            writeFileSync(outPath, json, 'utf-8');
            // Wave C1-Amend fix-up (V2-C1-013): success message for
            // `backup -o <file>` belongs on stderr, not stdout. The
            // whole point of -o is to write payload to the file; piping
            // the command (e.g. `db-cluster backup -o foo.json |
            // something`) shouldn't surface human prose on stdin.
            if (!cliQuiet) {
                process.stderr.write(`Backup written to ${opts.output}\n`);
            }
        } else {
            console.log(json);
        }
    }));

program
    .command('restore <file>')
    .description('Restore cluster state from a backup file. DESTRUCTIVE: may overwrite or merge with existing entities/receipts/ledger. Always takes an auto-snapshot before restoring so the prior state is recoverable. Use --dry-run to preview.')
    .option('--json', 'Output as JSON')
    .option('--dry-run', 'Parse the backup file and show what would be restored without mutating')
    .option('--force', 'Skip confirmation prompt (also --yes)')
    .option('--yes', 'Skip confirmation prompt (alias for --force)')
    .action(destructiveCommand(async (file: string, opts: { json?: boolean; dryRun?: boolean }) => {
        const stores = createLocalCluster(CLUSTER_DIR);
        const { restore } = await import('./ops/backup.js');
        const raw = readFileSync(resolve(file), 'utf-8');
        const data = safeJsonParse(raw, 'backup file');
        if (opts.dryRun) {
            // Dry-run path: parse the backup and report what WOULD be
            // restored without invoking the mutation path. The Stores
            // agent owns restore() itself; until it ships a `dryRun`
            // option there, we surface a structural preview here.
            const preview = {
                dryRun: true,
                wouldRestore: {
                    entities: Array.isArray((data as any).entities) ? (data as any).entities.length : 0,
                    events: Array.isArray((data as any).events) ? (data as any).events.length : 0,
                    receipts: Array.isArray((data as any).receipts) ? (data as any).receipts.length : 0,
                    artifacts: Array.isArray((data as any).artifacts) ? (data as any).artifacts.length : 0,
                },
            };
            if (opts.json) {
                console.log(JSON.stringify(preview, null, 2));
            } else {
                console.log('Dry run (no mutation performed):');
                console.log(`  Would restore: ${preview.wouldRestore.entities} entities, ${preview.wouldRestore.events} events, ${preview.wouldRestore.receipts} receipts, ${preview.wouldRestore.artifacts} artifacts`);
            }
            return;
        }
        const result = await restore(stores, data);
        if (opts.json) {
            console.log(JSON.stringify(result, null, 2));
        } else if (!cliQuiet) {
            // Wave C1-Amend fix-up (V2-C1-003): pre-fix the non-JSON
            // branch only printed counts, silently burying per-record
            // errors. STORES-C-003 added .summary + .warnings to the
            // RestoreResult shape but the CLI never read them. Print
            // the canonical summary, then surface per-store errors so
            // operators see the conflict prose.
            console.log(result.summary);
            for (const warning of result.warnings) {
                process.stderr.write(`Warning: ${warning}\n`);
            }
            const errorCategories: Array<[string, string[]]> = [
                ['entities', result.entities.errors],
                ['artifacts', result.artifacts.errors],
                ['events', result.events.errors],
                ['receipts', result.receipts.errors],
                ['staging', result.staging?.errors ?? []],
            ];
            for (const [label, errs] of errorCategories) {
                for (const errMsg of errs) {
                    process.stderr.write(`  ${label}: ${errMsg}\n`);
                }
            }
        }
        // Wave C1-Amend fix-up (V2-C1-003): when ANY per-store error[]
        // was non-empty, the restore did not fully succeed — surface a
        // non-zero exit code so operator CI pipelines can branch. Use
        // typedErrorToExitCode('IMPORT_CONFLICT') = 65 (EX_DATAERR)
        // since restore-error is structurally a data conflict class.
        const totalErrors =
            result.entities.errors.length +
            result.artifacts.errors.length +
            result.events.errors.length +
            result.receipts.errors.length +
            (result.staging?.errors.length ?? 0);
        if (totalErrors > 0) {
            process.exit(typedErrorToExitCode('IMPORT_CONFLICT'));
        }
    }, {
        name: 'restore',
        preMutationSnapshot: true,
        undoHint: 'restore the prior state from the auto-snapshot at <previous-snapshot> via `db-cluster restore <file>`',
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
        // EGRESS-001: idle-client pool errors must not crash the CLI.
        pool.on('error', (err) => console.error(`postgres pool error: ${err.message}`));
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
        // EGRESS-001: idle-client pool errors must not crash the CLI.
        pool.on('error', (err) => console.error(`postgres pool error: ${err.message}`));
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

// ─── SURFACE-C-010 — Shell completion (Wave C1-Amend) ─────────────────────
//
// `db-cluster completion <shell>` prints a completion script the operator
// can `source` (bash/zsh) or dot-source (pwsh). The completion is
// generated by walking the program's registered command tree so it stays
// in sync with the CLI surface — adding a new subcommand auto-flows
// through to the completion script.

const completion = program
    .command('completion <shell>')
    .description('Output a shell-completion script (bash | zsh | pwsh) for db-cluster. Pipe through `source` (bash/zsh) or dot-source (pwsh) to install for the current shell.')
    .action(cliCommand(async (shell: string) => {
        const subcommands = collectSubcommandNames(program);
        const script = generateCompletionScript(shell, subcommands);
        // Completion script goes to stdout (so `source <(db-cluster
        // completion bash)` works). Errors / hints go to stderr.
        process.stdout.write(script);
        process.stderr.write(`\n# To install:\n# bash:  source <(db-cluster completion bash)\n# zsh:   db-cluster completion zsh > "\${fpath[1]}/_db-cluster"\n# pwsh:  db-cluster completion pwsh | Out-String | Invoke-Expression\n`);
    }));
// Reference variable to silence "unused" lint; commander binds the action.
void completion;

/**
 * Walk the commander program tree and collect first-level subcommand
 * names. We don't currently flatten flag names — operators that
 * tab-complete past the subcommand boundary get a "no further
 * suggestions" experience until a future enhancement adds option-name
 * completion. The headline value is "spell `db-cluster <tab>` and see
 * all 30+ verbs" — that part lands here.
 */
function collectSubcommandNames(program: Command): string[] {
    const names: string[] = [];
    for (const cmd of program.commands) {
        names.push(cmd.name());
        for (const sub of cmd.commands) {
            names.push(`${cmd.name()} ${sub.name()}`);
        }
    }
    // Add the global help/exit-code aliases.
    names.push('--help');
    names.push('--version');
    names.push('--help-exit-codes');
    return names;
}

/**
 * Emit a shell-completion script for one of the supported shells.
 *
 * The output is intentionally self-contained — no external dependencies
 * required. Each shell's format follows the standard idiom:
 *   - bash: `complete -F _db_cluster db-cluster`
 *   - zsh: `compdef _db-cluster db-cluster`
 *   - pwsh: `Register-ArgumentCompleter -Native -CommandName ...`
 */
function generateCompletionScript(shell: string, names: string[]): string {
    const topLevel = names.filter((n) => !n.includes(' '));
    if (shell === 'bash') {
        return [
            '# db-cluster bash completion (SURFACE-C-010 — Wave C1-Amend)',
            '_db_cluster() {',
            '  local cur prev words cword',
            '  COMPREPLY=()',
            '  cur="${COMP_WORDS[COMP_CWORD]}"',
            `  local commands="${topLevel.join(' ')}"`,
            '  if [ "$COMP_CWORD" -eq 1 ]; then',
            '    COMPREPLY=( $(compgen -W "$commands" -- "$cur") )',
            '    return 0',
            '  fi',
            '  return 0',
            '}',
            'complete -F _db_cluster db-cluster',
            '',
        ].join('\n');
    }
    if (shell === 'zsh') {
        return [
            '#compdef db-cluster',
            '# db-cluster zsh completion (SURFACE-C-010 — Wave C1-Amend)',
            '_db-cluster() {',
            '  local -a commands',
            `  commands=(${topLevel.map((n) => `'${n}'`).join(' ')})`,
            '  _describe "command" commands',
            '}',
            '_db-cluster "$@"',
            '',
        ].join('\n');
    }
    if (shell === 'pwsh' || shell === 'powershell') {
        return [
            '# db-cluster PowerShell completion (SURFACE-C-010 — Wave C1-Amend)',
            'Register-ArgumentCompleter -Native -CommandName db-cluster -ScriptBlock {',
            '  param($wordToComplete, $commandAst, $cursorPosition)',
            `  $commands = @(${topLevel.map((n) => `'${n}'`).join(', ')})`,
            '  $commands | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {',
            '    [System.Management.Automation.CompletionResult]::new($_, $_, "ParameterValue", $_)',
            '  }',
            '}',
            '',
        ].join('\n');
    }
    // Unknown shell — emit usage to stderr and exit non-zero.
    process.stderr.write(`Unknown shell: ${shell}\n  → try: db-cluster completion bash | zsh | pwsh\n`);
    process.exit(1);
}

// Entry-point guard (Wave S2-A2 — Fix Agent 2): only drive the CLI when
// this module is executed as the program entry point (the `db-cluster` bin
// or `node dist/cli.js …`). When the module is *imported* — e.g. a unit
// test importing `resolveClusterDir` / `renderClusterErrorForCli` for direct
// assertion — `program.parse()` must NOT fire, or commander would parse the
// test runner's argv and `process.exit`. This is a pure additive guard:
// under every existing invocation path (the bin shebang, spawnSync against
// dist/cli.js) the module IS the entry point, so parse() still runs exactly
// as before. Tests gain an import seam without a dist rebuild.
function isCliEntryPoint(): boolean {
    const argvEntry = process.argv[1];
    if (!argvEntry) return false;
    try {
        return realpathSync(argvEntry) === realpathSync(fileURLToPath(import.meta.url));
    } catch {
        // realpath can throw if argv[1] was unlinked mid-run; fall back to a
        // best-effort string compare so the real bin still launches.
        return argvEntry === fileURLToPath(import.meta.url);
    }
}

if (isCliEntryPoint()) {
    program.parse();
}

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
