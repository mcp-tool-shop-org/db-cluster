# Example: ClusterSDK — programmatic API

Five working examples of the `ClusterSDK` (`db-cluster/sdk`) — the recommended way to drive db-cluster from application code. The SDK wraps `PolicyEnforcedKernel`, owns store wiring, and exposes a stable promise-based surface.

## What's in this directory

| File | Demonstrates |
|---|---|
| `local-cluster.ts` | Basic setup: ingest an artifact + create an entity through the lifecycle. |
| `retrieval-bundle.ts` | Retrieving an `EvidenceBundle` — owner truth, freshness, confidence. |
| `mutation-lifecycle.ts` | Full propose → validate → approve → commit lifecycle. |
| `policy-redaction.ts` | Policy enforcement + redaction view from different principals. |

## Prerequisites

- Node.js 20+
- npm or pnpm
- `db-cluster` installed (`npm install db-cluster` or local `npm link`)

## Run any example

```bash
cd examples/sdk
npx tsx local-cluster.ts
npx tsx retrieval-bundle.ts
npx tsx mutation-lifecycle.ts
npx tsx policy-redaction.ts
```

Or compile through the examples tsconfig:

```bash
npx tsc -p ../../tsconfig.examples.json
node ../../dist-examples/examples/sdk/local-cluster.js
```

## Expected output

Each script ends with `Done.` after exercising its lifecycle. Specific output varies by example — `local-cluster.ts` produces:

```
Cluster initialized at: <temp dir>
Artifact ingested: <id>
Entity created: <id>
Retrieved: 1 entities, 1 artifacts
All fresh: true
Provenance nodes: <N>
  cluster://canonical/<id> <label>
  cluster://artifact/<id> <label>
  ...
Done.
```

## SDK methods exercised

All four examples between them cover the SDK's public surface:

| Method | Demonstrated in |
|---|---|
| `proposeMutation` / `validateMutation` / `approveMutation` / `commitMutation` | every example |
| `compensateMutation` | mutation-lifecycle.ts |
| `rejectMutation` | mutation-lifecycle.ts |
| `inspectCommand` | mutation-lifecycle.ts |
| `listReceipts` | mutation-lifecycle.ts |
| `findSources` | retrieval-bundle.ts |
| `retrieveBundle` | retrieval-bundle.ts, local-cluster.ts |
| `explainRetrieval` | retrieval-bundle.ts |
| `traceObject` / `why` | local-cluster.ts, policy-redaction.ts |
| `policyExplain` / `policyTest` | policy-redaction.ts |

## Variations to try

- Inject a policy that denies `read_owner_truth` on the canonical store. Re-run `retrieval-bundle.ts` and confirm the bundle is empty / filtered.
- Add a `compensateMutation` call to `local-cluster.ts` after the commit. Inspect the resulting receipt chain — the original receipt is preserved.
- Tamper with the staging file between propose and commit (sleep mid-test). Confirm `commitMutation` raises `StagedContentTamperedError` — the kernel detects on-disk tampering.

## Failure paths

The SDK is a thin wrapper around `PolicyEnforcedKernel`. Every typed error from the kernel surface comes through unchanged:

- `POLICY_DENIED` — Surface to operator; do NOT retry with elevated principal automatically.
- `CONTENT_HASH_MISMATCH` — Recompute hash; re-propose.
- `COMMAND_NOT_VALIDATED` / `COMMAND_REJECTED` / `COMMAND_ALREADY_TERMINAL` — Wrong lifecycle step; consult the error's `remediationHint`.
- `RECEIPT_FAILED` — Critical; see [docs/runbooks/orphan-mutations.md](../../docs/runbooks/orphan-mutations.md).

All errors are `ClusterError` subclasses — pattern-match via `instanceof` or `err.code`.

## Next steps

- Read `docs/sdk.md` for the full method reference.
- Read `docs/runbooks/README.md` for the typed-error → recovery map.
- See `examples/agent-safe-app-db/` for the SDK driven by an AI-proposer.
- See `examples/mcp/` for the MCP boundary that wraps the same SDK.
