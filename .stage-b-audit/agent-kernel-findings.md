# Stage B Audit — Kernel Domain — db-cluster

**Lens:** Proactive Health
**Date:** 2026-05-27
**HEAD audited:** 71ba55c

## Files audited

- `src/kernel/cluster-kernel.ts`
- `src/kernel/policy-enforced-kernel.ts`
- `src/kernel/command-queue.ts`
- `src/kernel/commands.ts`
- `src/kernel/errors.ts`
- `src/kernel/provenance.ts`
- `src/kernel/receipts.ts`
- `src/kernel/cluster-kernel-interface.ts`
- `src/kernel/index.ts`
- `src/policy/policy-engine.ts`
- `src/policy/redactor.ts`
- `src/policy/store-output-sanitizers.ts`
- `src/policy/default-policies.ts`
- `src/policy/index.ts`
- `src/resolver/cluster-resolver.ts`
- `src/resolver/index.ts`
- `src/provenance/trace-builder.ts`
- `src/provenance/index.ts`
- `src/retrieval/retrieval-planner.ts`
- `src/retrieval/index.ts`
- `src/uri/cluster-uri.ts`
- `src/uri/index.ts`
- `src/types/policy.ts`
- `src/types/command.ts`
- `src/types/provenance-event.ts`
- `src/types/provenance-graph.ts`
- `src/types/evidence-bundle.ts`
- `src/types/index-record.ts`
- `src/types/entity.ts`
- `src/types/artifact.ts`
- `src/types/receipt.ts`
- `src/types/health.ts`
- `src/types/index.ts`
- `src/indexing/content-indexer.ts`
- `src/indexing/tokenizer.ts`
- Cross-domain confirmation reads only: `src/contracts/index-store.ts`, `src/ops/doctor.ts`, `src/ops/verify.ts`

## Severity rollup

| Severity | Count |
|---|---:|
| CRITICAL (proactive) | 0 |
| HIGH | 6 |
| MEDIUM | 10 |
| LOW | 7 |
| should-have-been-stage-a | 3 |

## Findings

### KERNEL-B-001 — Verb-scoped allow policies are unreachable at commit time

**Severity:** HIGH
**Category:** defensive
**File:** `src/kernel/policy-enforced-kernel.ts:543-546`
**Description:** `commitMutation` calls `this.enforce('commit_command', { commandVerb: undefined })`. The policy engine treats an underspecified `commandVerb` as "refuse to match allow policies" (`src/policy/policy-engine.ts:121-127` — `matchCommandVerbs` returns `effect === 'deny'` when the request omits the field). Net effect: an operator who writes a verb-scoped allow rule (e.g. "allow commit_command for verb=ingest_artifact only") gets a policy that NEVER fires at the commit gate — the call collapses to default-deny or to a verb-agnostic allow. Verb-scoped deny rules still fire (correctly), but the allow side is silently broken. The kernel can trivially load the command by `commandId` first and pass its verb forward.
**Recommendation:** In `commitMutation`, fetch the command (or peek its verb) before enforcement and pass `commandVerb: command.verb`. Same for `compensateMutation` (line 554 — `compensate_command` enforcement also lacks verb context). Add a typed test that registers an allow-only-for-verb policy and exercises commit.
**Evidence:**
```
async commitMutation(commandId: string, actorId: string): Promise<CommitMutationResult> {
    this.enforce('commit_command', { commandVerb: undefined });
    return this.kernel.commitMutation(commandId, actorId);
}
```

### KERNEL-B-002 — `redactArtifact` `summarize` and `strip` are indistinguishable (asymmetric rule semantics)

**Severity:** HIGH
**Category:** observability
**File:** `src/policy/redactor.ts:33-43`
**Description:** Carry-over of AGG-005 (asymmetric/incomplete strip-vs-mask divergence). For `artifact_content`, `case 'summarize'` returns `{ ...redacted, storagePath: REDACTED }` — byte-for-byte the same as `case 'strip'`. `case 'hash'` keeps `contentHash` exposed but `case 'mask'` extends the redaction to `filename`. Net effect: policy authors writing `behavior: 'summarize'` get strip behavior; writing `'hash'` leaves the content hash visible while `'mask'` extends to filename — the policy vocabulary's semantic contract is not honored. Same issue in `redactReceipt` (line 102-109 — `summarize` and `strip` both clear `affectedIds`; `hash` only changes `resultSummary` to `REDACTED`, leaving `affectedIds` exposed). This is observability because operators reason about redaction by behavior name; the runtime contract no longer matches.
**Recommendation:** Either (a) document the equivalences and remove the implementations that collapse, or (b) make each behavior actually distinct. Add a `default:` arm to each `switch (rule.behavior)` block so a new behavior literal (or a runtime-tampered rule) doesn't silently return `undefined` from a function typed `Artifact`. Per-target rule matrix in `policy/redactor.ts` header doc.
**Evidence:**
```
case 'strip': return { ...redacted, storagePath: REDACTED };
case 'mask':  return { ...redacted, storagePath: REDACTED, filename: `${REDACTED}.${...}` };
case 'summarize': return { ...redacted, storagePath: REDACTED };  // === strip
case 'hash':  return { ...redacted, storagePath: `${REDACTED_HASH_PREFIX}${artifact.contentHash}` };
```

### KERNEL-B-003 — Redaction-rule switches return `undefined` on unknown behavior (silent type hole)

**Severity:** HIGH
**Category:** defensive
**File:** `src/policy/redactor.ts:33-43, 53-66, 76-89, 100-109`
**Description:** All four redactor switches (`redactArtifact`, `redactEntity`, `redactCommand`, `redactReceipt`) cover the four current behaviors (`strip|mask|summarize|hash`) without a `default:` arm. TypeScript compiles cleanly because the enum is exhausted at the type level, but at runtime — if a policy file is loaded from disk / DB / network with a typo'd behavior, OR if the behavior union is extended without updating callers — the switch falls through and returns `undefined`. The function signature claims `Artifact`/`Entity`/etc., so callers get a phantom undefined where they expect a redacted object, and downstream `_.attributes` / `_.payload` accesses throw `TypeError`. Compile-time exhaustiveness is not equivalent to runtime safety here because redaction rules cross the trust boundary (default policies, trust-zone redactionRules, user policies — all parsed as `RedactionRule[]`).
**Recommendation:** Add `default:` arm to each switch that either throws a typed `ClusterError('Unknown redaction behavior: ' + rule.behavior, 'INVALID_REDACTION_RULE')` or falls back to the safest behavior (`strip`). Combine with KERNEL-B-002 fix.
**Evidence:** Each of the four functions has identical pattern — `switch (rule.behavior) { case 'strip': ...; case 'mask': ...; case 'summarize': ...; case 'hash': ...; }` with no fallback.

### KERNEL-B-004 — `update_entity` index refresh queries store without `limit`, O(N) memory growth path

**Severity:** HIGH
**Category:** degradation
**File:** `src/kernel/cluster-kernel.ts:495`
**Description:** The `update_entity` arm in `commitMutation` does `await this.stores.index.search({ text: '', metadata: {} })` with NO `limit` field. The `IndexQuery` contract (`src/contracts/index-store.ts:32`) declares `limit?: number` as optional — adapters may interpret missing limit as "no cap". When the index grows to 100K+ records, every single `update_entity` commit pulls the entire record set into memory just to find the 1-2 records matching the entity ID for stale removal. Symmetric concern in `indexStatus` (line 928 `search({ limit: 100000 })`) and `listStaleRecords` (line 1020 — same 100k hardcoded limit). These magic limits silently cap operability and have no observable failure signal — the cluster appears to work, until a 100,001st record is added and `indexStatus`/`listStaleRecords` silently drop tail.
**Recommendation:** Two-part: (a) For `update_entity`, replace the full-table scan with a `sourceId`-indexed lookup contract method on `IndexStore` (e.g. `findBySource(sourceId, sourceStore)`) — kernel's job is to express intent, not to scan. (b) For `indexStatus` / `listStaleRecords`, paginate or document the cap explicitly and emit a `degraded` health check when count exceeds the cap. The 100k literal is currently invisible to operators.
**Evidence:**
```
const staleRecords = await this.stores.index.search({ text: '', metadata: {} });  // no limit
```

### KERNEL-B-005 — `cause.message` leaked into `mutation_orphaned` ledger detail unredacted

**Severity:** HIGH
**Category:** observability
**File:** `src/kernel/cluster-kernel.ts:129`
**Description:** When a post-mutation receipt write fails, `recordOrphanMutation` persists the underlying error into the ledger via `error: cause.message`. The cause is typically a thrown error from `ledger.append` / `appendReceipt` / `saveCommand`, which (per KERNEL-R010 / R2-010 carry-over) frequently embeds full filesystem paths verbatim. Net effect: the ledger — which `listReceipts` / `traceProvenance` / `retrieveBundle.provenanceEvents` all surface to AI-facing trust zones — accumulates ledger events with sensitive operator-host paths in the `detail.error` field. The redaction surface in `policy-enforced-kernel.ts:retrieveBundle` strips `detail` for opaque ledger events but `traceProvenance` / `inspectCommand` surfaces still pass through. This is observability vs information-disclosure: the operator wants the error for debugging, but the ledger stores it forever and surfaces it through every read path.
**Recommendation:** Sanitize `cause.message` before persisting (a redactor pass that masks absolute paths to relative or hashed form), OR mark `detail.error` as a structured field that the per-event redactor (`redactProvenanceEvent`) handles symmetrically to `detail.payload`. Pair with KERNEL-R010 fix; this is the propagation point.
**Evidence:**
```
await recordProvenance(this.stores.ledger, 'mutation_orphaned', 'kernel', subjectId, subjectStore, {
    ...detail, commandId, error: cause.message, errorName: cause.name,
});
```

### KERNEL-B-006 — TraceBuilder leaks entity identifiers into `label` and `metadata` (AGG-008 active)

**Severity:** HIGH
**Category:** observability
**File:** `src/provenance/trace-builder.ts:104, 115, 168, 180, 295, 328`
**Description:** AGG-008 carry-over confirmed present. `TraceBuilder.addNode` is called with `label` strings like `${entity.kind}: ${entity.name}`, `${event.action} by ${event.actorId}`, `${artifact.filename} v${artifact.version}`, and metadata objects that include raw `actorId`, `kind`, `name`, `filename`, `subjectId`. Downstream `redactProvenanceActors` (redactor.ts:185-207) does string-level `replace(/by\s+[\w\-@.]+/g, ...)` mangling on the label, which only catches actor identifiers and only when they're space-separated — entity names with hyphens, dots, emails, or different separators may not match. Entity names and filenames are not mangled at all. The structured fix is to never bake identifiers into the label in the first place — store them in `metadata` and have render-time consumers apply policy.
**Recommendation:** Refactor `addNode` to take a structured `{ kind, name }` or `{ filename, version }` and synthesize the label at render time AFTER redaction. Apply `redactProvenanceActors` AND a sibling `redactProvenanceLabels` that operates on the structured metadata, not on regex-mangled strings. Add `entity_name` / `artifact_filename` as new `RedactionTarget` literals or fold them into existing targets.
**Evidence:**
```
this.addNode(uri, 'entity', 'canonical', true, `${entity.kind}: ${entity.name}`, { kind: entity.kind, name: entity.name, ... });
this.addNode(eventUri, 'provenance_event', 'ledger', true, `${event.action} by ${event.actorId}`, { actorId: event.actorId, ... });
```

### KERNEL-B-007 — V2-004: `ingest_artifact` commit arm casts `payload.content` as `Buffer` after JSON round-trip (silent corruption)

**Severity:** should-have-been-stage-a (correctness gap — but proactive lens makes it HIGH)
**Category:** defensive
**File:** `src/kernel/cluster-kernel.ts:528-533`
**Description:** Carry-over V2-004 confirmed present. The `ingest_artifact` arm casts `readyCommand.payload as { ..., content: Buffer, ... }` and then calls `stores.artifact.ingest({ filename, content, mimeType })`. But `CommandQueue.persist` (`command-queue.ts:73`) serializes the entire command tree via `JSON.stringify(arr, null, 2)`. A `Buffer` JSON-serializes to `{ type: 'Buffer', data: [byte, byte, ...] }`. On `load()` (line 60), `JSON.parse` reconstructs that as a plain object, NOT a Buffer. The cast at line 530 silently lies — at runtime `content.length` works (the object has a `data` array), but `artifact.ingest` likely treats the value as a Buffer and either writes garbage to disk or throws an opaque store error. This only fires on the propose+commit lifecycle path (kernel helper `ingestArtifact` skips this arm), so test coverage of the helper path doesn't catch it. Classified `should-have-been-stage-a` because the Stage A bug/security lens should have caught silent content corruption; raised to HIGH from proactive lens because the failure mode is silent and the fix is structural.
**Recommendation:** Two viable fix scopes: (a) Reject `Buffer` in `proposeCommand`'s payload validation — require a base64 `content` string and a separate `decodeBufferFields` helper that's called at commit time, OR (b) Make `CommandQueue` Buffer-aware (custom replacer/reviver in JSON.stringify/parse). (a) is preferred — the propose-validate-approve-commit lifecycle should never carry transient `Buffer`s across persistence boundaries. The Wave A3 v2 ensemble missed this because no Stage-A lens exercised the round-trip.
**Evidence:**
```
case 'ingest_artifact': {
    const { filename, content, mimeType } = readyCommand.payload as {
        filename: string;
        content: Buffer;   // ← cast lies after JSON round-trip
        mimeType: string;
    };
    const artifact = await this.stores.artifact.ingest({ filename, content, mimeType });
```

### KERNEL-B-008 — `CommandVerb` union includes `'propose_mutation'` but switch arm rejects it (dead union member)

**Severity:** MEDIUM
**Category:** future-proofing
**File:** `src/types/command.ts:62`, `src/kernel/cluster-kernel.ts:599-603`, `src/kernel/commands.ts:236`
**Description:** Carry-over KERNEL-R016 / R2-011 confirmed. The `CommandVerb` union declares `'propose_mutation'` as a valid verb (`types/command.ts:62`). `validatePayloadForVerb` accepts it (`commands.ts:236` — falls into `default:` arm with `passed: true`). But `commitMutation`'s switch covers only `update_entity | create_entity | ingest_artifact | link_evidence | reindex` (and `compensate` via the fast-track path). A command proposed with `verb: 'propose_mutation'` would pass propose+validate, then hit the `default:` arm in commit (line 599) and silently fail with `Unknown verb: propose_mutation` — an error message that contradicts the type system. Proactive concern: future-proofing. A new contributor seeing `propose_mutation` in the union assumes the verb is implemented and uses it; the failure surfaces as a confusing "unknown verb" rejection.
**Recommendation:** Either (a) remove `'propose_mutation'` from `CommandVerb` (it's a kernel verb, not a command verb — the union should mirror what `commitMutation` actually accepts), OR (b) add an explicit switch arm that rejects with a clearer error. (a) is cleaner. Coordinate with Surface domain since `mcp/server.ts:288` references `cluster_propose_mutation` as a TOOL name; verify no MCP path sets `verb: 'propose_mutation'` on the command itself.
**Evidence:**
```
// types/command.ts:57-64
export type CommandVerb =
    | 'ingest_artifact' | 'create_entity' | 'update_entity'
    | 'link_evidence' | 'propose_mutation'  // ← no switch arm in commitMutation
    | 'reindex' | 'compensate';

// cluster-kernel.ts:599-603 (default arm)
default: {
    const rejected = markRejected(readyCommand, actorId, `Unknown verb: ${readyCommand.verb}`);
```

### KERNEL-B-009 — `redactIndexSourceUri` is dead code; type-system claims index_source_uri rules are enforced

**Severity:** MEDIUM
**Category:** future-proofing
**File:** `src/policy/redactor.ts:303-308`
**Description:** Carry-over V2-011 confirmed. `redactIndexSourceUri` is exported from `policy/index.ts:28`, declared as the canonical handler for `RedactionTarget = 'index_source_uri'` (types/policy.ts:192), but ripgrep across `src/` shows ZERO call sites. Policy authors writing `target: 'index_source_uri'` rules see them silently no-op. The type system tells them the target is valid; the runtime says nothing. Future-proofing concern: an extension surface that lies about coverage will keep growing.
**Recommendation:** Either (a) wire it: `PolicyEnforcedKernel.findSources` / `retrieveBundle` index-record loops should apply this rule to the records they surface. OR (b) delete the function and remove `'index_source_uri'` from `RedactionTarget` so the type system reflects actual enforcement. (b) is lower-risk if the original design intent has been superseded by per-source filtering (KERNEL-003 fix). Verify there's no legacy SDK doc/example that promises this target works.
**Evidence:**
```
export function redactIndexSourceUri(record: { sourceId: string; sourceStore: string }, rules: RedactionRule[]): { sourceId: string; sourceStore: string } {
    const uriRules = rules.filter((r) => r.target === 'index_source_uri');
    if (uriRules.length === 0) return record;
    return { ...record, sourceId: REDACTED, sourceStore: record.sourceStore };
}
// ZERO callers in src/
```

### KERNEL-B-010 — `CommandQueueCorruptError.message` embeds full filesystem path verbatim

**Severity:** MEDIUM
**Category:** observability
**File:** `src/kernel/errors.ts:80-92`
**Description:** Carry-over KERNEL-R010 / R2-010 confirmed. The error message constructed in `CommandQueueCorruptError` includes the full `filePath` as raw text in the message, plus the inner cause's message. The error is thrown by `CommandQueue.load()` and bubbles up through every `getCommand` / `saveCommand` call — meaning any API surface that exercises the command queue with a corrupt file can surface this error to a remote/AI caller. Operators want the path; AI-facing callers / log shippers may not. Same shape in `ReceiptFailedError` (line 58 — uses `cause.message` which often contains paths).
**Recommendation:** Stage observability tradeoff: keep the full path in a structured field (`filePath` property — already there at line 78), but make the `.message` use a relative path or sanitized form. Surface the full path through `error.filePath` so operators inspecting the typed error get it, but loggers serializing `.message` don't. Same fix for `ReceiptFailedError.cause.message` propagation — sanitize at the error-construction boundary.
**Evidence:**
```
super(
    `Command queue file is unreadable or corrupt: ${filePath} (${causeMsg}). ` +
        `Pending commands cannot be loaded safely. Recovery: restore from a backup, ` +
        `delete the file to start fresh (pending commands will be lost), ` +
        `or inspect the file by hand.`,
    'COMMAND_QUEUE_CORRUPT',
);
```

### KERNEL-B-011 — `PolicyDeniedError.message` leaks policy ID + reason to caller

**Severity:** MEDIUM
**Category:** observability
**File:** `src/kernel/policy-enforced-kernel.ts:40-46`
**Description:** Carry-over V2-012 confirmed. `PolicyDeniedError.message` is `Policy denied: ${decision.capability} — ${decision.reason} (policy: ${decision.matchedPolicyName})`. For audit-internal use, this is exactly what an operator wants. But the error is thrown from every `enforce()` call, and the stringified `.message` propagates through SDK / MCP / CLI to callers across trust zones. An external-trust-zone principal performing a denied read learns: which capability was checked, the human-readable policy reason (likely the policy author's intent description), and the policy name. That is enough to start enumerating the policy graph. Observability vs information-disclosure tradeoff: internal callers want the diagnostic; external callers should get an opaque "denied" token + a correlation ID.
**Recommendation:** Two-stage message: keep the full diagnostic on `error.decision` (structured, typed `PolicyDecision`) and replace `.message` with a generic `Policy denied (capability: <cap>, correlation: <uuid>)`. Add a `toAuditLog()` method that yields the full diagnostic for operator log shippers. Surface-side audit should re-emit the structured field, not the message text.
**Evidence:**
```
super(
    `Policy denied: ${decision.capability} — ${decision.reason} (policy: ${decision.matchedPolicyName})`,
    'POLICY_DENIED',
);
```

### KERNEL-B-012 — `KERNEL-R2-008` hardening of `detail.targetStore` validation is point-fix, not universal

**Severity:** MEDIUM
**Category:** defensive
**File:** `src/kernel/policy-enforced-kernel.ts:438-449`
**Description:** Carry-over KERNEL-R2-008 confirmed: hardening is correct at the `retrieveBundle` ledger-event filtering path, but it's a single point-fix. Other call paths read `event.detail` without validating its claim shape — most notably `explainIndex` for ledger-source records (line 698-703), `traceProvenance` (line 800-803), and `traceObject` (line 491+) all flow event details through redactor functions that don't gate on the claim. If a future code path constructs a policy decision based on `detail.targetStore` outside `retrieveBundle`, it will repeat the original V2-008 vulnerability. The hardening should be a helper (`validateLedgerClaim(detail): { targetStore?: KnownStore }` ) used at every site that reads attacker-controlled `detail.*` and feeds it to policy.
**Recommendation:** Extract `ALLOWED_STORES` and the validation pattern into a single helper in `policy/` or a new `policy/ledger-claim-validator.ts`. Call sites that read `event.detail.targetStore` / `event.detail.subjectStore` / any `event.detail.*` that feeds policy decisions must go through it. Audit-only here; the proactive concern is that the next "policy gate over ledger event details" call site will silently re-introduce the leak.
**Evidence:**
```
// retrieveBundle: hardened
const ALLOWED_STORES = new Set(['canonical', 'artifact', 'index', 'ledger']);
const rawTarget = e.detail?.targetStore;
let targetStore: ...;
if (rawTarget === undefined) { targetStore = undefined; }
else if (typeof rawTarget === 'string' && ALLOWED_STORES.has(rawTarget)) { ... }
else { continue; }
// No equivalent helper used at other detail-reading call sites.
```

### KERNEL-B-013 — `proposeMutation` casts `input.targetStore as any` past the policy boundary

**Severity:** MEDIUM
**Category:** defensive
**File:** `src/kernel/policy-enforced-kernel.ts:520-526`
**Description:** `enforce('propose_mutation', { ownerStore: input.targetStore as any, commandVerb: input.verb })` casts `input.targetStore` to `any`, bypassing TypeScript's check that the value matches the policy engine's `ownerStore` union (`canonical | artifact | index | ledger`). The `ProposeMutationInput.targetStore` is typed `Command['targetStore']` which is the same union, so the cast is currently safe — but proposal input flows in from MCP/SDK/CLI surfaces where validation may be incomplete (`mcp/server.ts:595` uses `args.targetStore as any` and feeds it directly here). A malformed targetStore reaches the policy engine via the `as any` lane. The `matchStores` evaluator does `match.stores.includes(request.ownerStore)` which would silently false-negative an attacker-controlled value, defaulting to default-deny — but the more proactive concern is that the cast is an inhibitor for future hardening (similar to KERNEL-B-012's lesson).
**Recommendation:** Replace `as any` with a type guard that validates against the known union: `const allowed: ReadonlySet<Command['targetStore']> = new Set(['canonical','artifact','index','ledger']); if (!allowed.has(input.targetStore as any)) throw new ClusterError(...);`. Apply at the public API boundary (PolicyEnforcedKernel.proposeMutation), not buried inside the policy engine.
**Evidence:**
```
async proposeMutation(input: ProposeMutationInput): Promise<Command> {
    this.enforce('propose_mutation', {
        ownerStore: input.targetStore as any,   // ← cast bypass
        commandVerb: input.verb,
    });
```

### KERNEL-B-014 — `update_entity` index refresh is non-atomic delete-then-insert (empty-projection window)

**Severity:** MEDIUM
**Category:** degradation
**File:** `src/kernel/cluster-kernel.ts:495-505`
**Description:** Parallel to KERNEL-R2-003 (which closed the empty-index window in `performIndexRebuild` by using `replaceAll`), the `update_entity` arm in `commitMutation` removes stale index records and then `await stores.index.index(...)`. Between the `for (const old of matching) { await this.stores.index.remove(old.id); }` loop and the subsequent `index(...)` call, a concurrent reader sees the entity with NO index record. For most adapters this is a millisecond window; under high contention or a slow ledger write it's longer. The Wave A2 lesson learned in `performIndexRebuild` (atomic swap) was not applied here.
**Recommendation:** Add a `replaceForSource(sourceId, sourceStore, newRecord)` atomic contract method on `IndexStore` and use it from `update_entity`. Falls under the same fix scope as KERNEL-B-004 (the contract grew a `replaceAll`; it should grow a `replaceForSource` too).
**Evidence:**
```
const matching = staleRecords.filter((r) => r.sourceId === entityId && r.sourceStore === 'canonical');
for (const old of matching) {
    await this.stores.index.remove(old.id);   // empty window opens
}
await this.stores.index.index({...});         // closes here
```

### KERNEL-B-015 — `compensateMutation` writes original payload into ledger detail unredacted (V2-014)

**Severity:** MEDIUM
**Category:** observability
**File:** `src/kernel/cluster-kernel.ts:735-770`
**Description:** Carry-over V2-014 confirmed. When compensating, the kernel constructs `compPayload = { originalCommandId, reason, originalVerb: original.verb, originalPayload: original.payload }`. This payload becomes the compensating command's payload and is persisted to the command queue (via JSON, with the same Buffer round-trip risk as V2-004). The compensation provenance event at line 769 carries `{ compensatingCommandId, reason }` — but the receipt itself stores the compensating command (line 773), and `commitMutation`'s receipt emit pattern writes `payload: readyCommand.payload` into the `mutation_committed` detail. That means the original payload travels through the ledger via the compensating command. Symmetric to V2-014: the compensation surface has asymmetric redaction — the per-receipt redactor handles the receipt's own payload, but the original command's payload is now embedded inside the new command's payload, two levels deep.
**Recommendation:** Redact / hash / summarize `originalPayload` at construction time inside `compensateMutation`. Document the compensation surface as a redaction boundary: any field that flows from the original command into the compensating command is policy-controlled. Pair with KERNEL-B-005 (cause.message propagation).
**Evidence:**
```
const compPayload = compensatingPayload ?? {
    originalCommandId, reason,
    originalVerb: original.verb,
    originalPayload: original.payload,   // ← raw payload travels into compensating command
};
```

### KERNEL-B-016 — `redactProvenanceActors` regex misses identifiers with email/UUID separators

**Severity:** MEDIUM
**Category:** observability
**File:** `src/policy/redactor.ts:190-192`
**Description:** `redactLabel` does `label.replace(/by\s+[\w\-@.]+/g, ...)`. The character class `[\w\-@.]` covers `[A-Za-z0-9_]` plus `- @ .`, which catches `actor@host.tld` and `actor-name` but NOT identifiers with other separators (slashes, colons, plus signs) — and more importantly, the regex requires the `by ` prefix to appear before the identifier. Labels constructed differently (e.g. trace-builder line 143: `Entity ${entity.kind}/${entity.name} exists without supporting provenance`) are NOT mangled. The redactor pretends to mask actors in labels but only catches the `${event.action} by ${event.actorId}` pattern. Pair with KERNEL-B-006 — the structural fix is to never embed actors in labels; the regex is a brittle band-aid.
**Recommendation:** Track this as part of KERNEL-B-006's structural refactor. As a tactical fix, the regex should ALSO scan for identifiers in `metadata.actorId` / `metadata.kind` / `metadata.name` / `metadata.filename` consistently. Current `redactMetadataActors` only covers actor-flavored fields.
**Evidence:**
```
const redactLabel = (label: string): string => {
    return label.replace(/by\s+[\w\-@.]+/g, `by ${REDACTED}`);
};
```

### KERNEL-B-017 — `validateCommand` runs structural checks but does not guard against `payload` containing Buffer/binary

**Severity:** MEDIUM
**Category:** defensive
**File:** `src/kernel/commands.ts:30-80, 209-216`
**Description:** `validatePayloadForVerb` for `ingest_artifact` accepts a payload with `filename` OR `artifactId` (line 210). It does NOT check whether `content` is present, nor whether it's a `Buffer` instance (vs a JSON-deserialized object). Combined with KERNEL-B-007 (V2-004), this means the validation gate happily passes commands that will silently corrupt at commit time. The `payload_shape` check for `ingest_artifact` is too lenient — it accepts a partial payload that the commit arm will then try to cast.
**Recommendation:** Tighten `validatePayloadForVerb` for `ingest_artifact`: when payload includes `content`, require it to be a `Buffer` instance (`Buffer.isBuffer(payload.content)`) or a string with a documented encoding (`encoding: 'base64' | 'utf-8'`). Reject ambiguous content shapes at validate time so they don't reach the queue and round-trip.
**Evidence:**
```
case 'ingest_artifact': {
    const hasFilename = typeof payload.filename === 'string' || typeof payload.artifactId === 'string';
    return { name: 'payload_shape', passed: hasFilename, ... };
}
// No check on content shape — Buffer or deserialized object both pass.
```

### KERNEL-B-018 — Default `default-policies.ts` policies do not enumerate `update_entity` capability

**Severity:** LOW
**Category:** future-proofing
**File:** `src/policy/default-policies.ts:42-60`
**Description:** The `proposer-propose` role allows capabilities `discover_existence, read_owner_truth, read_derivative, trace_provenance, read_receipts, read_command, explain_retrieval, propose_mutation, validate_command`. A proposer can propose any mutation including `update_entity`. There's no separate gate. Future-proofing: as `Capability` grows, the default proposer grant will grow with it implicitly — there's no scoping. Compare to AGG-005 architectural pattern: denylist (default deny + explicit allow) is correct, but the explicit allows here are coarse-grained. A future contributor adding a `delete_entity` capability gets default-deny correctly, but the proposer ALSO gets `propose_mutation` allowed by default — a proposer can propose a delete and the system will accept the proposal.
**Recommendation:** Add `commandVerbs` constraint to the `proposer-propose` policy so proposer-allow is scoped to specific verbs. Currently a proposer can call `proposeMutation` with ANY verb, including future verbs they shouldn't have. Wider lesson: extension-surface defaults should be conservative.
**Evidence:**
```
{
    id: 'proposer-propose',
    match: { principals: ['proposer'], capabilities: [..., 'propose_mutation', 'validate_command'] },
    decision: 'allow',
    // No `commandVerbs` constraint → proposer can propose any verb.
}
```

### KERNEL-B-019 — `evaluatePolicy` URI auto-derive silently swallows malformed URIs

**Severity:** LOW
**Category:** observability
**File:** `src/policy/policy-engine.ts:183-194`
**Description:** When `request.ownerStore` is omitted but `resourceUri` is present, `evaluatePolicy` tries to `parseClusterUri` and fall back to "leave the request alone" on parse error (line 192). Silent fallback is correct for graceful degradation, but the operator gets no signal. A typo'd policy URI pattern (e.g. `cluster://canonica/x` vs `canonical`) results in store-scoped policies being silently bypassed. There's no observability hook — no counter, no warning. Combine with the underspecification-handling fallback (`matchStores` returns `effect === 'deny'`) and the policy fails-closed, but the operator has no way to learn their URI is wrong.
**Recommendation:** Either (a) emit a structured warning event on the cluster (`ledger.append({ action: 'policy_uri_parse_failed', ... })` — but careful, that's recursive into the policy engine), OR (b) add a typed `parseStats` return path on `evaluatePolicy` that callers can surface. Tactical: counters via a metric hook (lower priority — db-cluster doesn't yet have a metrics surface).
**Evidence:**
```
} catch {
    // Malformed URI — leave the request alone and let downstream evaluation handle it.
}
```

### KERNEL-B-020 — `parseClusterUri` accepts arbitrary characters in id segment (including `/`)

**Severity:** LOW
**Category:** defensive
**File:** `src/uri/cluster-uri.ts:27`
**Description:** `URI_REGEX = /^cluster:\/\/([a-z]+)\/(.+)$/`. The `.+` for the id segment matches greedily — including `/`. A URI like `cluster://canonical/foo/bar/baz` parses successfully with `id = 'foo/bar/baz'`. Whether that's intentional or accidental depends on the store contract. For local adapters that pass the id into a filesystem path, this opens a path-traversal lane (`../../../etc/passwd` type attacks). For SQL adapters it's likely harmless. The kernel itself doesn't dereference IDs, but it passes them to adapters — so the kernel domain's defensive choice is whether to constrain the URI regex or rely on adapter input validation.
**Recommendation:** Tighten the id regex to `[A-Za-z0-9_\-]+` (matches randomUUID format and most adapter ID shapes) and document it. If adapters need exotic IDs, opt-in via a separate constructor. Coordinate with the adapter domain since this is a contract change.
**Evidence:**
```
const URI_REGEX = /^cluster:\/\/([a-z]+)\/(.+)$/;
// .+ allows slashes, dots, anything — including ../, : on windows, etc.
```

### KERNEL-B-021 — `ResolveError` is a plain `Error`, not a `ClusterError` subclass

**Severity:** LOW
**Category:** defensive
**File:** `src/resolver/cluster-resolver.ts:20-28`
**Description:** Every other domain error in the kernel inherits from `ClusterError` (`errors.ts:1-9`) which gives it a `.code` field for stable matching. `ResolveError` is a plain `Error` with no code. Callers cannot do `if (err instanceof ClusterError && err.code === 'RESOLVE_NOT_FOUND')` — they have to instanceof-check `ResolveError` specifically, which couples the caller to the resolver module. The error class also can't be picked up by error-handling middleware that filters on `ClusterError`.
**Recommendation:** Make `ResolveError extends ClusterError` and add a `'RESOLVE_NOT_FOUND'` code. Symmetric to `NotFoundError` (`errors.ts:11-16`) which already does this — actually, `ResolveError` could just be replaced with `NotFoundError`.
**Evidence:**
```
export class ResolveError extends Error {   // ← should be ClusterError
    constructor(public readonly uri: string, message: string) {
        super(message);
        this.name = 'ResolveError';
    }
}
```

### KERNEL-B-022 — `ClusterUriError` is also a plain `Error`, not `ClusterError`

**Severity:** LOW
**Category:** defensive
**File:** `src/uri/cluster-uri.ts:87-92`
**Description:** Same issue as KERNEL-B-021. URI parse failures throw a plain `Error` with no stable code. Code paths that want to handle "this URI is malformed vs not found" differently have to instanceof-check the module-local class.
**Recommendation:** Same fix as KERNEL-B-021 — extend `ClusterError` with code `'INVALID_URI'`.
**Evidence:**
```
export class ClusterUriError extends Error {
    constructor(message: string) { super(message); this.name = 'ClusterUriError'; }
}
```

### KERNEL-B-023 — `Receipt.id` is missing from the Receipt interface

**Severity:** LOW
**Category:** future-proofing
**File:** `src/types/receipt.ts:5-12`
**Description:** The `Receipt` interface declares `id, commandId, committedAt, resultSummary, affectedIds, provenanceEventId`. But the redactor (`redactor.ts:107-108`) returns `{...receipt, resultSummary: REDACTED}` and accesses `receipt.affectedIds.map(() => REDACTED)`. The `redactReceipt` function is fine, but the interface doesn't carry an `owner: 'receipt'` field like other store types. Other types use the `owner` field for URI derivation (`uri/cluster-uri.ts:73-85 uriForObject`). Receipts can't currently be derived to URIs through `uriForObject` because their owner is `'receipt'` but the type doesn't declare it. Minor consistency gap — surfaces only when someone tries to use the generic URI-deriver on a receipt.
**Recommendation:** Add `owner: 'receipt'` field on the Receipt interface and emit it from `appendReceipt`. Update `uriForObject`'s store map to include `receipt`. Low priority — receipts are addressed via `cluster://receipt/<id>` URIs already, just not through this helper.
**Evidence:**
```
export interface Receipt {
    id: string;
    commandId: string;
    committedAt: string;
    resultSummary: string;
    affectedIds: string[];
    provenanceEventId: string;
    // No `owner: 'receipt'` field, unlike Entity / Artifact / ProvenanceEvent / IndexRecord
}
```

### KERNEL-B-024 — `markCommitted` accepts a string `committedBy` parameter without sanitization

**Severity:** LOW
**Category:** defensive
**File:** `src/kernel/commands.ts:119-129`
**Description:** `committedBy: committedBy ?? command.proposedBy` — accepts any string and embeds it directly into the Command record. That string flows into the ledger via `mutation_committed` provenance, into receipts via `resultSummary` indirectly, and into trace labels via the redactor regex. There's no validation that `committedBy` is a known principal ID, a UUID, or even a non-empty string. A misbehaving caller (e.g. SDK with a broken trust-zone propagation) could write `\n[INJECTED LOG LINE]\n` into the actor field and corrupt log-shipping pipelines. Symmetric concern for `markRejected`, `markCompensated`, `proposeCommand` — all accept actorId-shaped strings without validation.
**Recommendation:** Add a lightweight actor-id validator at the kernel boundary (e.g. `[\w\-@.]+` and length cap 256). Don't trust transport-layer validation. Pair with the KERNEL-B-016 / KERNEL-B-006 fixes — label/log injection are the same family of concern.
**Evidence:**
```
export function markCommitted(command: Command, committedBy?: string): Command {
    ...
    return { ...command, status: 'committed', committedAt: ..., committedBy: committedBy ?? command.proposedBy };
}
```

## Carry-over verification matrix

| ID | Present? | Proactive severity | Fix scope (one line) | New file:line if moved |
|---|---|---|---|---|
| AGG-005 | yes | HIGH (KERNEL-B-002 + KERNEL-B-003) | Add default arms; document/repair behavior equivalences; denylist→allowlist contract is the longer fix | src/policy/redactor.ts:33-110 |
| AGG-008 | yes | HIGH (KERNEL-B-006) | Refactor addNode to use structured metadata + render-time labels; new redaction targets for entity_name/artifact_filename | src/provenance/trace-builder.ts:104,168,295 |
| V2-004 | yes (Buffer round-trip silent corruption) | should-have-been-stage-a / HIGH from proactive lens (KERNEL-B-007) | Reject Buffer in propose payload OR Buffer-aware CommandQueue serialization | src/kernel/cluster-kernel.ts:528-533, src/kernel/command-queue.ts:73 |
| V2-011 | yes (dead code confirmed by ripgrep) | MEDIUM (KERNEL-B-009) | Wire into findSources/retrieveBundle OR delete + remove from RedactionTarget union | src/policy/redactor.ts:303-308 |
| V2-012 | yes (full diagnostic in .message) | MEDIUM (KERNEL-B-011) | Generic message + structured decision field for audit; correlation ID for callers | src/kernel/policy-enforced-kernel.ts:36-46 |
| V2-014 | yes (originalPayload travels into compensating command) | MEDIUM (KERNEL-B-015) | Redact/hash originalPayload at compensateMutation construction time | src/kernel/cluster-kernel.ts:735-740 |
| V2-015 | partial (per-source filter present in findSources + retrieveBundle, but ledger branch in compensateMutation/commit emits raw original_payload — see V2-014) | MEDIUM | Wrap compensateMutation provenance write with redaction pass | src/kernel/cluster-kernel.ts:763-770 |
| KERNEL-R2-008 | yes hardened in retrieveBundle only | MEDIUM (KERNEL-B-012) | Extract validateLedgerClaim helper; apply at all detail-reading policy sites | src/kernel/policy-enforced-kernel.ts:438-449 |
| KERNEL-R010 / R2-010 | yes (full filesystem paths in .message) | MEDIUM (KERNEL-B-010 + propagation in KERNEL-B-005) | Sanitize message at error-construction boundary; keep raw path on structured field | src/kernel/errors.ts:80-92, cluster-kernel.ts:129 |
| KERNEL-R016 / R2-011 | yes (CommandVerb includes propose_mutation but no switch arm) | MEDIUM (KERNEL-B-008) | Remove propose_mutation from CommandVerb union OR add explicit rejection arm | src/types/command.ts:62, src/kernel/cluster-kernel.ts:599-603 |
| mutation_orphaned operator visibility (doctor + verify) | yes — both doctor.ts and verify.ts emit a count check; rendered in HealthCheck.message strings as "${orphanCount} orphaned mutation event(s) recorded" | n/a (verified in ops domain, out of kernel scope) | Doctor/verify both render the count; not silent. Confirmed at src/ops/doctor.ts:218-249 and src/ops/verify.ts:158-189. The promise in cluster-kernel.ts:106-111 is honored. | (out of domain) |

## Domain summary

The kernel domain after Wave A3 has cleanly closed orphan-mutation propagation, double-enforce existence oracles, and atomic index swap on rebuild. The proactive lens surfaces two related themes the v2 ensemble systematically missed.

**Theme 1 — Lifecycle data flow does not respect type promises.** Commands traverse JSON persistence (CommandQueue) but the type system claims fields like `content: Buffer` survive the round-trip (V2-004 / KERNEL-B-007 / KERNEL-B-017). Compensation propagates raw `originalPayload` into a new command (V2-014 / KERNEL-B-015). Error messages embed paths that flow into ledger details (KERNEL-B-005). Each individual cast-without-validate compiles cleanly; the proactive shape is "the propose-validate-commit lifecycle is not a redaction boundary, and nobody guards it as one." Fix scope is structural — Buffer-aware persistence OR a payload-shape validator at validateCommand.

**Theme 2 — Defense surfaces are point-fixes, not pattern-fixes.** KERNEL-R2-008 hardens one ledger-detail read site; KERNEL-B-012 shows three others remain unguarded. `redactArtifact`/`redactEntity`/etc. lack default arms (KERNEL-B-003). The verb-scoped policy gate only works for verb-explicit call sites (KERNEL-B-001). The pattern is "fix the reported bug, miss the family." The v2 ensemble's gap is structural: it does not scan for OTHER call sites that match the same pattern as the bug found. A "pattern-fix verifier" — given a fix, look for siblings — would catch this family.

## Top 3 HIGH findings (compressed for summary)

- **KERNEL-B-001 — Verb-scoped allow policies unreachable at commit** (`policy-enforced-kernel.ts:543-546`)
- **KERNEL-B-002 / KERNEL-B-003 — redactor switches have indistinguishable cases and no default arm** (`redactor.ts:33-110`)
- **KERNEL-B-007 — `ingest_artifact` commit arm casts post-JSON-round-trip `content` as `Buffer` (V2-004 silent corruption)** (`cluster-kernel.ts:528-533`)
