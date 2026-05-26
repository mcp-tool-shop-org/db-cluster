# Phase 12 — Dogfood Findings Repair

## Repair rule

A dogfood finding may become Phase 12 scope only if it blocks recovery, consistency, multi-principal workflow, retrieval usefulness, or operator trust.

## Scope includes

- Artifact restore (backup/restore preserves artifact truth)
- Command persistence across kernel instances
- Auto-index consistency for command-created entities
- Content-aware retrieval improvement
- Regression dogfood replay

## Scope excludes

- repo-knowledge replacement
- New UI
- New backend
- Graph/vector store layer
- Hosted service
- Broad search redesign
- Natural-language answer generation

## Phase 11 findings addressed

| # | Finding | Blocks |
|---|---------|--------|
| 1 | `restore()` does not restore artifacts | Recovery |
| 2 | `commitMutation(create_entity)` does not auto-index | Consistency |
| 3 | Command state not shared across kernel instances | Multi-principal workflow |
| 4 | Index is name-based, not content-based | Retrieval usefulness |

## Exit sentence

Phase 12 repairs dogfood-proven product gaps without changing the product center.
