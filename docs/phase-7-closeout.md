# Phase 7 Closeout — Policy, Permissions, and Trust Boundaries

## Exit Sentence

db-cluster can govern access to cluster truth across stores and AI-facing tools without leaking restricted owner data, bypassing mutation law, or turning policy into the product center.

## Proof Sentence

db-cluster can enforce policy, redaction, and existence boundaries across kernel, SDK, CLI, and MCP without leaking restricted truth or weakening retrieval, provenance, or command-gated mutation law.

## Waves

| Wave | Scope | Tests | Status |
|------|-------|-------|--------|
| 1 | Policy type model | 6 | PASS |
| 2 | Deterministic policy engine | 24 | PASS |
| 3 | Kernel enforcement | 18 | PASS |
| 4 | MCP/SDK/CLI policy surface | 12 | PASS |
| 5 | Redaction and existence leakage | 20 | PASS |
| 6 | Phase 7 proof suite | 34 | PASS |

## Test Coverage

- 339 tests across 21 files
- TypeScript strict mode, zero errors
- All phases 1–7 tests pass without regression

## Architecture Additions

### Types (`src/types/policy.ts`)
- `Policy` — verb + resource + effect + conditions + redactionRules
- `Principal` — identity + roles + trustZone
- `TrustZone` — named boundary with default policies + zone redaction
- `VisibilityRule` — existence + metadata visibility per resource pattern
- `RedactionRule` — target (entity/artifact/command/receipt/provenance) + mode (strip/mask/summarize/hash)

### Engine (`src/policy/policy-engine.ts`)
- `evaluatePolicy()` — deterministic first-match, deny-wins
- `checkVisibility()` — existence-aware denial presentation
- `matchPolicy()` — role + zone + condition matching

### Enforcement (`src/kernel/policy-enforced-kernel.ts`)
- Wraps ClusterKernel with per-operation policy evaluation
- Read paths: entity, find, retrieve, trace, why, commands, receipts
- Mutation paths: propose, commit
- Visibility: denied reads either throw or silently exclude
- Redaction: applied post-retrieval preserving object shape

### Redactor (`src/policy/redactor.ts`)
- `redactArtifact()` — storagePath stripping/masking
- `redactEntity()` — attribute stripping preserving shape
- `redactCommand()` — payload stripping preserving lifecycle
- `redactReceipt()` — detail stripping preserving audit shape
- `redactProvenanceActors()` — actor identity stripping
- `redactGraphNodes()` — hidden node placeholders
- `sanitizeWarnings()` — URI reference removal

### Surface (`src/cli.ts`, `src/mcp/server.ts`, `src/sdk/cluster-sdk.ts`)
- `policy explain` / `policy test` CLI subcommands
- `cluster_policy_explain` / `cluster_policy_test` MCP tools
- `policyExplain()` / `policyTest()` SDK methods

## Design Decisions

1. **Policy is not the product center.** The kernel routes, the stores own truth, policy gates access. Policy never transforms data — it redacts or denies.
2. **Deny-wins, first-match.** Deterministic evaluation order. No ambient authority.
3. **Visibility is not a pre-filter.** Policy decides access first. Visibility only controls how denial is presented (throw vs silent exclude).
4. **Redaction preserves shape.** Callers get structurally valid objects with redacted content — no null explosions or missing fields.
5. **No policy bypass path.** MCP, SDK, and CLI all route through PolicyEnforcedKernel. Raw ClusterKernel is not exposed at the AI surface.

## Commits

- `214f9cc` — Phase 7 Waves 1–3 (types, engine, kernel enforcement)
- `33a8873` — Phase 7 Waves 4–6 (surface, redaction, proof suite)

## Tag

`phase-7-policy-trust-boundaries`
