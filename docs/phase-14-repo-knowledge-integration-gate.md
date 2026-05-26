# Phase 14 — Repo-Knowledge Integration Gate

**Status:** IN PROGRESS  
**Mandate:** Prove whether db-cluster can improve repo/project knowledge workflows as a backing or parallel substrate before replacing the existing repo-knowledge system.

## Posture

This phase is a **gate**, not a migration.

- Do not rip out repo-knowledge yet.
- Do not turn db-cluster into repo-knowledge.
- Do not flatten db-cluster into "better search over repo facts."

db-cluster runs **beside** repo-knowledge first, ingesting the same or overlapping project memory, then comparing retrieval, traceability, mutation safety, and recovery.

## Non-replacement rule

| Constraint | Enforced |
|------------|----------|
| repo-knowledge remains source workflow | ✓ |
| db-cluster acts as parallel truth substrate | ✓ |
| no destructive migration | ✓ |
| no schema replacement | ✓ |
| no repo-knowledge data loss | ✓ |
| no auto-writeback until proven | ✓ |

## What counts as value

db-cluster adds value if it delivers measurably better:

1. **Traceability** — every fact traces to source artifact
2. **Source ownership** — every fact has a named owner store
3. **Recovery** — imported memory survives damage + restore
4. **Mutation audit** — every update flows through typed command lifecycle
5. **Policy/redaction** — role-based visibility without mutating truth
6. **Cross-repo provenance** — facts link across project boundaries
7. **Operator inspection** — dashboard makes memory structure visible

## Gate criteria

| Verdict | Condition |
|---------|-----------|
| **PASS** | db-cluster clearly improves ≥3 of the value dimensions |
| **PASS_WITH_CONDITIONS** | Improves workflow but named blockers remain |
| **FAIL** | Integration adds ceremony without meaningful improvement |

## What this phase tests

1. Can repo-knowledge concepts map cleanly into cluster truth stores?
2. Can parallel ingest work without modifying repo-knowledge source files?
3. Does db-cluster retrieval produce better evidence structure?
4. Can the dashboard inspect imported project memory?
5. Does mutation law make repo-memory updates safer?
6. Can imported memory survive damage and recovery?
7. Does the gate report reflect dogfood evidence, not architectural enthusiasm?

## Non-goals (do not do yet)

- Replace repo-knowledge
- Write back automatically
- Delete existing repo-knowledge storage
- Change repo-knowledge schema
- Add daemon sync
- Add hosted service
- Add vector DB / graph DB
- Add UI beyond dashboard snapshot
- Publish npm
- Generalize to all external tools

## Exit sentence

Phase 14 evaluates db-cluster against repo-knowledge without prematurely replacing repo-knowledge.
