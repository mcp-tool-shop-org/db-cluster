# Phase 13 — Dashboard / Truth Inspector Integration

## Mandate

Integrate the existing ClusterTruthInspector template as a real dashboard surface over db-cluster data, without turning the product into a generic admin UI.

The dashboard makes cluster laws visible:

- Every object has an owner store
- Index records are derivative
- Source truth resolves from owner stores
- Provenance is graph-shaped
- Mutation is command-gated
- Policy/redaction affects what is visible
- Operations can diagnose and repair cluster state

## Doctrine

The dashboard is an **inspector over cluster truth**, not the product center.

It must never become:

- A CRUD admin panel
- A generic database dashboard
- A metrics dashboard
- A chat interface
- A marketing site
- A replacement for CLI/SDK/MCP

## Exit sentence

> The dashboard exists to make cluster law inspectable.

## Architecture

```
dashboard/                     ← Static UI assets (React/JSX + HTML)
  ClusterTruthInspector.jsx    ← Main inspector component
  index.html                   ← Demo host page
  demo-data.js                 ← Shaped demo data for offline rendering
  components/                  ← Additional panels
    OperationsPanel.jsx
    CommandPreviewPanel.jsx
    PolicyViewToggle.jsx
  data/                        ← Generated snapshots
    dogfood-snapshot.json

src/dashboard/                 ← TypeScript data contract
  dashboard-model.ts           ← DashboardObject type + builder
  inspector-data.ts            ← Maps kernel verbs → DashboardObject
  ops-model.ts                 ← Operations health model
```

## Data flow

```
ClusterKernel verbs → inspector-data.ts → DashboardObject → React component
```

The UI never reads raw adapter stores. It consumes a shaped model derived from kernel surfaces:

- `resolve`
- `retrieveBundle`
- `traceObject`
- `why`
- `explainIndex`
- `listReceipts`
- `inspectCommand`
- `doctor`
- `verify`

## Store visualization law

| Store     | Display label  | Meaning         |
|-----------|---------------|-----------------|
| canonical | owner truth   | source truth    |
| artifact  | raw source    | source truth    |
| index     | derivative    | rebuildable     |
| ledger    | append-only   | audit/provenance|
