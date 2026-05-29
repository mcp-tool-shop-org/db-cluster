---
title: Policy & Redaction
description: Principal, Capability, Policy, TrustZone, VisibilityRule. Redaction at every read path.
sidebar:
  order: 4
---

Policy and redaction are **native** to db-cluster — not bolted on. The package is policy-enforced by default: the root factory `createSafeCluster()` hands back a `PolicyEnforcedKernel`-backed handle (raw stores only via the explicit `@mcptoolshop/db-cluster/unsafe` escape hatch), and every read path applies redaction before returning.

This page is the canonical reference. Other docs (CLI, SDK, MCP) link here rather than restate.

## The five types

| Type | Purpose |
|------|---------|
| `Principal` | Identity of the actor requesting the operation. |
| `Capability` | A verb the actor wants to perform (one of 13). |
| `Policy` | A rule binding capabilities to principals + resources, with an effect (allow / deny). |
| `TrustZone` | A named boundary with default policies + zone-level redaction rules. |
| `VisibilityRule` | What's visible vs hidden (existence visibility + metadata visibility) for a principal. |

### Principal

```ts
interface Principal {
    id: string;                 // stable identifier
    name: string;               // human-readable
    roles: string[];            // e.g. ['operator', 'reviewer']
    trustZone: string;          // bound zone name
    metadata?: Record<string, unknown>;
}
```

Configured via `DB_CLUSTER_PRINCIPAL` env (JSON, schema-validated, fail-closed on malformed input).

### Capability

One of 13 verbs:

```
find_sources · retrieve_bundle · explain_retrieval · resolve · trace · why
inspect_command · list_receipts
propose_mutation · validate_mutation · approve_mutation · reject_mutation
commit_mutation · compensate_mutation
```

Each maps to an SDK / MCP / CLI operation. The policy engine checks the capability before the operation runs.

### Policy

```ts
interface Policy {
    id: string;
    name: string;
    verb: Capability | '*';
    resource: string | '*';     // URI pattern or wildcard
    effect: 'allow' | 'deny';
    principal?: { roles?: string[]; trustZones?: string[] };
    conditions?: PolicyCondition[];
    redactionRules?: RedactionRule[];
}
```

Evaluation is **first-match deny-wins** — the engine walks policies in order; the first deny match short-circuits with an `AccessDenied` decision. Allows accumulate.

### TrustZone

```ts
interface TrustZone {
    name: string;
    description?: string;
    defaultPolicies?: Policy[];   // applied before user policies
    redactionRules?: RedactionRule[];
}
```

Default zones: `internal-trusted`, `external-readonly`, `audit-only`, `compliance-restricted`. Custom zones can be added via `DB_CLUSTER_POLICIES_FILE`.

### VisibilityRule

```ts
interface VisibilityRule {
    resource: string;             // URI pattern
    existenceVisibility: 'visible' | 'hidden';
    metadataVisibility: 'visible' | 'hidden' | 'redacted';
}
```

If `existenceVisibility` is `'hidden'`, the resource is silently excluded from list responses (the requester cannot tell it exists). If `'visible'`, attempts to read it return `AccessDenied` with the URI surfaced.

## Redaction

`PolicyEnforcedKernel` applies redaction on every read path:

- `redactArtifact` — masks / strips / summarizes / hashes the artifact storagePath.
- `redactEntity` — masks / strips entity attributes, preserving object shape.
- `redactCommand` — strips command payloads, preserving lifecycle metadata.
- `redactReceipt` — strips receipt details, preserving audit shape.
- `redactProvenanceActors` — strips actor identities from provenance graph nodes / edges.
- `redactGraphNodes` — replaces hidden nodes with `[Access restricted]` placeholders.
- `sanitizeWarnings` — removes stale / gap warnings referencing hidden URIs.

### Allowlist redactor

The redactor is **allowlist-based**, not denylist-based. Adding a new field to an internal type does NOT silently leak — the redactor must explicitly opt-in. This was the AGG-005 fix in Wave B1-Amend.

Markers are explicit `RedactionMarker` instances, not byte-level regex mangling — `TraceBuilder` builds labels from structured metadata at render time so the dashboard can render the `[Access restricted]` placeholder accurately.

## Configuring policy

```bash
DB_CLUSTER_PRINCIPAL='{"id":"u-1","name":"Alice","roles":["operator"],"trustZone":"internal-trusted"}' \
DB_CLUSTER_POLICIES_FILE=./policies.json \
npx db-cluster retrieve "..."
```

The `policies.json` file is structurally validated (`validatePolicyConfig`) on load — fail-closed on malformed input. The file path is sandboxed against cwd.

## Inspecting policy

```bash
npx db-cluster policy explain --principal '{...}'
npx db-cluster policy test --principal '{...}' --verb retrieve_bundle --resource 'cluster://canonical/...'
```

Both surface the effective policy decision: matched policy ID + name, allow / deny, the rule that determined the outcome. Useful for "why is this denied?" debugging.

## Default safety

The default posture depends on the **surface**:

**In-process SDK / `createSafeCluster` (trusted callers).** Out of the box, with
no policies file:

- Default principal: `INTERNAL_TRUSTED_PRINCIPAL` (zone: `internal-trusted`).
- Default policies: full allow within the internal-trusted zone.
- Default redaction: empty.

This is appropriate because constructing the SDK or calling `createSafeCluster`
in-process is itself a trusted act. Production deployments **should** still
override the principal + add a policies file.

**MCP server (`db-cluster-mcp`).** The MCP surface does **not** fall back to the
trusted in-process default. It defaults to the **`ai-facing` trust zone with
redaction ON** — artifact content and sensitive attributes are stripped at the
boundary, and write tools refuse to commit until a command is `approved`. The
privileged (`internal` / `cluster-admin`) posture is reachable only when an
operator explicitly opts in via an environment flag (provisionally
`DB_CLUSTER_MCP_ALLOW_PRIVILEGED`). See [MCP Integration](../mcp/).

## See also

- [SDK Reference](../sdk/) — `ClusterSDK` accepts `policies`, `trustZones`, `visibilityRules`, `principal` constructor options.
- [MCP Integration](../mcp/) — `cluster_policy_explain` and `cluster_policy_test` are exposed as MCP tools.
