---
title: SDK Reference
description: ClusterSDK — programmatic db-cluster from Node code. Mutation lifecycle, retrieve, trace.
sidebar:
  order: 6
---

The SDK is the in-process equivalent of the MCP surface. Use it when embedding db-cluster as a library in your Node application.

## Install + import

```bash
npm install db-cluster
```

```ts
import { ClusterSDK } from 'db-cluster/sdk';
```

`db-cluster/sdk` is the canonical subpath. `db-cluster` (the bare import) exports the same SDK plus the `PolicyEnforcedKernel` factory + store contracts + URI helpers + types.

## Constructor

```ts
interface SDKOptions {
    clusterDir: string;
    policies?: Policy[];
    trustZones?: TrustZone[];
    visibilityRules?: VisibilityRule[];
    principal?: Principal;
}

const sdk = new ClusterSDK({
    clusterDir: './.db-cluster',
    principal: { id: 'u-1', name: 'Alice', roles: ['operator'], trustZone: 'internal-trusted' },
});
```

`ClusterKernel` is **not** exported. The SDK wraps `PolicyEnforcedKernel`; every read goes through redaction, every mutation through the command lifecycle.

## Read paths

```ts
// Find candidate index records for a query.
const sources = await sdk.findSources('LLM database architecture');

// Retrieve an evidence bundle — index → resolver → freshness → confidence.
const bundle = await sdk.retrieveBundle('LLM database architecture');
console.log(bundle.confidenceBoundaries);    // what the bundle can / cannot claim
console.log(bundle.missingContext);          // what's missing
console.log(bundle.freshness.staleCount);    // how many records were stale

// Resolve a URI to owner truth (never an index projection).
const entity = await sdk.resolve('cluster://canonical/<entity-id>');

// Trace provenance from any URI.
const graph = await sdk.traceObject('cluster://canonical/<entity-id>', {
    direction: 'bidirectional',
    depth: 3,
});

// Compact operator-facing explanation.
const explanation = await sdk.why('cluster://canonical/<entity-id>');
```

## Mutation lifecycle

The lifecycle is **explicit** — there is no SDK-side auto-walk. Each step is a separate call so the audit trail is complete and the separation of duties is enforceable.

```ts
// 1. Propose — stages a command in the ledger.
const cmd = await sdk.proposeMutation({
    verb: 'update_entity',
    targetStore: 'canonical',
    payload: { entityId: '<entity-id>', patch: { name: 'New name' } },
    proposedBy: 'agent-1',
});

// 2. Validate — runs structural + verb-specific checks. Returns a ValidationResult.
const validated = await sdk.validateMutation(cmd.id);
if (!validated.passed) {
    for (const check of validated.checks.filter(c => !c.passed)) {
        console.error(`${check.name}: ${check.message}`);
    }
    return;
}

// 3. Approve — operator gate. Optional note.
await sdk.approveMutation(cmd.id, 'reviewer-1', 'Looks reasonable.');

// 4. Commit — writes truth, emits provenance event, generates receipt.
const result = await sdk.commitMutation(cmd.id, 'committer-1');
console.log(`Receipt: ${result.receipt.id}`);
```

Compensation creates a **new** compensating command — it does not erase the original.

```ts
const compensating = await sdk.compensateMutation(
    cmd.id,
    'compensator-1',
    'Reverting because of upstream policy change.',
);
```

## Inspection

```ts
const cmd = await sdk.inspectCommand('<command-id>');
const receipts = await sdk.listReceipts({ subjectId: '<entity-id>' });
```

## Policy

```ts
const decision = await sdk.policyExplain({
    principal: { id: 'u-1', name: 'Alice', roles: ['operator'], trustZone: 'internal-trusted' },
});

const test = await sdk.policyTest({
    principal: { /* ... */ },
    verb: 'commit_mutation',
    resource: 'cluster://canonical/<entity-id>',
});
console.log(test.effect, test.matchedPolicyId);
```

## Error handling

Every method throws a `ClusterError` subclass on failure. Catch and branch on `err.code`:

```ts
import { ClusterError, PolicyDeniedError, CommandNotValidatedError } from 'db-cluster';
import { formatForUser } from 'db-cluster';

try {
    await sdk.commitMutation(cmd.id, 'committer-1');
} catch (err) {
    if (err instanceof CommandNotValidatedError) {
        await sdk.validateMutation(cmd.id);
        // retry
    } else if (err instanceof PolicyDeniedError) {
        // Escalate to operator
    } else if (err instanceof ClusterError) {
        process.stderr.write(formatForUser(err) + '\n');
        process.exit(typedErrorToExitCode(err.code));
    }
}
```

`formatForUser(err)` produces the canonical `<message>\n  → try: <remediation hint>` shape used by the CLI's error handler. Same helper is used by MCP, SDK, and the dashboard.

## See also

- [MCP Integration](../mcp/) — the AI-agent surface equivalent.
- [Policy & Redaction](../policy-and-redaction/) — what the SDK constructor's policy / trustZone / visibilityRule options do.
- [CLI Reference](../cli/) — the operator surface that wraps the SDK.
