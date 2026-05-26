# Phase 5 Closeout — Mutation Law and Command Runtime

**Committed:** 2026-05-26  
**Tag:** `phase-5-mutation-law`  
**Tests:** 166 passing (17 new)

## Exit sentence

> db-cluster can safely mutate cluster truth through typed, validated, auditable command lifecycles where failures, rejections, approvals, commits, and compensations are all traceable.

## What shipped

| Component | Location | Purpose |
|-----------|----------|---------|
| Lifecycle model | `src/types/command.ts` | 6-state lifecycle, ValidationResult, ValidationCheck |
| Command validator | `src/kernel/commands.ts` | Structural + semantic validation with named checks |
| Kernel verbs | `src/kernel/cluster-kernel.ts` | validateMutation, approveMutation, rejectMutation, compensateMutation, inspectCommand |
| CLI commands | `src/cli.ts` | validate, approve, reject, compensate, inspect-command |
| Proof tests | `test/phase5-proof.test.ts` | 17 proofs covering lifecycle, audit, persistence |

## Architecture properties established

1. **Validation is named and inspectable** — not a boolean, not opaque. Each check has a name, pass/fail, and message.
2. **Rejection is explicit** — carries actor, reason, timestamp. Rejected commands cannot commit.
3. **Approval is a gate** — only validated commands can be approved. Approval is separate from commit.
4. **Compensation corrects without erasing** — original receipt is preserved. New compensating receipt created.
5. **All transitions emit provenance** — approval, rejection, compensation all produce ledger events.
6. **Lifecycle persists across processes** — CommandQueue file-backed persistence survives restart.
7. **Status transitions are enforced** — invalid transitions throw, preventing state corruption.

## Cumulative architecture

| Phase | Property | Tests |
|-------|----------|-------|
| 1 | Cluster spine — four truth stores, kernel, CLI | 46 |
| 2 | Cross-store identity — URI, resolver, rebuild, explain | 67 |
| 3 | Evidence retrieval — bundles, freshness, gaps, confidence | 24 |
| 4 | Trace surface — provenance graph, trace builder, why | 12 |
| 5 | Mutation law — command lifecycle, validation, compensation | 17 |
| **Total** | | **166** |

## What comes next

**Phase 6 — AI-Facing Interface: MCP and SDK.** The mutation law is now strong enough that exposing it to AI tools will not collapse into overpowered agent actions. Every tool call goes through the same propose → validate → approve → commit boundary that internal operations use.
