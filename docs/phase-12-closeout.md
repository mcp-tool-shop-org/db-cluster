# Phase 12 — Dogfood Findings Repair: Closeout

## Verdict: PASS

All four Phase 11 findings repaired. Zero regressions. 485 tests passing.

## Findings addressed

| # | Finding | Root cause | Fix |
|---|---------|-----------|-----|
| 1 | `restore()` doesn't restore artifacts | Backup only saved metadata; restore had no content to write | Backup captures base64 + SHA-256; restore verifies integrity; `importSnapshot()` preserves IDs |
| 2 | Command state not shared across instances | CommandQueue cached commands in memory | Removed cache; `get()` reads from disk every call |
| 3 | `commitMutation(create_entity)` doesn't auto-index | Only `createEntity()` wrote index records | `commitMutation` now indexes on `create_entity` and refreshes on `update_entity` |
| 4 | Index is name-based, not content-based | `rebuildIndex` wrote `"filename vN"` | New `src/indexing/` module extracts headings + key terms from artifact content |

## Test coverage added

| File | Tests | Purpose |
|------|-------|---------|
| `test/restore-artifacts.test.ts` | 6 | Content restore, ID preservation, integrity verification |
| `test/command-persistence.test.ts` | 7 | Disk-backed queue, multi-instance sharing |
| `test/command-index-consistency.test.ts` | 6 | Auto-index on create/update mutations |
| `test/content-index.test.ts` | 10 | Tokenizer, content indexer, heading extraction |
| `test/dogfood-replay.test.ts` | 6 | End-to-end regression replay |
| `test/phase12-proof.test.ts` | 14 | Combined proof of all four repairs |

## Existing tests updated

Tests that previously verified "update via command leaves index stale" now create staleness via direct store writes (bypassing kernel). This accurately tests stale detection while respecting the new auto-index-on-commit behavior.

## Final numbers

- **485** tests passing
- **48** skipped (integration tests requiring external services)
- **37** test files active
- **0** failures
