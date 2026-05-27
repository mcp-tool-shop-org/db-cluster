# Example: Agent-Safe App Database

An application database where an **AI agent proposes mutations** and an **operator validates / approves / commits**. The cluster proves the safety property: the AI cannot mutate truth directly, and a policy-restricted external principal sees a filtered view of the same data.

## What this demonstrates

- Command-gated mutation lifecycle: propose → validate → approve → commit.
- Provenance trace from the resulting state back to the AI's original proposal.
- Policy enforcement: the same cluster surfaces a different view to an `external` trust-zone principal than to an `operator`.
- Content-addressable artifact ingestion (uploaded records → artifact store with `contentHash`).

## Prerequisites

- Node.js 20+
- npm or pnpm
- `db-cluster` installed (`npm install db-cluster` or local `npm link`)

## Run

```bash
cd examples/agent-safe-app-db
npx tsx index.ts
```

Or compile first:

```bash
npx tsc -p ../../tsconfig.examples.json
node ../../dist-examples/examples/agent-safe-app-db/index.js
```

## Expected output

```
=== Agent-Safe App Database ===

Records created: <userId> <publicId>

--- AI Agent proposes mutation ---
Agent proposed: <commandId> → proposed
(No store writes yet — command is staged)

--- Operator validates, approves, and commits ---
Operator committed: committed
Receipt: <receiptId>

--- Trace explains change ---
Why: <provenance explanation>

--- Policy enforcement (external principal) ---
Operator sees: 2 entities
External sees: <fewer> entities (may be filtered/redacted)

Done.
```

## Variations to try

- Switch the operator principal's `trustZone` to `external` and re-run — the operator-side `findSources` should also return a filtered view.
- Add a `restricted` capability requirement to the canonical store's `DEFAULT_POLICIES` and watch the AI's propose call return `PolicyDeniedError` with `code: 'POLICY_DENIED'` and exit code 77 from CLI.
- Trigger a failure-path: try `commitMutation` BEFORE `validateMutation` — the SDK throws `CommandNotValidatedError` with code `COMMAND_NOT_VALIDATED` and `remediationHint` naming the missing step.
- Try `compensateMutation` instead of `update_entity` — preserves the original receipt instead of mutating in place.

## Failure paths an AI agent should branch on

Every cluster surface answers with a `ClusterError` (or its `AiErrorEnvelope` form for MCP). The four classes an AI integrating against this example should handle:

| Class | Code | Branch |
|---|---|---|
| Policy denial | `POLICY_DENIED` | Surface to operator; do NOT retry with elevated principal automatically. |
| Validation failure | `COMMAND_NOT_VALIDATED` | Call `validateMutation` first, then retry. |
| Data error | `CONTENT_HASH_MISMATCH` | Recompute hash from current bytes; re-propose. |
| Terminal command | `COMMAND_REJECTED` / `COMMAND_ALREADY_TERMINAL` | Propose a fresh command — terminal status is final. |

See `docs/runbooks/` for the full typed-error → runbook map.

## Next steps

- Read `docs/policy-and-redaction.md` for the full Principal / Capability / Policy / TrustZone model.
- Read `docs/runbooks/README.md` for operator recovery procedures.
- Read `docs/mcp.md` for the MCP surface — the same lifecycle through tool calls.
- See `examples/project-memory-cluster/` for the same lifecycle without AI-proposing.
