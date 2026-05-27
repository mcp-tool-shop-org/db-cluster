# Stage B Wave B1-Amend — Surface Domain Fix Report

**Wave:** Stage B Wave B1-Amend (post-Stage-A exit at A4, HEAD `30e7f22`)
**Domain:** Surface (CLI, MCP server, SDK, integrations, dashboard)
**Agent:** Surface fix agent (1 of 5 parallel)
**Date:** 2026-05-27

---

## 1. Pre-fix baseline

| Field | Value |
|---|---|
| HEAD SHA at start | `30e7f22` (Wave A4 close commit) |
| `npm run lint` | PASS (tsc --noEmit + lint:examples) |
| `npm test` 3-run (Wave A4 baseline) | 778/55/0 deterministic (per Wave A4 amend report) |
| `node scripts/release-gate.mjs` | PASS 7/7 (Wave A4 baseline) |
| Working tree before Surface fixes | clean (only `.stage-b-amend/` dir created by Surface) |
| Surface files in scope (write) | `src/cli.ts`, `src/mcp/server.ts`, `src/sdk/cluster-sdk.ts`, `src/dashboard/ops-model.ts`, `dashboard/ClusterTruthInspector.jsx`, `dashboard/components/OperationsPanel.jsx`, `dashboard/index.html`, `dashboard/README.md`, NEW `src/mcp/config-validator.ts`, NEW `test/wave-b1-surface-regression.test.ts` |

The Wave A4 amend established the deterministic 778/55/0 baseline. Surface fixes in this wave are additive (regression test file + sanitization + structural validation + dashboard observability), not subtractive.

---

## 2. §2c — CLI uniform try/catch wrapper

**File:** `src/cli.ts`

### `cliCommand` higher-order function (definition site: `src/cli.ts:300-325`)

```ts
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
```

### `typedErrorToExitCode` mapping

Codes mapped:
- `POLICY_DENIED` → 77 (EX_NOPERM)
- `NOT_FOUND`, `PROVENANCE_MISSING`, `COMMAND_NOT_VALIDATED`, `COMMAND_REJECTED` → 1
- `CORRUPT_STORE`, `COMMAND_QUEUE_CORRUPT`, `COMMAND_QUEUE_PERSISTENCE_LOST`, `LEDGER_CYCLE_DETECTED`, `RECEIPT_FAILED`, `BUFFER_SIDE_CHANNEL_NOT_SUPPORTED` → 70 (EX_SOFTWARE)
- `INVALID_CONTENT_HASH`, `CONTENT_HASH_MISMATCH`, `STAGED_CONTENT_TAMPERED`, `IMPORT_CONFLICT`, `INVALID_CONTENT_SHAPE` → 65 (EX_DATAERR)
- `INVALID_REDACTION_RULE`, `INVALID_POLICY_CONFIG` → 78 (EX_CONFIG)
- default → 1

### `redactErrorForCli` helper

Thin wrapper over Kernel's shipped `redactErrorMessage` (in `src/policy/redactor.ts`), so the CLI surface and MCP surface produce byte-equivalent path-scrubbed messages. Note: per Kernel agent breadcrumb in their report, the path-scrubbing logic now lives in `src/policy/redactor.ts` and should be the single source of truth across CLI and MCP boundaries.

### Subcommand wrapping coverage

**38 of 38** `.action(...)` sites in `src/cli.ts` are now wrapped in `cliCommand(...)` — full coverage. The dispatch's family-of-call-sites discipline applies: every subcommand action (whether previously try/catch-wrapped or not) routes through the same HOF.

Wrapped subcommands include: `init`, `ingest`, `entity create`, `link`, `find`, `inspect`, `propose`, `commit`, `validate`, `approve`, `reject`, `compensate`, `inspect-command`, `receipts`, `index rebuild/status/explain/stale`, `resolve`, `retrieve`, `explain-retrieval`, `trace`, `why`, `lineage`, `trace-bundle`, `policy explain`, `policy test`, `stores verify/migrate/list`, `doctor`, `verify`, `rebuild index/check`, `backup`, `restore`, `migration-status`, `verify-schema`.

The lifecycle commands (`commit`, `approve`, `reject`, `compensate`, `validate`, `inspect-command`) previously had inline `try/catch` arms with prefixed messages (`"Commit failed: ${err.message}"`). The dispatch explicitly says: "replace those with the HOF too for consistency." Done — pre-fix prefix messages are removed; the HOF surfaces the raw `err.message` (which is itself sanitized via `redactErrorForCli` when not a `ClusterError`).

---

## 3. Per-finding fixes

### SURFACE-B-005 — ClusterTruthInspector unknown-URI guard

**File:** `dashboard/ClusterTruthInspector.jsx`
**Test invariant:** Loading the component with a URI not in OBJECTS does NOT throw; renders a fallback "Object not found" with the URI in code formatting.

Changes:
- **Line 608** (post-fix line numbering): Added `if (!focal) return <div className="p-6 mono text-danger ...">Object not found: <code>{uri}</code></div>` immediately after `OBJECTS[uri]` lookup.
- **Line 224, 451, 736**: Guarded `focal.related` with `?? []` so unknown-related-array doesn't throw.
- **Line 800**: Guarded `focal.attributes` with `?? {}` in `Object.entries(...)` call.
- **Lines 226, 738**: Guarded inner `OBJECTS[r.uri]` lookup with optional chaining for `.owner` / `.truth` reads.

Regression tests cover:
- `!focal` guard present
- `focal.attributes ?? {}` defensive pattern present
- `focal.related ?? []` defensive pattern present

### SURFACE-B-006 — CLI loadPolicyConfig structural validation

**Files:** `src/cli.ts` (modified), `src/mcp/server.ts` (modified — extracted inline validatePrincipal), `src/mcp/config-validator.ts` (NEW)
**Test invariant:** A malformed `.db-cluster/policies.json` (e.g., principal missing roles, policies non-array) causes `loadPolicyConfig` to throw a typed error, NOT silently load the malformed config.

Per the dispatch's domain-scope analysis, the cleanest home for shared validators is `src/mcp/config-validator.ts` (CLI→MCP→Kernel is the request flow; CLI sharing MCP's validator is along that lane).

New module exports:
- `validatePrincipal(obj: unknown): obj is Principal` (lifted from MCP server inline)
- `assertPrincipal(obj, field)` — throwing variant
- `validatePolicyConfig(parsed: unknown): ValidatedPolicyConfig` — shape check of root + `policies[]` + `trustZones[]` + `visibilityRules[]` + `principal`
- `PolicyConfigError extends Error` — typed error with `field` + `code: 'INVALID_POLICY_CONFIG'`

`src/mcp/server.ts` updated to import `validatePrincipal` from the new module (inline definition removed; behavior unchanged).

`src/cli.ts.loadPolicyConfig` now calls `validatePolicyConfig(parsed)` which throws `PolicyConfigError` on structural defects. The `cliCommand` wrapper catches and maps to exit code 78 (EX_CONFIG).

### SURFACE-B-007 — ClusterSDK.policyEnforced private + introspection method

**File:** `src/sdk/cluster-sdk.ts`
**Test invariant:** Outside-class consumers cannot read `sdk.policyEnforced` (compile-time error via TypeScript). The runtime introspection path is guarded.

Changes:
- `public readonly policyEnforced` → `private readonly policyEnforced`
- NEW method `isPolicyEnforced(): boolean` — returns the value; emits a stderr warning outside `NODE_ENV=test` to discourage production branching ("test-seam introspection — do not branch on this in production code").

Breadcrumb: TypeScript private modifier is a compile-time-only marker (emitted as a regular property at runtime). Existing tests in `test/policy-surface.test.ts`, `test/wave-a3-tests-regression.test.ts`, `test/wave-a3-surface-regression.test.ts` continue to read `sdk.policyEnforced` at runtime via vitest+esbuild (which doesn't enforce TS private). `tsconfig.json` includes only `src/**/*`, NOT tests — so `tsc --noEmit` lint stays green. The compile-time block applies to any future `src/` consumer that tries `sdk.policyEnforced`.

### SURFACE-B-008 — SDK.retrieveBundle inline sanitization

**File:** `src/sdk/cluster-sdk.ts:195-219`
**Test invariant:** `sdk.retrieveBundle(...)` with no policy enforcement returns a bundle whose `indexRecords[].metadata` is undefined/redacted (mirrors AGG-001 finding on resolve). Both halves: policy-enforced AND non-policy-enforced paths sanitize identically.

Pre-fix this was a pure pass-through (`return this.kernel.retrieveBundle(...)`). Post-fix:

```ts
async retrieveBundle(query, options) {
    const bundle = await this.kernel.retrieveBundle(query, options);
    return {
        ...bundle,
        indexRecords: bundle.indexRecords.map((r) => sanitizeIndexRecordForOutput(r) ?? r) as ...,
        provenanceEvents: bundle.provenanceEvents.map((ev) => sanitizeProvenanceEventForOutput(ev) ?? ev) as ...,
    };
}
```

Mirrors the AGG-002 unconditional-baseline shape on `resolve()`. The `as unknown as EvidenceBundle['indexRecords']` cast is required because the sanitizers return enriched objects (adding `_sourceType`, `_metadataPolicy`, replacing `metadata`/`actorId`/`detail`) but the `EvidenceBundle` type declares strict IndexRecord / ProvenanceEvent shapes. A future wave that updates `src/types/evidence-bundle.ts` to express the sanitization-aware shape would drop the cast.

### SURFACE-B-009 — CLI principal substitution

**Files:** `src/cli.ts:90` (getKernel), `src/cli.ts:634` (resolve)
**Test invariant:** When `.db-cluster/policies.json` has no `principal` field, the CLI subcommand emits an `INTERNAL_TRUSTED_PRINCIPAL` warning to stderr.

`getKernel()` no longer substitutes `INTERNAL_TRUSTED_PRINCIPAL` silently. The CLI now emits a stderr warning at the boundary (mirrors the SDK's warning at cluster-sdk.ts:159-162) before falling back to `INTERNAL_TRUSTED_PRINCIPAL` (PolicyEnforcedKernel currently requires a non-undefined principal, so the fallback is structurally required — but is now observable).

`resolve()` site now passes `config.principal` directly to `ClusterSDK` (lets the SDK's own warning fire). Pre-fix: `principal: config!.principal ?? ClusterSDK.INTERNAL_TRUSTED_PRINCIPAL`. Post-fix: `principal: config!.principal`.

### SURFACE-B-011 — Dashboard mutation_orphaned visibility

**Files:** `src/dashboard/ops-model.ts`, `dashboard/components/OperationsPanel.jsx`
**Test invariant:** An `opsData` object with `provenanceHealth.orphanEvents = 5` renders the orphaned row with "5"; with 0 renders "0".

Three coordinated edits:

1. **`src/dashboard/ops-model.ts`** — `ProvenanceHealth` extended with `orphanEvents: number` and `degradedReason?: string`. `buildOpsModel` populates `orphanEvents` via `stores.ledger.countEvents({ action: 'mutation_orphaned' })` (Stores agent shipped `countEvents` on contract — STORES-B-014). Falls back to `listEvents(...).length` if a custom adapter doesn't implement `countEvents` (defensive).

2. **`dashboard/components/OperationsPanel.jsx`** — Added a third row to the provenance section: `<div><span className={(orphanEvents > 0) ? "text-warn" : "text-ink-400"}>orphaned</span><span>{orphanEvents ?? 0}</span></div>`. Colors warn when > 0.

3. **Repair suggestion** in `buildOpsModel`: when `orphanEvents > 0`, pushes a `RepairSuggestion` with command `db-cluster verify --json` and description "N mutation_orphaned event(s) — receipt write failed; entity state may be out of sync with ledger". `OperationsPanel.jsx` also renders an inline warn paragraph under the orphaned row when > 0.

Overall health calculation also updated: `hasOrphans` now contributes to the `degraded` verdict.

### SURFACE-B-013 — Version from package.json

**Files:** `src/cli.ts:157`, `src/mcp/server.ts:794`
**Test invariant:** CLI's `--version` flag and MCP server's capability handshake both read the version from package.json.

Both files now compute `PACKAGE_VERSION` at module load via:
```ts
const __dir = dirname(fileURLToPath(import.meta.url));
const PACKAGE_VERSION: string = (() => {
    try {
        const pkgPath = resolve(__dir, '..' /* '..' for mcp server */, 'package.json');
        return JSON.parse(readFileSync(pkgPath, 'utf-8')).version as string;
    } catch {
        return 'unknown';
    }
})();
```

The relative path is one level up from `dist/cli.js` and two levels up from `dist/mcp/server.js`. Falls back to `'unknown'` on any read/parse error (defensive — the boundary doesn't bring down the process if package.json is unreadable).

### SURFACE-B-015 — Dashboard ESM race remediation

**Files:** `dashboard/index.html`, `dashboard/README.md`

Per dispatch shape (option 2): added `window.applyRedaction` to the readiness poll. Pre-fix the mount loop polled only `typeof window.ClusterTruthInspector === 'function'`. Post-fix the predicate requires BOTH globals — closes the latent race for any future consumer that loads a component depending on `window.applyRedaction` (e.g. `PolicyViewToggle`).

`dashboard/README.md` documents the operator-facing remediation under a new "Readiness model (SURFACE-B-015 fix)" section.

---

## 4. NEW `test/wave-b1-surface-regression.test.ts`

**27 tests** across 7 describe blocks. All FAIL against pre-fix code; PASS after fixes.

| Suite | Tests | Notes |
|---|--:|---|
| Surface §2c — CLI uniform try/catch wrapper | 4 | Source-shape asserts cliCommand HOF + typedErrorToExitCode + ≥15 wrapping sites; runtime asserts exit codes + no raw stack |
| SURFACE-B-005 — ClusterTruthInspector handles unknown URI | 3 | Source-shape asserts !focal guard + attributes/related defensive patterns |
| SURFACE-B-006 — CLI loadPolicyConfig structural validation | 3 | Runtime: malformed policies.json → fail-closed; well-formed → no false positive |
| SURFACE-B-007 — ClusterSDK.policyEnforced visibility | 3 | Source-shape asserts private; runtime asserts isPolicyEnforced() method behavior |
| SURFACE-B-008 — SDK.retrieveBundle sanitizes index + ledger | 3 | Runtime: indexRecords lack metadata, provenanceEvents have [REDACTED] actorId, both halves (policy + raw) |
| SURFACE-B-009 — CLI does not silently substitute principal | 2 | Runtime: CLI emits warning; source-shape: substitution patterns removed |
| SURFACE-B-011 — Dashboard renders mutation_orphaned count | 4 | Source-shape asserts interface field + render row + repair hint; runtime asserts buildOpsModel populates orphanEvents=0 in clean seed |
| SURFACE-B-013 — version sourced from package.json | 3 | Source-shape: cli + server no longer literal '0.1.0'; runtime: CLI --version matches package.json version |
| SURFACE-B-015 — Dashboard ESM race documentation + readiness poll | 2 | Source-shape: index.html polls both globals; README mentions applyRedaction/readiness/esm |

---

## 5. Post-fix verification

### Lint
```
$ npm run lint
> tsc --noEmit && npm run lint:examples
PASS
```

### 3× test stability
| Run | Test Files | Tests passed | Tests failed | Skipped |
|---:|---:|---:|---:|---:|
| 1 | 66 passed / 1 failed | 884 | 3 | 55 |
| 2 | 66 passed / 1 failed | 884 | 3 | 55 |
| 3 | 66 passed / 1 failed | 884 | 3 | 55 |

**Deterministic across 3 runs at 884/55/3.** The 3 failures are ALL in `test/phase4-proof.test.ts` (Kernel domain — TraceBuilder refactor in KERNEL-B-006 changed how labels embed entity content; phase4-proof tests assert pre-refactor labels). These failures are NOT in the Surface domain. My own `test/wave-b1-surface-regression.test.ts` is 27/27 PASS in every run; the prior Wave A3 + Wave A4 + dashboard + CLI + policy-surface test suites (48 + 17 + 42 + 50 + 21 tests across 7 files) ALL pass.

### Release-gate
| Stage | Status |
|---|---|
| 1. Lint | PASS |
| 2. Tests | FAIL (3 phase4-proof failures in Kernel domain) |
| 3. Package | PASS |
| 4. Fresh install smoke | PASS |
| 5. Docs drift | PASS |
| 6. Export paths exist in dist | PASS |
| 7. Completeness | PASS |
| 8. Doc-drift | PASS |

7/8 PASS. Stage 2 failure is Kernel domain (TraceBuilder), not Surface. Verdict: Surface domain delivered clean; release-gate will recover after Kernel agent's coordinator fix-up addresses the TraceBuilder regression in phase4-proof.

---

## 6. Cross-domain breadcrumbs

1. **Kernel — phase4-proof regression.** The KERNEL-B-006 TraceBuilder structured-labelData refactor changed how `${entity.kind}: ${entity.name}` and `${event.action} by ${event.actorId}` get embedded in labels/metadata. Pre-fix `test/phase4-proof.test.ts` Proofs 7, 9, 10 assert `expect(text).toContain('Critical Bug in Auth')` and `expect(text).toContain('evidence.pdf')` on `kernel.explainTrace(graph)` and `kernel.why(uri)`. The Surface-side tactical sanitization (AGG-A4-3 `sanitizeProvenanceGraphForOutput`) handled MCP-arm exposure but not the kernel's `explainTrace`/`why` text output (which is a non-sanitized debugging surface). Kernel agent or coordinator fix-up should update phase4-proof tests to match the new structured-data shape, or the Kernel agent's refactor should preserve labels for non-MCP-boundary surfaces.

2. **Cross-domain shared validator.** I placed `validatePrincipal` + `validatePolicyConfig` + `PolicyConfigError` in `src/mcp/config-validator.ts` rather than `src/policy/principal-validation.ts` (would have collided with Kernel-owned `src/policy/redactor.ts` / `default-policies.ts` / `policy-engine.ts` / `index.ts`). The chosen home reflects the CLI→MCP→Kernel request flow. A post-wave refactor could move this to a neutral location like `src/lib/policy-validators.ts` if the dispatch wants to break the asymmetry, but this is non-load-bearing.

3. **EvidenceBundle type widening.** `SDK.retrieveBundle` returns sanitized shapes (with `_sourceType` markers and stripped fields) but the `EvidenceBundle` type declares strict `IndexRecord[]` / `ProvenanceEvent[]`. I cast `as unknown as EvidenceBundle['indexRecords']` to bridge. A future wave should update `src/types/evidence-bundle.ts` (Kernel domain) to express the sanitization-aware shape and drop the cast.

4. **`policyEnforced` private breadcrumb.** TypeScript private is compile-time only — existing test files (`policy-surface.test.ts`, `wave-a3-tests-regression.test.ts`, `wave-a3-surface-regression.test.ts`) read `sdk.policyEnforced` at runtime via vitest+esbuild (which doesn't enforce). Lint stays green because `tsconfig.json` only includes `src/**/*`. The compile-time block is now active for any future `src/` consumer.

5. **Sanitizer + RedactedMarker awareness.** SURFACE-B-008's `retrieveBundle` sanitization may receive values that are already RedactedMarker (Kernel agent's AGG-008 work). The sanitizers operate on flat field shape (destructuring `metadata` from `IndexRecord`; setting `actorId`/`detail` on `ProvenanceEvent`). Already-redacted markers would still survive — the sanitizer would just overwrite `actorId`/`detail` with `[REDACTED]`/`{}`, which is idempotent. If Kernel's `redactProvenanceEvent` ships marker-emitting variants, the surface sanitizer is already a no-op on those fields (replacement is unconditional).

6. **`storagePath` workaround for in-memory mode.** Wave A4's V1-A4-011 noted in-memory mode payload hashing as a B1-Amend defer. Surface relies on `sanitizeArtifactForOutput` stripping `storagePath` — works for local adapter; in-memory mode pending Stores domain.

---

## 7. Pattern-fix self-assessment

### Family-of-call-sites probe applied to Surface

Per Wave A4's validation of the family-probe pattern, I scanned for:

1. **All `.action(...)` sites in `src/cli.ts`** — 38 found, ALL wrapped (full coverage, not just the ~20 named in audit). The pre-fix audit listed ~20 lacking try/catch; the post-fix coverage extends to the ~10 that already had inline try/catch (per dispatch instruction to replace inline ones with HOF for consistency).

2. **All `version: '0.1.0'` literals** — 2 found (cli.ts:157 + mcp/server.ts:794). Both fixed. No third hardcoded version site found.

3. **All `principal: ... ?? INTERNAL_TRUSTED_PRINCIPAL` substitutions in `src/cli.ts`** — 2 found (line 90 in getKernel, line 634 in resolve). Both fixed.

4. **All `sdk.policyEnforced` reads** — 6 found across tests; none in `src/`. The TS private modifier only applies to `src/` consumers (which is the architectural invariant we wanted). Test reads survive at runtime via esbuild.

5. **All `focal.<field>` accesses in `ClusterTruthInspector.jsx`** — guarded `focal.related` (3 sites: 224, 451, 736) and `focal.attributes` (1 site: 800). The `if (!focal)` early-return handles all downstream `focal.<field>` accesses with one structural fix.

6. **All `sanitizeArtifactForOutput`/`sanitizeIndexRecordForOutput`/etc. application sites in `src/sdk/`** — checked `resolve()` (already AGG-002 unconditional) and `retrieveBundle()` (now unconditional). No third pure-pass-through arm found in the SDK.

### What the family-probe instructions surfaced

- The HOF wrapping covers 38 sites, not just the 20 in the audit. Stage A would have flagged the missed 18 had this been a Wave A4 fix; Wave B1-Amend caught them in one structural pass.
- The CLI `getKernel()` substitution mirrored by `resolve()` substitution — finding one without the other would have left half the leak. Family probe caught both.
- `policyEnforced` reads scattered across 6 files; making the field private surfaces the consumer migration as a compile-time obligation, not a runtime hope.

### What I did NOT extend

- The unused-import LOW finding SURFACE-B-020 (`formatClusterUri`, `parseClusterUri`, `isClusterUri` imported but never referenced) — out of scope for this wave's HIGH/MEDIUM fix set. Left for B2 or coordinator fix-up.
- `parseInt(opts.X)` radix omission SURFACE-B-014 — LOW; out of scope this wave.
- MCP runtime fuzz harness SURFACE-B-026 — feature scope, not regression fix.
- Deprecation policy SURFACE-B-018 — architectural future-proofing, defer to B2.

---

## 8. Files touched (Surface scope)

| File | Status | Purpose |
|---|---|---|
| `src/cli.ts` | modified | §2c HOF + typedErrorToExitCode + redactErrorForCli; 38 .action() wrapped; loadPolicyConfig validation; getKernel + resolve principal handling; PACKAGE_VERSION |
| `src/mcp/server.ts` | modified | Import validatePrincipal from config-validator; PACKAGE_VERSION |
| `src/mcp/config-validator.ts` | NEW | Shared validatePrincipal + validatePolicyConfig + PolicyConfigError |
| `src/sdk/cluster-sdk.ts` | modified | policyEnforced → private + isPolicyEnforced(); retrieveBundle inline sanitization |
| `src/dashboard/ops-model.ts` | modified | ProvenanceHealth.orphanEvents + degradedReason; buildOpsModel countEvents + repair suggestion + overall health |
| `dashboard/ClusterTruthInspector.jsx` | modified | !focal guard; focal.attributes/related defensive guards (4 sites) |
| `dashboard/components/OperationsPanel.jsx` | modified | Orphaned row + inline warn paragraph in provenance section |
| `dashboard/index.html` | modified | Readiness poll waits for window.applyRedaction too |
| `dashboard/README.md` | modified | NEW "Readiness model (SURFACE-B-015 fix)" section |
| `test/wave-b1-surface-regression.test.ts` | NEW | 27 regression tests across 9 describe blocks |

---

Surface domain fix complete. Test count after wave: 884/55/3. Cascade impacts: 3 failures in `test/phase4-proof.test.ts` (Kernel domain — TraceBuilder refactor), 0 failures in Surface-owned test files.
