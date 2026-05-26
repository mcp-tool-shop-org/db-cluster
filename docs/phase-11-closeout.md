# Phase 11 Closeout — Dogfood Gate

## Objective

Prove db-cluster's value by having it manage its own project memory — phases, decisions, milestones, findings, and source artifacts — through its own APIs.

## Deliverables

| Wave | Deliverable | Status |
|------|------------|--------|
| 1 | Schema + overview | DONE |
| 2 | Dogfood ingest (12 artifacts, 22 entities, 19 links) | DONE |
| 3 | Retrieval tests (10 tests) | DONE |
| 4 | Trace tests (7 tests) | DONE |
| 5 | Mutation tests (7 tests) | DONE |
| 6 | Policy tests (7 tests) | DONE |
| 7 | Operations tests (7 tests) | DONE |
| 8 | Proof suite (12 proofs) + value report | DONE |

## Test count

- Previous (Phase 10): 434 tests, 29 files
- Added: 50 tests (10 + 7 + 7 + 7 + 7 + 12)
- Total: 484 tests, 35 files

## Product findings

1. **Artifact restore gap** — `backup()` exports artifact metadata but `restore()` does not re-ingest artifacts. Full restore requires source file access.
2. **commitMutation doesn't auto-index** — entities created via command lifecycle aren't discoverable through `findSources()` until explicit rebuild. Direct `createEntity()` does auto-index.
3. **Command state isolation** — each PolicyEnforcedKernel instance has its own command map. Multi-principal workflows require the same kernel instance.
4. **Index is name-based, not content-based** — index stores `"kind: name"` text. Semantic queries over artifact content require content-aware indexing.

## Verdict

PASS_WITH_CONDITIONS — db-cluster proves value as project-memory substrate. Items 1-2 recommended for Phase 12.

## Files added

- `scripts/dogfood-ingest.ts`
- `scripts/dogfood-query.ts`
- `scripts/dogfood-trace.ts`
- `scripts/dogfood-update.ts`
- `scripts/dogfood-policy.ts`
- `scripts/dogfood-ops.ts`
- `test/dogfood-retrieval.test.ts`
- `test/dogfood-trace.test.ts`
- `test/dogfood-mutation.test.ts`
- `test/dogfood-policy.test.ts`
- `test/dogfood-ops.test.ts`
- `test/phase11-proof.test.ts`
- `examples/dogfood-project-memory/README.md`
- `examples/dogfood-project-memory/schema.md`
- `docs/phase-11-dogfood-report.md`
- `docs/phase-11-closeout.md`
