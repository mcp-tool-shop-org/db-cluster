# Phase 10 — Developer Product Surface

## Mandate

db-cluster can be understood, installed, run, and integrated by a developer without weakening the cluster thesis or hiding the ownership/provenance/mutation laws behind vague docs.

## Waves Delivered

### Wave 1: Documentation Architecture
12 docs in `docs/`: quickstart, architecture, store-contracts, cluster-uris, retrieval-bundles, provenance-graphs, mutation-law, policy-and-redaction, mcp, sdk, cli, operations. All lead with cluster thesis, name store ownership law, never position as RAG/vector/memory.

### Wave 2: Quickstart Golden Path
`examples/quickstart/` with evidence.md, commands.md, README.md, and expected-output/ for init, ingest, doctor.

### Wave 3: CLI Reference Test
`test/cli-docs.test.ts` — 14 tests verifying docs/cli.md stays in sync with actual CLI commands.

### Wave 4: SDK Reference Examples
`examples/sdk/` — 4 examples: local-cluster, retrieval-bundle, mutation-lifecycle, policy-redaction. All compile. (The `postgres-canonical` example was removed in Wave A2 — the SDK does not support a Postgres-via-SDK path today; use `createClusterFromEnv()` with the raw kernel if you need Postgres canonical.)

### Wave 5: MCP Integration Guide
`examples/mcp/` — config.example.json, tool-catalog.md (16 tools), safety-model.md (artifact content boundary, lifecycle enforcement, trust zones).

### Wave 6: Example Applications
3 example apps proving cluster thesis in real scenarios:
- `examples/research-evidence-cluster/` — papers as artifacts, claims as entities
- `examples/project-memory-cluster/` — docs as artifacts, decisions as entities
- `examples/agent-safe-app-db/` — uploaded records as artifacts, app records as entities

### Wave 7: Installation + Smoke Tests
`test/install-smoke.test.ts` — 9 tests proving: package.json correct, build succeeds, dist outputs exist, CLI help works, init creates cluster, SDK imports resolve, MCP module loads, Postgres fails cleanly when URL missing.

### Wave 8: Phase 10 Proof Suite
`test/phase10-proof.test.ts` — 12 proofs:
1. README status matches package/test reality
2. CLI docs mention every public command group
3. SDK examples compile
4. MCP tool catalog docs match runtime tools
5. Quickstart golden path executes
6. At least one example uses all 4 stores
7. No example uses single-store-only behavior
8. No docs position as RAG/vector/memory middleware
9. Mutation examples always use command lifecycle
10. Policy examples do not leak restricted truth
11. Operations docs include backup/restore/doctor/rebuild
12. Fresh install smoke passes or reports missing services

## Exit Criteria Met

- A fresh developer can install and run db-cluster without repo-local assumptions
- Documentation covers all subsystems without reducing to middleware framing
- Examples prove the cluster thesis in real scenarios
- Tests verify the developer surface stays correct as code evolves

## Test Count

434 tests passing across 29 files.
