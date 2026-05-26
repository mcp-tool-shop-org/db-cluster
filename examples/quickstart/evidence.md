# Research Evidence: LLM Database Architecture

## Claim: LLMs should not write directly to databases

Large language models lack the structural guarantees needed for safe database mutation:

1. **No transaction boundaries** — LLM outputs are probabilistic, not atomic
2. **No audit trail** — natural language commands don't produce receipts
3. **No rollback** — there is no "undo" for a malformed write
4. **No ownership model** — who authorized the change?

## Evidence

From "Designing Safe AI-Database Interactions" (2025):

> "Systems that allow AI agents to execute arbitrary SQL mutations without a command lifecycle
> have no way to attribute changes, no way to compensate errors, and no way to prove that
> a specific mutation was intentional."

## Implication

A database cluster designed for AI interaction should:

- Require typed commands for all mutations
- Separate intent (propose) from execution (commit)
- Emit receipts for every committed change
- Maintain provenance from proposal through execution
- Allow compensation without erasing history
