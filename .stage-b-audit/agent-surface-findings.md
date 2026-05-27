# Stage B Audit — Surface Domain — db-cluster

**Lens:** Proactive Health
**Date:** 2026-05-27
**HEAD audited:** 71ba55c

## Files audited

- `src/sdk/cluster-sdk.ts` (411 lines)
- `src/sdk/index.ts` (3 lines)
- `src/mcp/server.ts` (846 lines)
- `src/mcp/sanitize.ts` (98 lines)
- `src/mcp/index.ts` (2 lines)
- `src/cli.ts` (1184 lines)
- `src/integrations/repo-knowledge/ingest.ts` (407 lines)
- `src/integrations/repo-knowledge/mapping.ts` (141 lines)
- `src/integrations/repo-knowledge/compare-retrieval.ts` (147 lines)
- `src/integrations/repo-knowledge/update-workflow.ts` (113 lines)
- `src/dashboard/dashboard-model.ts` (111 lines)
- `src/dashboard/inspector-data.ts` (342 lines)
- `src/dashboard/ops-model.ts` (130 lines)
- `dashboard/index.html` (211 lines)
- `dashboard/ClusterTruthInspector.jsx` (902 lines)
- `dashboard/components/CommandPreviewPanel.jsx` (186 lines)
- `dashboard/components/OperationsPanel.jsx` (129 lines)
- `dashboard/components/PolicyViewToggle.jsx` (113 lines)
- `dashboard/lib/apply-redaction.js` (72 lines)
- `dashboard/lib/apply-redaction.d.ts` (21 lines)
- `dashboard/demo-data.js` (287 lines)
- `dashboard/README.md` (37 lines)
- `src/policy/store-output-sanitizers.ts` (89 lines, read for cross-reference)

## Severity rollup

| Severity | Count |
|---|---:|
| HIGH | 5 |
| MEDIUM | 13 |
| LOW | 9 |
| should-have-been-stage-a | 3 |

## Findings (HIGH then MEDIUM then LOW)

### SURFACE-B-001 — `cluster_find_sources` returns index records WITHOUT `sanitizeIndexRecordForOutput`, leaking `metadata`
**Severity:** HIGH
**Category:** defensive
**File:** `src/mcp/server.ts:471-476`
**Description:** Every MCP arm that returns an *individual* index record (e.g. `cluster_resolve` line 562, `cluster_inspect_command` etc.) routes through `sanitizeIndexRecordForOutput`. The list path through `cluster_find_sources` does not — it spreads each `IndexRecord` with `...r, _sourceType: 'derivative', _sourceStore: 'index'`. The `IndexRecord.metadata` field mirrors owner-truth content (per the file header of `src/policy/store-output-sanitizers.ts:11-15`: "Metadata mirrors owner-truth content and may include sensitive fields"). With no policies configured (the ~614-test baseline path), `find_sources` returns raw IndexRecord with `metadata`, defeating the unconditional MCP-output baseline that exists for the resolve path. AGG-001 (Wave A3 fix-up) closed the same hole on the singular path but left the list path uncovered.
**Recommendation:** Wrap each record: `result.indexRecords.map((r) => ({ ...sanitizeIndexRecordForOutput(r), _sourceStore: 'index', _note: 'Index records are derived from owner-store truth. They may be stale.' }))`. Add a regression test in the SURFACE family asserting `find_sources` output never carries the `metadata` field for any index record. Same shape as AGG-001 / AGG-003.
**Evidence:**
```ts
// src/mcp/server.ts:471-476
indexRecords: result.indexRecords.map((r: any) => ({
    ...r,                                  // ← raw IndexRecord, includes metadata
    _sourceType: 'derivative',
    _sourceStore: 'index',
    _note: 'Index records are derived from owner-store truth. They may be stale.',
})),
```

### SURFACE-B-002 — `db-cluster policy explain` / `policy test` IGNORE `.db-cluster/policies.json` and silently evaluate against `DEFAULT_POLICIES`
**Severity:** HIGH
**Category:** observability
**File:** `src/cli.ts:829, 865`
**Description:** Both `policy explain` and `policy test` hard-code `{ policies: DEFAULT_POLICIES, trustZones: DEFAULT_TRUST_ZONES }` regardless of whether `.db-cluster/policies.json` exists. An operator who has configured custom policies and runs `db-cluster policy explain --principal foo --capability read_owner_truth` gets a misleading decision that has no relationship to what their cluster will actually enforce. The CLI is the operator's primary dry-run interface for policy reasoning — this is the canonical sponsor for the "operator clarity vs ergonomic default" observability concern flagged in V2-005. The result is a confidence trap: operator thinks they've validated their policy state, but they've validated the *defaults*.
**Recommendation:** Mirror `getKernel()` pattern: read `loadPolicyConfig()`; if a `policies.json` exists, use its `policies` + `trustZones` + `visibilityRules`. Otherwise fall back to DEFAULTs and print a stderr warning ("no policies.json configured — evaluating against DEFAULT_POLICIES"). The MCP boundary's `cluster_policy_explain` (server.ts:715) correctly delegates to `sdk.policyExplain` which uses the SDK's `policyOptions` — the CLI is the divergent surface.
**Evidence:**
```ts
// src/cli.ts:821-829
const decision = evaluatePolicy({ ... }, {
    policies: DEFAULT_POLICIES,            // ← ignores .db-cluster/policies.json
    trustZones: DEFAULT_TRUST_ZONES,
});
```

### SURFACE-B-003 — MCP error responses leak `err.message` unfiltered to host
**Severity:** HIGH
**Category:** defensive
**File:** `src/mcp/server.ts:815-820`
**Description:** The MCP request handler's catch arm returns `JSON.stringify({ error: err.message, _meta: { operation: 'error' } })` with no filtering. `err.message` from kernel internals can carry filesystem paths (`ENOENT: no such file or directory, open '/var/lib/...'`), JSON-parse positions, or raw store-adapter detail. An MCP host receiving such an error learns about the server's filesystem layout and internal state. This is an unconditional leak path regardless of whether policies are configured. Parallel concern to SURFACE-R005 (the env-var validator masks internal detail with a structured fail-closed) — handleTool's catch is the symmetric outbound surface that should mask in the same way.
**Recommendation:** Map error to a stable code + sanitized message. Either: (a) introduce typed errors (e.g. `ClusterError` subclasses) and serialize `{ code, publicMessage }`; or (b) include `err.constructor.name` and a one-sentence canned message keyed off the error class, with the raw `err.message` logged to stderr for operator debug. Wrap the catch in a `redactError(err)` helper that strips absolute paths, raw command payloads, and policy decision detail.
**Evidence:**
```ts
// src/mcp/server.ts:815-820
} catch (err: any) {
    return {
        content: [{ type: 'text', text: JSON.stringify({ error: err.message, _meta: { operation: 'error' } }) }],
        isError: true,
    };
}
```

### SURFACE-B-004 — CLI commands lack top-level try/catch — kernel exceptions print raw stack traces
**Severity:** HIGH
**Category:** observability + graceful degradation
**File:** `src/cli.ts:184-212 (ingest), 217-239 (entity create), 242-260 (link), 263-288 (find), 312-332 (propose), 504-524 (receipts), 526-595 (index commands), 672-715 (retrieve), 717-728 (explain-retrieval), 730-749 (trace), 751-759 (why), 761-776 (lineage), 778-797 (trace-bundle), 987-1008 (doctor), 1010-1028 (verify), 1030-1074 (rebuild), 1076-1093 (backup)`
**Description:** Of ~30 CLI subcommands, only ~10 wrap the kernel call in try/catch (commit/approve/reject/compensate/inspect-command/validate/etc.). The remaining ~20 (ingest, entity create, link, find, propose, receipts, index rebuild/status/explain/stale, retrieve, explain-retrieval, trace, why, lineage, trace-bundle, doctor, verify, rebuild, backup) let kernel exceptions propagate to the top-level Node handler. Result: raw stack traces in operator-facing terminal output, polluted exit codes (sometimes 1, sometimes the unhandled-rejection default), no clean operator-facing error message. This is the worst kind of failure for shell-script integration (CI/automation cannot reliably trap errors). 
**Recommendation:** Adopt a uniform wrapper: `async function safeAction(fn) { try { await fn(); } catch (err: any) { console.error(`${commandName} failed: ${err.message}`); process.exit(1); } }`. Or migrate every `.action(async (...) => { ... })` body to wrap the kernel call. The lifecycle commands (commit/approve/reject/compensate/inspect-command/validate) demonstrate the correct shape — propagate it.
**Evidence:** Example — `db-cluster ingest`:
```ts
// src/cli.ts:199-211 — no try/catch around kernel.ingestArtifact
const result = await kernel.ingestArtifact({
    filename, content, mimeType, actorId: operator.actorId,
});
console.log(`Ingested: ${filename}`);
// ...if kernel throws, raw stack hits stderr
```

### SURFACE-B-005 — `ClusterTruthInspector.jsx` crashes when given unknown URI; no error state
**Severity:** HIGH
**Category:** defensive + graceful degradation
**File:** `dashboard/ClusterTruthInspector.jsx:608-613`
**Description:** Component does `const focal = OBJECTS[uri]; const ownerStore = STORES.find((s) => s.id === focal.owner);` without a guard. If `uri` is not in OBJECTS (which happens whenever an external snapshot is loaded and a relationship URI points to an object not in the snapshot), `focal` is undefined and `focal.owner` throws TypeError. There is no fallback render. Sibling components in `dashboard/components/` (`OperationsPanel`, `CommandPreviewPanel`) all have `if (!opsData) return null;` style guards; `ClusterTruthInspector` is the only one without.
**Recommendation:** Add `if (!focal) return <div className="p-6 mono text-danger">Object not found: <code>{uri}</code></div>;` immediately after the lookup. Additionally, guard against missing `focal.related`, `focal.attributes` (already absent on artifact/index_record types — `focal.attributes?.definition` is partially guarded at line 755 but `Object.entries(focal.attributes)` at line 783 will throw if attributes is undefined).
**Evidence:**
```jsx
// dashboard/ClusterTruthInspector.jsx:608-609
const focal = OBJECTS[uri];                          // ← may be undefined
const ownerStore = STORES.find((s) => s.id === focal.owner);  // ← throws TypeError
```

### SURFACE-B-006 — CLI `loadPolicyConfig` does NO structural validation on `.db-cluster/policies.json`
**Severity:** MEDIUM
**Category:** defensive
**File:** `src/cli.ts:64-74`
**Description:** Symmetric gap to MCP's SURFACE-R005 fix. The MCP server's `buildSDKOptions` (server.ts:73-168) added `validatePrincipal()` + fail-closed for both `DB_CLUSTER_PRINCIPAL` and the policies-file principal field. The CLI's `loadPolicyConfig` (cli.ts:64-74) does `JSON.parse(raw) as PolicyConfig` — no `validatePrincipal` call, no structural check on `policies[]`, `trustZones[]`, or `visibilityRules[]`. A malformed `policies.json` (e.g. principal missing `roles`, policies field is a non-array) silently slips into `PolicyEnforcedKernel`, which may then trust-zone-not-found-branch into bypass behavior. Confirmed carry-over (V2-008 in dispatch).
**Recommendation:** Lift `validatePrincipal` to a shared module (e.g. `src/policy/principal-validation.ts`) and import from both MCP server and CLI. Apply structural validation on the parsed config: `principal` if present must validatePrincipal; `policies` if present must be array of objects with `id`/`capability`/`effect`; `trustZones` if present must be array. Fail closed with a clear stderr message + exit(1) — same fail-shape as MCP.
**Evidence:**
```ts
// src/cli.ts:64-74
function loadPolicyConfig(): PolicyConfig | null {
    if (!existsSync(POLICIES_FILE)) return null;
    try {
        const raw = readFileSync(POLICIES_FILE, 'utf-8');
        const parsed = JSON.parse(raw) as PolicyConfig;   // ← no shape check
        return parsed;
    } catch (err: any) { ... }
}
```

### SURFACE-B-007 — `ClusterSDK.policyEnforced: boolean` is `public readonly` — probing signal + bypass branching surface
**Severity:** MEDIUM
**Category:** future-proofing
**File:** `src/sdk/cluster-sdk.ts:131`
**Description:** Direct carry-over of SURFACE-R009 / R2-008. The flag exposes internal enforcement state to any SDK consumer. Consumers can read it and branch ("if policies aren't enforced, skip the principal check") — a documented anti-pattern that is now compileable. Tests reference it (test/policy-surface.test.ts, wave-a3-surface-regression.test.ts), but no production code outside tests should. The visibility is too wide for what is essentially internal state. Stage A judged this LOW because no consumer was branching on it; Stage B proactive lens says the existence of the branch point is itself the future-proofing risk.
**Recommendation:** Make `policyEnforced` private + expose `isPolicyEnforced(): boolean` only via a debug/introspection helper that emits a stderr warning when called outside `NODE_ENV=test`. OR remove entirely and have tests construct a known-policy SDK instead. The current pattern (public readonly boolean) is the most permissive option and rewards bypass branching.
**Evidence:**
```ts
// src/sdk/cluster-sdk.ts:131
/** True when this SDK wrapped the kernel with PolicyEnforcedKernel. */
public readonly policyEnforced: boolean;
```

### SURFACE-B-008 — `SDK.retrieveBundle` returns raw `EvidenceBundle` containing unsanitized `indexRecords` + `provenanceEvents` to non-policy-enforced consumers
**Severity:** MEDIUM
**Category:** defensive
**File:** `src/sdk/cluster-sdk.ts:195-197`
**Description:** `SDK.retrieveBundle` is a pure pass-through. The returned `EvidenceBundle` includes `indexRecords: IndexRecord[]` (with `metadata`) and `provenanceEvents: ProvenanceEvent[]` (with `actorId`/`detail.payload`). With policy-enforced kernel, `PolicyEnforcedKernel.retrieveBundle` applies redaction inline (per the grep result on `redactProvenanceEvent`). With raw `ClusterKernel`, the bundle returns owner-store-truth raw. The SDK's doctrine in `resolve()` (lines 218-219) explicitly says: "the returned object is sanitized inline before it leaves the SDK boundary" — `retrieveBundle` violates this doctrine for the same fields. AGG-002 made `resolve()` unconditional; `retrieveBundle` was not extended. The MCP boundary saves the day by dropping these fields from `cluster_retrieve_bundle`, but any direct SDK consumer (programmatic API, examples/ scripts) sees the leak.
**Recommendation:** Apply `sanitizeIndexRecordForOutput` over `bundle.indexRecords` and `sanitizeProvenanceEventForOutput` over `bundle.provenanceEvents` before SDK return — unconditional, mirroring the AGG-002 fix shape. Adds a 5-line transform; preserves all existing typings on the sanitized side. Document the "5 store types sanitize at SDK boundary unconditionally" rule once in the file header.
**Evidence:**
```ts
// src/sdk/cluster-sdk.ts:195-197
async retrieveBundle(query: string, options?: { limit?: number }): Promise<EvidenceBundle> {
    return this.kernel.retrieveBundle(query, options);   // ← raw passthrough
}
```

### SURFACE-B-009 — CLI silently substitutes `INTERNAL_TRUSTED_PRINCIPAL` BEFORE constructing SDK; SDK no-principal warning suppressed
**Severity:** MEDIUM
**Category:** observability
**File:** `src/cli.ts:90, 634`
**Description:** Direct V2-005 carry-over. The SDK has a well-engineered warning path (cluster-sdk.ts:159-162) for the no-principal case. The CLI defeats it: at line 90 (`getKernel`) and line 634 (`resolve`) the CLI substitutes `INTERNAL_TRUSTED_PRINCIPAL` BEFORE handing options to the SDK constructor, so `options.principal !== undefined` and the warning is never emitted. Result: operators using the CLI with policies configured but no principal NEVER see the least-privilege warning. The MCP server does NOT substitute (server.ts:161-165 passes principal undefined when not set, letting the SDK warn). Architectural asymmetry — same input, different observability.
**Recommendation:** Two options:
1. **Operator clarity (preferred):** CLI passes `principal: config.principal` (i.e. undefined when not set in policies.json) to ClusterSDK and lets the SDK warn. Match MCP server shape exactly.
2. **Ergonomic default:** CLI continues substituting but emits its own stderr warning at the substitution site, so operator clarity is preserved.
Option 1 reduces code paths to one truth (the SDK's warning); option 2 preserves CLI ergonomics but adds duplication.
**Evidence:**
```ts
// src/cli.ts:90
const principal = config.principal ?? INTERNAL_TRUSTED_PRINCIPAL;   // ← substitutes before SDK sees options
// src/cli.ts:634
principal: config!.principal ?? ClusterSDK.INTERNAL_TRUSTED_PRINCIPAL,
```

### SURFACE-B-010 — MCP tool inputs have no runtime validation beyond JSON-schema types (no length caps, no negative-`limit` guard, no URI shape check)
**Severity:** MEDIUM
**Category:** defensive
**File:** `src/mcp/server.ts:466-764 (all tool arms)`
**Description:** Every arm does `args.query as string`, `args.limit as number | undefined`, `args.uri as string` with no runtime guards. The MCP framework's JSON-schema validator covers required + type but doesn't constrain: (a) string length (no upper bound on `query`); (b) limit range (negative limit, `Number.MAX_SAFE_INTEGER`, NaN); (c) URI shape (the `uri` field passes through unchecked despite `src/uri/` having `isClusterUri()`). A malformed limit `-1` flows to kernel.findSources where it may produce unexpected behavior. A query of 10MB may DoS the index. The SDK's `resolve()` also has no guard (cluster-sdk.ts:238) — `uri` is passed raw to the resolver.
**Recommendation:** Introduce a per-tool argument validator (lightweight; could reuse zod or hand-rolled), invoked at the top of each `case` arm: validate string non-empty, length-bound `query` (e.g. 4096 chars), enforce `limit` ≥ 0 and ≤ 1000, and require `isClusterUri(uri)` for any tool that accepts a URI. Fail with a stable, sanitized error code (not raw `err.message`).
**Evidence:**
```ts
// src/mcp/server.ts:468
const result = await sdk.findSources(args.query as string, args.limit as number | undefined);
// no length check on query, no bound check on limit
```

### SURFACE-B-011 — `OperationsPanel.jsx` does NOT render `mutation_orphaned` count — health surface blind to load-bearing observability signal
**Severity:** MEDIUM
**Category:** observability
**File:** `dashboard/components/OperationsPanel.jsx:72-83 (provenance section)`, `src/dashboard/ops-model.ts:118-126 (provenance shape)`, `dashboard/demo-data.js:278 (data carries it)`
**Description:** Wave A2 introduced `mutation_orphaned` ledger events on receipt failure. Wave A3 fixes (V1-007, STORES-R2-003) wired `verify()` and `doctor()` to consume these events. The dashboard ops surface — the most operator-facing window into cluster health — does NOT render `mutation_orphaned` count anywhere. `OperationsPanel.jsx` provenance section renders only `receipts` and `events`. `demo-data.js:278` already carries `orphanEvents: 0` in the `provenanceHealth` shape; `src/dashboard/ops-model.ts:118-126` has `totalEvents` and `totalReceipts` only. The kernel's primary post-Wave-A3 observability signal has no view-layer surface.
**Recommendation:** Three coordinated edits:
1. `src/dashboard/ops-model.ts` — extend `ProvenanceHealth` with `orphanEvents: number` (count from `stores.ledger.listEvents({ action: 'mutation_orphaned' })`) and `degradedReason?: string` (mirrors verify.ts L154-189's degraded signal).
2. `dashboard/components/OperationsPanel.jsx:72-83` — add a third row to provenance section: `<div className="flex justify-between"><span className="text-warn">orphaned</span><span className="text-ink-200">{opsData.provenanceHealth?.orphanEvents ?? 0}</span></div>`. Style as warn when > 0.
3. Add a repair suggestion when orphans > 0 ("Investigate `mutation_orphaned` events — receipt write failed; entity state may be out of sync with ledger").
**Evidence:**
```jsx
// dashboard/components/OperationsPanel.jsx:72-83 — provenance section
{/* Provenance health */}
<div>
    <div className="...">provenance</div>
    <div className="space-y-1.5 mono text-[11px]">
        <div className="flex justify-between">
            <span>receipts</span><span>{opsData.provenanceHealth?.receipts}</span>
        </div>
        <div className="flex justify-between">
            <span>events</span><span>{opsData.provenanceHealth?.events}</span>
        </div>
        {/* NO orphan_events / mutation_orphaned row */}
```

### SURFACE-B-012 — `cli.ts` `inspect-command` dumps raw Command JSON including `payload` (may include large/sensitive content)
**Severity:** MEDIUM
**Category:** defensive
**File:** `src/cli.ts:495-497`
**Description:** `inspect-command` does `console.log(JSON.stringify(cmd, null, 2))` on the raw Command object. The Command's `payload` field is verb-specific and may contain: entity attributes (sensitive user data), `ingest_artifact` Buffer content (encoded as `{type:'Buffer', data:[byte array]}` — bulky and obscures terminal output), or supportingArtifacts arrays. No sanitization, no field stripping. CLI's `inspect-command` is one of the most-used commands for debugging — defaults should hide payload by default, expose with `--show-payload`.
**Recommendation:** Mirror MCP's `formatCommandOutput` (server.ts:769-785) at the CLI: dump structural metadata by default (id, verb, targetStore, status, proposedBy, dates, approvals), expose `--show-payload` flag to include payload. For Buffer payloads, summarize as `{ payloadKind: 'Buffer', size: N }` rather than dump bytes.
**Evidence:**
```ts
// src/cli.ts:495-497
const cmd = await kernel.inspectCommand(commandId);
console.log(JSON.stringify(cmd, null, 2));   // ← raw payload including Buffer bytes
```

### SURFACE-B-013 — Hard-coded version strings (`'0.1.0'`) in src/cli.ts:157 and src/mcp/server.ts:794
**Severity:** MEDIUM
**Category:** future-proofing
**File:** `src/cli.ts:157`, `src/mcp/server.ts:794`
**Description:** Both surfaces hardcode the version string. When package.json bumps to 0.2.0, these will silently report stale versions (CLI's `--version` flag and MCP server's `{ name, version }` capability handshake). MCP hosts and CLI consumers use these for compatibility branching — a wrong version is a real interoperability hazard.
**Recommendation:** Import from package.json at build time. Either: (a) use `await import('../../package.json', { with: { type: 'json' } })` (ESM JSON imports), (b) generate `src/version.ts` from package.json in a build step, or (c) use `process.env.npm_package_version` when run via npm scripts (least reliable but easy). Prefer (b) for reproducibility.
**Evidence:**
```ts
// src/cli.ts:157
.version('0.1.0')
// src/mcp/server.ts:794
{ name: 'db-cluster', version: '0.1.0' },
```

### SURFACE-B-014 — `parseInt(opts.limit)` without radix and NaN check; malformed `--limit foo` returns NaN
**Severity:** MEDIUM
**Category:** defensive
**File:** `src/cli.ts:270, 512, 679, 724, 741, 770, 787, 1018`
**Description:** Eight call sites use `parseInt(opts.limit)` (or `opts.depth`, `opts.sample`) with no radix and no NaN handling. A user passing `--limit foo` produces `NaN`, which then flows into kernel as `limit: NaN` — kernel may behave unpredictably (return all rows, throw later, etc.). Defensive coding gap and inconsistent with surface-as-trust-boundary discipline.
**Recommendation:** Wrap with a parsing helper:
```ts
function parseIntArg(value: string, name: string, dflt: number): number {
    const n = parseInt(value, 10);
    if (Number.isNaN(n) || n < 0) {
        console.error(`Invalid --${name}: ${value} (expected non-negative integer)`);
        process.exit(1);
    }
    return n;
}
```
Use it at every call site. Also: pass radix `10` to all `parseInt` to avoid the (rare) octal-leading-zero quirk.
**Evidence:**
```ts
// src/cli.ts:270
const result = await kernel.findSources({ query, limit: parseInt(opts.limit) });   // ← no radix, no NaN check
// src/cli.ts:1018
const health = await verify(stores, { sampleLimit: parseInt(opts.sample, 10) });   // radix present here only
```

### SURFACE-B-015 — `dashboard/components/*.jsx` not loaded by `dashboard/index.html` — three dashboard components dead in the demo
**Severity:** MEDIUM
**Category:** future-proofing
**File:** `dashboard/index.html`, `dashboard/components/CommandPreviewPanel.jsx`, `dashboard/components/OperationsPanel.jsx`, `dashboard/components/PolicyViewToggle.jsx`
**Description:** `dashboard/index.html` loads only `ClusterTruthInspector.jsx` (line 194). The three component files in `dashboard/components/` (with `window.OperationsPanel = ...` etc. globals) are never sourced by the demo. They're shipped to npm via the `files: ["dashboard/"]` glob but the README doesn't document them as consumable. This is the worst of both worlds for future-proofing: (a) the demo never exercises them so regressions land silently; (b) external consumers who *do* load them hit the ESM race (SURFACE-R2-009) since `apply-redaction.js` is an async module load and there's no readiness signal. The dashboard README claims "the UI consumes DashboardObject" but `ClusterTruthInspector.jsx` uses a divergent inline schema (`owner` instead of `ownerStore`, `truth` instead of `sourceType`, flat `related[]` instead of `relationships[]`).
**Recommendation:** Either:
1. **Promote:** load `<script src="./components/OperationsPanel.jsx" data-presets="react">` etc. in index.html, drive them from `demo-data.js`'s shapes (already DashboardObject-shaped), AND solve the ESM race for `applyRedaction` by switching from `<script type="module">` to a sync script that exposes the export via a global before component scripts load.
2. **Demote:** Move components/ to `dashboard/_extra/` and exclude from the npm tarball via `files` — make explicit that they're not part of the shipped UI surface.
The current half-state ("present, untested, unreferenced") is the future-proofing trap that grows worst with time.
**Evidence:**
```html
<!-- dashboard/index.html — no reference to components/ -->
<script type="text/babel" data-presets="react" src="ClusterTruthInspector.jsx"></script>
```
```jsx
// dashboard/ClusterTruthInspector.jsx:30-32 — flat schema
'cluster://entity/concept/federated-truth': {
    owner: 'canonical',                                       // ← DashboardObject calls this ownerStore
    truth: 'source',                                          // ← DashboardObject calls this sourceType
```

### SURFACE-B-016 — Dashboard ESM race: `window.applyRedaction` assigned by async `<script type="module">`; bootstrap loop only waits for `ClusterTruthInspector`
**Severity:** MEDIUM
**Category:** defensive
**File:** `dashboard/index.html:188-208`
**Description:** Direct SURFACE-R2-009 carry-over. The ESM script at line 188 (`import { applyRedaction } from './lib/apply-redaction.js'`) is asynchronous (modules are deferred + executed after parser finishes). The mount loop at line 197-208 polls `window.ClusterTruthInspector` but never checks `window.applyRedaction`. As-shipped, `ClusterTruthInspector` doesn't call applyRedaction so the race is latent. But any future addition of `PolicyViewToggle` (which is documented in PolicyViewToggle.jsx:99-105 to expect `window.applyRedaction`) will hit the race intermittently. The risk is not theoretical for consumers who follow the README and load policy views.
**Recommendation:** Either:
1. Switch the ESM import to a sync, non-module script that wraps applyRedaction in an IIFE and assigns the global synchronously. (Simpler but requires bundling the ESM into a UMD shim.)
2. Add `window.applyRedaction` to the readiness poll at line 197-208 ("if both ClusterTruthInspector AND applyRedaction are available, mount; else retry").
3. Make components depend on applyRedaction via a Promise/event ("applyRedaction-ready") rather than a global. This is the most robust, but the largest refactor.
**Evidence:**
```html
<!-- dashboard/index.html:188-191 -->
<script type="module">
    import { applyRedaction } from './lib/apply-redaction.js';
    window.applyRedaction = applyRedaction;                                  /* async assignment */
</script>
<!-- dashboard/index.html:197-208: bootstrap loop checks only ClusterTruthInspector */ -->
```

### SURFACE-B-017 — `src/integrations/repo-knowledge/ingest.ts` file-header comment misrepresents policy-gate behavior
**Severity:** MEDIUM
**Category:** observability (doc-drift)
**File:** `src/integrations/repo-knowledge/ingest.ts:34-37, 239-240`
**Description:** Direct SURFACE-R2-013 carry-over. The file-header doctrine block (lines 34-37) states: "the policy gate fires for both `ClusterKernel` and `PolicyEnforcedKernel` callers". This is false for raw `ClusterKernel` — raw ClusterKernel has no policy layer; the `ingestArtifact` call goes through without policy evaluation. `warnIfNoPolicy` at line 157 + 106-114 already emits a runtime warning confirming this. The line-244 inline comment ("policy gate fires for both...") repeats the same misleading claim. The KERNEL-001 wrappers ensure `PolicyEnforcedKernel.ingestArtifact` invokes the policy gate; they do NOT add a policy layer to raw `ClusterKernel`.
**Recommendation:** Rewrite the doctrine block:
> "When the caller wraps with `PolicyEnforcedKernel`, the KERNEL-001 wrappers ensure the policy gate fires on `ingestArtifact` even though the lifecycle path (propose/validate/approve/commit) is unsafe for Buffer payloads today. When the caller passes a raw `ClusterKernel`, no policy layer is engaged — `warnIfNoPolicy()` emits a runtime stderr warning so this is observable, not silent."
Update line 244 similarly.
**Evidence:**
```ts
// src/integrations/repo-knowledge/ingest.ts:34-37
 * which writes garbage). Until the kernel's `ingest_artifact` arm rehydrates
 * Buffer payloads, artifact ingest stays on the direct `kernel.ingestArtifact`
 * helper. KERNEL-001 added wrappers for ingestArtifact on
 * PolicyEnforcedKernel (KERNEL-R003 ≡ SURFACE-R001/R002), so the policy gate
 * fires whether the caller passes a `ClusterKernel` or `PolicyEnforcedKernel`.   /* ← false for raw ClusterKernel */
```

### SURFACE-B-018 — Surface code has no documented deprecation policy
**Severity:** MEDIUM
**Category:** future-proofing
**File:** `src/sdk/`, `src/mcp/`, `src/cli.ts` (whole surfaces)
**Description:** Direct SURFACE-R012 carry-over. No `@deprecated` JSDoc, no `DeprecationWarning` emissions, no documented migration path from v0.1 → v0.2 surface changes. SDK exports 4 type interfaces and 1 class; MCP exports 16 tools with annotations; CLI exposes ~30 subcommands. None carry a migration story. When v0.2 changes a tool name or SDK method signature, consumers have no signal — they discover the break at runtime.
**Recommendation:** Establish three conventions:
1. **JSDoc `@deprecated`** on any export slated for removal, with `@see` pointing to the replacement.
2. **Runtime deprecation warnings** on deprecated MCP tools: include `_meta.deprecated: 'Removing in v0.3; use cluster_xxx instead'` and emit `console.warn` once per process.
3. **CHANGELOG.md migration section** for every minor version: list renamed/removed exports + tool names + CLI commands, with migration sketch.
Add a `MIGRATION.md` at repo root listing v0.x → v0.y transitions (currently absent).
**Evidence:** No `@deprecated` matches in `src/sdk/`, `src/mcp/`, `src/cli.ts`. No "deprecation" in dashboard README or main README's surface sections.

### SURFACE-B-019 — `sourceOnly` toggle in `ClusterTruthInspector` hides index lane but doesn't hide the focal-to-ledger drop line if focal is an index record
**Severity:** LOW
**Category:** defensive
**File:** `dashboard/ClusterTruthInspector.jsx:262-365`
**Description:** When `sourceOnly` is true, the index lane is shown at 25% opacity but the focal node still draws if its owner is `index` (line 333 only filters non-focal nodes), and the focal-to-ledger drop line (line 326) still draws from that focal. The toggle's stated intent ("hiding index projections") is partially honored — a user who navigates to an index-record URI and flips `sourceOnly` sees a stranded focal node in a dimmed lane with a drop line going to ledger. Mild UX inconsistency; defensible because "the user picked this focal" but at minimum the badge should change.
**Recommendation:** When `sourceOnly && focal.owner === 'index'`, show a banner: "Focal is a derivative; toggle off to view its source." OR auto-navigate to the `derived-from` related on toggle-on.
**Evidence:**
```jsx
// dashboard/ClusterTruthInspector.jsx:333
if (sourceOnly && p.owner === 'index') return null;     /* only filters non-focal */
```

### SURFACE-B-020 — Dead import in CLI: `formatClusterUri, parseClusterUri, isClusterUri` imported but never used
**Severity:** LOW
**Category:** future-proofing
**File:** `src/cli.ts:9`
**Description:** Imports never referenced in CLI. Linter dead-code; also a signal that URI shape validation (which `isClusterUri` would provide) was intended but never wired. Could be removed OR wired as part of SURFACE-B-010 input-validation work.
**Recommendation:** Either remove the import OR (preferred) actually use `isClusterUri` in the `resolve`, `trace`, `why`, `lineage`, `trace-bundle` subcommands' input validation. Letting the import linger is a comprehension hazard.
**Evidence:**
```ts
// src/cli.ts:9
import { formatClusterUri, parseClusterUri, isClusterUri } from './uri/index.js';   /* never referenced */
```

### SURFACE-B-021 — `dashboard/README.md` claims UI consumes `DashboardObject` but demo uses divergent schema
**Severity:** LOW
**Category:** observability (doc-drift)
**File:** `dashboard/README.md:36`, `dashboard/ClusterTruthInspector.jsx:30-95`
**Description:** README:36 — "The UI consumes `DashboardObject` — a shaped model produced by `src/dashboard/inspector-data.ts` from kernel verbs." But `ClusterTruthInspector.jsx`'s inline OBJECTS use a flat schema: `owner` (not `ownerStore`), `truth` (not `sourceType`), `related` (not `relationships`). No object in the demo conforms to the DashboardObject contract. Future consumers reading the README expect to drop in an inspector-data.ts output and have it render — they cannot, because the inspector renders the legacy schema.
**Recommendation:** Either update the inspector to consume DashboardObject (which is what `demo-data.js` actually provides — note the two demo files use different schemas) OR update the README to clarify that the inspector currently uses a legacy flat schema and migration to DashboardObject is Stage B work. The two-demo-data-files state is itself confusing — pick one.
**Evidence:**
```jsx
// ClusterTruthInspector.jsx:30-32 — uses owner/truth/related
'cluster://entity/concept/federated-truth': { uri: ..., owner: 'canonical', truth: 'source', related: [...] }
```
```js
// demo-data.js:11-29 — uses ownerStore/sourceType/relationships (DashboardObject)
'cluster://canonical/entity/ent-project-01': { uri: ..., ownerStore: 'canonical', sourceType: 'owner-truth', relationships: [...] }
```

### SURFACE-B-022 — `cluster_validate_mutation` `_meta.statusTransition` builds string with naive ternary; if command stays at status other than 'validated', label says "validation failed" even on other states
**Severity:** LOW
**Category:** observability
**File:** `src/mcp/server.ts:618`
**Description:** The ternary `command.status === 'validated' ? 'proposed → validated' : 'validation failed'` collapses every non-'validated' outcome to "validation failed". If the command was already 'approved' or 'committed', the label is misleading. Defensive coding: the validate arm should refuse to act on commands not in 'proposed' state, OR the message should reflect the actual current state.
**Recommendation:** Use a switch: `'proposed' → 'proposed → validated'`; `'validated' → 'already validated (no transition)'`; otherwise `'no transition: current status ${cmd.status}'`. Refusing to validate non-proposed commands is the kernel-side fix; the MCP message should accurately reflect what happened.
**Evidence:**
```ts
// src/mcp/server.ts:618
statusTransition: `${command.status === 'validated' ? 'proposed → validated' : 'validation failed'}`,
```

### SURFACE-B-023 — `dashboard/index.html` external script integrity hashes pin development React; production tarball should use production React
**Severity:** LOW
**Category:** defensive
**File:** `dashboard/index.html:169-177`
**Description:** Loads `react.development.js` (and Babel standalone via CDN) — development builds include warnings, dev-tools hooks, and assertions that are bigger and less performant than production builds. The dashboard ships as part of the npm tarball (`files: ["dashboard/"]` per package.json). Consumers running this in production get the dev build. Minor performance + clarity concern.
**Recommendation:** Switch to `react.production.min.js` + `react-dom.production.min.js` for the demo, with matching SRI hashes. If the dev build was chosen for in-Chrome debugging, document it and ship a separate `index.production.html`.
**Evidence:**
```html
<!-- dashboard/index.html:169-177 -->
<script src="https://unpkg.com/react@18.3.1/umd/react.development.js" integrity="...">
<script src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.development.js" integrity="...">
```

### SURFACE-B-024 — `getSDK()` memoization: SDK cached as module-level singleton; no way to reset for tests or after env-var changes
**Severity:** LOW
**Category:** future-proofing
**File:** `src/mcp/server.ts:170-179`
**Description:** `_sdk` is a module-level `let` cache. Once `getSDK()` is called, the SDK is built from env vars at THAT moment and re-used for the process lifetime. Tests that mutate env vars between cases can hit stale SDK state; long-running MCP servers that should reload policies on config change cannot. The `sdkOverride` parameter on `handleTool` works around this for tests but not for live config reload.
**Recommendation:** Add an exported `resetSDK()` helper that clears `_sdk`. Document it as the test seam. For live reload, consider a SIGHUP handler that clears the cache and rebuilds — but this is out of Stage B scope.
**Evidence:**
```ts
// src/mcp/server.ts:170-179
let _sdk: ClusterSDK | undefined;
function getSDK(): ClusterSDK {
    if (_sdk) return _sdk;        /* cached for process lifetime */
    if (!existsSync(CLUSTER_DIR)) { ... }
    _sdk = new ClusterSDK(buildSDKOptions());
    return _sdk;
}
```

### SURFACE-B-025 — `CommandPreviewPanel.jsx` `activeIndex` short-circuit for compensated state ignores statusIndex (always sets to 4)
**Severity:** LOW
**Category:** defensive
**File:** `dashboard/components/CommandPreviewPanel.jsx:27`
**Description:** `const activeIndex = isRejected ? 1 : isCompensated ? 4 : statusIndex;` — for compensated commands, `activeIndex = 4` regardless of statusIndex. If statusIndex computes to -1 (unknown status), this masks the unknown rather than surfacing it. Defensive coding: the unknown-status path should not silently become "compensated".
**Recommendation:** Guard the order: check for known status first, only short-circuit if status is valid.
**Evidence:**
```jsx
// dashboard/components/CommandPreviewPanel.jsx:27
const activeIndex = isRejected ? 1 : isCompensated ? 4 : statusIndex;
```

### SURFACE-B-026 — MCP runtime fuzz gap: no live-fuzz harness exercises malformed MCP requests against the stdio transport
**Severity:** LOW
**Category:** defensive
**File:** `src/mcp/server.ts:823-846 (server bootstrap)`, no test harness exists
**Description:** Direct carry-over from dispatch. Wave A2 added `DB_CLUSTER_POLICIES_FILE` realpath sandbox; the unit tests exercise that boundary. But no test fires malformed JSON-RPC over the stdio transport (e.g., truncated message frames, malformed `arguments`, oversized payloads, requests with unknown tool names that smell like they should crash). Coverage gap for the actual transport boundary.
**Recommendation:** Add a `test/mcp-fuzz.test.ts` that spawns the MCP server as a child process and pipes malformed requests via stdio. Use `fast-check` (already in devDeps) to generate stress inputs. This is true Stage B feature scope but called out for ownership clarity.
**Evidence:** No test file matches `mcp-fuzz`, `mcp.transport`, or `stdio` in test/ (verified via grep).

### SURFACE-B-027 — `parseInt` radix omitted in 7 of 8 CLI sites; only `verify` uses radix 10 (cli.ts:1018)
**Severity:** LOW
**Category:** defensive (subset of SURFACE-B-014)
**File:** `src/cli.ts:270, 512, 679, 724, 741, 770, 787` (no radix); `src/cli.ts:1018` (radix 10)
**Description:** Sub-finding of B-014 worth tracking separately because modern node's `parseInt` defaults to radix 10 in practice, but ECMAScript spec allows octal interpretation for `0`-leading strings (deprecated, but a portability concern for older runtimes). Inconsistent: 1018 uses `parseInt(opts.sample, 10)` while 270/512/etc. omit. The B-014 rewrite captures this; flagged separately so a single search-replace gets all sites.
**Recommendation:** Search-replace `parseInt(opts.X)` → `parseInt(opts.X, 10)` plus NaN guard per B-014. Single PR.
**Evidence:** See SURFACE-B-014 evidence.

## Carry-over verification matrix

| ID | Present? | Proactive severity | Fix scope | New file:line |
|---|---|---|---|---|
| V2-005 CLI INTERNAL_TRUSTED_PRINCIPAL substitution | Yes | MEDIUM (observability — defeats SDK warning) | Small (5 lines, pass undefined upstream OR add CLI warning); see SURFACE-B-009 | `src/cli.ts:90, 634` |
| V2-008 CLI `loadPolicyConfig` validation | Yes | MEDIUM (defensive — fail-closed gap) | Medium (lift validatePrincipal to shared module; add policies-shape check); see SURFACE-B-006 | `src/cli.ts:64-74` |
| SURFACE-R009 / R2-008 `policyEnforced: boolean` public-readonly on SDK | Yes | MEDIUM (future-proofing — bypass branching surface); see SURFACE-B-007 | Small (make private + getter, gate behind NODE_ENV check) | `src/sdk/cluster-sdk.ts:131` |
| SURFACE-R2-009 dashboard JSDOM-ESM race | Yes (latent in current demo, real for future consumers) | MEDIUM (defensive); see SURFACE-B-016 | Small-Medium (move applyRedaction to sync script, OR add to ready-poll) | `dashboard/index.html:188-208` |
| V1-003 bundle redaction edge cases | Yes — SDK `retrieveBundle` is raw pass-through; non-policy-enforced consumers see unsanitized `indexRecords` + `provenanceEvents`; MCP boundary saves by dropping fields | MEDIUM (defensive — SDK boundary discipline gap); see SURFACE-B-008 | Small (5 lines: sanitize the two arrays before return); same shape as AGG-002 | `src/sdk/cluster-sdk.ts:195-197` |
| SURFACE-R012 deprecation policy | Yes — no `@deprecated`, no MIGRATION.md, no runtime warnings | MEDIUM (future-proofing); see SURFACE-B-018 | Medium (conventions + scaffold MIGRATION.md + scan exports) | repo-wide |
| MCP `_meta.writesCluster` / `_meta.operation` discipline | Yes — present + accurate. 16/16 tool arms have `_meta`, writesCluster is true only on commit + compensate (correct) | N/A (verified clean post-Wave-A3) | N/A | server.ts (verified) |
| `ToolAnnotations` interface | Yes — interface defined (server.ts:192-198) and applied to all 16 tools; readOnly/writesCluster/approvalSensitive/stagedOnly/requiresExistingCommand all set | N/A (verified clean) | N/A | server.ts (verified) |
| Dashboard observability — `OperationsPanel` consume `mutation_orphaned` | NO — dashboard surface blind; demo-data carries the field but the component doesn't render it; ops-model.ts doesn't expose it; see SURFACE-B-011 | MEDIUM (observability — load-bearing signal has no view surface) | Medium (3-file change: ops-model.ts shape, ops-panel render, repair suggestion) | `dashboard/components/OperationsPanel.jsx:72-83`, `src/dashboard/ops-model.ts:118-126` |
| `src/integrations/repo-knowledge/ingest.ts` doc-drift | Yes — file-header line 34-37 + inline 239-240 misrepresent "policy gate fires for both ClusterKernel and PolicyEnforcedKernel"; see SURFACE-B-017 | MEDIUM (observability via doc-drift) | Trivial (rewrite the doctrine block) | `src/integrations/repo-knowledge/ingest.ts:34-37, 239-240` |
| `src/integrations/repo-knowledge/ingest.ts:236-249` Buffer-in-CommandQueue (V2-004 cross-check) | Yes — artifact-ingest path still bypasses propose+commit; comment is accurate that this is intentional pending kernel Buffer-safe persistence | LOW (acknowledged limitation, documented exit) | None until kernel grows Buffer-safe command persistence | `src/integrations/repo-knowledge/ingest.ts:244-249` |
| CLI exit codes | Partial — lifecycle commands exit(1) on caught error; non-lifecycle commands have NO try/catch and rely on unhandled-rejection default; see SURFACE-B-004 | HIGH (graceful degradation — breaks shell-script integration) | Medium (uniform safeAction wrapper across ~20 subcommands) | `src/cli.ts` (multi-site) |
| MCP runtime fuzz gap | Yes — no live-fuzz harness; see SURFACE-B-026 | LOW (defensive — coverage gap, not a defect) | Stage-B-feature scope (new test/mcp-fuzz.test.ts) | `test/mcp-fuzz.test.ts` (new) |

## Should-have-been-stage-a (real bugs)

These three findings are real defects that should have been caught in Stage A. Notes for v2 dispatch-shaping:

1. **SURFACE-B-001** (HIGH) — `cluster_find_sources` returns raw IndexRecord with `metadata` field. Same class as AGG-001 / AGG-003 (resolve-path sanitization) which were caught in Wave A3, but the LIST path through find_sources was not audited. **V2 gap:** the AGG family checked singular-resolve paths but did not enumerate every tool arm that returns an IndexRecord. A "every tool that emits a store object emits a sanitized store object" invariant would have caught this in one query.
2. **SURFACE-B-002** (HIGH) — `db-cluster policy explain` / `policy test` ignore `.db-cluster/policies.json`. This is an operator-trust defect: the dry-run interface reports decisions that don't match the real cluster. **V2 gap:** Stage A focused on policy enforcement and sanitization on the read/write paths; the dry-run/policy-introspection path was not audited as a "must reflect actual state" surface.
3. **SURFACE-B-003** (HIGH) — MCP error responses leak `err.message` unfiltered. The SURFACE-R005 fix established a fail-closed posture on inbound env-var validation; the symmetric outbound error path was not audited. **V2 gap:** an "all boundary error messages pass through a redactor" invariant would have caught this. The MCP server has a unified error-response code path (one `catch` arm) — it should have been the easy place to enforce.

## Domain summary (≤150 words)

The surface is structurally well-disciplined post-Wave-A3 (5-store-type sanitization unconditional, MCP `_meta` annotations comprehensive, fail-closed on env-var validation, `policies-file` symlink sandboxing). But the proactive lens surfaces five categories of latent risk: (1) a metadata-leak path in `cluster_find_sources` mirroring the AGG-001 hole but on the list arm; (2) operator-misleading dry-run in `db-cluster policy explain` / `policy test` which ignore `.db-cluster/policies.json`; (3) unfiltered `err.message` leakage at the MCP error boundary; (4) ~20 CLI subcommands lack top-level try/catch, producing raw stack traces and incoherent exit codes; (5) a dashboard error state that crashes the entire UI on unknown URI. Plus the `mutation_orphaned` observability signal — wired into doctor/verify in Stage A — has no dashboard surface. Plus public-readonly `policyEnforced` remains a bypass-branch invitation. Deprecation policy, MCP fuzz coverage, and dashboard-component layering remain unfinished future-proofing work.

---

**Top 3 HIGH findings:**

1. **SURFACE-B-001** — `cluster_find_sources` MCP arm returns raw IndexRecord with `metadata` field (mirrors entity content), defeating the unconditional sanitization baseline that AGG-001/AGG-003 established for singular-resolve paths.
2. **SURFACE-B-002** — `db-cluster policy explain` and `policy test` silently evaluate against `DEFAULT_POLICIES`, ignoring `.db-cluster/policies.json` — operators trust this dry-run to validate their actual policy state but it cannot.
3. **SURFACE-B-003** — MCP error catch returns raw `err.message` to host, leaking filesystem paths and internal state through the one unified error path on the server.

**Counts:** 5 HIGH, 13 MEDIUM, 9 LOW, 3 should-have-been-stage-a. Total: 27 findings (within 30 cap).

**Carry-overs materially worse than Wave A3 said:**

- **Dashboard `mutation_orphaned` blindness:** Wave A3's STORES-R2-003 / V1-007 fixed `verify()` and `doctor()` to consume orphan events, but the dashboard ops surface — the primary operator window — does not render the count. Wave A3 framing was "fixed"; Stage B framing is "fixed in the data plane, blind in the view plane."
- **V2-008 CLI `loadPolicyConfig`:** Wave A3 closed this on MCP (SURFACE-R005); the CLI mirror was deferred and is now a structural symmetry gap, not a low-impact note.
- **V1-003 / SDK retrieveBundle sanitization:** Re-audit-2 categorized as edge cases; actual finding is that the SDK boundary IS the leak path for non-policy-enforced consumers — broader than "edge cases."
