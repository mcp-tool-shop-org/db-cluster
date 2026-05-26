# Phase 3 Closeout — Retrieval Planner and Evidence Bundles

**Committed:** 2026-05-26  
**Tag:** `phase-3-retrieval-planner`  
**Tests:** 137 passing (24 new)

## Exit sentence

> db-cluster retrieves structured evidence bundles that carry truth, freshness, gaps, and confidence boundaries — not search hits.

## What shipped

| Component | Location | Purpose |
|-----------|----------|---------|
| Type model | `src/types/evidence-bundle.ts` | EvidenceBundle, ResolvedEvidence, FreshnessAssessment, MissingContext, ConfidenceBoundary |
| RetrievalPlanner | `src/retrieval/retrieval-planner.ts` | Query → index → resolve → provenance → freshness → confidence |
| Kernel verbs | `src/kernel/cluster-kernel.ts` | retrieveBundle, explainRetrieval |
| CLI commands | `src/cli.ts` | retrieve, explain-retrieval |
| Proof tests | `test/phase3-proof.test.ts` | 10 proofs covering all wave acceptance criteria |

## Architecture properties established

1. **Retrieval is not search** — returns structured bundles with owner truth, not index hits.
2. **Freshness is classified** — stale records, unprovenanced objects, and missing sources all surfaced.
3. **Confidence boundaries are explicit** — what the bundle can and cannot claim.
4. **Gaps are first-class** — missing context is reported, not hidden.
5. **Same surface for CLI/SDK** — all consumers get EvidenceBundle.

## Cumulative architecture at Phase 3

| Phase | Property | Tests |
|-------|----------|-------|
| 1 | Cluster spine — four truth stores, kernel, CLI | 46 |
| 2 | Cross-store identity — URI, resolver, rebuild, explain | 67 |
| 3 | Evidence retrieval — bundles, freshness, gaps, confidence | 24 |
| **Total** | | **137** |
