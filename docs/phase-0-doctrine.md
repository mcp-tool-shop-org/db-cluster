# Phase 0 — Doctrine (Frozen)

## Product Identity

**db-cluster is an AI-native federated database cluster.**

The core product is the cluster of specialized truth stores. Each store exists because it preserves a different truth shape that would be weakened elsewhere.

## Product Thesis

> AI does not need one magic database.
> AI needs a federated database cluster where each store preserves a native kind of truth
> — relational, document, vector, graph, event, object, time-series —
> and a kernel/index layer makes those stores act like one governed data organism.

## Hierarchy

1. **Product:** AI-native federated database cluster
2. **Support:** shared index (discoverability, cross-store identity, recall)
3. **Support:** kernel / coordination law (routing, contracts, permissions, mutation boundaries)
4. **Interface:** CLI, SDK, MCP, app API, or agent-facing surface

The kernel makes the cluster coherent.
The index makes the cluster searchable.
The cluster is the thing being sold, built, and defended.

## Architecture Laws

1. Every fact has an owner store
2. Indexes are derivative (never the source of truth)
3. AI never mutates raw state directly
4. Every answer traces to source truth
5. Every mutation crosses a typed command boundary
6. Artifact truth is immutable by default
7. Kernel routes; cluster owns

## Why Each Store Exists

| Single-DB tradeoff | What breaks                          |
| ------------------ | ------------------------------------ |
| Relational only    | loses long-form context              |
| Vector only        | loses canonical state                |
| Document only      | weakens joins and transactions       |
| Graph only         | awkward for raw artifacts            |
| Object only        | cannot reason over relationships     |
| Event log only     | not ergonomic for querying           |
| Time-series only   | not for business entities            |

## Anti-patterns

- "Cool stack diagram with many databases" — cluster must have *reason* per store
- Retrieval swamp — too many stores, no ownership, no catalog discipline
- Safety theater — kernel in name but model still over-privileged
- Provenance drift — eventual consistency without exposing freshness/version/confidence
- Index-as-primary-store — derivative only
- Generic "AI database assistant" framing — too weak

## Positioning

- YES: "AI-native federated truth-store cluster with built-in indexing, routing, provenance, and mutation control"
- YES: "Federated evidence control plane"
- NO: "A kernel over databases" (sounds like middleware)
- NO: "AI needs more databases" (misses the point)
