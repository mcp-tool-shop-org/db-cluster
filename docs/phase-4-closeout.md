# Phase 4 Closeout — Provenance Graph and Trace Surface

**Committed:** 2026-05-26  
**Tag:** `phase-4-provenance-graph`  
**Tests:** 149 passing (12 new)

## Exit sentence

> db-cluster can explain why any surfaced object exists, what truth supports it, what changed it, what receipts prove it, and where provenance is stale, missing, or broken.

## What shipped

| Component | Location | Purpose |
|-----------|----------|---------|
| Type model | `src/types/provenance-graph.ts` | ProvenanceGraph, Node, Edge, Gap, Warning, Summary |
| TraceBuilder | `src/provenance/trace-builder.ts` | Cross-store graph builder |
| Kernel verbs | `src/kernel/cluster-kernel.ts` | traceObject, traceBundle, explainTrace, why |
| CLI commands | `src/cli.ts` | trace, why, lineage, trace-bundle |
| Proof tests | `test/phase4-proof.test.ts` | 12 proofs covering all wave acceptance criteria |

## Architecture properties established

1. **Trace is cross-store** — not limited to ledger parent chains. Follows evidence links, index derivation, receipt coverage across all four stores.
2. **Gaps are first-class** — missing provenance and missing owner truth are represented as graph nodes/warnings, not swallowed.
3. **Stale projections are graph-visible** — `stale_projection_of` edge + `stale_index` warning surface drift.
4. **`why()` summarizes truth** — compact explanation derived from actual trace, not generated prose.
5. **Graph ordering is stable** — same input produces same output, enabling snapshots and regression.
6. **Same surface for CLI/SDK/MCP** — all consumers get ProvenanceGraph; CLI is just one rendering.

## Cumulative architecture

| Phase | Property | Tests |
|-------|----------|-------|
| 1 | Cluster spine — four truth stores, kernel, CLI | 46 |
| 2 | Cross-store identity — URI, resolver, rebuild, explain | 67 |
| 3 | Evidence retrieval — bundles, freshness, gaps, confidence | 24 |
| 4 | Trace surface — provenance graph, trace builder, why | 12 |
| **Total** | | **149** |

## What comes next

**Phase 5 — Mutation Law and Command Runtime.** The trace infrastructure is strong enough to make mutation accountability first-class. Commands should carry law (who can propose, what validation gates apply, what provenance chain a commit produces) rather than just "propose → validate → commit → receipt."
