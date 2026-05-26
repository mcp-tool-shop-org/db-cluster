# Phase 12 — Repair Report

## 1. Phase 11 findings addressed

| # | Finding | Status |
|---|---------|--------|
| 1 | `restore()` does not restore artifacts | FIXED |
| 2 | `commitMutation(create_entity)` does not auto-index | FIXED |
| 3 | Command state not shared across kernel instances | FIXED |
| 4 | Index is name-based, not content-based | FIXED |

## 2. Repair decisions

| Finding | Repair approach |
|---------|-----------------|
| Artifact restore | Added `importSnapshot()` to ArtifactStore contract; backup now captures base64 content + checksum; restore verifies integrity then imports preserving original ID |
| Command persistence | Made `CommandQueue` read fresh from disk on every `get()`; multiple kernel instances sharing the same `dataDir` now see each other's commands immediately |
| Auto-index on commit | Added index record creation inside `commitMutation`'s `create_entity` case; added index refresh in `update_entity` case (removes stale record, re-indexes with current truth) |
| Content-aware retrieval | Created `src/indexing/content-indexer.ts` + `src/indexing/tokenizer.ts`; rebuild now extracts headings and key terms from markdown artifacts; search finds docs by body content |

## 3. Behavior before repair

- `backup()` captured artifact metadata but `restore()` skipped artifact restoration entirely
- `commitMutation(create_entity)` wrote canonical truth but never indexed — entity invisible to `findSources()`
- Each `CommandQueue` instance cached commands on construction; kernel B couldn't see kernel A's proposals
- Index text was `"filename vN"` for artifacts — searches like "MCP" or "mutation law" returned zero results

## 4. Behavior after repair

- `backup()` captures artifact content as base64 with SHA-256 checksum; `restore()` verifies checksum then imports via `importSnapshot()` preserving original artifact IDs
- `commitMutation(create_entity)` now writes canonical + index in one transaction; `update_entity` refreshes the stale index record
- `CommandQueue.get()` reads from disk every call — no stale cache; propose in kernel A, commit in kernel D works
- Artifacts indexed by filename + headings + key terms; "MCP" finds phase-6-closeout.md, "mutation law" finds phase-5-closeout.md

## 5. Tests added

| Test file | Count | Coverage |
|-----------|-------|----------|
| `test/restore-artifacts.test.ts` | 6 | Backup content, restore, ID preservation, trace, retrieve, corruption |
| `test/command-persistence.test.ts` | 7 | Cross-kernel propose/validate/approve/commit/inspect/reject/compensate + backup |
| `test/command-index-consistency.test.ts` | 6 | Auto-index, owner truth, bundle, trace, no dupes, update refresh |
| `test/content-index.test.ts` | 10 | Content indexed, headings, key terms, Phase 5/6/10 retrieval, rebuildable |
| `test/dogfood-replay.test.ts` | 6 | All 4 findings regression + overall replay |

## 6. Remaining known gaps

1. **Entity attributes not yet content-indexed** — only artifact text is indexed with content extraction. Entity attributes remain in metadata-only form in the index.
2. **Provenance link labels not indexed** — provenance events are not included in index text.
3. **Receipt summaries not indexed** — receipt `resultSummary` text is not searchable through the index.
4. **No multi-token scoring** — index search is substring matching, not weighted term scoring. "MCP SDK" finds any record containing either substring independently.

These are quality-of-life improvements, not recovery/consistency/workflow blockers.

## 7. Dogfood replay result

All four Phase 11 findings no longer reproduce:
- `restore()` restores artifacts with content + checksum verification ✓
- `commitMutation(create_entity)` auto-indexes ✓
- Command state persists across kernel instances ✓
- Content retrieval finds docs by body content ✓

## 8. Verdict

**PASS**

All four load-bearing dogfood findings are repaired. Recovery, consistency, multi-principal workflow, and retrieval usefulness are restored. The remaining gaps (§6) are not blockers — they are improvements for future phases.
