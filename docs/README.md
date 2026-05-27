# db-cluster docs map

This directory has 40+ files. Most operators only need the "Start here" set;
the "Reference" set covers specific surfaces and contracts; the "Development
phase history" set is internal context for contributors and historians.

## Start here

| File | What it covers |
|------|----------------|
| [quickstart.md](quickstart.md) | 5-minute golden path — install, init, ingest, retrieve, mutate, prove. |
| [handbook.md](handbook.md) | The canonical operator + developer guide. Single document end-to-end. |
| [architecture.md](architecture.md) | Why four stores, not one. Where the cluster boundary is. |

## Reference

| File | What it covers |
|------|----------------|
| [sdk.md](sdk.md) | `ClusterSDK` programmatic surface. Recommended for application code. |
| [cli.md](cli.md) | `db-cluster <verb>` reference. Every subcommand + flag. |
| [mcp.md](mcp.md) | MCP tool surface for AI agents. Tool catalog + safety guardrails. |
| [store-contracts.md](store-contracts.md) | The 4 store interfaces. Adapter contract. |
| [cluster-uris.md](cluster-uris.md) | `cluster://<store>/<id>` URI scheme. |
| [policy-and-redaction.md](policy-and-redaction.md) | **Canonical** source for Principal, Capability, Policy, Redaction, TrustZone, VisibilityRule. Other docs link here. |
| [retrieval-bundles.md](retrieval-bundles.md) | EvidenceBundle shape and retrieval semantics. |
| [provenance-graphs.md](provenance-graphs.md) | ProvenanceGraph shape, traces, lineage. |
| [mutation-law.md](mutation-law.md) | Command lifecycle and the propose-validate-approve-commit boundary. |
| [operations.md](operations.md) | doctor, verify, rebuild, backup, restore. |
| [release-readiness.md](release-readiness.md) | Release flow, gate procedure, known flake patterns. |
| [release-notes-v0.1.md](release-notes-v0.1.md) | What v0.1.0 ships (and explicitly does not). |
| [package-boundary.md](package-boundary.md) | What is public surface vs internal. |
| [repo-knowledge-mapping.md](repo-knowledge-mapping.md) | Integration adapter for repo-knowledge workflows. |

## Development phase history

The repo grew through 15 phases plus 3 internal dogfood waves. The
`phase-*-closeout.md` files are CONTRIBUTOR / HISTORIAN context, not
user-facing — they document what each phase shipped + what it deferred.

| Phase | Closeout | Doctrine doc |
|-------|----------|--------------|
| 0 | — | [phase-0-doctrine.md](phase-0-doctrine.md) |
| 1 | [phase-1-closeout.md](phase-1-closeout.md) | [phase-1-cluster-spine.md](phase-1-cluster-spine.md) |
| 2 | [phase-2-closeout.md](phase-2-closeout.md) | [phase-2-cross-store-identity.md](phase-2-cross-store-identity.md) |
| 3 | [phase-3-closeout.md](phase-3-closeout.md) | — |
| 4 | [phase-4-closeout.md](phase-4-closeout.md) | — |
| 5 | [phase-5-closeout.md](phase-5-closeout.md) | — |
| 6 | [phase-6-closeout.md](phase-6-closeout.md) | — |
| 7 | [phase-7-closeout.md](phase-7-closeout.md) | — |
| 8 | [phase-8-closeout.md](phase-8-closeout.md) | [phase-8-physical-store-expansion.md](phase-8-physical-store-expansion.md) |
| 9 | [phase-9-closeout.md](phase-9-closeout.md) | [phase-9-operations-recovery.md](phase-9-operations-recovery.md) |
| 10 | [phase-10-closeout.md](phase-10-closeout.md) | — |
| 11 | [phase-11-closeout.md](phase-11-closeout.md) | [phase-11-dogfood-report.md](phase-11-dogfood-report.md) |
| 12 | [phase-12-closeout.md](phase-12-closeout.md) | [phase-12-dogfood-repair.md](phase-12-dogfood-repair.md) + [phase-12-repair-report.md](phase-12-repair-report.md) |
| 13 | [phase-13-closeout.md](phase-13-closeout.md) | [phase-13-dashboard-integration.md](phase-13-dashboard-integration.md) |
| 14 | [phase-14-closeout.md](phase-14-closeout.md) | [phase-14-repo-knowledge-integration-gate.md](phase-14-repo-knowledge-integration-gate.md) + [phase-14-repo-knowledge-integration-report.md](phase-14-repo-knowledge-integration-report.md) |
| 15 | [phase-15-closeout.md](phase-15-closeout.md) | — |

## Doc-drift guard

Every `typescript` code block in this directory is typechecked by
`scripts/doc-drift.mjs` (release-gate stage [8/8]). Every `from '@mcptoolshop/db-cluster'`
or `from '@mcptoolshop/db-cluster/<subpath>'` named import is verified against the actual
public exports. Drift fails the release-gate. See `docs/release-readiness.md`
for the stage map.
