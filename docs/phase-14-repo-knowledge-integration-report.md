# Phase 14: Repo-Knowledge Integration Gate — Report

**Verdict: PASS**

## Summary

db-cluster can serve as a backing substrate for repo-knowledge workflows,
providing provenance, evidence bundles, mutation safety, and operational
infrastructure that repo-knowledge alone does not offer.

This is NOT a migration recommendation. The existing repo-knowledge system
continues to function. This gate proves that db-cluster *adds value* as a
parallel truth layer without requiring replacement of the source system.

## Evidence Matrix

| Capability | repo-knowledge | db-cluster | Advantage |
|-----------|---------------|------------|-----------|
| Flat-file retrieval | ✓ Full-text scan | ✓ Indexed search | db-cluster: structured, scored |
| Provenance trace | ✗ None | ✓ Full event chain | db-cluster: who/when/why |
| Mutation safety | ✗ Direct file write | ✓ Command lifecycle | db-cluster: propose/validate/approve/commit |
| Evidence bundles | ✗ N/A | ✓ Multi-store resolution | db-cluster: entities + artifacts + provenance |
| Freshness visibility | ✗ File mtime only | ✓ Index staleness tracking | db-cluster: explicit freshness |
| Backup/restore | ✗ git only | ✓ Portable JSON + git | db-cluster: structured backup |
| Health diagnostics | ✗ None | ✓ Doctor + Verify | db-cluster: automated health checks |
| Confidence boundaries | ✗ None | ✓ Bundle-level confidence | db-cluster: explicit uncertainty |

## Gate Criteria

### 1. Ingest without modification ✓
Source files remain untouched. `ingestRepoKnowledge` reads files and creates
entities/artifacts in db-cluster without writing back to the source.

### 2. Retrieval comparison ✓
`compareRetrieval` demonstrates that db-cluster returns richer results:
provenance-backed, confidence-bounded, freshness-visible evidence bundles
vs. raw file content.

### 3. Provenance trace ✓
Every ingested fact traces back to its source artifact, with timestamped
events showing who ingested what and when.

### 4. Mutation safety ✓
The command lifecycle prevents unsupervised writes:
- Agent can propose
- Agent cannot commit (workflow gate)
- Operator approves and commits
- Receipt proves the mutation occurred

### 5. Operations ✓
Doctor, verify, backup, restore, and index rebuild all work correctly on
imported repo-knowledge memory.

### 6. Dashboard inspection ✓
`generateRepoKnowledgeSnapshot` produces a dashboard-compatible view of
ingested memory, including operations health.

## What This Does NOT Prove

- That repo-knowledge should be replaced (not in scope)
- That db-cluster is faster (not measured — not the point)
- That existing repo-knowledge consumers should change (they shouldn't yet)
- That the mapping is complete (10 entity kinds, 7 artifact kinds — sufficient for gate)

## Recommendation

**Keep both systems running.** Use db-cluster as the provenance and evidence
layer when richer guarantees are needed (audit trails, mutation safety,
confidence boundaries). Use repo-knowledge for simple flat-file access where
provenance doesn't matter.

The integration adapter (`src/integrations/repo-knowledge/`) provides the
bridge. No changes to repo-knowledge are required.

## Test Coverage

| Test file | Tests | Status |
|-----------|-------|--------|
| test/repo-knowledge-mapping.test.ts | 12 | ✓ Pass |
| test/repo-knowledge-ingest.test.ts | 9 | ✓ Pass |
| test/repo-knowledge-retrieval.test.ts | 8 | ✓ Pass |
| test/repo-knowledge-dashboard.test.ts | 8 | ✓ Pass |
| test/repo-knowledge-mutation.test.ts | 8 | ✓ Pass |
| test/repo-knowledge-ops.test.ts | 8 | ✓ Pass |
| test/phase14-proof.test.ts | 12 | ✓ Pass |

**Total: 65 tests** covering the full integration surface.
