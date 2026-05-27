---
title: db-cluster Handbook
description: AI-native federated database cluster — handbook for AI agents, operators, and developers.
sidebar:
  order: 0
---

**db-cluster** is an AI-native federated database cluster. Four specialized truth stores — canonical, artifact, index, ledger — behaving as one governed substrate, with typed errors, mutation receipts, and MCP / SDK / CLI surfaces.

This handbook is the canonical operator + developer + AI-integrator guide. The CLI `--help` is the source of truth for flags; this handbook is the source of truth for **why** and **how**.

## Who this handbook is for

- **AI agents** consuming the MCP surface — `cluster_find_sources`, `cluster_retrieve_bundle`, `cluster_propose_mutation`, etc. — and needing to branch on structured `AiErrorEnvelope` responses.
- **Operators** running the cluster locally or with a Postgres canonical backend, who want typed exit codes, doctor / verify diagnostics, and safe backup / restore.
- **Developers** embedding db-cluster as a library via `import 'db-cluster/sdk'` and the `PolicyEnforcedKernel` surface.

## What's in this handbook

| Page | Audience | What you'll find |
|------|----------|------------------|
| [Getting Started](./getting-started/) | All | Install + 5-minute golden path (init → ingest → retrieve → mutate → trace). |
| [Architecture](./architecture/) | All | The four-store federation thesis. Why the kernel routes and the cluster owns. |
| [Operations](./operations/) | Operators | doctor, verify, rebuild, backup, restore. Runbooks per typed-error class. |
| [Policy & Redaction](./policy-and-redaction/) | All | Principal, Capability, Policy, TrustZone, VisibilityRule. Redaction at every read path. |
| [MCP Integration](./mcp/) | AI agents | 16 tools with safety annotations. AiErrorEnvelope shape. Tool catalog. |
| [SDK Reference](./sdk/) | Developers | `ClusterSDK` constructor, mutation lifecycle, retrieve / trace / why. |
| [CLI Reference](./cli/) | Operators | Full command list. Exit-code table. `--quiet` / `--log-level` / `--no-color`. |

## Architecture in one diagram

```
  CLI / SDK / MCP                       ← surfaces (red, green, cyan colorized)
        │
  PolicyEnforcedKernel                  ← policy + redaction (the only exported entry)
        │
   ClusterKernel                        ← routing, retrieval, mutation lifecycle
        │
  ┌─────┼──────┬──────────┐
  │     │      │          │
Canonical Artifact Index Ledger         ← stores (owner truth vs derivative index)
(Postgres  (local) (local) (local)
 or local)
```

## Core invariants

1. Every fact has an **owner store**.
2. **Indexes are derivative** — can be deleted and rebuilt from owned stores.
3. AI never mutates raw state directly — every mutation crosses a **typed command boundary**.
4. Every answer **traces to source truth** via the ledger.
5. **Artifact truth is immutable by default** — corrections create versions, not overwrites.
6. **Kernel routes; cluster owns.**

## Next steps

- New to db-cluster? → [Getting Started](./getting-started/)
- Curious about the design? → [Architecture](./architecture/)
- AI agent integrator? → [MCP Integration](./mcp/)
- Operator? → [Operations](./operations/) + [CLI Reference](./cli/)
