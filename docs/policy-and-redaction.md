# Policy and Redaction

db-cluster enforces trust boundaries natively. Policy is not bolted on — it is evaluated on every operation through the `PolicyEnforcedKernel`.

## Principals

Every actor in the system is a `Principal`:

```typescript
interface Principal {
    id: string;
    name: string;
    roles: string[];
    trustZone: string;
    metadata?: Record<string, unknown>;
}

type Capability =
    | 'discover_existence'    // can see that an object exists in search/index
    | 'read_owner_truth'      // can read the full object from its owner store
    | 'read_derivative'       // can read index/derivative records
    | 'trace_provenance'      // can walk provenance graph
    | 'propose_mutation'      // can propose a command (writes nothing)
    | 'validate_command'      // can trigger validation on a proposed command
    | 'approve_command'       // can approve a validated command
    | 'reject_command'        // can reject a command
    | 'commit_command'        // can commit a validated/approved command (writes truth)
    | 'compensate_command'    // can compensate a committed command
    | 'read_receipts'         // can read mutation receipts
    | 'read_command'          // can inspect command lifecycle state
    | 'explain_retrieval';    // can see retrieval explanation / stale warnings
```

Capabilities are granted via `roles`. Roles are defined separately (each role
bundles a `capabilities: Capability[]` plus a `scope`), so principals carry
named roles rather than raw capability lists.

## Trust zones

Trust zones define security boundaries:

| Zone | Purpose |
|------|---------|
| `internal` | Full access operators |
| `agent` | AI agents — read + propose, no commit |
| `external` | Restricted consumers — limited read |

## Policies

Policies are first-match, deny-wins:

```typescript
interface Policy {
    id: string;
    name: string;
    priority: number;
    match: PolicyMatch;
    decision: 'allow' | 'deny';
    reason: string;
    redaction?: RedactionRule;
}

interface PolicyMatch {
    principals?: string[];
    trustZones?: string[];
    capabilities?: Capability[];
    stores?: string[];
    kinds?: string[];
    uriPatterns?: string[];
    commandVerbs?: string[];
}
```

Higher priority policies are evaluated first. First matching deny blocks the operation.

## Redaction

When policy allows access but with restrictions, redaction strips sensitive data while preserving object shape:

```typescript
interface RedactionRule {
    id: string;
    target: RedactionTarget;
    behavior: 'strip' | 'mask' | 'summarize' | 'hash';
    reason: string;
}
```

| Behavior | Effect |
|----------|--------|
| `strip` | Remove field entirely |
| `mask` | Replace value with `[REDACTED]` |
| `summarize` | Replace with summary text |
| `hash` | Replace with SHA-256 hash |

### What gets redacted

- **Entity attributes** (`entity_attributes`) — sensitive fields masked/stripped
- **Entity names** (`entity_name`) — gates the `name` component of entity-type
  provenance node labels. When this rule applies, the rendered label becomes
  `<kind>: [REDACTED]` instead of `<kind>: <name>`. Re-rendered at the
  PolicyEnforcedKernel boundary via `renderProvenanceLabel(metadata.labelData,
  policyView)` — the bare ClusterKernel surface always renders the literal
  name (see [Label rendering boundary](#label-rendering-boundary) below).
- **Artifact content/paths** (`artifact_content`) — storage locations hidden
- **Artifact filenames** (`artifact_filename`) — gates the `filename`
  component of artifact-type provenance node labels. Rendered label becomes
  `[REDACTED] v<version>` instead of `<filename> v<version>`. Same re-render
  boundary as `entity_name`.
- **Command payloads** (`command_payload`) — mutation details stripped
- **Receipt details** (`receipt_details`) — specific changes masked
- **Provenance actors** (`provenance_actors`) — identity hidden in traces
- **Index source URIs** (`index_source_uri`) — original source path hidden
  in index records
- **Graph nodes** — restricted nodes replaced with `[Access restricted]`
  placeholders (via visibility rules)

### Label rendering boundary

Provenance graph node labels (`ProvenanceNode.label: string`) carry the
literal identifier when produced by the bare `ClusterKernel`. The
`PolicyEnforcedKernel.traceObject` / `traceBundle` re-render every node
via `renderProvenanceLabel(metadata.labelData, policyView)` so the
`entity_name` and `artifact_filename` targets actually gate the rendered
string. Holding a bare-kernel graph is a trusted-internal operation;
surfacing it to an AI-facing trust zone without going through the
PolicyEnforcedKernel is a doctrine violation.

## Visibility rules

Some objects are invisible to certain principals:

```typescript
interface VisibilityRule {
    id: string;
    match: PolicyMatch;
    visible: boolean;
    reason: string;
}
```

When `visible: false`, the object is completely excluded from results — `find`, `retrieve`, and `list` operations never return it. This prevents existence leakage.

## CLI

```bash
# Explain what policy decides for a principal
db-cluster policy explain --principal '{"id":"agent","name":"Agent","roles":["reader"],"trustZone":"agent"}' --resource 'cluster://canonical/entity-id'

# Test a specific action
db-cluster policy test --principal '{"id":"agent","name":"Agent","roles":["reader"],"trustZone":"agent"}' --capability read_owner_truth --store canonical
```

## SDK

```typescript
const explanation = sdk.policyExplain({
    principal: { id: 'agent', name: 'Agent', roles: ['reader'], trustZone: 'agent' },
    resource: 'cluster://canonical/entity-id',
});

const test = sdk.policyTest({
    principal: { id: 'external', name: 'External', roles: ['reader'], trustZone: 'external' },
    actions: [
        { capability: 'read_owner_truth', store: 'canonical' },
        { capability: 'commit_command', store: 'canonical' },
    ],
});
// test.results[0].decision === 'allow'
// test.results[1].decision === 'deny'
```

## MCP

```json
{"tool": "cluster_policy_explain", "arguments": {"principal": {"id": "agent", "name": "Agent", "roles": ["reader"], "trustZone": "agent"}, "resource": "cluster://canonical/..."}}
```

```json
{"tool": "cluster_policy_test", "arguments": {"principal": {"id": "agent", "name": "Agent", "roles": ["reader", "proposer"], "trustZone": "agent"}, "actions": [{"capability": "read_owner_truth", "store": "canonical"}]}}
```

## Enforcement layers

| Layer | What it does |
|-------|-------------|
| PolicyEnforcedKernel | Wraps every kernel operation with policy check |
| Visibility filtering | Excludes invisible objects from results |
| Redaction | Strips sensitive fields from allowed results |
| Command verb restriction | Blocks unauthorized mutation verbs |
| Trust zone scoping | Limits operations by zone |

## Ownership law

- Policy is evaluated on **every** kernel operation — reads and writes
- Redaction preserves object shape but removes sensitive content
- Denied objects are invisible, not "access denied" in results
- Policy does not change store truth — it controls what consumers see
- The ledger records policy decisions as part of provenance
- Restricted provenance traces show `[Access restricted]` placeholders

## What this is NOT

- Not RBAC bolted onto a database
- Not row-level security
- Not an ACL file
- Policy is structural and deterministic — no LLM-based access decisions
- Redaction is content-aware, not field-level permissions only
