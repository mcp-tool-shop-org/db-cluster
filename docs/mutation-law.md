# Mutation Law

db-cluster enforces command-gated mutation. No store is ever written to directly by consumers. Every mutation crosses a typed command boundary with a full lifecycle.

## The command lifecycle

```
proposed → validated → approved → committed
                 ↘          ↘
              rejected    rejected
                              ↓
                        compensated
```

| State | Meaning | Writes to stores? |
|-------|---------|-------------------|
| `proposed` | Intent declared. No validation yet. | No |
| `validated` | Structurally and semantically valid. | No |
| `approved` | Operator/policy has approved execution. | No |
| `committed` | Mutation applied to owner store. Receipt emitted. | **Yes** |
| `rejected` | Terminal. Mutation will not execute. | No |
| `compensated` | Committed mutation corrected (not erased). | **Yes** (correction) |

## Commands

```typescript
interface Command {
    id: string;
    verb: string;
    targetStore: 'canonical' | 'artifact';
    payload: Record<string, unknown>;
    proposedBy: string;
    status: 'proposed' | 'validated' | 'approved' | 'committed' | 'rejected' | 'compensated';
    proposedAt: string;
    validatedAt?: string;
    approvedAt?: string;
    committedAt?: string;
    rejectedAt?: string;
    compensatedAt?: string;
    rejectionReason?: string;
    validationResult?: { valid: boolean; errors: string[] };
}
```

## Verbs

| Verb | Target store | Effect |
|------|-------------|--------|
| `create_entity` | canonical | Creates a new entity |
| `update_entity` | canonical | Updates entity name/attributes |
| `ingest_artifact` | artifact | Ingests a new artifact |

## CLI

```bash
# Propose (does NOT write)
db-cluster propose '{"verb":"update_entity","targetStore":"canonical","payload":{"entityId":"...","patch":{"name":"new name"}},"proposedBy":"dev"}'

# Validate (checks structure)
db-cluster validate <command-id>

# Approve (operator gate)
db-cluster approve <command-id> --by operator --note "Reviewed"

# Commit (WRITES to store)
db-cluster commit <command-id>

# Reject (terminal)
db-cluster reject <command-id> --by operator --reason "Not approved"

# Compensate (correct without erasing)
db-cluster compensate <command-id> --by operator --reason "Fix typo"

# Inspect command state
db-cluster inspect-command <command-id>
```

## SDK

```typescript
// Propose
const cmd = await sdk.proposeMutation({
    verb: 'update_entity',
    targetStore: 'canonical',
    payload: { entityId: '...', patch: { name: 'new name' } },
    proposedBy: 'developer',
});

// Validate
await sdk.validateMutation(cmd.id);

// Approve
await sdk.approveMutation(cmd.id, 'operator', 'Reviewed and approved');

// Commit — this is the ONLY step that writes to stores
const { command, receipt } = await sdk.commitMutation(cmd.id, 'operator');

// The receipt proves the mutation happened
console.log(receipt.commandId, receipt.affectedIds, receipt.provenanceEventId);
```

## MCP

```json
{"tool": "cluster_propose_mutation", "arguments": {"verb": "update_entity", "targetStore": "canonical", "payload": {"entityId": "...", "patch": {"name": "new"}}, "proposedBy": "ai-agent"}}
```

Then separately:
```json
{"tool": "cluster_commit_mutation", "arguments": {"commandId": "...", "actorId": "operator"}}
```

An AI agent can propose mutations. Only an authorized actor can commit them.

## Receipts

Every committed mutation produces a receipt in the ledger:

```bash
db-cluster receipts
```

Receipts include:
- `commandId` — links to the command that was committed
- `affectedIds` — which store objects were changed
- `provenanceEventId` — links to the provenance event
- `committedAt` — when the mutation was applied

## Compensation

Compensation does not erase history. It creates a **new** command that corrects the effect of a previous command:

```bash
db-cluster compensate <committed-command-id> --by operator --reason "Name was incorrect"
```

The original command and its receipt remain in the ledger. The compensating command has its own receipt. Provenance shows the full correction chain.

## Ownership law

- Only `commit` writes to truth stores
- Every write produces a receipt
- Every receipt links to a provenance event
- Compensation corrects without erasing
- Commands target a specific store — no cross-store writes in one command
- The ledger records everything — proposals, rejections, commits, compensations

## Why this matters

Without command-gated mutation:
- AI agents could write directly to stores
- No audit trail of what changed and why
- No way to reject or compensate
- No receipt proving the mutation happened
- No separation between intent (propose) and execution (commit)

With command-gated mutation:
- Every change is intentional, validated, and traceable
- Operators can review before execution
- AI agents propose; humans approve
- History is permanent and verifiable
